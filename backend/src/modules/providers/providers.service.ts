import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { SearchCacheService } from '../search/search-cache.service';
import { Errors } from '../../common/errors/api-error';
import { offsetPage } from '../../common/utils/pagination';
import { rankScore, etaMinutes, bayesianRating } from '../../common/utils/ranking';
import { applyRiskPenaltyToRankScore } from '../../common/utils/risk-scoring';
import { RiskService } from '../risk/risk.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { fairRangeFromPrices } from '../../common/utils/fair-range';
// FIX 11 (Stage 3): open-now is computed in Asia/Karachi from availability
// rows (overnight + day-off aware) — never `is_online`, never the DB
// server's local time. Weekday numbering: see availability.ts (0=Monday).
import { isOpenNow, AvailabilitySlot } from '../../common/utils/availability';
import { cnicHmac, isValidCnic } from '../../common/utils/cnic';
import { encryptField, decryptField } from '../../common/crypto/field-encryption';
import { resolveCategoryId } from '../../common/utils/category-resolve';

export interface NearbyQuery { lat: number; lng: number; category_id?: string; category_slug?: string; radius_km?: number; open_now?: boolean; verified_only?: boolean; }
const DOC_TYPES = ['cnic_front', 'cnic_back', 'selfie', 'shop_photo', 'certificate'] as const;

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);
  // Phase 3 integration: RiskService (ranking penalty from the STORED
  // score — never recomputeScore in a search request) and
  // SubscriptionsService (featured / "Sponsored" placement) are both
  // @Optional so unit tests that construct this service directly with
  // (db, redis) keep working; when absent, ranking is unpenalised and
  // sponsored is false, exactly as before Phase 3.
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    @Optional() @Inject(RiskService) private risk?: RiskService,
    @Optional() @Inject(SubscriptionsService) private subscriptions?: SubscriptionsService,
    @Optional() @Inject(SearchCacheService) private searchCache?: SearchCacheService,
  ) {}

  /** Phase 4, item 1 (search scale-out): a provider write can change
   *  cached search results. Best-effort — a cache failure must never
   *  fail the provider write. */
  private async invalidateSearchProvider(providerId: string): Promise<void> {
    if (!this.searchCache) return;
    try {
      await this.searchCache.invalidateProvider(providerId);
    } catch (e) {
      this.logger.warn(`search cache invalidation failed for provider ${providerId}: ${(e as Error).message}`);
    }
  }

  private categoryLookup() {
    return {
      byId: async (id: string) => (await this.db.query<{ id: string }>(`SELECT id FROM categories WHERE id=$1 AND is_active`, [id])).rows[0] ?? null,
      bySlug: async (slug: string) => (await this.db.query<{ id: string }>(`SELECT id FROM categories WHERE slug=$1 AND is_active`, [slug])).rows[0] ?? null,
    };
  }

  /** Resumable onboarding wizard (OpenAPI upsertOnboardingStep).
   *  Body: {step: identity|business|service_area|payout, data: {...}}.
   *  Phase 1 verification is MANUAL review by a human officer only. */
  async onboarding(userId: string, step: string, data: Record<string, unknown>) {
    if (data.cnic && !isValidCnic(String(data.cnic))) throw Errors.badRequest('INVALID_CNIC', 'CNIC must be 13 digits (xxxxx-xxxxxxx-x)');
    const lat = typeof data.lat === 'number' ? data.lat : 30.1798;
    const lng = typeof data.lng === 'number' ? data.lng : 66.975;
    const profileId = await this.db.withTransaction(async (c) => {
      const existing = (await c.query(`SELECT id FROM provider_profiles WHERE user_id=$1`, [userId])).rows[0];
      const hmac = data.cnic ? cnicHmac(String(data.cnic)) : null;
      // FIX 4: real field-level encryption (AES-256-GCM), never plain base64.
      const payout = data.payout_account ? encryptField(String(data.payout_account)) : null;
      let pid: string;
      if (!existing) {
        const r = await c.query(
          `INSERT INTO provider_profiles (user_id, provider_type, display_name, shop_name, cnic_encrypted, cnic_hmac, bio, experience_years, languages, base_point, payout_method, payout_account_encrypted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ST_SetSRID(ST_MakePoint($10,$11),4326)::geography,$12,$13) RETURNING id`,
          [userId, data.provider_type ?? 'INDIVIDUAL', data.display_name ?? 'Provider', data.shop_name ?? null,
           data.cnic ? encryptField(String(data.cnic)) : null, hmac, data.bio ?? null,
           data.experience_years ?? null, data.languages ?? null, lng, lat, data.payout_method ?? null, payout]);
        pid = r.rows[0].id;
        await c.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name='provider' ON CONFLICT DO NOTHING`, [userId]);
        if (data.service_radius_km) {
          await c.query(`INSERT INTO provider_service_areas (provider_id, center, radius_km) VALUES ($1, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, $4)`,
            [pid, lng, lat, data.service_radius_km]);
        }
        if (Array.isArray(data.category_ids)) {
          for (const catId of data.category_ids as string[]) {
            await c.query(`INSERT INTO provider_services (provider_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [pid, catId]);
          }
        }
      } else {
        pid = existing.id;
        await c.query(
          `UPDATE provider_profiles SET provider_type=COALESCE($2,provider_type), display_name=COALESCE($3,display_name), shop_name=COALESCE($4,shop_name),
           cnic_encrypted=COALESCE($5,cnic_encrypted), cnic_hmac=COALESCE($6,cnic_hmac), bio=COALESCE($7,bio),
           experience_years=COALESCE($8,experience_years), languages=COALESCE($9,languages),
           payout_method=COALESCE($10,payout_method), payout_account_encrypted=COALESCE($11,payout_account_encrypted), updated_at=now() WHERE id=$1`,
          [pid, data.provider_type ?? null, data.display_name ?? null, data.shop_name ?? null,
           data.cnic ? encryptField(String(data.cnic)) : null, hmac, data.bio ?? null,
           data.experience_years ?? null, data.languages ?? null, data.payout_method ?? null, payout]);
      }
      return pid;
    });
    // Wizard state: which steps have data, and the manual-review status.
    const p = (await this.db.query<{ tier: number; display_name: string; shop_name: string; cnic_hmac: string | null; payout_method: string | null }>(
      `SELECT tier, display_name, shop_name, cnic_hmac, payout_method FROM provider_profiles WHERE id=$1`, [profileId])).rows[0];
    const docs = (await this.db.query<{ review_status: string }>(`SELECT review_status FROM provider_documents WHERE provider_id=$1`, [profileId])).rows;
    const completed_steps: string[] = [];
    if (p.cnic_hmac || p.display_name) completed_steps.push('identity');
    if (p.shop_name) completed_steps.push('business');
    const area = (await this.db.query(`SELECT 1 FROM provider_service_areas WHERE provider_id=$1 LIMIT 1`, [profileId])).rows[0];
    if (area) completed_steps.push('service_area');
    if (p.payout_method) completed_steps.push('payout');
    if (!completed_steps.includes(step)) completed_steps.push(step);
    const review_status = p.tier >= 1 ? 'approved' : docs.some((d) => d.review_status === 'rejected') ? 'rejected' : docs.length ? 'pending' : 'not_submitted';
    // Phase 4, item 1: profile writes change search results.
    await this.invalidateSearchProvider(profileId);
    return { provider_id: profileId, completed_steps, review_status };
  }

  /** Document upload request (OpenAPI requestDocumentUpload). Records the
   *  document row as pending for MANUAL human review and returns a
   *  short-lived upload URL. Upload target: STORAGE_UPLOAD_BASE_URL when
   *  configured (S3-compatible presigned upload in production); otherwise
   *  the local dev receiver PUT /api/v1/uploads/:key (dev only). */
  async requestDocumentUpload(userId: string, docType: string) {
    if (!(DOC_TYPES as readonly string[]).includes(docType)) throw Errors.badRequest('INVALID_DOC_TYPE', `doc_type must be one of ${DOC_TYPES.join(', ')}`);
    const profile = (await this.db.query<{ id: string }>(`SELECT id FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
    if (!profile) throw Errors.badRequest('NO_PROVIDER_PROFILE', 'Complete onboarding step 1 before uploading documents');
    const storageKey = `providers/${profile.id}/${docType}-${randomUUID()}.bin`;
    await this.db.query(
      `INSERT INTO provider_documents (provider_id, doc_type, storage_key, review_status) VALUES ($1,$2,$3,'pending')`,
      [profile.id, docType, storageKey]);
    const base = process.env.STORAGE_UPLOAD_BASE_URL ?? 'http://localhost:3000/api/v1/uploads';
    return { upload_url: `${base}/${encodeURIComponent(storageKey)}`, storage_key: storageKey };
  }

  /** Ranked nearby providers (OpenAPI nearbyProviders). Returns the v1.2
   *  ProviderPage envelope {items, next_cursor}. The list is ranked in
   *  memory (rank_score), so the cursor is an opaque offset token — see
   *  common/utils/pagination. Default limit 20, max 50 (DB fetch cap).
   *  FIX 11 (Stage 3): is_open_now is computed per provider from their
   *  availability rows in Asia/Karachi (isOpenNow) — NOT is_online: a
   *  provider on holiday who leaves the app on must not be shown as open.
   *  The old SQL open-now filter compared CURRENT_TIME in the DB server's
   *  timezone and could never match overnight slots, so it is gone; the
   *  open_now query flag is applied in memory after computing isOpenNow.
   *  fairTypicalPkr is the real fair-price typical for the filtered
   *  category (hidden when the sample is too small), not a hard-coded null. */
  async nearby(q: NearbyQuery & { cursor?: string; limit?: number }) {
    const radiusKm = q.radius_km ?? 5;
    const lim = Math.min(Math.max(q.limit ?? 20, 1), 50);
    const categoryId = q.category_id || q.category_slug
      ? await resolveCategoryId(this.categoryLookup(), { category_id: q.category_id, category_slug: q.category_slug })
      : null;
    const rows = (await this.db.query<{
      id: string; user_id: string; display_name: string; provider_type: string; tier: number; rating_avg: string; jobs_completed: number;
      completion_rate: string | null; response_seconds_avg: number | null; is_online: boolean; distance_km: number; starting_price: string | null;
    }>(`
      SELECT p.id, p.user_id, p.display_name, p.provider_type, p.tier, p.rating_avg, p.jobs_completed, p.completion_rate,
             p.response_seconds_avg, p.is_online,
             ST_Distance(p.base_point, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography)/1000 AS distance_km,
             (SELECT MIN(starting_price) FROM provider_services WHERE provider_id=p.id AND is_active) AS starting_price
      FROM provider_profiles p
      WHERE p.deleted_at IS NULL AND ST_DWithin(p.base_point, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3*1000)
        AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM provider_services ps WHERE ps.provider_id=p.id AND ps.category_id=$4 AND ps.is_active))
        AND ($5::boolean IS NOT TRUE OR p.tier >= 1)
      ORDER BY distance_km ASC LIMIT 50`,
      [q.lat, q.lng, radiusKm, categoryId, q.verified_only ?? false])).rows;
    // Availability rows for the candidates, computed once in Karachi time.
    const now = new Date();
    const avail = new Map<string, AvailabilitySlot[]>();
    if (rows.length) {
      const arows = (await this.db.query<{ provider_id: string; weekday: number; opens: string | null; closes: string | null; is_day_off: boolean }>(
        `SELECT provider_id, weekday, opens, closes, is_day_off FROM provider_availability WHERE provider_id = ANY($1::uuid[])`,
        [rows.map((r) => r.id)])).rows;
      for (const a of arows) {
        const list = avail.get(a.provider_id) ?? [];
        list.push({ weekday: Number(a.weekday), opens: a.opens, closes: a.closes, is_day_off: a.is_day_off });
        avail.set(a.provider_id, list);
      }
    }
    // Fair-price typical for the filtered category (null when no category
    // filter or the sample is too small to publish — see fair-range.ts).
    let fairTypicalPkr: number | null = null;
    if (categoryId) {
      const prices = (await this.db.query<{ final_price: string }>(
        `SELECT j.final_price FROM jobs j JOIN service_requests r ON r.id=j.request_id
         WHERE r.category_id=$1 AND j.final_price IS NOT NULL AND j.state IN ('COMPLETED','PAYMENT_SETTLED','RATED')`,
        [categoryId])).rows.map((r) => Number(r.final_price));
      const range = fairRangeFromPrices(prices);
      fairTypicalPkr = range.hidden ? null : range.typical;
    }
    // Phase 3: risk penalty + featured placement for the candidates
    // (≤50 rows). rankingPenaltyForUser reads the STORED score only —
    // recomputeScore is never called in a search request. A failure in
    // either lookup degrades to "no penalty / not sponsored" rather than
    // breaking search. Blocking is deliberately NOT applied here: a
    // high-risk provider sinks in ranking but is never silently hidden.
    const riskScores = new Map<string, number>();
    const featured = new Map<string, boolean>();
    if (rows.length) {
      await Promise.all(rows.map(async (r) => {
        let riskScore = 0;
        try {
          if (this.risk) riskScore = (await this.risk.rankingPenaltyForUser(r.user_id)).score;
        } catch { riskScore = 0; }
        riskScores.set(r.id, riskScore);
        let sponsored = false;
        try {
          if (this.subscriptions) sponsored = (await this.subscriptions.isProviderFeatured(r.id)).sponsored;
        } catch { sponsored = false; }
        featured.set(r.id, sponsored);
      }));
    }
    const ranked = rows.map((r) => {
      const openNow = isOpenNow(avail.get(r.id) ?? [], now);
      const score = applyRiskPenaltyToRankScore(rankScore({
        distanceKm: Number(r.distance_km), maxRadiusKm: radiusKm,
        ratingAvg: Number(r.rating_avg), jobsCompleted: r.jobs_completed,
        responseSecondsAvg: r.response_seconds_avg, completionRate: r.completion_rate ? Number(r.completion_rate) : null,
        tier: r.tier, startingPricePkr: r.starting_price ? Number(r.starting_price) : null, fairTypicalPkr,
        isOnline: r.is_online, isOpenNow: openNow, cancellations: 0, noShows: 0, upheldDisputes: 0,
      }), riskScores.get(r.id) ?? 0);
      return {
        id: r.id, display_name: r.display_name, provider_type: r.provider_type, tier: r.tier,
        rating_bayes: bayesianRating(Number(r.rating_avg), r.jobs_completed),
        jobs_completed: r.jobs_completed, distance_km: Number(Number(r.distance_km).toFixed(2)),
        eta_minutes: etaMinutes(Number(r.distance_km)), is_open_now: openNow,
        starting_price: r.starting_price ? Number(r.starting_price) : null, sponsored: featured.get(r.id) ?? false,
        rank_score: Number(score.toFixed(4)),
      };
    }).filter((r) => !q.open_now || r.is_open_now).sort((a, b) => b.rank_score - a.rank_score);
    return offsetPage(ranked, q.cursor, lim);
  }

  async getById(id: string) {
    const p = (await this.db.query(`SELECT * FROM provider_profiles WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!p) throw Errors.notFound('Provider');
    const services = (await this.db.query(`SELECT c.id, c.slug, c.name_en, ps.starting_price FROM provider_services ps JOIN categories c ON c.id=ps.category_id WHERE ps.provider_id=$1 AND ps.is_active`, [id])).rows;
    const reviews = (await this.db.query(`SELECT stars, comment, photos, created_at FROM reviews WHERE reviewee_id=(SELECT user_id FROM provider_profiles WHERE id=$1) AND NOT is_held ORDER BY created_at DESC LIMIT 20`, [id])).rows;
    // FIX 11: same computed open-now as nearby() — is_online alone is not
    // "open" (holiday with the app left on).
    const arows = (await this.db.query<{ weekday: number; opens: string | null; closes: string | null; is_day_off: boolean }>(
      `SELECT weekday, opens, closes, is_day_off FROM provider_availability WHERE provider_id=$1`, [id])).rows;
    const openNow = isOpenNow(arows.map((a) => ({ weekday: Number(a.weekday), opens: a.opens, closes: a.closes, is_day_off: a.is_day_off })));
    // Phase 3: featured ("Sponsored") placement — always labelled
    // "Sponsored" by the client when sponsored is true, never organic.
    let sponsored = false;
    try {
      if (this.subscriptions) sponsored = (await this.subscriptions.isProviderFeatured(id)).sponsored;
    } catch { sponsored = false; }
    return {
      id: p.id, display_name: p.display_name, provider_type: p.provider_type, tier: p.tier,
      rating_bayes: bayesianRating(Number(p.rating_avg), p.jobs_completed), jobs_completed: p.jobs_completed,
      distance_km: null, eta_minutes: null, is_open_now: openNow,
      starting_price: services[0]?.starting_price ? Number(services[0].starting_price) : null, sponsored,
      services, reviews,
    };
  }

  async setOnline(userId: string, isOnline: boolean, lat?: number, lng?: number) {
    const rows = (await this.db.query(`UPDATE provider_profiles SET is_online=$2, updated_at=now() WHERE user_id=$1 RETURNING id`, [userId, isOnline])).rows;
    if (!rows[0]) throw Errors.notFound('Provider profile');
    if (lat != null && lng != null) await this.redis.geoAdd('providers:online:geo', lng, lat, rows[0].id);
    // Phase 4, item 1: online status changes search results.
    await this.invalidateSearchProvider(rows[0].id);
    return { provider_id: rows[0].id, is_online: isOnline };
  }

  // ---- Phase 2: own services / service area / availability / reviews ----

  private async myProfileId(userId: string): Promise<string> {
    const row = (await this.db.query<{ id: string }>(`SELECT id FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
    if (!row) throw Errors.forbidden('No provider profile for this account');
    return row.id;
  }

  /** Audited decrypt — the ONLY way a plaintext CNIC / payout account leaves
   *  the DB. Every call writes an audit_logs row (action `field.decrypt:<field>`);
   *  the plaintext itself is NEVER written to audit_logs or any log.
   *  Callers: AdminService.verificationDetail (CNIC, verification officers
   *  only) and the payout flow (payout account). Throws on legacy base64
   *  values and on tampered ciphertext — never returns garbage. */
  async decryptProviderField(actorId: string, providerId: string, field: 'cnic' | 'payout_account'): Promise<string | null> {
    const column = field === 'cnic' ? 'cnic_encrypted' : 'payout_account_encrypted';
    const row = (await this.db.query<{ v: string | null }>(
      `SELECT ${column} AS v FROM provider_profiles WHERE id=$1`, [providerId])).rows[0];
    if (!row || !row.v) return null;
    const plaintext = decryptField(row.v);
    await this.db.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,'provider_profiles',$3,$4,$5)`,
      [actorId, `field.decrypt:${field}`, providerId, null, JSON.stringify({ field })]);
    return plaintext;
  }

  /** Payout-code entry point: the decrypted payout destination for a provider.
   *  Audited via decryptProviderField. Live payouts are not built yet (Phase 2
   *  gateways are sandbox mocks), so no production code calls this today — it
   *  is the single place the future live payout code must use. */
  async getPayoutDestination(actorId: string, providerId: string): Promise<string | null> {
    return this.decryptProviderField(actorId, providerId, 'payout_account');
  }

  async getMyServices(userId: string) {
    const pid = await this.myProfileId(userId);
    const rows = (await this.db.query(
      `SELECT ps.category_id, c.slug, c.name_en, ps.starting_price, ps.is_active FROM provider_services ps
        JOIN categories c ON c.id=ps.category_id WHERE ps.provider_id=$1 ORDER BY c.sort_order`, [pid])).rows;
    return rows.map((r) => ({ category_id: r.category_id, slug: r.slug, name_en: r.name_en, starting_price: r.starting_price != null ? Number(r.starting_price) : null, is_active: r.is_active }));
  }

  /** Replace the provider's offered categories: upsert the listed ones and
   *  deactivate any previously offered category not in the list. */
  async updateMyServices(userId: string, services: { category_id?: string; category_slug?: string; starting_price?: number; is_active?: boolean }[]) {
    if (!Array.isArray(services) || services.length > 50) throw Errors.unprocessable('INVALID_SERVICES', 'services must be an array of at most 50 entries');
    const pid = await this.myProfileId(userId);
    const kept: string[] = [];
    for (const s of services) {
      const categoryId = await resolveCategoryId(this.categoryLookup(), { category_id: s.category_id, category_slug: s.category_slug });
      if (s.starting_price != null && !(s.starting_price > 0)) throw Errors.unprocessable('INVALID_STARTING_PRICE', 'starting_price must be > 0');
      await this.db.query(
        `INSERT INTO provider_services (provider_id, category_id, starting_price, is_active) VALUES ($1,$2,$3,$4)
         ON CONFLICT (provider_id, category_id) DO UPDATE SET starting_price=EXCLUDED.starting_price, is_active=EXCLUDED.is_active`,
        [pid, categoryId, s.starting_price ?? null, s.is_active ?? true]);
      kept.push(categoryId);
    }
    if (kept.length) {
      await this.db.query(`UPDATE provider_services SET is_active=false WHERE provider_id=$1 AND NOT (category_id = ANY($2::uuid[]))`, [pid, kept]);
    } else {
      await this.db.query(`UPDATE provider_services SET is_active=false WHERE provider_id=$1`, [pid]);
    }
    // Phase 4, item 1: service add/remove changes search results.
    await this.invalidateSearchProvider(pid);
    return this.getMyServices(userId);
  }

  /** Set the service area as a radius OR a polygon — exactly one, else 422
   *  (OpenAPI ServiceAreaInput). Replaces the provider's previous area. */
  async updateServiceArea(userId: string, dto: { center?: { lat: number; lng: number }; radius_km?: number; polygon?: Record<string, unknown> }) {
    const pid = await this.myProfileId(userId);
    const hasRadius = dto.center != null || dto.radius_km != null;
    const hasPolygon = dto.polygon != null;
    if (hasRadius === hasPolygon) {
      throw Errors.unprocessable('VALIDATION_FAILED', 'Provide exactly one of center+radius_km or polygon');
    }
    let row: Record<string, unknown>;
    if (hasRadius) {
      const { lat, lng } = dto.center ?? {};
      if (typeof lat !== 'number' || lat < -90 || lat > 90 || typeof lng !== 'number' || lng < -180 || lng > 180) {
        throw Errors.unprocessable('VALIDATION_FAILED', 'center.lat must be -90..90 and center.lng -180..180');
      }
      if (typeof dto.radius_km !== 'number' || dto.radius_km <= 0 || dto.radius_km > 100) {
        throw Errors.unprocessable('VALIDATION_FAILED', 'radius_km must be > 0 and <= 100');
      }
      await this.db.query(`DELETE FROM provider_service_areas WHERE provider_id=$1`, [pid]);
      row = (await this.db.query(
        `INSERT INTO provider_service_areas (provider_id, center, radius_km)
         VALUES ($1, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography, $4) RETURNING *`,
        [pid, lat, lng, dto.radius_km])).rows[0];
      // Phase 4, item 1: service area changes search results.
      await this.invalidateSearchProvider(pid);
      return { provider_id: pid, center: { lat, lng }, radius_km: Number(row.radius_km), polygon: null, updated_at: new Date().toISOString() };
    }
    const polygon = dto.polygon as { type?: string; coordinates?: unknown };
    if (polygon.type !== 'Polygon' || !Array.isArray(polygon.coordinates) || !Array.isArray(polygon.coordinates[0]) || polygon.coordinates[0].length < 4) {
      throw Errors.unprocessable('VALIDATION_FAILED', 'polygon must be a GeoJSON Polygon with a ring of at least 4 positions');
    }
    const ring = polygon.coordinates[0] as unknown[];
    const first = ring[0] as number[];
    const last = ring[ring.length - 1] as number[];
    if (!Array.isArray(first) || !Array.isArray(last) || first[0] !== last[0] || first[1] !== last[1]) {
      throw Errors.unprocessable('VALIDATION_FAILED', 'polygon ring must be closed (first position equals last)');
    }
    for (const pos of ring) {
      const p = pos as number[];
      if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number' || p[1] < -90 || p[1] > 90 || p[0] < -180 || p[0] > 180) {
        throw Errors.unprocessable('VALIDATION_FAILED', 'polygon positions must be [lng, lat] numbers in range');
      }
    }
    await this.db.query(`DELETE FROM provider_service_areas WHERE provider_id=$1`, [pid]);
    row = (await this.db.query(
      `INSERT INTO provider_service_areas (provider_id, polygon)
       VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2),4326)::geography) RETURNING *`,
      [pid, JSON.stringify(polygon)])).rows[0];
    // Phase 4, item 1: service area changes search results.
    await this.invalidateSearchProvider(pid);
    return { provider_id: pid, center: null, radius_km: null, polygon, updated_at: new Date().toISOString() };
  }

  /** Set weekly working hours (one slot per weekday, upsert). Weekday follows
   *  the v1.2 contract: 0=Monday .. 6=Sunday. Weekday numbering for the whole
   *  repo is documented in ONE place — src/common/utils/availability.ts —
   *  which also owns the conversion from Postgres DOW (0=Sunday, used by
   *  recurring jobs only). The nearby open-now check computes isOpenNow
   *  from these rows in Asia/Karachi; it does not read this table in SQL. */
  async updateAvailability(userId: string, slots: { weekday: number; opens?: string | null; closes?: string | null; is_day_off?: boolean }[]) {
    if (!Array.isArray(slots) || slots.length > 7) throw Errors.unprocessable('INVALID_SLOTS', 'slots must be an array of at most 7 entries');
    const pid = await this.myProfileId(userId);
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    const seen = new Set<number>();
    for (const s of slots) {
      if (!Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) throw Errors.unprocessable('INVALID_WEEKDAY', 'weekday must be 0..6 (0=Monday)');
      if (seen.has(s.weekday)) throw Errors.unprocessable('DUPLICATE_WEEKDAY', `weekday ${s.weekday} appears twice`);
      seen.add(s.weekday);
      if (!s.is_day_off) {
        if (!s.opens || !timeRe.test(s.opens) || !s.closes || !timeRe.test(s.closes)) {
          throw Errors.unprocessable('INVALID_SLOT_TIME', 'opens/closes must be HH:MM unless is_day_off is true');
        }
      }
      await this.db.query(
        `INSERT INTO provider_availability (provider_id, weekday, opens, closes, is_day_off) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (provider_id, weekday) DO UPDATE SET opens=EXCLUDED.opens, closes=EXCLUDED.closes, is_day_off=EXCLUDED.is_day_off`,
        [pid, s.weekday, s.is_day_off ? null : s.opens, s.is_day_off ? null : s.closes, !!s.is_day_off]);
    }
    return (await this.db.query(
      `SELECT weekday, opens, closes, is_day_off FROM provider_availability WHERE provider_id=$1 ORDER BY weekday`, [pid])).rows;
  }

  /** Paginated public reviews for a provider (OpenAPI ReviewPage). */
  async listReviews(providerId: string, cursor?: string, limit = 20) {
    const lim = Math.min(Math.max(limit || 20, 1), 100);
    const profile = (await this.db.query<{ user_id: string }>(`SELECT user_id FROM provider_profiles WHERE id=$1 AND deleted_at IS NULL`, [providerId])).rows[0];
    if (!profile) throw Errors.notFound('Provider');
    const rows = (await this.db.query(
      `SELECT r.id, r.job_id, u.full_name AS reviewer_name, r.stars, r.comment, r.tags, r.photos, r.created_at
       FROM reviews r JOIN users u ON u.id=r.reviewer_id
       WHERE r.reviewee_id=$1 AND NOT r.is_held
         AND ($2::text IS NULL OR (r.created_at, r.id) < (SELECT created_at, id FROM reviews WHERE id=$2::uuid))
       ORDER BY r.created_at DESC, r.id DESC LIMIT $3`,
      [profile.user_id, cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return { items: page.map((r) => ({ ...r, photos: (r as Record<string, unknown>).photos ?? [] })), next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }
}
