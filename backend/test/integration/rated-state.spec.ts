// Fix B — a job reaches RATED. REAL Postgres 16 + PostGIS 3 and REAL Redis.
// Run with (DEDICATED test DB — beforeAll drops the public schema):
//   DATABASE_URL=<redacted>
//   REDIS_URL=redis://localhost:6379 NODE_ENV=test \
//   npx jest --runInBand --forceExit test/integration/rated-state.spec.ts
// Skipped entirely when DATABASE_URL or REDIS_URL is not set.
//
// The decided rule (docs/phase4-api-addendum.md §10): a job moves
// PAYMENT_SETTLED -> RATED when BOTH sides have submitted their review,
// OR when the review window closes (feature_flags review_window_days,
// default 7 days) — whichever comes first. Until then it stays
// PAYMENT_SETTLED and each side can still review once. After RATED no
// more reviews (409 REVIEW_WINDOW_CLOSED).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { createValidationPipe } from '../../src/common/validation/validation-pipe';
import { RedisService } from '../../src/database/redis.service';
import { JobsService } from '../../src/modules/jobs/jobs.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import { SubscriptionsService } from '../../src/modules/subscriptions/subscriptions.service';
import { WarrantyService } from '../../src/modules/warranty/warranty.service';
import { hashOtp } from '../../src/common/utils/otp';

jest.setTimeout(120000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
let phoneSeq = 0;
// Single trailing digit (mod 10): +92 + 3-digit prefix + 6-digit RUN +
// 1 digit = exactly 10 digits after +92. Prefixes differ per role, so
// the cycling digit never collides within one prefix in this suite.
const PHONE = (prefix: string) => `+92${prefix}${RUN}${phoneSeq++ % 10}`;
const CATEGORY_ID = '00000000-0000-4000-8000-0000b0000001'; // Book Binding (seeded, v4 since Fix A)
const OTP_CODE = '123456';

async function bootApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

maybeDescribe('Fix B — jobs reach RATED (real DB + Redis)', () => {
  let app: INestApplication;
  let admin: Client;
  let redis: RedisService;
  let rawRedis: Redis;
  let jobs: JobsService;
  let analytics: AnalyticsService;
  let subscriptions: SubscriptionsService;
  let warranty: WarrantyService;

  let customerToken: string;
  let providerToken: string;
  let adminToken: string;
  let customerId: string;
  let providerUserId: string;

  const api = () => request(app.getHttpServer());

  async function login(phone: string): Promise<string> {
    await redis.set(`otp:${phone}`, hashOtp(OTP_CODE), 300);
    const res = await api().post('/api/v1/auth/otp/verify')
      .send({ phone, code: OTP_CODE, device_fingerprint: `fixb-${phone.slice(-4)}` });
    expect(res.status).toBe(200);
    return res.body.access_token as string;
  }

  /** Seed a settled job directly (same shape as warranty.spec.ts makeJob):
   *  real users + provider profile + request + offer + job in
   *  PAYMENT_SETTLED with a settlement job_events row `settledDaysAgo`
   *  days in the past (the review-window anchor). */
  async function seedSettledJob(opts: { finalPrice?: number; commission?: number; settledDaysAgo?: number; tier?: number } = {}) {
    const finalPrice = opts.finalPrice ?? 5000;
    const custPhone = PHONE('300');
    const provPhone = PHONE('301');
    const custId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'FixB Customer','ur') RETURNING id`,
      [custPhone])).rows[0].id as string;
    const provUserId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'FixB Provider','ur') RETURNING id`,
      [provPhone])).rows[0].id as string;
    const providerId = (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, tier, base_point)
       VALUES ($1,'INDIVIDUAL','FixB Provider',$2, ST_SetSRID(ST_MakePoint(66.975,30.1798),4326)::geography) RETURNING id`,
      [provUserId, opts.tier ?? 1])).rows[0].id as string;
    const reqId = (await admin.query(
      `INSERT INTO service_requests (customer_id, category_id, fulfillment, location, status)
       VALUES ($1,$2,'VISIT_SHOP', ST_SetSRID(ST_MakePoint(66.975,30.1798),4326)::geography, 'ACCEPTED') RETURNING id`,
      [custId, CATEGORY_ID])).rows[0].id as string;
    const offerId = (await admin.query(
      `INSERT INTO offers (request_id, provider_id, offered_by, price, status, expires_at)
       VALUES ($1,$2,'provider',$3,'accepted', now() + interval '1 hour') RETURNING id`,
      [reqId, providerId, finalPrice])).rows[0].id as string;
    const jobId = (await admin.query(
      `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price, commission_rate, commission_amount, state, payment_status,
                          customer_payment_confirmed_at, provider_payment_confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$5,0.10,$6,'PAYMENT_SETTLED','settled', now(), now()) RETURNING id`,
      [reqId, offerId, custId, providerId, finalPrice, opts.commission ?? 500])).rows[0].id as string;
    const daysAgo = opts.settledDaysAgo ?? 0;
    await admin.query(
      `INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload, created_at)
       VALUES ($1,'COMPLETED','PAYMENT_SETTLED',$2,'provider','{"method":"cash"}'::jsonb, now() - ($3 || ' days')::interval)`,
      [jobId, provUserId, String(daysAgo)]);
    return { jobId, custId, provUserId, providerId, custPhone, provPhone };
  }

  async function jobState(jobId: string): Promise<string> {
    return (await admin.query(`SELECT state FROM jobs WHERE id=$1`, [jobId])).rows[0].state as string;
  }

  /** Admin KPI GMV/commission + analytics ETL revenue totals + the
   *  provider subscription settled counter, for one provider. */
  async function settledTotals(providerUserIdFor: string) {
    const kpis = await api().get('/api/v1/admin/kpis').set('Authorization', `Bearer ${adminToken}`);
    expect(kpis.status).toBe(200);
    await analytics.runEtl('manual');
    const revenue = await analytics.revenue('city');
    const sub = await subscriptions.getAnalytics(providerUserIdFor, 30) as Record<string, unknown>;
    return {
      kpi_gmv: Number(kpis.body.gmv_pkr),
      kpi_commission: Number(kpis.body.commission_pkr),
      etl_revenue: revenue.reduce((s, r) => s + r.revenuePkr, 0),
      etl_commission: revenue.reduce((s, r) => s + r.commissionPkr, 0),
      sub_jobs_settled: Number(sub.jobs_settled),
      sub_gross: Number(sub.gross_pkr),
      sub_commission: Number(sub.commission_pkr),
    };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    const files = fs.readdirSync(dbDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    // review_window_days must be the seeded default (7) for the tests.
    const flag = (await admin.query(`SELECT config FROM feature_flags WHERE key='review_window_days'`)).rows[0];
    expect(flag?.config?.value_days).toBe(7);

    redis = new RedisService();
    rawRedis = new Redis(process.env.REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    const keys = [...(await rawRedis.keys('rl:*')), ...(await rawRedis.keys('otp:rl:*')), ...(await rawRedis.keys('idem:*'))];
    if (keys.length) await rawRedis.del(...keys);
    app = await bootApp();
    jobs = app.get(JobsService);
    analytics = app.get(AnalyticsService);
    subscriptions = app.get(SubscriptionsService);
    warranty = app.get(WarrantyService);

    // Admin user (roles are read from the DB at OTP verify time).
    const adminPhone = PHONE('302');
    const adminId = crypto.randomUUID();
    await admin.query(`INSERT INTO users (id, phone, full_name, language) VALUES ($1,$2,'FixB Admin','en')`, [adminId, adminPhone]);
    await admin.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name='super_admin'`, [adminId]);
    // Provider user for the full golden flow.
    const providerPhone = PHONE('303');
    const provId = crypto.randomUUID();
    await admin.query(`INSERT INTO users (id, phone, full_name, language) VALUES ($1,$2,'FixB Flow Provider','en')`, [provId, providerPhone]);
    await admin.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name='provider'`, [provId]);
    providerUserId = provId;

    const customerPhone = PHONE('304');
    customerToken = await login(customerPhone);
    providerToken = await login(providerPhone);
    adminToken = await login(adminPhone);
    customerId = (await admin.query(`SELECT id FROM users WHERE phone=$1`, [customerPhone])).rows[0].id as string;
  });

  afterAll(async () => {
    await app.close();
    await redis.onModuleDestroy();
    rawRedis.disconnect();
    await admin.end();
  });

  // (a) Full cash flow: complete -> settled -> customer review (still
  // PAYMENT_SETTLED) -> provider review (RATED + job_events row) ->
  // third review 409 REVIEW_WINDOW_CLOSED.
  it('(a) cash job settles, both reviews move it to RATED, a third review is 409', async () => {
    const cats = await api().get('/api/v1/categories');
    expect(cats.status).toBe(200);
    const categoryId = (cats.body as any[]).find((c) => c.slug === 'book-binding').id as string;

    const onb = await api().post('/api/v1/providers/onboarding').set('Authorization', `Bearer ${providerToken}`).send({
      step: 'identity',
      data: { display_name: 'FixB Binding House', provider_type: 'SHOP', lat: 30.1798, lng: 66.975, category_ids: [categoryId], service_radius_km: 10 },
    });
    expect(onb.status).toBe(200);
    const services = await api().put('/api/v1/providers/me/services').set('Authorization', `Bearer ${providerToken}`).send({
      services: [{ category_slug: 'book-binding', starting_price: 2500 }],
    });
    expect(services.status).toBe(200);

    const reqRes = await api().post('/api/v1/requests').set('Authorization', `Bearer ${customerToken}`).send({
      category_slug: 'book-binding', description: '20 school books, hard binding',
      fulfillment: 'PICKUP_DELIVERY', lat: 30.1798, lng: 66.975, customer_offer: 2400,
    });
    expect(reqRes.status).toBe(201);
    const requestId = reqRes.body.id as string;

    const offer = await api().post(`/api/v1/requests/${requestId}/offers`).set('Authorization', `Bearer ${providerToken}`).send({ price: 2400, eta_minutes: 60 });
    expect(offer.status).toBe(201);
    const job = await api().post(`/api/v1/offers/${offer.body.id}/accept`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(job.status).toBe(201);
    const jobId = job.body.id as string;
    expect(job.body.state).toBe('ACCEPTED');

    for (const to of ['ITEM_PICKED_UP', 'IN_PROGRESS'] as const) {
      const t = await api().post(`/api/v1/jobs/${jobId}/transition`).set('Authorization', `Bearer ${providerToken}`).send({ to_state: to });
      expect(t.status).toBe(200);
      expect(t.body.state).toBe(to);
    }
    const done = await api().post(`/api/v1/jobs/${jobId}/complete`).set('Authorization', `Bearer ${providerToken}`).send({});
    expect(done.status).toBe(200);
    expect(done.body.state).toBe('COMPLETED');

    // Batch 2 (§6a): the customer must confirm completion before either
    // side can confirm payment — and the provider cannot confirm (403).
    const providerConfirm = await api().post(`/api/v1/jobs/${jobId}/confirm-completion`).set('Authorization', `Bearer ${providerToken}`).send({});
    expect(providerConfirm.status).toBe(403);
    const confirmed = await api().post(`/api/v1/jobs/${jobId}/confirm-completion`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.completion_confirmed_at).toBeTruthy();
    const doubleConfirm = await api().post(`/api/v1/jobs/${jobId}/confirm-completion`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(doubleConfirm.status).toBe(409);
    expect(doubleConfirm.body.error.code).toBe('ALREADY_CONFIRMED');

    const c1 = await api().post(`/api/v1/jobs/${jobId}/confirm-payment`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(c1.status).toBe(200);
    expect(c1.body.state).toBe('COMPLETED');
    const c2 = await api().post(`/api/v1/jobs/${jobId}/confirm-payment`).set('Authorization', `Bearer ${providerToken}`).send({});
    expect(c2.status).toBe(200);
    expect(c2.body.state).toBe('PAYMENT_SETTLED');

    // First review: job stays PAYMENT_SETTLED.
    const r1 = await api().post(`/api/v1/jobs/${jobId}/reviews`).set('Authorization', `Bearer ${customerToken}`).send({ stars: 5, comment: 'Neat binding, on time.' });
    expect(r1.status).toBe(201);
    expect(r1.body.job_state).toBe('PAYMENT_SETTLED');
    expect((await api().get(`/api/v1/jobs/${jobId}`).set('Authorization', `Bearer ${customerToken}`)).body.state).toBe('PAYMENT_SETTLED');
    // Same side again before the other side reviews: ALREADY_REVIEWED.
    const dup = await api().post(`/api/v1/jobs/${jobId}/reviews`).set('Authorization', `Bearer ${customerToken}`).send({ stars: 4 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_REVIEWED');

    // Second review (provider): job becomes RATED.
    const r2 = await api().post(`/api/v1/jobs/${jobId}/reviews`).set('Authorization', `Bearer ${providerToken}`).send({ stars: 5, comment: 'Pleasant customer, paid on time.' });
    expect(r2.status).toBe(201);
    expect(r2.body.job_state).toBe('RATED');
    expect((await api().get(`/api/v1/jobs/${jobId}`).set('Authorization', `Bearer ${customerToken}`)).body.state).toBe('RATED');
    const ev = (await admin.query(
      `SELECT from_state, to_state, actor_user_id, actor_role, payload FROM job_events
        WHERE job_id=$1 AND to_state='RATED' ORDER BY id DESC LIMIT 1`, [jobId])).rows[0];
    expect(ev).toBeTruthy();
    expect(ev.from_state).toBe('PAYMENT_SETTLED');
    expect(ev.actor_user_id).toBe(providerUserId);
    expect(ev.actor_role).toBe('provider');
    expect(ev.payload.reason).toBe('both_reviews_submitted');

    // Third review (either side): 409 REVIEW_WINDOW_CLOSED, not ALREADY_REVIEWED.
    for (const token of [customerToken, providerToken]) {
      const r3 = await api().post(`/api/v1/jobs/${jobId}/reviews`).set('Authorization', `Bearer ${token}`).send({ stars: 5 });
      expect(r3.status).toBe(409);
      expect(r3.body.error.code).toBe('REVIEW_WINDOW_CLOSED');
    }
    expect(await jobState(jobId)).toBe('RATED');
  });

  // (c) Totals identical before/after RATED (KPI GMV/commission, analytics
  // ETL revenue/commission, subscription settled counter) — plus a warranty
  // claim filed on a RATED job and a fee collected AFTER the job is RATED.
  it('(c) GMV, commission and settled counters are identical before and after RATED; warranty still works on RATED', async () => {
    const s = await seedSettledJob({ finalPrice: 5000, commission: 500 });
    // Pro subscription (analytics_enabled) so getAnalytics works.
    await admin.query(`INSERT INTO wallet_accounts (user_id, balance_paisa) VALUES ($1, 1000000)`, [s.provUserId]);
    await subscriptions.subscribe(s.provUserId, 'pro');
    const custTok = await login(s.custPhone);
    const provTok = await login(s.provPhone);

    const before = await settledTotals(s.provUserId);
    const rc1 = await api().post(`/api/v1/jobs/${s.jobId}/reviews`).set('Authorization', `Bearer ${custTok}`).send({ stars: 4 });
    expect(rc1.status).toBe(201);
    expect(rc1.body.job_state).toBe('PAYMENT_SETTLED');
    const mid = await settledTotals(s.provUserId);
    expect(mid).toEqual(before); // first review alone changes nothing
    const rp1 = await api().post(`/api/v1/jobs/${s.jobId}/reviews`).set('Authorization', `Bearer ${provTok}`).send({ stars: 5 });
    expect(rp1.status).toBe(201);
    expect(rp1.body.job_state).toBe('RATED');
    const after = await settledTotals(s.provUserId);
    expect(after).toEqual(before);
    expect(after.sub_jobs_settled).toBe(before.sub_jobs_settled);
    // The warehouse fact row follows the job into RATED.
    const fact = (await admin.query(
      `SELECT state, is_completed, is_rated, final_price_pkr, commission_pkr FROM analytics_fact_jobs WHERE job_id=$1`, [s.jobId])).rows[0];
    expect(fact.state).toBe('RATED');
    expect(fact.is_completed).toBe(true);
    expect(fact.is_rated).toBe(true);
    expect(Number(fact.final_price_pkr)).toBe(5000);
    expect(Number(fact.commission_pkr)).toBe(500);

    // Warranty on a RATED job: opt in while IN_PROGRESS, settle, both
    // reviews -> RATED, THEN collect the fee (Fix B warranty fix), then
    // file a claim — all must still work.
    const w = await seedSettledJob({ finalPrice: 6000, commission: 600, tier: 3 });
    await admin.query(`UPDATE jobs SET state='IN_PROGRESS', payment_status='unpaid' WHERE id=$1`, [w.jobId]);
    await admin.query(`INSERT INTO wallet_accounts (user_id, balance_paisa) VALUES ($1, 1000000)`, [w.custId]);
    const warr = await warranty.optIn(w.jobId, w.custId);
    expect(warr.status).toBe('pending_payment');
    await admin.query(`UPDATE jobs SET state='COMPLETED', completed_at=now() WHERE id=$1`, [w.jobId]);
    await admin.query(
      `UPDATE jobs SET state='PAYMENT_SETTLED', payment_status='settled', customer_payment_confirmed_at=now(), provider_payment_confirmed_at=now() WHERE id=$1`, [w.jobId]);
    await admin.query(
      `INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload) VALUES ($1,'COMPLETED','PAYMENT_SETTLED',$2,'provider','{"method":"cash"}'::jsonb)`,
      [w.jobId, w.provUserId]);
    await jobs.review(w.jobId, w.custId, 5);
    await jobs.review(w.jobId, w.provUserId, 5);
    expect(await jobState(w.jobId)).toBe('RATED');
    const collected = await warranty.collectFee(w.jobId, w.custId);
    expect(collected.status).toBe('active');
    const claim = await warranty.fileClaim(w.jobId, w.custId, { reason: 'poor_work', description: 'Work fell apart after rating' });
    expect(claim.status).toBe('filed');
  });

  // (b) Window-closing sweep with a fake clock.
  it('(b) close-review-windows: elapsed window -> RATED, not elapsed -> unchanged, re-run is a no-op', async () => {
    // One review only, settled 8 days ago (> 7-day window): closes.
    // The review itself was submitted while the window was still open
    // (2 days ago), so it is seeded directly — a live review attempt
    // after the window has elapsed is refused (see the `late` job below).
    const old = await seedSettledJob({ settledDaysAgo: 8 });
    await admin.query(
      `INSERT INTO reviews (job_id, reviewer_id, reviewee_id, stars, tags, comment, created_at)
       VALUES ($1,$2,$3,5,'{}',NULL, now() - interval '2 days')`,
      [old.jobId, old.custId, old.provUserId]);
    const sweep1 = await jobs.closeReviewWindows(new Date());
    expect(sweep1.closed_job_ids).toContain(old.jobId);
    expect(sweep1.review_window_days).toBe(7);
    expect(await jobState(old.jobId)).toBe('RATED');
    const ev = (await admin.query(
      `SELECT from_state, to_state, actor_role, payload FROM job_events WHERE job_id=$1 AND to_state='RATED' ORDER BY id DESC LIMIT 1`, [old.jobId])).rows[0];
    expect(ev.from_state).toBe('PAYMENT_SETTLED');
    expect(ev.actor_role).toBe('system');
    expect(ev.payload.reason).toBe('review_window_closed');
    // Idempotent re-run closes nothing.
    const sweep2 = await jobs.closeReviewWindows(new Date());
    expect(sweep2.closed_job_ids).not.toContain(old.jobId);
    expect(sweep2.closed_count).toBe(0);

    // Settled 1 day ago: not closed by a real-now sweep...
    const fresh = await seedSettledJob({ settledDaysAgo: 1 });
    const sweep3 = await jobs.closeReviewWindows(new Date());
    expect(sweep3.closed_job_ids).not.toContain(fresh.jobId);
    expect(await jobState(fresh.jobId)).toBe('PAYMENT_SETTLED');
    // ...but closed when the clock is faked 8 days ahead (fake-clock proof).
    const fakeNow = new Date(Date.now() + 8 * 86400000);
    const sweep4 = await jobs.closeReviewWindows(fakeNow);
    expect(sweep4.closed_job_ids).toContain(fresh.jobId);
    expect(await jobState(fresh.jobId)).toBe('RATED');

    // Late review attempt on an elapsed-window job: 409 and the job is
    // closed to RATED by the attempt itself (sweep not yet run).
    const late = await seedSettledJob({ settledDaysAgo: 9 });
    const lateCustTok = await login(late.custPhone);
    const lr = await api().post(`/api/v1/jobs/${late.jobId}/reviews`).set('Authorization', `Bearer ${lateCustTok}`).send({ stars: 5 });
    expect(lr.status).toBe(409);
    expect(lr.body.error.code).toBe('REVIEW_WINDOW_CLOSED');
    expect(await jobState(late.jobId)).toBe('RATED');

    // Admin endpoint (the documented external-cron entry point).
    const adminSweep = await api().post('/api/v1/admin/jobs/close-review-windows').set('Authorization', `Bearer ${adminToken}`).send({});
    expect(adminSweep.status).toBe(200);
    expect(adminSweep.body.closed_count).toBe(0);
    expect(adminSweep.body.review_window_days).toBe(7);
    // Non-admin cannot trigger it.
    const forbidden = await api().post('/api/v1/admin/jobs/close-review-windows').set('Authorization', `Bearer ${customerToken}`).send({});
    expect(forbidden.status).toBe(403);
  });
});
