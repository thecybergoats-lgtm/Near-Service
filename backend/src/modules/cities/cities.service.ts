// Multi-city ops — CitiesService (Phase 4, item 3).
//
// Owns: the city status lifecycle + go/no-go gate, City Manager scoping,
// per-city overrides (categories, commission, fair pricing) and the
// launch checklist. Everything a City Manager touches is enforced
// server-side here against user_roles.city_id — the JWT roles alone are
// never enough, because the token carries role names but no city scope.
//
// Money tables are NOT duplicated: commission overrides live in the
// existing commission_rules (city_id) and resolve through the shared
// pickCommissionRule specificity order (city+category > category >
// city > global); fair-price overrides live in fair_price_seed
// (city_id). This service only adds the city-aware resolution + the
// admin writes for those rows.
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import {
  CityStatus,
  GateMetrics,
  GateThresholds,
  DEFAULT_GATE_THRESHOLDS,
  evaluateGate,
  isLegalCityTransition,
} from './gate';
import {
  clampCommissionRate,
  defaultCommissionRate,
  isCommissionRateInBand,
  pickCommissionRule,
  CommissionRuleRow,
} from '../../common/utils/commission';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

export interface CityRow {
  id: string;
  name: string;
  slug: string;
  status: CityStatus;
  is_launched: boolean;
  launched_at: string | null;
  default_radius_km: number;
  supply_target_providers: number;
  population_estimate: number | null;
  manager_id: string | null;
  created_at: string;
  updated_at: string;
}

const CITY_COLS = `id, name, slug, status, is_launched, launched_at, default_radius_km,
  supply_target_providers, population_estimate, manager_id, created_at, updated_at`;

@Injectable()
export class CitiesService {
  constructor(private db: DatabaseService) {}

  private async audit(actorId: string, action: string, entity: string, entityId: string | null, before: unknown, after: unknown) {
    await this.db.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
      [actorId, action, entity, entityId, JSON.stringify(before ?? null), JSON.stringify(after ?? null)],
    );
  }

  // ---- Scoping (server-side, DB is the source of truth) -----------------

  /** True when the user holds a GLOBAL super_admin role (city_id NULL). */
  async isSuperAdmin(userId: string): Promise<boolean> {
    const row = (await this.db.query(
      `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND r.name = 'super_admin' AND ur.city_id IS NULL`,
      [userId],
    )).rows[0];
    return !!row;
  }

  /** City ids this user manages as a City Manager. */
  async assignedCityIds(userId: string): Promise<string[]> {
    const rows = (await this.db.query(
      `SELECT ur.city_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND r.name = 'city_manager' AND ur.city_id IS NOT NULL`,
      [userId],
    )).rows as unknown as { city_id: string }[];
    return rows.map((r) => r.city_id);
  }

  /** 'super_admin' | 'city_manager' for this city, or throws 403. A
   *  City Manager assigned to Quetta gets 403 on Karachi — enforced
   *  here, in the service, not only in the route's @Roles guard. */
  async requireCityAccess(user: AuthUser, cityId: string): Promise<'super_admin' | 'city_manager'> {
    if (await this.isSuperAdmin(user.id)) return 'super_admin';
    const assigned = await this.assignedCityIds(user.id);
    if (assigned.includes(cityId)) return 'city_manager';
    throw Errors.forbidden('City Manager is not assigned to this city');
  }

  /** Throws 403 unless the user is a global super_admin. */
  async requireSuperAdmin(userId: string): Promise<void> {
    if (!(await this.isSuperAdmin(userId))) throw Errors.forbidden('Requires super_admin');
  }

  // ---- Cities ------------------------------------------------------------

  async listCities(user: AuthUser): Promise<CityRow[]> {
    if (await this.isSuperAdmin(user.id)) {
      return (await this.db.query(`SELECT ${CITY_COLS} FROM cities ORDER BY name`)).rows as unknown as CityRow[];
    }
    const assigned = await this.assignedCityIds(user.id);
    if (assigned.length === 0) throw Errors.forbidden('No cities assigned to this City Manager');
    return (await this.db.query(
      `SELECT ${CITY_COLS} FROM cities WHERE id = ANY($1::uuid[]) ORDER BY name`, [assigned],
    )).rows as unknown as CityRow[];
  }

  async getCity(user: AuthUser, cityId: string): Promise<CityRow> {
    await this.requireCityAccess(user, cityId);
    const row = (await this.db.query(`SELECT ${CITY_COLS} FROM cities WHERE id=$1`, [cityId])).rows[0] as unknown as CityRow | undefined;
    if (!row) throw Errors.notFound('City');
    return row;
  }

  async getCityBySlug(slug: string): Promise<CityRow> {
    const row = (await this.db.query(`SELECT ${CITY_COLS} FROM cities WHERE slug=$1`, [slug])).rows[0] as unknown as CityRow | undefined;
    if (!row) throw Errors.notFound('City');
    return row;
  }

  async createCity(actorId: string, dto: { name: string; slug: string; lat: number; lng: number; default_radius_km?: number; population_estimate?: number; supply_target_providers?: number }) {
    if (!dto.name || !dto.slug) throw Errors.unprocessable('INVALID_CITY', 'name and slug are required');
    if (!/^[a-z0-9-]+$/.test(dto.slug)) throw Errors.unprocessable('INVALID_CITY', 'slug must be lowercase letters, digits and hyphens');
    if (!(dto.lat >= -90 && dto.lat <= 90 && dto.lng >= -180 && dto.lng <= 180)) {
      throw Errors.unprocessable('INVALID_CITY', 'lat must be -90..90 and lng -180..180');
    }
    try {
      const row = (await this.db.query(
        `INSERT INTO cities (name, slug, center, is_launched, default_radius_km, status, population_estimate, supply_target_providers)
         VALUES ($1,$2,ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,false,$5,'planned',$6,$7) RETURNING ${CITY_COLS}`,
        [dto.name, dto.slug, dto.lat, dto.lng, dto.default_radius_km ?? 5, dto.population_estimate ?? null, dto.supply_target_providers ?? 10],
      )).rows[0];
      await this.db.query(`INSERT INTO city_gate_configs (city_id) VALUES ($1) ON CONFLICT (city_id) DO NOTHING`, [row.id]);
      await this.audit(actorId, 'city.create', 'cities', row.id, null, row);
      return row;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw Errors.conflict('CITY_SLUG_EXISTS', `A city with slug '${dto.slug}' already exists`);
      throw e;
    }
  }

  /** Assign a City Manager to a city (super_admin only). The user must
   *  already hold the city_manager role; the assignment is a
   *  user_roles row scoped to this city, and cities.manager_id records
   *  the primary owner. */
  async assignManager(actorId: string, cityId: string, managerUserId: string) {
    await this.requireSuperAdmin(actorId);
    const city = (await this.db.query(`SELECT ${CITY_COLS} FROM cities WHERE id=$1`, [cityId])).rows[0] as unknown as CityRow | undefined;
    if (!city) throw Errors.notFound('City');
    const user = (await this.db.query(`SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL`, [managerUserId])).rows[0];
    if (!user) throw Errors.notFound('User');
    const role = (await this.db.query(`SELECT id FROM roles WHERE name='city_manager'`)).rows[0] as unknown as { id: string } | undefined;
    if (!role) throw Errors.notFound('city_manager role');
    const holds = (await this.db.query(
      `SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id=$2`, [managerUserId, role.id],
    )).rows[0];
    if (!holds) throw Errors.unprocessable('NOT_CITY_MANAGER', 'User does not hold the city_manager role');
    await this.db.query(
      `INSERT INTO user_roles (user_id, role_id, city_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [managerUserId, role.id, cityId],
    );
    const updated = (await this.db.query(
      `UPDATE cities SET manager_id=$2, updated_at=now() WHERE id=$1 RETURNING ${CITY_COLS}`, [cityId, managerUserId],
    )).rows[0];
    await this.audit(actorId, 'city.assign_manager', 'cities', cityId, city, updated);
    return updated;
  }

  // ---- Supply targets / radius rules (City Manager scope) --------------

  async updateTargets(user: AuthUser, cityId: string, dto: { supply_target_providers?: number; default_radius_km?: number; population_estimate?: number }) {
    await this.requireCityAccess(user, cityId);
    const before = (await this.db.query(`SELECT ${CITY_COLS} FROM cities WHERE id=$1`, [cityId])).rows[0] as unknown as CityRow | undefined;
    if (!before) throw Errors.notFound('City');
    if (dto.supply_target_providers != null && dto.supply_target_providers < 0) {
      throw Errors.unprocessable('INVALID_TARGET', 'supply_target_providers must be >= 0');
    }
    if (dto.default_radius_km != null && !(dto.default_radius_km > 0 && dto.default_radius_km <= 100)) {
      throw Errors.unprocessable('INVALID_TARGET', 'default_radius_km must be > 0 and <= 100');
    }
    const updated = (await this.db.query(
      `UPDATE cities SET supply_target_providers=COALESCE($2,supply_target_providers),
         default_radius_km=COALESCE($3,default_radius_km),
         population_estimate=COALESCE($4,population_estimate), updated_at=now()
       WHERE id=$1 RETURNING ${CITY_COLS}`,
      [cityId, dto.supply_target_providers ?? null, dto.default_radius_km ?? null, dto.population_estimate ?? null],
    )).rows[0];
    await this.audit(user.id, 'city.update_targets', 'cities', cityId, before, updated);
    return updated;
  }

  // ---- Gate config + evaluation ------------------------------------------

  async getGateConfig(cityId: string): Promise<GateThresholds> {
    const row = (await this.db.query(
      `SELECT min_providers, min_supply_density_per_100k, min_fill_rate, max_time_to_first_offer_seconds
       FROM city_gate_configs WHERE city_id=$1`, [cityId],
    )).rows[0] as unknown as Record<string, string> | undefined;
    if (!row) return { ...DEFAULT_GATE_THRESHOLDS };
    return {
      minProviders: Number(row.min_providers),
      minSupplyDensityPer100k: Number(row.min_supply_density_per_100k),
      minFillRate: Number(row.min_fill_rate),
      maxTimeToFirstOfferSeconds: Number(row.max_time_to_first_offer_seconds),
    };
  }

  async updateGateConfig(user: AuthUser, cityId: string, dto: Partial<GateThresholds>) {
    await this.requireCityAccess(user, cityId);
    const before = await this.getGateConfig(cityId);
    if (dto.minFillRate != null && (dto.minFillRate < 0 || dto.minFillRate > 1)) {
      throw Errors.unprocessable('INVALID_GATE_CONFIG', 'min_fill_rate must be 0..1');
    }
    if (dto.minProviders != null && dto.minProviders < 0) throw Errors.unprocessable('INVALID_GATE_CONFIG', 'min_providers must be >= 0');
    if (dto.minSupplyDensityPer100k != null && dto.minSupplyDensityPer100k < 0) throw Errors.unprocessable('INVALID_GATE_CONFIG', 'min_supply_density_per_100k must be >= 0');
    if (dto.maxTimeToFirstOfferSeconds != null && dto.maxTimeToFirstOfferSeconds <= 0) throw Errors.unprocessable('INVALID_GATE_CONFIG', 'max_time_to_first_offer_seconds must be > 0');
    const updated = (await this.db.query(
      `INSERT INTO city_gate_configs (city_id, min_providers, min_supply_density_per_100k, min_fill_rate, max_time_to_first_offer_seconds, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (city_id) DO UPDATE SET
         min_providers=EXCLUDED.min_providers,
         min_supply_density_per_100k=EXCLUDED.min_supply_density_per_100k,
         min_fill_rate=EXCLUDED.min_fill_rate,
         max_time_to_first_offer_seconds=EXCLUDED.max_time_to_first_offer_seconds,
         updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING min_providers, min_supply_density_per_100k, min_fill_rate, max_time_to_first_offer_seconds`,
      [cityId,
       dto.minProviders ?? before.minProviders,
       dto.minSupplyDensityPer100k ?? before.minSupplyDensityPer100k,
       dto.minFillRate ?? before.minFillRate,
       dto.maxTimeToFirstOfferSeconds ?? before.maxTimeToFirstOfferSeconds,
       user.id],
    )).rows[0] as unknown as Record<string, string>;
    const after: GateThresholds = {
      minProviders: Number(updated.min_providers),
      minSupplyDensityPer100k: Number(updated.min_supply_density_per_100k),
      minFillRate: Number(updated.min_fill_rate),
      maxTimeToFirstOfferSeconds: Number(updated.max_time_to_first_offer_seconds),
    };
    await this.audit(user.id, 'city.update_gate_config', 'city_gate_configs', cityId, before, after);
    return after;
  }

  /** Live gate metrics for a city: providers inside the default radius,
   *  density per 100k residents, and — over non-cancelled requests in
   *  the last 30 days inside the radius — fill rate and mean time to
   *  first offer. */
  async computeMetrics(cityId: string): Promise<GateMetrics> {
    const city = (await this.db.query(
      `SELECT default_radius_km, population_estimate FROM cities WHERE id=$1`, [cityId],
    )).rows[0] as unknown as { default_radius_km: string; population_estimate: string | null } | undefined;
    if (!city) throw Errors.notFound('City');
    const counts = (await this.db.query(
      `SELECT COUNT(*)::int AS provider_count FROM provider_profiles p
         JOIN cities c ON c.id=$1
        WHERE p.deleted_at IS NULL
          AND ST_DWithin(p.base_point, c.center, c.default_radius_km * 1000)`,
      [cityId],
    )).rows[0] as unknown as { provider_count: number };
    const demand = (await this.db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE first_offer_at IS NOT NULL)::int AS filled,
              AVG(EXTRACT(EPOCH FROM (first_offer_at - created_at))) AS ttfo
         FROM (
           SELECT r.id, r.created_at, MIN(o.created_at) AS first_offer_at
             FROM service_requests r
             JOIN cities c ON c.id=$1
             LEFT JOIN offers o ON o.request_id = r.id
            WHERE r.deleted_at IS NULL AND r.status <> 'CANCELLED'
              AND r.created_at >= now() - interval '30 days'
              AND ST_DWithin(r.location, c.center, c.default_radius_km * 1000)
            GROUP BY r.id, r.created_at
         ) s`,
      [cityId],
    )).rows[0] as unknown as { total: number; filled: number; ttfo: string | null };
    const providerCount = Number(counts.provider_count);
    const population = city.population_estimate != null ? Number(city.population_estimate) : null;
    return {
      providerCount,
      supplyDensityPer100k:
        population != null && population > 0 ? Number(((providerCount / population) * 100000).toFixed(3)) : null,
      fillRate: demand.total > 0 ? Number((demand.filled / demand.total).toFixed(3)) : null,
      timeToFirstOfferSeconds: demand.ttfo != null ? Number(Number(demand.ttfo).toFixed(1)) : null,
    };
  }

  /** Run a gate evaluation: compute live metrics, decide pass/fail,
   *  persist the evaluation + audit it. A passing evaluation also
   *  ticks the 'gate_evaluation_pass' checklist item. */
  async evaluateGateFor(user: AuthUser, cityId: string, notes?: string) {
    await this.requireCityAccess(user, cityId);
    const city = (await this.db.query(`SELECT ${CITY_COLS} FROM cities WHERE id=$1`, [cityId])).rows[0] as unknown as CityRow | undefined;
    if (!city) throw Errors.notFound('City');
    const thresholds = await this.getGateConfig(cityId);
    const metrics = await this.computeMetrics(cityId);
    const evaluation = evaluateGate(metrics, thresholds);
    const row = await this.db.withTransaction(async (c) => {
      const q = c.query.bind(c);
      const inserted = (await q(
        `INSERT INTO city_gate_evaluations (city_id, evaluated_by, metrics, results, passed, notes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [cityId, user.id, JSON.stringify(metrics), JSON.stringify(evaluation.results), evaluation.passed, notes ?? null],
      )).rows[0];
      await q(
        `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
        [user.id, 'city.gate_evaluate', 'city_gate_evaluations', inserted.id,
         JSON.stringify({ city_id: cityId }), JSON.stringify({ ...inserted, thresholds })],
      );
      if (evaluation.passed) {
        await q(
          `UPDATE city_launch_checklist SET done=true, done_by=$2, done_at=now()
            WHERE city_id=$1 AND item_key='gate_evaluation_pass'`,
          [cityId, user.id],
        );
      }
      return inserted;
    });
    return { ...row, thresholds, metrics };
  }

  async listEvaluations(user: AuthUser, cityId: string) {
    await this.requireCityAccess(user, cityId);
    const rows = (await this.db.query(
      `SELECT * FROM city_gate_evaluations WHERE city_id=$1 ORDER BY evaluated_at DESC, id DESC LIMIT 50`, [cityId],
    )).rows;
    return { items: rows, next_cursor: null };
  }

  // ---- Status lifecycle (super_admin only) -------------------------------

  async transitionStatus(actorId: string, cityId: string, to: CityStatus, note?: string) {
    await this.requireSuperAdmin(actorId);
    const before = (await this.db.query(`SELECT ${CITY_COLS} FROM cities WHERE id=$1`, [cityId])).rows[0] as unknown as CityRow | undefined;
    if (!before) throw Errors.notFound('City');
    if (!isLegalCityTransition(before.status, to)) {
      throw Errors.conflict('ILLEGAL_CITY_TRANSITION', `Cannot move city ${before.status} -> ${to}`);
    }
    if (to === 'live') {
      // Going live requires a PASSING gate evaluation — the latest one.
      const latest = (await this.db.query(
        `SELECT passed FROM city_gate_evaluations WHERE city_id=$1 ORDER BY evaluated_at DESC, id DESC LIMIT 1`, [cityId],
      )).rows[0] as unknown as { passed: boolean } | undefined;
      if (!latest || !latest.passed) {
        throw Errors.conflict('GATE_NOT_PASSED', 'City cannot go live: the latest gate evaluation did not pass (run a new evaluation first)');
      }
    }
    // NOTE: $2 is never reused inside a CASE — node-pg sends parameters
    // untyped, and Postgres fails type deduction ("inconsistent types
    // deduced for parameter $2") when one parameter is both assigned and
    // compared inside CASE branches. is_launched and the
    // going-live flag are computed in JS and passed as plain booleans.
    const isLaunched = to === 'live' ? true : to === 'paused' ? false : before.is_launched;
    const updated = (await this.db.query(
      `UPDATE cities SET status=$2, is_launched=$3,
         launched_at = CASE WHEN $4 AND launched_at IS NULL THEN now() ELSE launched_at END,
         updated_at=now()
       WHERE id=$1 RETURNING ${CITY_COLS}`,
      [cityId, to, isLaunched, to === 'live'],
    )).rows[0];
    await this.audit(actorId, `city.status:${to}`, 'cities', cityId, { ...before, note: note ?? null }, updated);
    return updated;
  }

  // ---- Launch checklist ---------------------------------------------------

  async getChecklist(user: AuthUser, cityId: string) {
    await this.requireCityAccess(user, cityId);
    const rows = (await this.db.query(
      `SELECT * FROM city_launch_checklist WHERE city_id=$1 ORDER BY item_key`, [cityId],
    )).rows;
    return { items: rows };
  }

  async setChecklistItem(user: AuthUser, cityId: string, itemKey: string, done: boolean, notes?: string) {
    await this.requireCityAccess(user, cityId);
    const before = (await this.db.query(
      `SELECT * FROM city_launch_checklist WHERE city_id=$1 AND item_key=$2`, [cityId, itemKey],
    )).rows[0];
    if (!before) throw Errors.notFound('Checklist item');
    const updated = (await this.db.query(
      `UPDATE city_launch_checklist SET done=$3, done_by=CASE WHEN $3 THEN $4 ELSE NULL END,
         done_at=CASE WHEN $3 THEN now() ELSE NULL END, notes=COALESCE($5,notes)
       WHERE city_id=$1 AND item_key=$2 RETURNING *`,
      [cityId, itemKey, done, user.id, notes ?? null],
    )).rows[0];
    await this.audit(user.id, `city.checklist:${done ? 'done' : 'reopen'}`, 'city_launch_checklist', before.id, before, updated);
    return updated;
  }

  // ---- Per-city categories -------------------------------------------------

  async listCategoryOverrides(user: AuthUser, cityId: string) {
    await this.requireCityAccess(user, cityId);
    const rows = (await this.db.query(
      `SELECT o.city_id, o.category_id, o.is_enabled, o.sort_order, c.slug, c.name_en
         FROM city_category_overrides o JOIN categories c ON c.id=o.category_id
        WHERE o.city_id=$1 ORDER BY o.sort_order, c.name_en`, [cityId],
    )).rows;
    return { items: rows };
  }

  async setCategoryOverride(user: AuthUser, cityId: string, categoryId: string, isEnabled: boolean, sortOrder?: number) {
    await this.requireCityAccess(user, cityId);
    const cat = (await this.db.query(`SELECT id FROM categories WHERE id=$1`, [categoryId])).rows[0];
    if (!cat) throw Errors.notFound('Category');
    const before = (await this.db.query(
      `SELECT * FROM city_category_overrides WHERE city_id=$1 AND category_id=$2`, [cityId, categoryId],
    )).rows[0];
    const updated = (await this.db.query(
      `INSERT INTO city_category_overrides (city_id, category_id, is_enabled, sort_order, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (city_id, category_id) DO UPDATE SET
         is_enabled=EXCLUDED.is_enabled, sort_order=EXCLUDED.sort_order,
         updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING *`,
      [cityId, categoryId, isEnabled, sortOrder ?? 0, user.id],
    )).rows[0];
    await this.audit(user.id, 'city.category_override', 'city_category_overrides', null, before ?? null, updated);
    return updated;
  }

  // ---- Per-city commission + pricing (override precedence) ---------------

  /** Effective commission rate for (city, category, tier): the most
   *  specific matching rule wins — city+category > category > city >
   *  global — so a city override always beats the global rule. Falls
   *  back to the configured default rate when no rule matches. */
  async resolveCommissionRate(cityId: string, categoryId?: string | null, tier?: number | null): Promise<{
    rate: number; ruleId: string | null; source: string;
  }> {
    const city = (await this.db.query(`SELECT id FROM cities WHERE id=$1`, [cityId])).rows[0];
    if (!city) throw Errors.notFound('City');
    const rows = (await this.db.query(
      `SELECT id, category_id, city_id, tier, rate, valid_from, valid_to, is_promo FROM commission_rules`,
    )).rows as unknown as CommissionRuleRow[];
    const rule = pickCommissionRule(rows, { categoryId: categoryId ?? null, cityId, tier: tier ?? null });
    if (!rule) return { rate: clampCommissionRate(defaultCommissionRate()), ruleId: null, source: 'default' };
    const parts: string[] = [];
    if (rule.city_id) parts.push('city');
    if (rule.category_id) parts.push('category');
    if (rule.tier !== null && rule.tier !== undefined) parts.push('tier');
    return { rate: clampCommissionRate(Number(rule.rate)), ruleId: rule.id ?? null, source: parts.length > 0 ? parts.join('+') : 'global' };
  }

  async createCommissionRule(user: AuthUser, cityId: string, dto: { category_id?: string | null; tier?: number | null; rate: number; valid_from?: string; valid_to?: string | null }) {
    await this.requireCityAccess(user, cityId);
    if (!isCommissionRateInBand(dto.rate)) {
      throw Errors.unprocessable('RATE_OUT_OF_BAND', 'Commission rate must be within the 0.05–0.15 band');
    }
    if (dto.category_id) {
      const cat = (await this.db.query(`SELECT id FROM categories WHERE id=$1`, [dto.category_id])).rows[0];
      if (!cat) throw Errors.notFound('Category');
    }
    const row = (await this.db.query(
      `INSERT INTO commission_rules (category_id, city_id, tier, rate, valid_from, valid_to, is_promo)
       VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING *`,
      [dto.category_id ?? null, cityId, dto.tier ?? null, dto.rate, dto.valid_from ?? new Date().toISOString().slice(0, 10), dto.valid_to ?? null],
    )).rows[0];
    await this.audit(user.id, 'city.commission_rule.create', 'commission_rules', row.id, null, row);
    return row;
  }

  /** Fair-price range for (city, category): the city row wins; without
   *  one, the global row (city_id NULL) is the fallback; null when
   *  neither exists. */
  async resolveFairPrice(cityId: string, categoryId: string): Promise<{
    minPrice: number; typicalPrice: number; maxPrice: number; sampleSize: number; source: 'city' | 'global';
  } | null> {
    const row = (await this.db.query(
      `SELECT min_price, typical_price, max_price, sample_size, city_id FROM fair_price_seed
        WHERE category_id=$1 AND (city_id=$2 OR city_id IS NULL)
        ORDER BY (city_id IS NULL) ASC LIMIT 1`,
      [categoryId, cityId],
    )).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      minPrice: Number(row.min_price),
      typicalPrice: Number(row.typical_price),
      maxPrice: Number(row.max_price),
      sampleSize: Number(row.sample_size),
      source: row.city_id ? 'city' : 'global',
    };
  }

  async upsertFairPrice(user: AuthUser, cityId: string, dto: { category_id: string; min_price: number; typical_price: number; max_price: number; sample_size?: number }) {
    await this.requireCityAccess(user, cityId);
    if (!(dto.min_price > 0 && dto.typical_price >= dto.min_price && dto.max_price >= dto.typical_price)) {
      throw Errors.unprocessable('INVALID_FAIR_PRICE', 'Require 0 < min_price <= typical_price <= max_price');
    }
    const cat = (await this.db.query(`SELECT id FROM categories WHERE id=$1`, [dto.category_id])).rows[0];
    if (!cat) throw Errors.notFound('Category');
    const before = (await this.db.query(
      `SELECT * FROM fair_price_seed WHERE category_id=$1 AND city_id=$2`, [dto.category_id, cityId],
    )).rows[0];
    const updated = (await this.db.query(
      `INSERT INTO fair_price_seed (category_id, city_id, min_price, typical_price, max_price, sample_size)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (category_id, city_id) DO UPDATE SET
         min_price=EXCLUDED.min_price, typical_price=EXCLUDED.typical_price,
         max_price=EXCLUDED.max_price, sample_size=EXCLUDED.sample_size
       RETURNING *`,
      [dto.category_id, cityId, dto.min_price, dto.typical_price, dto.max_price, dto.sample_size ?? 0],
    )).rows[0];
    await this.audit(user.id, 'city.fair_price.upsert', 'fair_price_seed', updated.id, before ?? null, updated);
    return updated;
  }
}
