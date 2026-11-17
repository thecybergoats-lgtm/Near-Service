// API contract tests (OpenAPI v1.3, FIX 7).
// (1) Route-diff: boot the Nest app, read all registered routes, and assert
//     the set of (method, path) equals the set in backend/openapi.yaml.
// (2) No-DB checks: auth guard, 422 validation, error shape.
// (3) Golden flow against REAL Postgres + Redis (login -> categories ->
//     nearby -> create request -> offer -> accept -> job transitions ->
//     complete -> confirm payment -> review), with every response validated
//     against the OpenAPI spec via openapi-response-validator.
//
// DB-backed checks skip cleanly when DATABASE_URL/REDIS_URL are absent.
// When present, run with a DEDICATED test DB — beforeAll drops the public
// schema and re-applies db/0001–0008 + seed. Example:
//   DATABASE_URL=<redacted> REDIS_URL=redis://localhost:6379 \
//   NODE_ENV=test OTP_DEV_MODE=false \
//   JWT_ACCESS_SECRET=<redacted> JWT_REFRESH_SECRET=<redacted> \
//   CNIC_PEPPER=<32+ chars> OTP_HASH_SECRET=<32+ chars> \
//   FIELD_ENCRYPTION_KEY=<base64 of 32 bytes> \
//   npx jest --runInBand --forceExit test/contract/api.contract.spec.ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import * as yaml from 'js-yaml';
import OpenAPIResponseValidator from 'openapi-response-validator';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { createValidationPipe } from '../../src/common/validation/validation-pipe';
import { env } from '../../src/config/env';
import { RedisService } from '../../src/database/redis.service';
import { hashOtp } from '../../src/common/utils/otp';

jest.setTimeout(60000);

// Per-run unique phones: the service limits OTP requests to 5/hour per phone
// (FIX 3) and the guard limits per IP (FIX 9); counters live in real Redis
// across runs, so fixed phones would 429 after a few full-suite runs.
const RUN = String(crypto.randomInt(100000, 999999));
const CUSTOMER_PHONE = `+92300${RUN}1`;
const PROVIDER_PHONE = `+92300${RUN}2`;
const ADMIN_PHONE = `+92300${RUN}3`;
const OTP_CODE = '123456';

const SPEC_PATH = path.resolve(__dirname, '../../openapi.yaml');
const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;

function findOp(operationId: string): { path: string; method: string; op: any } {
  for (const [p, item] of Object.entries<any>(spec.paths)) {
    for (const [m, o] of Object.entries<any>(item)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(m) && o.operationId === operationId) {
        return { path: p, method: m, op: o };
      }
    }
  }
  throw new Error(`operationId ${operationId} not found in ${SPEC_PATH}`);
}

/** Validate one response against the spec. Returns silently when the
 *  operation declares no response body schema for that status (requestOtp
 *  202 and createReview 201 carry no content schema in v1.3 — those are
 *  asserted manually by the caller instead). Throws a readable error on
 *  mismatch. */
function validateResponse(operationId: string, status: number, body: unknown): void {
  const { op } = findOp(operationId);
  const resp = op.responses?.[String(status)];
  const schema = resp?.content?.['application/json']?.schema;
  if (!schema) return; // no schema declared for this status — manual checks apply
  const validator = new OpenAPIResponseValidator({
    responses: { [status]: resp },
    components: spec.components,
  } as any);
  const result = validator.validateResponse(status, body);
  if (result) {
    throw new Error(
      `${operationId} ${status} failed OpenAPI response validation:\n${JSON.stringify(result, null, 2)}\nbody: ${JSON.stringify(body).slice(0, 2000)}`,
    );
  }
}

/** Every route the running Nest app registered, as "METHOD /api/v1/path"
 *  with :params intact (Express router stack, via the HTTP adapter). */
function collectAppRoutes(app: INestApplication): string[] {
  const expressApp: any = app.getHttpAdapter().getInstance();
  const routes: string[] = [];
  const walk = (stack: any[]) => {
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
        for (const m of methods) routes.push(`${m.toUpperCase()} ${layer.route.path}`);
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  const router = expressApp.router ?? expressApp._router;
  if (router?.stack) walk(router.stack);
  return routes.sort();
}

/** "GET /api/v1/requests/:id" -> "GET /requests/{}"; same for "{requestId}". */
function normalizeRoute(route: string): string {
  const [method, p] = route.split(' ', 2);
  return `${method} ${p.replace('/api/v1', '').replace(/:[^/]+/g, '{}').replace(/\{[^}]*\}/g, '{}')}`;
}

async function bootApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

describe('API contract v1.3 — route-diff + no-DB checks', () => {
  let app: INestApplication;
  beforeAll(async () => {
    // Rate-limit buckets (rl:*) leak across suites sharing one Redis; flush
    // them so the OTP checks below start clean (FIX 9).
    if (process.env.REDIS_URL) {
      const raw = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
      const keys = [...(await raw.keys('rl:*')), ...(await raw.keys('otp:rl:*'))];
      if (keys.length) await raw.del(...keys);
      raw.disconnect();
    }
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('registered routes equal the openapi.yaml route set (no extra, no missing)', async () => {
    const specRoutes = new Set<string>();
    for (const [p, item] of Object.entries<any>(spec.paths)) {
      for (const m of Object.keys(item)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) {
          specRoutes.add(normalizeRoute(`${m.toUpperCase()} /api/v1${p}`));
        }
      }
    }
    const appRoutes = new Set(collectAppRoutes(app).map(normalizeRoute));
    const extra = [...appRoutes].filter((r) => !specRoutes.has(r));
    const missing = [...specRoutes].filter((r) => !appRoutes.has(r));
    expect({ extra, missing }).toEqual({ extra: [], missing: [] });
    expect(appRoutes.size).toBeGreaterThan(90);
  });

  it('protected routes require a Bearer <redacted>', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
  // FIX 6: validation failures are 422 VALIDATION_FAILED, not 400.
  it('OTP request rejects a non-PK phone with 422 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/otp/request').send({ phone: '12345' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.fields).toHaveProperty('phone');
  });
  it('OTP request returns 202 for a valid PK phone (dev OTP, no DB needed)', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/otp/request').send({ phone: `+92300${RUN}9`, device_fingerprint: 'test-device' });
    expect(res.status).toBe(202);
  });
  it('OTP verify requires device_fingerprint (v1.1) — 422 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/otp/verify').send({ phone: '+923001234567', code: '123456' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.fields).toHaveProperty('device_fingerprint');
  });
  it('logout returns 204 with a valid access token', async () => {
    // Signed with the same secret the guard reads (src/config/env.ts) — the
    // old test signed with the removed 'dev-secret-change-me' fallback.
    const token = jwt.sign({ sub: '00000000-0000-4000-8000-000000000001', phone: '+923001234567', roles: ['customer'] }, env.jwtAccessSecret, { expiresIn: 60 });
    const res = await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`).send({ refresh_token: '00000000-0000-4000-8000-000000000002' });
    expect(res.status).toBe(204);
  });
  it('error shape is {error:{code,message,details},request_id}', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/me');
    expect(res.body).toHaveProperty('error.code');
    expect(res.body).toHaveProperty('error.message');
    expect(res.body).toHaveProperty('request_id');
  });
});

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

maybeDescribe('golden flow (real Postgres + Redis, OpenAPI schema-validated)', () => {
  let app: INestApplication;
  let admin: Client;
  let redis: RedisService;
  let rawRedis: Redis;

  const api = () => request(app.getHttpServer());

  /** Login via the real OTP endpoints. The code is seeded into Redis with
   *  the same HMAC the service checks (pattern from
   *  test/integration/auth-refresh-reuse.spec.ts) — the API path is real,
   *  only the SMS delivery is stubbed. */
  async function login(phone: string): Promise<string> {
    await redis.set(`otp:${phone}`, hashOtp(OTP_CODE), 300);
    const res = await api().post('/api/v1/auth/otp/verify').send({ phone, code: OTP_CODE, device_fingerprint: `fix7-${phone.slice(-4)}` });
    expect(res.status).toBe(200);
    validateResponse('verifyOtp', 200, res.body);
    expect(res.body.access_token).toBeTruthy();
    return res.body.access_token as string;
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
    // Admin + provider users, created directly so their tokens carry the
    // roles at login (roles are read from the DB at verify time).
    const adminId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO users (id, phone, full_name, language) VALUES ($1,$2,'Fix7 Admin','en')`,
      [adminId, ADMIN_PHONE],
    );
    await admin.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name='super_admin'`,
      [adminId],
    );
    const providerId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO users (id, phone, full_name, language) VALUES ($1,$2,'Fix7 Provider','en')`,
      [providerId, PROVIDER_PHONE],
    );
    await admin.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name='provider'`,
      [providerId],
    );
    redis = new RedisService();
    rawRedis = new Redis(process.env.REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    // Rate-limit buckets (rl:*) and OTP counters (otp:rl:*) leak across
    // suites sharing one Redis — flush them so this run starts clean.
    const keys = [...(await rawRedis.keys('rl:*')), ...(await rawRedis.keys('otp:rl:*')), ...(await rawRedis.keys('idem:*'))];
    if (keys.length) await rawRedis.del(...keys);
    app = await bootApp();
  });

  afterAll(async () => {
    await app.close();
    await redis.onModuleDestroy();
    rawRedis.disconnect();
    await admin.end();
  });

  it('login -> categories -> nearby -> request -> offer -> accept -> transitions -> complete -> confirm payment -> review', async () => {
    // --- login (customer + provider) -----------------------------------
    const customerReq = await api().post('/api/v1/auth/otp/request').send({ phone: CUSTOMER_PHONE, device_fingerprint: 'fix7-cust' });
    expect(customerReq.status).toBe(202);
    expect(customerReq.body.expires_in_seconds).toBeGreaterThan(0);
    const customerToken = await login(CUSTOMER_PHONE);
    const providerToken = await login(PROVIDER_PHONE);
    const adminToken = await login(ADMIN_PHONE);

    // --- categories ------------------------------------------------------
    const cats = await api().get('/api/v1/categories');
    expect(cats.status).toBe(200);
    validateResponse('listCategories', 200, cats.body);
    const bookBinding = (cats.body as any[]).find((c) => c.slug === 'book-binding');
    expect(bookBinding?.id).toBeTruthy();
    const categoryId = bookBinding.id as string;

    // --- provider onboarding + services ----------------------------------
    const onb = await api().post('/api/v1/providers/onboarding').set('Authorization', `Bearer ${providerToken}`).send({
      step: 'identity',
      data: { display_name: 'Fix7 Binding House', provider_type: 'SHOP', lat: 30.1798, lng: 66.975, category_ids: [categoryId], service_radius_km: 10 },
    });
    expect(onb.status).toBe(200);
    validateResponse('upsertOnboardingStep', 200, onb.body);
    const services = await api().put('/api/v1/providers/me/services').set('Authorization', `Bearer ${providerToken}`).send({
      // Seeded category ids are RFC-4122 v4 since Fix A
      // (db/0021_fix_seed_uuids.sql); either category_id or
      // category_slug works. This flow uses the slug path.
      services: [{ category_slug: 'book-binding', starting_price: 2500 }],
    });
    expect(services.status).toBe(200);
    validateResponse('updateMyServices', 200, services.body);

    // --- nearby (v1.2 ProviderPage envelope) ------------------------------
    const nearby = await api().get('/api/v1/providers/nearby').query({ lat: 30.1798, lng: 66.975 });
    expect(nearby.status).toBe(200);
    validateResponse('nearbyProviders', 200, nearby.body);
    expect(Array.isArray(nearby.body.items)).toBe(true);
    expect(nearby.body).toHaveProperty('next_cursor');
    expect(nearby.body.items.length).toBeGreaterThanOrEqual(1);
    expect(nearby.body.items.map((p: any) => p.id)).toContain(onb.body.provider_id);
    // Cursor paging: limit 1 returns one item and a non-null next_cursor
    // (the seeded providers plus ours are all within range).
    const nearbyPage1 = await api().get('/api/v1/providers/nearby').query({ lat: 30.1798, lng: 66.975, limit: 1 });
    expect(nearbyPage1.status).toBe(200);
    validateResponse('nearbyProviders', 200, nearbyPage1.body);
    expect(nearbyPage1.body.items).toHaveLength(1);
    expect(nearbyPage1.body.next_cursor).toBeTruthy();
    const nearbyPage2 = await api().get('/api/v1/providers/nearby').query({ lat: 30.1798, lng: 66.975, limit: 1, cursor: nearbyPage1.body.next_cursor });
    expect(nearbyPage2.status).toBe(200);
    validateResponse('nearbyProviders', 200, nearbyPage2.body);
    expect(nearbyPage2.body.items[0].id).not.toBe(nearbyPage1.body.items[0].id);

    // --- invalid request is 422 VALIDATION_FAILED (FIX 6) -----------------
    const bad = await api().post('/api/v1/requests').set('Authorization', `Bearer ${customerToken}`).send({
      category_slug: 'book-binding', fulfillment: 'PICKUP_DELIVERY', lat: 999, lng: 66.975, customer_offer: 2400,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(bad.body.error.details.fields).toHaveProperty('lat');
    validateResponse('createRequest', 422, bad.body);

    // --- create request ----------------------------------------------------
    const reqRes = await api().post('/api/v1/requests').set('Authorization', `Bearer ${customerToken}`).send({
      category_slug: 'book-binding', description: '20 school books, hard binding',
      fulfillment: 'PICKUP_DELIVERY', lat: 30.1798, lng: 66.975, customer_offer: 2400,
    });
    expect(reqRes.status).toBe(201);
    validateResponse('createRequest', 201, reqRes.body);
    const requestId = reqRes.body.id as string;
    expect(reqRes.body.status).toBe('BROADCASTING');

    // --- offers (empty page, then one offer) -------------------------------
    const offersEmpty = await api().get(`/api/v1/requests/${requestId}/offers`).set('Authorization', `Bearer ${customerToken}`);
    expect(offersEmpty.status).toBe(200);
    validateResponse('listOffers', 200, offersEmpty.body);
    expect(offersEmpty.body.items).toEqual([]);
    expect(offersEmpty.body.next_cursor).toBeNull();

    const offer = await api().post(`/api/v1/requests/${requestId}/offers`).set('Authorization', `Bearer ${providerToken}`).send({ price: 2400, eta_minutes: 60 });
    expect(offer.status).toBe(201);
    validateResponse('createOffer', 201, offer.body);
    const offerId = offer.body.id as string;

    const offers = await api().get(`/api/v1/requests/${requestId}/offers`).set('Authorization', `Bearer ${customerToken}`);
    expect(offers.status).toBe(200);
    validateResponse('listOffers', 200, offers.body);
    expect(offers.body.items).toHaveLength(1);

    // --- accept -> job ------------------------------------------------------
    const job = await api().post(`/api/v1/offers/${offerId}/accept`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(job.status).toBe(201);
    validateResponse('acceptOffer', 201, job.body);
    const jobId = job.body.id as string;
    expect(job.body.state).toBe('ACCEPTED');

    // --- transitions (provider) ----------------------------------------------
    for (const to of ['ITEM_PICKED_UP', 'IN_PROGRESS'] as const) {
      const t = await api().post(`/api/v1/jobs/${jobId}/transition`).set('Authorization', `Bearer ${providerToken}`).send({ to_state: to });
      expect(t.status).toBe(200);
      validateResponse('transitionJob', 200, t.body);
      expect(t.body.state).toBe(to);
    }
    const done = await api().post(`/api/v1/jobs/${jobId}/complete`).set('Authorization', `Bearer ${providerToken}`).send({});
    expect(done.status).toBe(200);
    validateResponse('completeJob', 200, done.body);
    expect(done.body.state).toBe('COMPLETED');

    // --- confirm completion (Batch 2 §6a): provider cannot confirm (403),
    //     customer confirms once; payment is blocked until then --------------
    const blockedPay = await api().post(`/api/v1/jobs/${jobId}/confirm-payment`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(blockedPay.status).toBe(409);
    expect(blockedPay.body.error.code).toBe('COMPLETION_NOT_CONFIRMED');
    const providerConfirm = await api().post(`/api/v1/jobs/${jobId}/confirm-completion`).set('Authorization', `Bearer ${providerToken}`).send({});
    expect(providerConfirm.status).toBe(403);
    const confirmed = await api().post(`/api/v1/jobs/${jobId}/confirm-completion`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.completion_confirmed_at).toBeTruthy();

    // --- confirm payment: customer first, then provider settles ---------------
    const confirm1 = await api().post(`/api/v1/jobs/${jobId}/confirm-payment`).set('Authorization', `Bearer ${customerToken}`).send({});
    expect(confirm1.status).toBe(200);
    validateResponse('confirmCashPayment', 200, confirm1.body);
    expect(confirm1.body.state).toBe('COMPLETED');
    expect(confirm1.body.customer_confirmed).toBe(true);

    const confirm2 = await api().post(`/api/v1/jobs/${jobId}/confirm-payment`).set('Authorization', `Bearer ${providerToken}`).send({});
    expect(confirm2.status).toBe(200);
    validateResponse('confirmCashPayment', 200, confirm2.body);
    expect(confirm2.body.state).toBe('PAYMENT_SETTLED');

    // --- review ----------------------------------------------------------------
    const review = await api().post(`/api/v1/jobs/${jobId}/reviews`).set('Authorization', `Bearer ${customerToken}`).send({ stars: 5, comment: 'Neat binding, on time.' });
    expect(review.status).toBe(201);
    expect(review.body.stars).toBe(5);
    expect(review.body.job_id).toBe(jobId);

    // --- job detail + history (paginated) ---------------------------------------
    const detail = await api().get(`/api/v1/jobs/${jobId}`).set('Authorization', `Bearer ${customerToken}`);
    expect(detail.status).toBe(200);
    validateResponse('getJob', 200, detail.body);
    // NOTE (Fix B): one review does NOT move the job to RATED — the job
    // stays PAYMENT_SETTLED until BOTH sides have reviewed or the review
    // window closes (POST /admin/jobs/close-review-windows). See
    // backend/test/integration/rated-state.spec.ts for the full rule.
    expect(detail.body.state).toBe('PAYMENT_SETTLED');

    const history = await api().get('/api/v1/jobs').set('Authorization', `Bearer ${customerToken}`).query({ role: 'customer' });
    expect(history.status).toBe(200);
    validateResponse('listJobs', 200, history.body);
    expect(history.body.items.map((j: any) => j.id)).toContain(jobId);

    // --- admin lists (envelopes; also proves the promos ORDER BY fix) ----------
    for (const [opid, path] of [
      ['adminListPromos', '/admin/promos'],
      ['adminListCommissionRules', '/admin/commission-rules'],
      ['adminListVerifications', '/admin/verifications'],
      ['adminListUsers', '/admin/users'],
      ['adminListJobs', '/admin/jobs'],
      ['adminListAuditLogs', '/admin/audit-logs'],
      ['adminListCategories', '/admin/categories'],
      ['adminGetKpis', '/admin/kpis'],
      ['adminListRequests', '/admin/requests'],
      ['adminListDisputes', '/admin/disputes'],
      ['adminListSlaBreaches', '/admin/disputes/sla-breaches'],
    ] as const) {
      const r = await api().get(`/api/v1${path}`).set('Authorization', `Bearer ${adminToken}`);
      expect(r.status).toBe(200);
      validateResponse(opid, 200, r.body);
    }
    const reconRun = await api().post('/api/v1/admin/reconciliation/run').set('Authorization', `Bearer ${adminToken}`).send({});
    expect(reconRun.status).toBe(200);
    validateResponse('adminRunReconciliation', 200, reconRun.body);
    expect(reconRun.body.status).toBe('clean');
    const reconGet = await api().get('/api/v1/admin/reconciliation').set('Authorization', `Bearer ${adminToken}`);
    expect(reconGet.status).toBe(200);
    validateResponse('adminGetReconciliation', 200, reconGet.body);
    expect(reconGet.body.status).toBe('clean');
  });
});
