// Analytics warehouse — ETL + dashboards + CSV exports (Phase 4, item 2).
// PRD v1.1 Phase 4 line: "analytics warehouse"; monthly statements and
// tax-ready exports are generated from the ledger, designed for
// FBR/PRA/SRB reporting subject to legal review (p.32).
//
// ETL (runEtl): reads ONLY from operational tables and upserts into the
// `analytics_*` warehouse tables (db/0017). Grain is one row per source
// entity keyed by the source id, so re-running the same day is idempotent:
// INSERT ... ON CONFLICT DO UPDATE never duplicates a fact row. Each run
// appends one analytics_etl_runs row carrying reconciliation counts
// (operational vs warehouse) — a mismatch is reported, not hidden.
//
// SCHEDULING: no cron/scheduler service exists in this repo, so there is
// no in-process schedule. The operator runs it nightly from an external
// scheduler — see docs/phase4-analytics.md for the cron line:
//   0 2 * * * curl -X POST https://<host>/api/v1/admin/analytics/etl/run
// On-demand runs use the same endpoint; GET .../etl/status is the
// latest run (same pattern as POST /admin/reconciliation/run).
//
// Dashboards read the WAREHOUSE facts only, never operational tables, so
// a heavy admin query cannot slow down booking. Date filters default to
// the last 30 days. Money here is PKR as stored on jobs/payments; the
// double-entry ledger (paisa) remains the system of record for money.
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { ANALYTICS_CSV_DISCLAIMER, funnelRates, toCsvExport } from './analytics-csv';

export interface EtlRunReport {
  id: string;
  run_date: string;
  started_at: string;
  finished_at: string;
  status: 'completed' | 'failed';
  triggered_by: string;
  counts: Record<string, number>;
  reconciliation: Record<string, { operational: number; warehouse: number; match: boolean }>;
  error?: string | null;
}

export interface Funnel {
  requests: number;
  withOffers: number;
  accepted: number;
  completed: number;
  rated: number;
  offerRate: number;
  fillRate: number;
  completionRate: number;
  ratingRate: number;
  medianTimeToFirstOfferSeconds: number | null;
}

export interface RevenueRow {
  key: string;
  label: string;
  jobs: number;
  completedJobs: number;
  revenuePkr: number;
  commissionPkr: number;
}

export interface SupplyDemand {
  demandByHour: { city: string; hour: number; requests: number; withOffers: number }[];
  supplyByCity: { city: string; providersTotal: number; providersOnline: number }[];
}

const COMPLETED_STATES = ['COMPLETED', 'PAYMENT_SETTLED', 'RATED'];

function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

@Injectable()
export class AnalyticsService {
  constructor(private db: DatabaseService) {}

  // ---- ETL ------------------------------------------------------------
  async runEtl(triggeredBy: 'manual' | 'nightly' = 'manual'): Promise<EtlRunReport> {
    const startedAt = new Date();
    try {
      const report = await this.db.withTransaction(async (c) => this.loadWarehouse(c, triggeredBy, startedAt));
      return report;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        const row = (await this.db.query<{ id: string }>(
          `INSERT INTO analytics_etl_runs (run_date, status, triggered_by, error, finished_at)
           VALUES (CURRENT_DATE, 'failed', $1, $2, now()) RETURNING id`,
          [triggeredBy, message],
        )).rows[0];
        return {
          id: row?.id ?? '', run_date: startedAt.toISOString().slice(0, 10),
          started_at: startedAt.toISOString(), finished_at: new Date().toISOString(),
          status: 'failed', triggered_by: triggeredBy, counts: {}, reconciliation: {}, error: message,
        };
      } catch {
        throw e;
      }
    }
  }

  private async loadWarehouse(c: PoolClient, triggeredBy: string, startedAt: Date): Promise<EtlRunReport> {
    // 1. Dimensions from operational reference data (upsert = idempotent).
    await c.query(`
      INSERT INTO analytics_dim_city (city_id, slug, name, is_launched, updated_at)
      SELECT id, slug, name, is_launched, now() FROM cities
      ON CONFLICT (city_id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name,
        is_launched = EXCLUDED.is_launched, updated_at = now()`);
    await c.query(`
      INSERT INTO analytics_dim_category (category_id, slug, name_en, level, parent_slug, updated_at)
      SELECT c.id, c.slug, c.name_en, c.level, p.slug, now()
        FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
      ON CONFLICT (category_id) DO UPDATE SET slug = EXCLUDED.slug, name_en = EXCLUDED.name_en,
        level = EXCLUDED.level, parent_slug = EXCLUDED.parent_slug, updated_at = now()`);
    await c.query(`
      INSERT INTO analytics_dim_zone (zone_id, city_id, name, updated_at)
      SELECT id, city_id, name, now() FROM zones
      ON CONFLICT (zone_id) DO UPDATE SET city_id = EXCLUDED.city_id, name = EXCLUDED.name, updated_at = now()`);
    await c.query(`
      INSERT INTO analytics_dim_provider_tier (tier, name, min_rating, min_jobs, updated_at)
      SELECT tier, name, min_rating, min_jobs, now() FROM provider_tiers
      ON CONFLICT (tier) DO UPDATE SET name = EXCLUDED.name, min_rating = EXCLUDED.min_rating,
        min_jobs = EXCLUDED.min_jobs, updated_at = now()`);
    // 2. Time dimension: every calendar day from the earliest source row to today.
    await c.query(`
      INSERT INTO analytics_dim_time (date, year, month, day, day_of_week, week_of_year, quarter)
      SELECT d::date, EXTRACT(YEAR FROM d)::smallint, EXTRACT(MONTH FROM d)::smallint,
             EXTRACT(DAY FROM d)::smallint, EXTRACT(DOW FROM d)::smallint,
             EXTRACT(WEEK FROM d)::smallint, EXTRACT(QUARTER FROM d)::smallint
        FROM generate_series(
          (SELECT COALESCE(MIN(DATE(created_at)), CURRENT_DATE) FROM service_requests),
          CURRENT_DATE, interval '1 day') AS d
      ON CONFLICT (date) DO NOTHING`);

    // 3. Fact: requests (one row per service_request; flags derived from
    //    offers / jobs / reviews so the funnel needs no joins at read time).
    const reqRes = await c.query(`
      INSERT INTO analytics_fact_requests
        (request_id, request_date, city_id, zone_id, category_id, customer_id, status,
         customer_offer_pkr, offers_count, first_offer_seconds, had_offer,
         is_accepted, is_completed, is_rated, created_at, etl_loaded_at)
      SELECT r.id, DATE(r.created_at),
        (SELECT ci.id FROM cities ci ORDER BY ST_Distance(r.location, ci.center) LIMIT 1),
        (SELECT z.id FROM zones z WHERE ST_Within(r.location::geometry, z.polygon::geometry) LIMIT 1),
        r.category_id, r.customer_id, r.status, r.customer_offer,
        (SELECT COUNT(*) FROM offers o WHERE o.request_id = r.id),
        (SELECT EXTRACT(EPOCH FROM (MIN(o.created_at) - r.created_at))::int FROM offers o WHERE o.request_id = r.id),
        EXISTS (SELECT 1 FROM offers o WHERE o.request_id = r.id),
        EXISTS (SELECT 1 FROM jobs j WHERE j.request_id = r.id),
        EXISTS (SELECT 1 FROM jobs j WHERE j.request_id = r.id AND j.state = ANY($1::varchar[])),
        EXISTS (SELECT 1 FROM jobs j JOIN reviews rv ON rv.job_id = j.id WHERE j.request_id = r.id),
        r.created_at, now()
      FROM service_requests r
      WHERE r.deleted_at IS NULL
      ON CONFLICT (request_id) DO UPDATE SET
        request_date = EXCLUDED.request_date, city_id = EXCLUDED.city_id,
        zone_id = EXCLUDED.zone_id, category_id = EXCLUDED.category_id,
        status = EXCLUDED.status, customer_offer_pkr = EXCLUDED.customer_offer_pkr,
        offers_count = EXCLUDED.offers_count, first_offer_seconds = EXCLUDED.first_offer_seconds,
        had_offer = EXCLUDED.had_offer, is_accepted = EXCLUDED.is_accepted,
        is_completed = EXCLUDED.is_completed, is_rated = EXCLUDED.is_rated,
        etl_loaded_at = now()`, [COMPLETED_STATES]);

    // 4. Fact: jobs (city/zone from the linked request's location).
    const jobsRes = await c.query(`
      INSERT INTO analytics_fact_jobs
        (job_id, request_id, job_date, city_id, zone_id, category_id, provider_id, provider_tier,
         state, agreed_price_pkr, final_price_pkr, commission_pkr, commission_rate,
         payment_method, payment_status, is_completed, is_rated, stars, created_at, completed_at, etl_loaded_at)
      SELECT j.id, j.request_id, DATE(j.created_at),
        (SELECT ci.id FROM cities ci ORDER BY ST_Distance(r.location, ci.center) LIMIT 1),
        (SELECT z.id FROM zones z WHERE ST_Within(r.location::geometry, z.polygon::geometry) LIMIT 1),
        r.category_id, j.provider_id, pp.tier, j.state, j.agreed_price, j.final_price,
        j.commission_amount, j.commission_rate, j.payment_method, j.payment_status,
        j.state = ANY($1::varchar[]),
        EXISTS (SELECT 1 FROM reviews rv WHERE rv.job_id = j.id),
        (SELECT rv.stars FROM reviews rv WHERE rv.job_id = j.id ORDER BY rv.created_at DESC LIMIT 1),
        j.created_at, j.completed_at, now()
      FROM jobs j
      JOIN service_requests r ON r.id = j.request_id
      JOIN provider_profiles pp ON pp.id = j.provider_id
      ON CONFLICT (job_id) DO UPDATE SET
        job_date = EXCLUDED.job_date, city_id = EXCLUDED.city_id, zone_id = EXCLUDED.zone_id,
        category_id = EXCLUDED.category_id, provider_tier = EXCLUDED.provider_tier,
        state = EXCLUDED.state, agreed_price_pkr = EXCLUDED.agreed_price_pkr,
        final_price_pkr = EXCLUDED.final_price_pkr, commission_pkr = EXCLUDED.commission_pkr,
        commission_rate = EXCLUDED.commission_rate, payment_method = EXCLUDED.payment_method,
        payment_status = EXCLUDED.payment_status, is_completed = EXCLUDED.is_completed,
        is_rated = EXCLUDED.is_rated, stars = EXCLUDED.stars,
        completed_at = EXCLUDED.completed_at, etl_loaded_at = now()`, [COMPLETED_STATES]);

    // 5. Fact: payments.
    const paysRes = await c.query(`
      INSERT INTO analytics_fact_payments
        (payment_id, payment_date, job_id, method, provider_name, amount_pkr, status, created_at, etl_loaded_at)
      SELECT id, DATE(created_at), job_id, method, provider_name, amount, status, created_at, now()
        FROM payments
      ON CONFLICT (payment_id) DO UPDATE SET
        payment_date = EXCLUDED.payment_date, method = EXCLUDED.method,
        provider_name = EXCLUDED.provider_name, amount_pkr = EXCLUDED.amount_pkr,
        status = EXCLUDED.status, etl_loaded_at = now()`);

    // 6. Fact: providers — daily snapshot keyed (provider_id, snapshot_date).
    const provsRes = await c.query(`
      INSERT INTO analytics_fact_providers
        (provider_id, snapshot_date, city_id, tier, rating_avg, jobs_completed,
         completion_rate, is_online, etl_loaded_at)
      SELECT pp.id, CURRENT_DATE,
        (SELECT ci.id FROM cities ci ORDER BY ST_Distance(pp.base_point, ci.center) LIMIT 1),
        pp.tier, pp.rating_avg, pp.jobs_completed, pp.completion_rate, pp.is_online, now()
      FROM provider_profiles pp WHERE pp.deleted_at IS NULL
      ON CONFLICT (provider_id, snapshot_date) DO UPDATE SET
        city_id = EXCLUDED.city_id, tier = EXCLUDED.tier, rating_avg = EXCLUDED.rating_avg,
        jobs_completed = EXCLUDED.jobs_completed, completion_rate = EXCLUDED.completion_rate,
        is_online = EXCLUDED.is_online, etl_loaded_at = now()`);

    // 7. Reconciliation: operational vs warehouse counts, same transaction.
    const recon = await this.reconcile(c);
    const counts: Record<string, number> = {
      requests: reqRes.rowCount ?? 0, jobs: jobsRes.rowCount ?? 0,
      payments: paysRes.rowCount ?? 0, providers: provsRes.rowCount ?? 0,
    };

    const finishedAt = new Date();
    const run = (await c.query<{ id: string }>(
      `INSERT INTO analytics_etl_runs (run_date, started_at, finished_at, status, triggered_by, counts, reconciliation)
       VALUES (CURRENT_DATE, $1, $2, 'completed', $3, $4::jsonb, $5::jsonb) RETURNING id`,
      [startedAt.toISOString(), finishedAt.toISOString(), triggeredBy,
       JSON.stringify(counts), JSON.stringify(recon)],
    )).rows[0];
    return {
      id: run.id, run_date: finishedAt.toISOString().slice(0, 10),
      started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(),
      status: 'completed', triggered_by: triggeredBy, counts, reconciliation: recon,
    };
  }

  /** Operational vs warehouse row counts. A mismatch means the ETL missed
   *  rows (or the warehouse holds rows whose source was hard-deleted) and
   *  must be investigated — it is surfaced on the run report, never hidden. */
  async reconcile(c: PoolClient): Promise<Record<string, { operational: number; warehouse: number; match: boolean }>> {
    const q = async (sql: string) => num((await c.query<{ cnt: string }>(sql)).rows[0]?.cnt);
    const op = {
      requests: await q(`SELECT COUNT(*)::text AS cnt FROM service_requests WHERE deleted_at IS NULL`),
      jobs: await q(`SELECT COUNT(*)::text AS cnt FROM jobs`),
      payments: await q(`SELECT COUNT(*)::text AS cnt FROM payments`),
      providers: await q(`SELECT COUNT(*)::text AS cnt FROM provider_profiles WHERE deleted_at IS NULL`),
    };
    const wh = {
      requests: await q(`SELECT COUNT(*)::text AS cnt FROM analytics_fact_requests`),
      jobs: await q(`SELECT COUNT(*)::text AS cnt FROM analytics_fact_jobs`),
      payments: await q(`SELECT COUNT(*)::text AS cnt FROM analytics_fact_payments`),
      // Providers are a daily snapshot: reconcile against the latest date only.
      providers: await q(`SELECT COUNT(DISTINCT provider_id)::text AS cnt FROM analytics_fact_providers
                           WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM analytics_fact_providers)`),
    };
    const out: Record<string, { operational: number; warehouse: number; match: boolean }> = {};
    for (const k of Object.keys(op) as (keyof typeof op)[]) {
      out[k] = { operational: op[k], warehouse: wh[k], match: op[k] === wh[k] };
    }
    return out;
  }

  async latestRun(): Promise<EtlRunReport | null> {
    const row = (await this.db.query<Record<string, unknown>>(
      `SELECT id, run_date, started_at, finished_at, status, triggered_by, counts, reconciliation, error
         FROM analytics_etl_runs ORDER BY started_at DESC LIMIT 1`,
    )).rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      run_date: String(row.run_date).slice(0, 10),
      started_at: new Date(String(row.started_at)).toISOString(),
      finished_at: row.finished_at ? new Date(String(row.finished_at)).toISOString() : '',
      status: row.status as 'completed' | 'failed',
      triggered_by: String(row.triggered_by),
      counts: (row.counts ?? {}) as Record<string, number>,
      reconciliation: (row.reconciliation ?? {}) as EtlRunReport['reconciliation'],
      error: (row.error as string | null) ?? null,
    };
  }

  // ---- Dashboards (warehouse facts only) ------------------------------
  private rangeClause(from?: string, to?: string, alias = 'request_date'): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    let sql = '';
    const f = from ?? new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const t = to ?? new Date().toISOString().slice(0, 10);
    sql += ` AND ${alias} >= $1 AND ${alias} <= $2`;
    params.push(f, t);
    return { sql, params };
  }

  async funnel(from?: string, to?: string): Promise<Funnel> {
    const { sql, params } = this.rangeClause(from, to);
    const row = (await this.db.query<Record<string, string>>(
      `SELECT COUNT(*)::text AS requests,
              COUNT(*) FILTER (WHERE had_offer)::text AS with_offers,
              COUNT(*) FILTER (WHERE is_accepted)::text AS accepted,
              COUNT(*) FILTER (WHERE is_completed)::text AS completed,
              COUNT(*) FILTER (WHERE is_rated)::text AS rated,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY first_offer_seconds)::text AS median_first_offer
         FROM analytics_fact_requests WHERE 1=1 ${sql}`,
      params,
    )).rows[0] ?? {};
    return {
      ...funnelRates({
        requests: num(row.requests), withOffers: num(row.with_offers),
        accepted: num(row.accepted), completed: num(row.completed), rated: num(row.rated),
      }),
      medianTimeToFirstOfferSeconds: row.median_first_offer === null || row.median_first_offer === undefined
        ? null : Math.round(num(row.median_first_offer)),
    };
  }

  async revenue(groupBy: 'city' | 'category', from?: string, to?: string): Promise<RevenueRow[]> {
    const { sql, params } = this.rangeClause(from, to, 'job_date');
    const dim = groupBy === 'city'
      ? `LEFT JOIN analytics_dim_city d ON d.city_id = f.city_id`
      : `LEFT JOIN analytics_dim_category d ON d.category_id = f.category_id`;
    const key = groupBy === 'city' ? 'COALESCE(f.city_id::text, \'unknown\')' : 'COALESCE(f.category_id::text, \'unknown\')';
    const label = groupBy === 'city' ? `COALESCE(d.name, 'Unknown city')` : `COALESCE(d.name_en, 'Unknown category')`;
    const rows = (await this.db.query<Record<string, string>>(
      `SELECT ${key} AS key, ${label} AS label,
              COUNT(*)::text AS jobs,
              COUNT(*) FILTER (WHERE is_completed)::text AS completed_jobs,
              COALESCE(SUM(COALESCE(final_price_pkr, agreed_price_pkr)), 0)::text AS revenue_pkr,
              COALESCE(SUM(commission_pkr), 0)::text AS commission_pkr
         FROM analytics_fact_jobs f ${dim} WHERE 1=1 ${sql}
        GROUP BY ${key}, ${label} ORDER BY revenue_pkr DESC`,
      params,
    )).rows;
    return rows.map((r) => ({
      key: String(r.key), label: String(r.label), jobs: num(r.jobs),
      completedJobs: num(r.completed_jobs), revenuePkr: num(r.revenue_pkr), commissionPkr: num(r.commission_pkr),
    }));
  }

  async supplyDemand(from?: string, to?: string): Promise<SupplyDemand> {
    const { sql, params } = this.rangeClause(from, to);
    const demand = (await this.db.query<Record<string, string>>(
      `SELECT COALESCE(dc.name, 'Unknown city') AS city,
              EXTRACT(HOUR FROM f.created_at)::int AS hour,
              COUNT(*)::text AS requests,
              COUNT(*) FILTER (WHERE had_offer)::text AS with_offers
         FROM analytics_fact_requests f
         LEFT JOIN analytics_dim_city dc ON dc.city_id = f.city_id
        WHERE 1=1 ${sql}
        GROUP BY dc.name, EXTRACT(HOUR FROM f.created_at)
        ORDER BY city, hour`,
      params,
    )).rows;
    const supply = (await this.db.query<Record<string, string>>(
      `SELECT COALESCE(dc.name, 'Unknown city') AS city,
              COUNT(DISTINCT provider_id)::text AS providers_total,
              COUNT(DISTINCT provider_id) FILTER (WHERE is_online)::text AS providers_online
         FROM analytics_fact_providers f
         LEFT JOIN analytics_dim_city dc ON dc.city_id = f.city_id
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM analytics_fact_providers)
        GROUP BY dc.name ORDER BY city`,
    )).rows;
    return {
      demandByHour: demand.map((r) => ({
        city: String(r.city), hour: num(r.hour), requests: num(r.requests), withOffers: num(r.with_offers),
      })),
      supplyByCity: supply.map((r) => ({
        city: String(r.city), providersTotal: num(r.providers_total), providersOnline: num(r.providers_online),
      })),
    };
  }

  // ---- CSV exports ------------------------------------------------------
  static readonly EXPORT_TABLES = [
    'fact_requests', 'fact_jobs', 'fact_payments', 'fact_providers',
    'revenue_by_city', 'revenue_by_category',
  ] as const;
  static readonly DISCLAIMER = ANALYTICS_CSV_DISCLAIMER;

  async exportCsv(table: string): Promise<{ filename: string; csv: string }> {
    const queries: Record<string, { sql: string; columns: string[] }> = {
      fact_requests: { sql: `SELECT request_id, request_date, city_id, zone_id, category_id, customer_id, status, customer_offer_pkr, offers_count, first_offer_seconds, had_offer, is_accepted, is_completed, is_rated, created_at FROM analytics_fact_requests ORDER BY created_at DESC`, columns: ['request_id', 'request_date', 'city_id', 'zone_id', 'category_id', 'customer_id', 'status', 'customer_offer_pkr', 'offers_count', 'first_offer_seconds', 'had_offer', 'is_accepted', 'is_completed', 'is_rated', 'created_at'] },
      fact_jobs: { sql: `SELECT job_id, request_id, job_date, city_id, zone_id, category_id, provider_id, provider_tier, state, agreed_price_pkr, final_price_pkr, commission_pkr, commission_rate, payment_method, payment_status, is_completed, is_rated, stars, created_at, completed_at FROM analytics_fact_jobs ORDER BY created_at DESC`, columns: ['job_id', 'request_id', 'job_date', 'city_id', 'zone_id', 'category_id', 'provider_id', 'provider_tier', 'state', 'agreed_price_pkr', 'final_price_pkr', 'commission_pkr', 'commission_rate', 'payment_method', 'payment_status', 'is_completed', 'is_rated', 'stars', 'created_at', 'completed_at'] },
      fact_payments: { sql: `SELECT payment_id, payment_date, job_id, method, provider_name, amount_pkr, status, created_at FROM analytics_fact_payments ORDER BY created_at DESC`, columns: ['payment_id', 'payment_date', 'job_id', 'method', 'provider_name', 'amount_pkr', 'status', 'created_at'] },
      fact_providers: { sql: `SELECT provider_id, snapshot_date, city_id, tier, rating_avg, jobs_completed, completion_rate, is_online FROM analytics_fact_providers ORDER BY snapshot_date DESC, provider_id`, columns: ['provider_id', 'snapshot_date', 'city_id', 'tier', 'rating_avg', 'jobs_completed', 'completion_rate', 'is_online'] },
      revenue_by_city: { sql: `SELECT COALESCE(dc.name, 'Unknown city') AS city, COUNT(*) AS jobs, COUNT(*) FILTER (WHERE is_completed) AS completed_jobs, COALESCE(SUM(COALESCE(final_price_pkr, agreed_price_pkr)), 0) AS revenue_pkr, COALESCE(SUM(commission_pkr), 0) AS commission_pkr FROM analytics_fact_jobs f LEFT JOIN analytics_dim_city dc ON dc.city_id = f.city_id GROUP BY dc.name ORDER BY revenue_pkr DESC`, columns: ['city', 'jobs', 'completed_jobs', 'revenue_pkr', 'commission_pkr'] },
      revenue_by_category: { sql: `SELECT COALESCE(dc.name_en, 'Unknown category') AS category, COUNT(*) AS jobs, COUNT(*) FILTER (WHERE is_completed) AS completed_jobs, COALESCE(SUM(COALESCE(final_price_pkr, agreed_price_pkr)), 0) AS revenue_pkr, COALESCE(SUM(commission_pkr), 0) AS commission_pkr FROM analytics_fact_jobs f LEFT JOIN analytics_dim_category dc ON dc.category_id = f.category_id GROUP BY dc.name_en ORDER BY revenue_pkr DESC`, columns: ['category', 'jobs', 'completed_jobs', 'revenue_pkr', 'commission_pkr'] },
    };
    const q = queries[table];
    if (!q) throw new Error(`unknown export table: ${table}`);
    const rows = (await this.db.query<Record<string, unknown>>(q.sql)).rows;
    return { filename: `near-service-analytics-${table}.csv`, csv: toCsvExport(rows, q.columns) };
  }
}
