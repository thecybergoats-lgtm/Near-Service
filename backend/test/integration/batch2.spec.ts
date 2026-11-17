// Batch 2 — favourites, photo reviews, live support, push plumbing,
// promo listing, customer-confirms-completion, pickup-time / no-show.
// REAL Postgres 16 + PostGIS 3 and REAL Redis. Run with (DEDICATED test
// DB — beforeAll drops the public schema):
//   DATABASE_URL=<redacted>
//   REDIS_URL=redis://localhost:6379 NODE_ENV=test \
//   npx jest --runInBand --forceExit test/integration/batch2.spec.ts
// Skipped entirely when DATABASE_URL or REDIS_URL is not set.
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
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { hashOtp } from '../../src/common/utils/otp';

jest.setTimeout(120000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
let phoneSeq = 0;
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

maybeDescribe('Batch 2 — favourites, photo reviews, support, push, confirm-completion, no-show (real DB + Redis)', () => {
  let app: INestApplication;
  let admin: Client;
  let redis: RedisService;
  let rawRedis: Redis;
  let jobs: JobsService;
  let notifications: NotificationsService;

  let customerToken: string;
  let providerToken: string;
  let adminToken: string;
  let otherToken: string;
  let customerId: string;
  let providerUserId: string;
  let providerId: string;

  const api = () => request(app.getHttpServer());

  async function login(phone: string): Promise<string> {
    await redis.set(`otp:${phone}`, hashOtp(OTP_CODE), 300);
    const res = await api().post('/api/v1/auth/otp/verify')
      .send({ phone, code: OTP_CODE, device_fingerprint: `b2-${phone.slice(-4)}` });
    expect(res.status).toBe(200);
    return res.body.access_token as string;
  }

  /** A PAYMENT_SETTLED job seeded directly (same shape as rated-state's
   *  seedSettledJob), with completion already confirmed so the review
   *  path is reachable. */
  async function seedSettledJob(opts: { finalPrice?: number } = {}) {
    const finalPrice = opts.finalPrice ?? 5000;
    const custId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'B2 Customer','ur') RETURNING id`,
      [PHONE('310')])).rows[0].id as string;
    const provUserId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'B2 Provider','ur') RETURNING id`,
      [PHONE('311')])).rows[0].id as string;
    const provId = (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, tier, base_point)
       VALUES ($1,'INDIVIDUAL','B2 Provider',1, ST_SetSRID(ST_MakePoint(66.975,30.1798),4326)::geography) RETURNING id`,
      [provUserId])).rows[0].id as string;
    const reqId = (await admin.query(
      `INSERT INTO service_requests (customer_id, category_id, fulfillment, location, status)
       VALUES ($1,$2,'VISIT_SHOP', ST_SetSRID(ST_MakePoint(66.975,30.1798),4326)::geography, 'ACCEPTED') RETURNING id`,
      [custId, CATEGORY_ID])).rows[0].id as string;
    const offerId = (await admin.query(
      `INSERT INTO offers (request_id, provider_id, offered_by, price, status, expires_at)
       VALUES ($1,$2,'provider',$3,'accepted', now() + interval '1 hour') RETURNING id`,
      [reqId, provId, finalPrice])).rows[0].id as string;
    const jobId = (await admin.query(
      `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price, commission_rate, commission_amount, state, payment_status,
                          customer_payment_confirmed_at, provider_payment_confirmed_at, completion_confirmed_at, completion_confirmed_by)
       VALUES ($1,$2,$3,$4,$5,$5,0.10,500,'PAYMENT_SETTLED','settled', now(), now(), now(), $3) RETURNING id`,
      [reqId, offerId, custId, provId, finalPrice])).rows[0].id as string;
    await admin.query(
      `INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload)
       VALUES ($1,'COMPLETED','PAYMENT_SETTLED',$2,'provider','{"method":"cash"}'::jsonb)`,
      [jobId, provUserId]);
    return { jobId, custId, provUserId, providerId: provId };
  }

  /** A COMPLETED, unconfirmed job seeded directly, completed `daysAgo`
   *  days in the past (for the auto-confirm sweep). */
  async function seedCompletedJob(daysAgo: number) {
    const s = await seedSettledJob();
    await admin.query(
      `UPDATE jobs SET state='COMPLETED', payment_status='unpaid', completion_confirmed_at=NULL, completion_confirmed_by=NULL,
        completed_at=now() - ($2 || ' days')::interval WHERE id=$1`,
      [s.jobId, String(daysAgo)]);
    return s;
  }

  /** Full API flow up to an ACCEPTED job (request -> offer -> accept),
   *  optionally with a pickup-time commitment. */
  async function makeAcceptedJob(scheduledAt?: string) {
    const reqRes = await api().post('/api/v1/requests').set('Authorization', `Bearer ${customerToken}`).send({
      category_slug: 'book-binding', description: 'B2 books', fulfillment: 'PICKUP_DELIVERY',
      lat: 30.1798, lng: 66.975, customer_offer: 2400,
    });
    expect(reqRes.status).toBe(201);
    const offer = await api().post(`/api/v1/requests/${reqRes.body.id}/offers`).set('Authorization', `Bearer ${providerToken}`).send({ price: 2400, eta_minutes: 60 });
    expect(offer.status).toBe(201);
    const body: Record<string, unknown> = {};
    if (scheduledAt) body.scheduled_at = scheduledAt;
    const job = await api().post(`/api/v1/offers/${offer.body.id}/accept`).set('Authorization', `Bearer ${customerToken}`).send(body);
    return job;
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
    // Batch 2 migration applied: feature flag + tables exist.
    const flag = (await admin.query(`SELECT config FROM feature_flags WHERE key='completion_confirm_window_hours'`)).rows[0];
    expect(flag?.config?.value_hours).toBe(48);
    expect((await admin.query(`SELECT to_regclass('public.user_favourites') AS t`)).rows[0].t).toBe('user_favourites');
    expect((await admin.query(`SELECT to_regclass('public.support_threads') AS t`)).rows[0].t).toBe('support_threads');

    redis = new RedisService();
    rawRedis = new Redis(process.env.REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    const keys = [...(await rawRedis.keys('rl:*')), ...(await rawRedis.keys('otp:rl:*')), ...(await rawRedis.keys('idem:*'))];
    if (keys.length) await rawRedis.del(...keys);
    app = await bootApp();
    jobs = app.get(JobsService);
    notifications = app.get(NotificationsService);
    expect(notifications.providerStatus().configured).toBe(false); // no FCM creds in test

    const adminPhone = PHONE('312');
    const adminId = crypto.randomUUID();
    await admin.query(`INSERT INTO users (id, phone, full_name, language) VALUES ($1,$2,'B2 Admin','en')`, [adminId, adminPhone]);
    await admin.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name='super_admin'`, [adminId]);
    await admin.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name='support_agent'`, [adminId]);
    const providerPhone = PHONE('313');
    const provId = crypto.randomUUID();
    await admin.query(`INSERT INTO users (id, phone, full_name, language) VALUES ($1,$2,'B2 Flow Provider','en')`, [provId, providerPhone]);
    await admin.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name='provider'`, [provId]);
    providerUserId = provId;

    customerToken = await login(PHONE('314'));
    providerToken = await login(providerPhone);
    adminToken = await login(adminPhone);
    otherToken = await login(PHONE('315'));
    // Resolve the customer id from the JWT the login returned (sub = user id).
    const decoded = JSON.parse(Buffer.from(customerToken.split('.')[1], 'base64').toString('utf8')) as { sub: string };
    customerId = decoded.sub;

    // Onboard the provider so a real provider profile exists.
    const cats = await api().get('/api/v1/categories');
    expect(cats.status).toBe(200);
    const categoryId = (cats.body as any[]).find((c) => c.slug === 'book-binding').id as string;
    const onb = await api().post('/api/v1/providers/onboarding').set('Authorization', `Bearer ${providerToken}`).send({
      step: 'identity',
      data: { display_name: 'B2 Binding House', provider_type: 'SHOP', lat: 30.1798, lng: 66.975, category_ids: [categoryId], service_radius_km: 10 },
    });
    expect(onb.status).toBe(200);
    const prof = await api().get('/api/v1/me/profiles').set('Authorization', `Bearer ${providerToken}`);
    expect(prof.status).toBe(200);
    providerId = prof.body.provider.id as string;
  });

  afterAll(async () => {
    await app.close();
    await redis.onModuleDestroy();
    rawRedis.disconnect();
    await admin.end();
  });

  // ---- (1) Favourites ---------------------------------------------------
  it('(1) favourites: add, duplicate is idempotent, list, remove, 404', async () => {
    const first = await api().post(`/api/v1/providers/${providerId}/favourite`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(first.status).toBe(201);
    expect(first.body.provider_id).toBe(providerId);
    expect(first.body.already).toBe(false);
    const dup = await api().post(`/api/v1/providers/${providerId}/favourite`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(dup.status).toBe(201);
    expect(dup.body.already).toBe(true);
    const count = (await admin.query(`SELECT COUNT(*) AS cnt FROM user_favourites WHERE user_id=$1 AND provider_id=$2`, [customerId, providerId])).rows[0];
    expect(Number(count.cnt)).toBe(1);
    const list = await api().get('/api/v1/favourites').set('Authorization', `Bearer ${customerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].provider_id).toBe(providerId);
    expect(list.body.items[0].display_name).toBe('B2 Binding House');
    const ghost = crypto.randomUUID();
    const missing = await api().post(`/api/v1/providers/${ghost}/favourite`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(missing.status).toBe(404);
    const del = await api().delete(`/api/v1/providers/${providerId}/favourite`).set('Authorization', `Bearer ${customerToken}`);
    expect(del.status).toBe(204);
    const delAgain = await api().delete(`/api/v1/providers/${providerId}/favourite`).set('Authorization', `Bearer ${customerToken}`);
    expect(delAgain.status).toBe(204); // idempotent remove
    const empty = await api().get('/api/v1/favourites').set('Authorization', `Bearer ${customerToken}`);
    expect(empty.body.items).toHaveLength(0);
  });

  // ---- (5) Promo listing -------------------------------------------------
  it('(5) GET /promotions/active is public and lists FIRSTJOB10', async () => {
    const res = await api().get('/api/v1/promotions/active');
    expect(res.status).toBe(200);
    const first = (res.body.items as { code: string; title: string; discount_text: string }[]).find((p) => p.code === 'FIRSTJOB10');
    expect(first).toBeTruthy();
    expect(first?.discount_text).toBe('10% off');
    expect(first?.title).toBe('FIRSTJOB10');
  });

  // ---- (4) Push plumbing -------------------------------------------------
  it('(4) devices register/upsert + preferences + send degrades cleanly', async () => {
    const token = `fcm-test-token-${RUN}`;
    const r1 = await api().post('/api/v1/devices/register').set('Authorization', `Bearer ${customerToken}`).send({ device_token: token, platform: 'android' });
    expect(r1.status).toBe(201);
    expect(r1.body.device_id).toBeTruthy();
    expect(r1.body.device_token).toBeUndefined(); // never echoed
    expect(r1.body.platform).toBe('android');
    const r2 = await api().post('/api/v1/devices/register').set('Authorization', `Bearer ${customerToken}`).send({ device_token: token, platform: 'android' });
    expect(r2.status).toBe(201);
    expect(r2.body.device_id).toBe(r1.body.device_id); // same device, upserted
    // Login also writes a user_devices row (auth device fingerprint), so
    // count only rows carrying an FCM token.
    const rows = (await admin.query(`SELECT COUNT(*) AS cnt FROM user_devices WHERE user_id=$1 AND fcm_token IS NOT NULL`, [customerId])).rows[0];
    expect(Number(rows.cnt)).toBe(1);
    // The stored fingerprint is a hash, not the raw token.
    const stored = (await admin.query(`SELECT device_fingerprint, fcm_token FROM user_devices WHERE user_id=$1 AND fcm_token IS NOT NULL`, [customerId])).rows[0];
    expect(stored.device_fingerprint).not.toBe(token);
    expect(stored.device_fingerprint).toHaveLength(64);
    const prefs = await api().get('/api/v1/users/me/notification-preferences').set('Authorization', `Bearer ${customerToken}`);
    expect(prefs.status).toBe(200);
    expect(prefs.body.push_enabled).toBe(true);
    const off = await api().patch('/api/v1/users/me/notification-preferences').set('Authorization', `Bearer ${customerToken}`).send({ push_enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.push_enabled).toBe(false);
    // Disabled preference: send degrades, never throws.
    const disabled = await notifications.sendToUser(customerId, 'job.completed', { job_id: 'x' });
    expect(disabled).toEqual({ sent: false, reason: 'push_disabled' });
    await api().patch('/api/v1/users/me/notification-preferences').set('Authorization', `Bearer ${customerToken}`).send({ push_enabled: true });
    // Token exists but no FCM configured: degrades, never throws, no 500.
    const unconfigured = await notifications.sendToUser(customerId, 'job.completed', { job_id: 'x' });
    expect(unconfigured).toEqual({ sent: false, reason: 'provider_not_configured' });
    // No token at all for the other user: also degrades cleanly.
    const decoded = JSON.parse(Buffer.from(otherToken.split('.')[1], 'base64').toString('utf8')) as { sub: string };
    const noToken = await notifications.sendToUser(decoded.sub, 'job.completed', { job_id: 'x' });
    expect(noToken).toEqual({ sent: false, reason: 'no_device_token' });
  });

  // ---- (3) Live support --------------------------------------------------
  it('(3) support: create, reply, admin list/reply/close; no fake replies', async () => {
    const created = await api().post('/api/v1/support/threads').set('Authorization', `Bearer ${customerToken}`).send({ subject: 'Refund question', message: 'Where is my refund?' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('open');
    expect(created.body.first_message.body).toBe('Where is my refund?');
    const threadId = created.body.id as string;
    // Nobody has replied yet — the thread is open as a ticket, with only
    // the customer's own message (no fake agent reply).
    const before = await api().get(`/api/v1/support/threads/${threadId}/messages`).set('Authorization', `Bearer ${customerToken}`);
    expect(before.status).toBe(200);
    expect(before.body.items).toHaveLength(1);
    expect(before.body.items[0].sender_role).toBe('customer');
    // Another customer cannot read it.
    const forbidden = await api().get(`/api/v1/support/threads/${threadId}/messages`).set('Authorization', `Bearer ${otherToken}`);
    expect(forbidden.status).toBe(403);
    // Admin sees it in the open queue.
    const queue = await api().get('/api/v1/admin/support/threads').set('Authorization', `Bearer ${adminToken}`).query({ status: 'open' });
    expect(queue.status).toBe(200);
    expect((queue.body.items as { id: string }[]).some((t) => t.id === threadId)).toBe(true);
    // Customer follows up.
    const follow = await api().post(`/api/v1/support/threads/${threadId}/messages`).set('Authorization', `Bearer ${customerToken}`).send({ body: 'Any update?' });
    expect(follow.status).toBe(201);
    // Admin replies; the customer sees both.
    const reply = await api().post(`/api/v1/admin/support/threads/${threadId}/messages`).set('Authorization', `Bearer ${adminToken}`).send({ body: 'We are checking with finance.' });
    expect(reply.status).toBe(201);
    expect(reply.body.sender_role).toBe('support');
    const after = await api().get(`/api/v1/support/threads/${threadId}/messages`).set('Authorization', `Bearer ${customerToken}`);
    expect(after.body.items).toHaveLength(3);
    // Close; further replies are 409 and the thread stays closed.
    const closed = await api().post(`/api/v1/admin/support/threads/${threadId}/close`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');
    const afterClose = await api().post(`/api/v1/support/threads/${threadId}/messages`).set('Authorization', `Bearer ${customerToken}`).send({ body: 'Hello again' });
    expect(afterClose.status).toBe(409);
    expect(afterClose.body.error.code).toBe('THREAD_CLOSED');
    const mine = await api().get('/api/v1/support/threads').set('Authorization', `Bearer ${customerToken}`);
    expect((mine.body.items as { id: string }[]).some((t) => t.id === threadId)).toBe(true);
  });

  // ---- (6a) Auto-confirm sweep -------------------------------------------
  it('(6a) auto-confirm: old unconfirmed COMPLETED job is confirmed by system, re-run is a no-op', async () => {
    const s = await seedCompletedJob(3); // completed 3 days ago, window is 48h
    const run = await api().post('/api/v1/admin/jobs/auto-confirm-completions').set('Authorization', `Bearer ${adminToken}`).send({});
    expect(run.status).toBe(200);
    expect(run.body.confirmed_job_ids).toContain(s.jobId);
    expect(run.body.completion_confirm_window_hours).toBe(48);
    const row = (await admin.query(`SELECT completion_confirmed_at FROM jobs WHERE id=$1`, [s.jobId])).rows[0];
    expect(row.completion_confirmed_at).toBeTruthy();
    const ev = (await admin.query(
      `SELECT actor_role, payload FROM job_events WHERE job_id=$1 AND payload->>'reason'='completion_auto_confirmed'`, [s.jobId])).rows[0];
    expect(ev?.actor_role).toBe('system');
    const again = await api().post('/api/v1/admin/jobs/auto-confirm-completions').set('Authorization', `Bearer ${adminToken}`).send({});
    expect(again.status).toBe(200);
    expect(again.body.confirmed_job_ids).not.toContain(s.jobId);
  });

  // ---- (6a) Confirm-completion rule, full API flow -----------------------
  it('(6a) customer confirms completion: provider complete-only, payment gated, double-confirm 409', async () => {
    const job = await makeAcceptedJob();
    expect(job.status).toBe(201);
    const jobId = job.body.id as string;
    for (const to of ['ITEM_PICKED_UP', 'IN_PROGRESS'] as const) {
      const t = await api().post(`/api/v1/jobs/${jobId}/transition`).set('Authorization', `Bearer ${providerToken}`).send({ to_state: to });
      expect(t.status).toBe(200);
    }
    // The customer cannot mark work done (403) — the verified gap.
    const custComplete = await api().post(`/api/v1/jobs/${jobId}/complete`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(custComplete.status).toBe(403);
    const done = await api().post(`/api/v1/jobs/${jobId}/complete`).set('Authorization', `Bearer ${providerToken}`).send({});
    expect(done.status).toBe(200);
    expect(done.body.state).toBe('COMPLETED');
    // Payment is blocked until the customer confirms completion.
    const blocked = await api().post(`/api/v1/jobs/${jobId}/confirm-payment`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('COMPLETION_NOT_CONFIRMED');
    // The provider cannot confirm (403); the customer can, once.
    const provConfirm = await api().post(`/api/v1/jobs/${jobId}/confirm-completion`).set('Authorization', `Bearer ${providerToken}`).send({});
    expect(provConfirm.status).toBe(403);
    const confirmed = await api().post(`/api/v1/jobs/${jobId}/confirm-completion`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.completion_confirmed_at).toBeTruthy();
    const dbl = await api().post(`/api/v1/jobs/${jobId}/confirm-completion`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(dbl.status).toBe(409);
    expect(dbl.body.error.code).toBe('ALREADY_CONFIRMED');
    // GET /jobs/:id surfaces the confirmation.
    const detail = await api().get(`/api/v1/jobs/${jobId}`).set('Authorization', `Bearer ${customerToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.completion_confirmed_at).toBeTruthy();
    // Payment now works: customer then provider settles.
    const c1 = await api().post(`/api/v1/jobs/${jobId}/confirm-payment`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(c1.status).toBe(200);
    const c2 = await api().post(`/api/v1/jobs/${jobId}/confirm-payment`).set('Authorization', `Bearer ${providerToken}`).send({});
    expect(c2.status).toBe(200);
    expect(c2.body.state).toBe('PAYMENT_SETTLED');
  });

  // ---- (6b) Pickup-time commitment + no-show ----------------------------
  it('(6b) scheduled_at: accept stores it, past is 422, no-show rules + counter', async () => {
    const future = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const job = await makeAcceptedJob(future);
    expect(job.status).toBe(201);
    expect(job.body.scheduled_at).toBe(future);
    const jobId = job.body.id as string;
    const detail = await api().get(`/api/v1/jobs/${jobId}`).set('Authorization', `Bearer ${customerToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.scheduled_at).toBe(future);
    // Past scheduled_at is rejected at accept time.
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    const bad = await makeAcceptedJob(past);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('SCHEDULED_AT_PAST');
    // No-show before the scheduled time: too early.
    const early = await api().post(`/api/v1/jobs/${jobId}/report-no-show`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('TOO_EARLY');
    // Provider cannot report a no-show on their own job.
    const provReport = await api().post(`/api/v1/jobs/${jobId}/report-no-show`).set('Authorization', `Bearer ${providerToken}`).send({});
    expect(provReport.status).toBe(403);
    // Move the committed time into the past (as if the provider missed it).
    await admin.query(`UPDATE service_requests SET scheduled_at=now() - interval '1 hour' WHERE id=(SELECT request_id FROM jobs WHERE id=$1)`, [jobId]);
    const reported = await api().post(`/api/v1/jobs/${jobId}/report-no-show`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(reported.status).toBe(200);
    expect(reported.body.no_show_count).toBe(1);
    const prof = (await admin.query(`SELECT no_show_count FROM provider_profiles WHERE id=$1`, [providerId])).rows[0];
    expect(Number(prof.no_show_count)).toBe(1);
    const risk = (await admin.query(`SELECT signal, score_delta FROM risk_events WHERE job_id=$1 AND signal='no_show'`, [jobId])).rows[0];
    expect(risk?.signal).toBe('no_show');
    expect(Number(risk.score_delta)).toBe(12);
    const ev = (await admin.query(`SELECT payload FROM job_events WHERE job_id=$1 AND payload->>'reason'='provider_no_show'`, [jobId])).rows[0];
    expect(ev).toBeTruthy();
    // The customer can still cancel afterwards (job is ACCEPTED).
    const cancel = await api().post(`/api/v1/jobs/${jobId}/transition`).set('Authorization', `Bearer ${customerToken}`).send({ to_state: 'CANCELLED_BY_CUSTOMER' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.state).toBe('CANCELLED_BY_CUSTOMER');
    // A job with no committed time cannot get a no-show report.
    const noTime = await makeAcceptedJob();
    expect(noTime.status).toBe(201);
    const noTimeReport = await api().post(`/api/v1/jobs/${noTime.body.id}/report-no-show`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(noTimeReport.status).toBe(409);
    expect(noTimeReport.body.error.code).toBe('NO_SCHEDULED_TIME');
  });

  // ---- (2) Photo reviews --------------------------------------------------
  it('(2) photo reviews: upload-request keys attach, unknown keys 422, provider list returns photos', async () => {
    const s = await seedSettledJob();
    // The seeded customer's token: log in as a fresh user is not possible
    // for a seeded user (no phone login here) — review as the seeded
    // customer through the service-level party check via a direct login:
    // seed a login for the seeded customer phone instead. Simpler: use
    // the JobsService directly for the review call, and the API for the
    // provider review list.
    const slot = await jobs.requestReviewUpload(s.jobId, s.custId);
    expect(slot.storage_key.startsWith(`reviews/${s.jobId}/photo-`)).toBe(true);
    expect(slot.upload_url).toContain(encodeURIComponent(slot.storage_key));
    const reviewed = await jobs.review(s.jobId, s.custId, 5, ['on_time'], 'Great work, see photos.', [slot.storage_key]);
    expect(reviewed.photos).toEqual([slot.storage_key]);
    // A hand-typed / foreign key is rejected 422.
    await expect(jobs.review(s.jobId, s.provUserId, 5, [], 'Nice customer.', ['reviews/some-other-job/photo-x.bin']))
      .rejects.toMatchObject({ code: 'INVALID_PHOTO_KEY', status: 422 });
    await expect(jobs.review(s.jobId, s.provUserId, 5, [], 'Nice customer.', ['disputes/abc/evidence-x.bin']))
      .rejects.toMatchObject({ code: 'INVALID_PHOTO_KEY', status: 422 });
    // Too many photos: 4 keys -> 422 (DTO limit is also 3, service enforces it).
    const keys = [slot.storage_key, slot.storage_key, slot.storage_key, slot.storage_key];
    await expect(jobs.review(s.jobId, s.provUserId, 5, [], 'Too many.', keys))
      .rejects.toMatchObject({ code: 'TOO_MANY_PHOTOS', status: 422 });
    // Provider review list returns the photos.
    const list = await api().get(`/api/v1/providers/${s.providerId}/reviews`).set('Authorization', `Bearer ${customerToken}`);
    expect(list.status).toBe(200);
    const mine = (list.body.items as { job_id: string; photos?: string[] }[]).find((r) => r.job_id === s.jobId);
    expect(mine?.photos).toEqual([slot.storage_key]);
    // Upload-request for a non-party is forbidden; for a non-settled job 409.
    await expect(jobs.requestReviewUpload(s.jobId, customerId)).rejects.toMatchObject({ status: 403 });
    const accepted = await makeAcceptedJob();
    await expect(jobs.requestReviewUpload(accepted.body.id as string, customerId)).rejects.toMatchObject({ code: 'NOT_SETTLED', status: 409 });
  });
});
