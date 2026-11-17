// Analytics warehouse — integration tests (Phase 4, item 2). REAL Postgres
// 16 + PostGIS 3. Run with:
//   DATABASE_URL=<redacted>
//   REDIS_URL=redis://127.0.0.1:6379
//   NODE_ENV=test npm test -- analytics-warehouse
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0015 + 0017 ONLY (an explicit list — other
// Phase 4 items' migrations 0016/0018/0019/0020 are built in parallel and
// must not be pulled in here). Only ever point it at a dedicated test DB
// (nearservice_p4_analytics). Skipped entirely when DATABASE_URL
// or REDIS_URL is not set.
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { DatabaseService } from '../../src/database/database.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';

jest.setTimeout(60000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

maybeDescribe('Analytics warehouse (real DB)', () => {
  let dbSvc: DatabaseService;
  let svc: AnalyticsService;
  let admin: Client;
  let req1: string; let job1: string;

  const CAT_BOOK = '00000000-0000-4000-8000-0000b0000001'; // book-binding (seed 0004)
  const CAT_AC = '00000000-0000-4000-8000-0000b0000002'; // ac-repair (seed 0004)
  const CAT_ELEC = '00000000-0000-4000-8000-0000b0000003'; // electrician (seed 0004)
  const CAT_PLUMB = '00000000-0000-4000-8000-0000b0000004'; // plumber (seed 0004)

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    const files = [
      '0001_init.sql', '0002_requests_jobs.sql', '0003_money_trust.sql',
      '0004_seed.sql', '0005_phase2_payments.sql', '0006_phase2_ops.sql',
      '0007_revoke_refresh_families.sql', '0008_ledger_balance_guard.sql',
      '0009_stage3_fixes.sql', '0010_ai_gateway.sql', '0011_risk_engine.sql',
      '0012_subscriptions_teams.sql', '0013_tenders.sql', '0014_verification.sql',
      '0015_escrow_payouts.sql', '0017_analytics_warehouse.sql',
    ];
    for (const file of files) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    dbSvc = new DatabaseService();
    svc = new AnalyticsService(dbSvc);

    // Fixture: customer + provider (Quetta point), 4 requests with known
    // outcomes. created_at is fixed so date-range dashboards are exact.
    const customer = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ('+923009991111','Analytics Customer','ur') RETURNING id`)).rows[0].id;
    const providerUser = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ('+923009992222','Analytics Provider','ur') RETURNING id`)).rows[0].id;
    const provider = (await admin.query(
      `INSERT INTO provider_profiles (user_id, display_name, provider_type, tier, base_point, is_online)
       VALUES ($1,'Analytics Provider','individual',2,ST_SetSRID(ST_MakePoint(66.9750,30.1798),4326)::geography,true) RETURNING id`,
      [providerUser])).rows[0].id;
    const mkReq = async (cat: string, at: string, status: string, offer: number) =>
      (await admin.query(
        `INSERT INTO service_requests (customer_id, category_id, description, fulfillment, location, customer_offer, status, created_at)
         VALUES ($1,$2,'fixture','PROVIDER_COMES',ST_SetSRID(ST_MakePoint(66.9750,30.1798),4326)::geography,$3,$4,$5) RETURNING id`,
        [customer, cat, offer, status, at])).rows[0].id as string;
    const r1 = await mkReq(CAT_BOOK, '2026-11-10T10:00:00Z', 'ACCEPTED', 1500);
    const r2 = await mkReq(CAT_AC, '2026-11-10T11:00:00Z', 'OFFERS_RECEIVED', 2500);
    await mkReq(CAT_ELEC, '2026-11-10T12:00:00Z', 'BROADCASTING', 1000);
    const r4 = await mkReq(CAT_PLUMB, '2026-11-10T13:00:00Z', 'ACCEPTED', 900);
    req1 = r1;
    const mkOffer = async (req: string, at: string, price: number, status: string) =>
      (await admin.query(
        `INSERT INTO offers (request_id, provider_id, offered_by, price, status, expires_at, created_at)
         VALUES ($1,$2,'provider',$3,$4,now() + interval '1 hour',$5) RETURNING id`,
        [req, provider, price, status, at])).rows[0].id as string;
    const o1 = await mkOffer(r1, '2026-11-10T10:01:00Z', 1500, 'accepted'); // +60s
    await mkOffer(r2, '2026-11-10T11:05:00Z', 2700, 'pending'); // +300s
    const o4 = await mkOffer(r4, '2026-11-10T13:02:00Z', 900, 'accepted'); // +120s
    const mkJob = async (req: string, offer: string, state: string, price: number, commission: number, at: string) =>
      (await admin.query(
        `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price, commission_rate, commission_amount, state, payment_method, payment_status, completed_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$5,0.1000,$6,$7,'cash','unpaid',$8,$9) RETURNING id`,
        [req, offer, customer, provider, price, commission, state,
         ['COMPLETED', 'PAYMENT_SETTLED', 'RATED'].includes(state) ? at : null, at])).rows[0].id as string;
    job1 = await mkJob(r1, o1, 'COMPLETED', 1500, 150, '2026-11-10T10:30:00Z');
    await mkJob(r4, o4, 'IN_PROGRESS', 900, 90, '2026-11-10T13:10:00Z');
    await admin.query(
      `INSERT INTO reviews (job_id, reviewer_id, reviewee_id, stars) VALUES ($1,$2,$3,5)`,
      [job1, customer, providerUser]);
    await admin.query(
      `INSERT INTO payments (job_id, payer_id, method, provider_name, amount, status, created_at)
       VALUES ($1,$2,'cash','JazzCash',1500,'completed','2026-11-10T10:35:00Z')`,
      [job1, customer]);
  });

  afterAll(async () => {
    await dbSvc.onModuleDestroy();
    await admin.end();
  });

  it('migration 0017 tables exist', async () => {
    const rows = (await admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'analytics_%' ORDER BY 1`)).rows;
    expect(rows.map((r) => r.table_name)).toEqual([
      'analytics_dim_category', 'analytics_dim_city', 'analytics_dim_provider_tier',
      'analytics_dim_time', 'analytics_dim_zone', 'analytics_etl_runs',
      'analytics_fact_jobs', 'analytics_fact_payments', 'analytics_fact_providers',
      'analytics_fact_requests',
    ]);
  });

  it('ETL loads the fixture request with exact funnel flags and timings', async () => {
    const run = await svc.runEtl('manual');
    expect(run.status).toBe('completed');
    const row = (await admin.query(
      `SELECT * FROM analytics_fact_requests WHERE request_id = $1`, [req1])).rows[0];
    expect(row).toBeDefined();
    expect(row.category_id).toBe(CAT_BOOK);
    expect(row.request_date.toISOString().slice(0, 10)).toBe('2026-11-10');
    expect(row.offers_count).toBe(1);
    expect(row.first_offer_seconds).toBe(60);
    expect(row.had_offer).toBe(true);
    expect(row.is_accepted).toBe(true);
    expect(row.is_completed).toBe(true);
    expect(row.is_rated).toBe(true);
    // City derived from the Quetta point.
    const city = (await admin.query(`SELECT name FROM analytics_dim_city WHERE city_id = $1`, [row.city_id])).rows[0];
    expect(city.name).toBe('Quetta');
    const job = (await admin.query(`SELECT * FROM analytics_fact_jobs WHERE job_id = $1`, [job1])).rows[0];
    expect(Number(job.final_price_pkr)).toBe(1500);
    expect(Number(job.commission_pkr)).toBe(150);
    expect(job.stars).toBe(5);
    expect(job.is_completed).toBe(true);
  });

  it('ETL is idempotent: a second run duplicates no fact rows', async () => {
    const before = (await admin.query(
      `SELECT (SELECT COUNT(*) FROM analytics_fact_requests) AS r,
              (SELECT COUNT(*) FROM analytics_fact_jobs) AS j,
              (SELECT COUNT(*) FROM analytics_fact_payments) AS p,
              (SELECT COUNT(*) FROM analytics_fact_providers) AS pv`)).rows[0];
    const run2 = await svc.runEtl('manual');
    expect(run2.status).toBe('completed');
    const after = (await admin.query(
      `SELECT (SELECT COUNT(*) FROM analytics_fact_requests) AS r,
              (SELECT COUNT(*) FROM analytics_fact_jobs) AS j,
              (SELECT COUNT(*) FROM analytics_fact_payments) AS p,
              (SELECT COUNT(*) FROM analytics_fact_providers) AS pv`)).rows[0];
    expect(after).toEqual(before);
    const runs = Number((await admin.query(`SELECT COUNT(*)::text AS c FROM analytics_etl_runs`)).rows[0].c);
    expect(runs).toBe(2); // the run log appends; the facts do not duplicate
  });

  it('reconciliation matches operational counts on every entity', async () => {
    const run = await svc.latestRun();
    expect(run).not.toBeNull();
    for (const key of ['requests', 'jobs', 'payments', 'providers']) {
      expect(run!.reconciliation[key].match).toBe(true);
      expect(run!.reconciliation[key].operational).toBeGreaterThan(0);
      expect(run!.reconciliation[key].warehouse).toBe(run!.reconciliation[key].operational);
    }
  });

  it('funnel aggregates match the operational data over the fixture window', async () => {
    const f = await svc.funnel('2026-01-01', '2026-12-31');
    const op = (await admin.query(
      `SELECT COUNT(*)::int AS requests,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM offers o WHERE o.request_id = r.id))::int AS with_offers,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.request_id = r.id))::int AS accepted,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.request_id = r.id AND j.state IN ('COMPLETED','PAYMENT_SETTLED','RATED')))::int AS completed,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM jobs j JOIN reviews rv ON rv.job_id = j.id WHERE j.request_id = r.id))::int AS rated
         FROM service_requests r WHERE r.deleted_at IS NULL`)).rows[0];
    expect(f.requests).toBe(op.requests);
    expect(f.withOffers).toBe(op.with_offers);
    expect(f.accepted).toBe(op.accepted);
    expect(f.completed).toBe(op.completed);
    expect(f.rated).toBe(op.rated);
    expect(f.fillRate).toBeCloseTo(op.accepted / op.requests);
    expect(f.medianTimeToFirstOfferSeconds).not.toBeNull();
    expect(f.medianTimeToFirstOfferSeconds!).toBeGreaterThanOrEqual(0);
  });

  it('revenue by category carries the fixture job (book-binding PKR 1,500 / commission 150)', async () => {
    const rows = await svc.revenue('category', '2026-01-01', '2026-12-31');
    const book = rows.find((r) => r.label === 'Book Binding');
    expect(book).toBeDefined();
    expect(book!.revenuePkr).toBeGreaterThanOrEqual(1500);
    expect(book!.commissionPkr).toBeGreaterThanOrEqual(150);
    const byCity = await svc.revenue('city', '2026-01-01', '2026-12-31');
    expect(byCity.find((r) => r.label === 'Quetta')).toBeDefined();
  });

  it('supply vs demand shows fixture demand hours and the online provider', async () => {
    const sd = await svc.supplyDemand('2026-01-01', '2026-12-31');
    const quettaHours = sd.demandByHour.filter((d) => d.city === 'Quetta');
    expect(quettaHours.some((d) => d.hour === 10 && d.requests >= 1)).toBe(true);
    const quettaSupply = sd.supplyByCity.find((s) => s.city === 'Quetta');
    expect(quettaSupply).toBeDefined();
    expect(quettaSupply!.providersTotal).toBeGreaterThanOrEqual(1);
    expect(quettaSupply!.providersOnline).toBeGreaterThanOrEqual(1);
  });

  it('CSV exports return real warehouse rows with the legal-review disclaimer', async () => {
    const jobs = await svc.exportCsv('fact_jobs');
    expect(jobs.filename).toBe('near-service-analytics-fact_jobs.csv');
    expect(jobs.csv.startsWith('# SUBJECT TO LEGAL REVIEW')).toBe(true);
    expect(jobs.csv).toContain('FBR, PRA, SRB');
    expect(jobs.csv).toContain(job1);
    expect(jobs.csv).toContain('1500');
    const rev = await svc.exportCsv('revenue_by_city');
    expect(rev.csv).toContain('Quetta');
    await expect(svc.exportCsv('users')).rejects.toThrow('unknown export table');
  });
});
