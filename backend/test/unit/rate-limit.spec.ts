// FIX 9 (Stage 2) — per-endpoint rate limiting.
// Boots the real app (global RateLimitGuard + ValidationPipe + filter) and
// fires limit+1 requests at each limited endpoint: the first `limit` must
// NOT be 429, the next one must be 429 RATE_LIMITED with a Retry-After
// header. Limits come from env defaults (see src/config/env.ts).
//
// Real Redis is used when REDIS_URL is set (redis-cli PONG in this VM);
// otherwise the guard runs on RedisService's in-memory fallback and the
// same assertions hold. rl:* keys are flushed before each test. Run with
// --runInBand when REDIS_URL is set so two spec files cannot share one IP
// bucket in the same window.
//
// NOTE: there is NO admin-login endpoint in this codebase (admin auth is a
// JWT bearer), so there is nothing to rate-limit for "admin login" —
// recorded here rather than silently skipped.
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import Redis from 'ioredis';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { createValidationPipe } from '../../src/common/validation/validation-pipe';
import { RedisService } from '../../src/database/redis.service';
import { RATE_LIMIT_PRESETS } from '../../src/common/guards/rate-limit.guard';
import { parseEnv } from '../../src/config/env';
import { env } from '../../src/config/env';

jest.setTimeout(60000);

const CUSTOMER_A = 'c0000001-4000-4000-8000-000000000001';
const CUSTOMER_B = 'c0000002-4000-4000-8000-000000000002';
const PROVIDER_ID = 'c0000003-4000-4000-8000-000000000003';
const REQ_ID = '11111111-1111-4111-8111-111111111111';
const CHAT_ID = '33333333-3333-4333-8333-333333333333';

function token(sub: string, roles: string[]) {
  return jwt.sign({ sub, phone: '+923001234567', roles }, env.jwtAccessSecret, { expiresIn: 600 });
}
const CUSTOMER_A_TOKEN = token(CUSTOMER_A, ['customer']);
const CUSTOMER_B_TOKEN = token(CUSTOMER_B, ['customer']);
const PROVIDER_TOKEN = token(PROVIDER_ID, ['provider']);

const VALID_REQUEST = { category_slug: 'ac-repair', fulfillment: 'PROVIDER_COMES', lat: 30.18, lng: 66.99, description: 'Fix my AC' };
const HAS_DB = !!process.env.DATABASE_URL;

/** Fire the same request n times; returns all responses in order. */
async function fire(app: INestApplication, n: number, build: (i: number) => request.Test) {
  const out: request.Response[] = [];
  for (let i = 0; i < n; i += 1) out.push(await build(i));
  return out;
}

function expectRateLimited(res: request.Response) {
  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe('RATE_LIMITED');
  expect(res.headers['retry-after']).toBeDefined();
  const retryAfter = Number(res.headers['retry-after']);
  expect(Number.isFinite(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
}

describe('rate limiting (FIX 9)', () => {
  let app: INestApplication;
  let pg: Client | null = null;

  async function flushRateLimits() {
    if (process.env.REDIS_URL) {
      const raw = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
      // Guard buckets (rl:*) AND the service-level per-phone OTP counters
      // (otp:rl:*) — both are windows that would otherwise leak across
      // suites and runs sharing one Redis.
      const keys = [...(await raw.keys('rl:*')), ...(await raw.keys('otp:rl:*'))];
      if (keys.length) await raw.del(...keys);
      raw.disconnect();
    } else {
      const redis = app.get(RedisService);
      (redis as unknown as { mem?: Map<string, unknown> }).mem?.clear();
    }
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    // POST /requests and SOS write rows keyed by the caller's user id, which
    // is a foreign key — seed the two test users (no-op without a DB).
    if (process.env.DATABASE_URL) {
      pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      for (const [id, phone] of [[CUSTOMER_A, '+923009998881'], [CUSTOMER_B, '+923009998882']] as const) {
        await pg.query(
          `INSERT INTO users (id, phone, full_name, language, status) VALUES ($1, $2, 'Rate Limit Test', 'ur', 'active') ON CONFLICT (id) DO NOTHING`,
          [id, phone],
        );
      }
    }
  });

  afterAll(async () => {
    if (pg) {
      await pg.query('DELETE FROM service_requests WHERE customer_id IN ($1, $2)', [CUSTOMER_A, CUSTOMER_B]).catch(() => undefined);
      await pg.query(`DELETE FROM fraud_signals WHERE user_id IN ($1, $2)`, [CUSTOMER_A, CUSTOMER_B]).catch(() => undefined);
      await pg.query(`DELETE FROM notifications WHERE user_id IN ($1, $2)`, [CUSTOMER_A, CUSTOMER_B]).catch(() => undefined);
      await pg.query('DELETE FROM reports WHERE reporter_id IN ($1, $2)', [CUSTOMER_A, CUSTOMER_B]).catch(() => undefined);
      await pg.query('DELETE FROM blocks WHERE blocker_id IN ($1, $2)', [CUSTOMER_A, CUSTOMER_B]).catch(() => undefined);
      await pg.query('DELETE FROM users WHERE id IN ($1, $2)', [CUSTOMER_A, CUSTOMER_B]).catch(() => undefined);
      await pg.end().catch(() => undefined);
    }
    await app.close();
  });
  beforeEach(async () => { await flushRateLimits(); });

  it('env defaults are the documented limits', () => {
    expect(RATE_LIMIT_PRESETS['otp-request']).toEqual({ limit: 5, windowSeconds: 3600 });
    expect(RATE_LIMIT_PRESETS['otp-verify']).toEqual({ limit: 10, windowSeconds: 3600 });
    expect(RATE_LIMIT_PRESETS.refresh).toEqual({ limit: 30, windowSeconds: 3600 });
    expect(RATE_LIMIT_PRESETS.search).toEqual({ limit: 60, windowSeconds: 60 });
    expect(RATE_LIMIT_PRESETS.nearby).toEqual({ limit: 60, windowSeconds: 60 });
    expect(RATE_LIMIT_PRESETS['create-request']).toEqual({ limit: 30, windowSeconds: 3600 });
    expect(RATE_LIMIT_PRESETS.offers).toEqual({ limit: 60, windowSeconds: 3600 });
    expect(RATE_LIMIT_PRESETS.messages).toEqual({ limit: 60, windowSeconds: 60 });
    expect(RATE_LIMIT_PRESETS.reports).toEqual({ limit: 10, windowSeconds: 3600 });
    expect(RATE_LIMIT_PRESETS.blocks).toEqual({ limit: 10, windowSeconds: 3600 });
    // SOS: high limit on purpose — throttled, never fully blocked.
    expect(RATE_LIMIT_PRESETS.sos).toEqual({ limit: 30, windowSeconds: 60 });
  });

  it('RATE_LIMIT_* env vars override the defaults', () => {
    const parsed = parseEnv({ NODE_ENV: 'development', RATE_LIMIT_OTP_REQUEST_PER_HOUR: '2', RATE_LIMIT_SOS_PER_MINUTE: '100' });
    expect(parsed.rateLimits.otpRequest).toEqual({ limit: 2, windowSeconds: 3600 });
    expect(parsed.rateLimits.sos).toEqual({ limit: 100, windowSeconds: 60 });
  });

  it('otp/request: 5 allowed per hour per IP, 6th is 429 with Retry-After', async () => {
    const res = await fire(app, 6, (i) =>
      request(app.getHttpServer()).post('/api/v1/auth/otp/request').send({ phone: `+9230011${10000 + i}`, device_fingerprint: `rl-test-${i}` }),
    );
    for (const r of res.slice(0, 5)) expect(r.status).toBe(202);
    expectRateLimited(res[5]);
  });

  it('otp/verify: 10 allowed per hour per IP, 11th is 429 (not OTP_LOCKED)', async () => {
    // Distinct phones, no OTP seeded: the service answers 400 OTP_EXPIRED
    // before recording any failure, so only the guard can produce the 429.
    const res = await fire(app, 11, (i) =>
      request(app.getHttpServer()).post('/api/v1/auth/otp/verify').send({ phone: `+9230012${10000 + i}`, code: '123456', device_fingerprint: `rl-test-v${i}` }),
    );
    for (const r of res.slice(0, 10)) {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('OTP_EXPIRED');
    }
    expectRateLimited(res[10]);
  });

  it('refresh: 30 allowed per hour, 31st is 429', async () => {
    const res = await fire(app, 31, () =>
      request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refresh_token: 'x'.repeat(64) }),
    );
    for (const r of res.slice(0, 30)) expect(r.status).toBe(401);
    expectRateLimited(res[30]);
  });

  it('search: 60 allowed per minute, 61st is 429', async () => {
    const res = await fire(app, 61, () => request(app.getHttpServer()).get('/api/v1/search?q=ac'));
    for (const r of res.slice(0, 60)) expect(r.status).not.toBe(429);
    if (HAS_DB) for (const r of res.slice(0, 60)) expect(r.status).toBe(200);
    expectRateLimited(res[60]);
  });

  it('providers/nearby: 60 allowed per minute, 61st is 429', async () => {
    const res = await fire(app, 61, () => request(app.getHttpServer()).get('/api/v1/providers/nearby?lat=30.18&lng=66.99'));
    for (const r of res.slice(0, 60)) expect(r.status).not.toBe(429);
    if (HAS_DB) for (const r of res.slice(0, 60)) expect(r.status).toBe(200);
    expectRateLimited(res[60]);
  });

  it('POST /requests: 30 allowed per hour per user, 31st is 429', async () => {
    const res = await fire(app, 31, () =>
      request(app.getHttpServer()).post('/api/v1/requests').set('Authorization', `Bearer ${CUSTOMER_A_TOKEN}`).send(VALID_REQUEST),
    );
    for (const r of res.slice(0, 30)) expect(r.status).not.toBe(429);
    if (HAS_DB) for (const r of res.slice(0, 30)) expect(r.status).toBe(201);
    expectRateLimited(res[30]);
  });

  it('limits are per-user: user A exhausted does not block user B', async () => {
    const a = await fire(app, 31, () =>
      request(app.getHttpServer()).post('/api/v1/requests').set('Authorization', `Bearer ${CUSTOMER_A_TOKEN}`).send(VALID_REQUEST),
    );
    expectRateLimited(a[30]);
    const b = await request(app.getHttpServer()).post('/api/v1/requests').set('Authorization', `Bearer ${CUSTOMER_B_TOKEN}`).send(VALID_REQUEST);
    expect(b.status).not.toBe(429);
    if (HAS_DB) expect(b.status).toBe(201);
  });

  it('offers: 60 allowed per hour, 61st is 429', async () => {
    const res = await fire(app, 61, () =>
      request(app.getHttpServer()).post(`/api/v1/requests/${REQ_ID}/offers`).set('Authorization', `Bearer ${PROVIDER_TOKEN}`).send({ price: 2500, eta_minutes: 60 }),
    );
    for (const r of res.slice(0, 60)) expect(r.status).not.toBe(429);
    expectRateLimited(res[60]);
  });

  it('messages: 60 allowed per minute, 61st is 429', async () => {
    const res = await fire(app, 61, () =>
      request(app.getHttpServer()).post(`/api/v1/chats/${CHAT_ID}/messages`).set('Authorization', `Bearer ${CUSTOMER_A_TOKEN}`).send({ body: 'hello' }),
    );
    for (const r of res.slice(0, 60)) expect(r.status).not.toBe(429);
    expectRateLimited(res[60]);
  });

  it('reports: 10 allowed per hour, 11th is 429', async () => {
    const res = await fire(app, 11, () =>
      request(app.getHttpServer()).post('/api/v1/reports').set('Authorization', `Bearer ${CUSTOMER_A_TOKEN}`).send({ context: 'chat', reason_code: 'spam' }),
    );
    for (const r of res.slice(0, 10)) expect(r.status).not.toBe(429);
    expectRateLimited(res[10]);
  });

  it('blocks: 10 allowed per hour on its own bucket, 11th is 429', async () => {
    const res = await fire(app, 11, () =>
      request(app.getHttpServer()).post('/api/v1/blocks').set('Authorization', `Bearer ${CUSTOMER_A_TOKEN}`).send({ blocked_id: CUSTOMER_B }),
    );
    for (const r of res.slice(0, 10)) expect(r.status).toBe(HAS_DB ? 201 : 500);
    expectRateLimited(res[10]);
  });

  it('sos: 30 allowed per minute (high limit — throttled, never fully blocked), 31st is 429 with Retry-After', async () => {
    const res = await fire(app, 31, () =>
      request(app.getHttpServer()).post('/api/v1/sos').set('Authorization', `Bearer ${CUSTOMER_A_TOKEN}`).send({ lat: 30.18, lng: 66.99 }),
    );
    for (const r of res.slice(0, 30)) expect(r.status).not.toBe(429);
    if (HAS_DB) for (const r of res.slice(0, 30)) expect(r.status).toBe(202);
    expectRateLimited(res[30]);
    // Retry-After is at most the 60s window: the caller waits, not blocked.
    expect(Number(res[30].headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('unlimited routes are not throttled: 5 fast GET /me calls stay 401/200, never 429', async () => {
    const res = await fire(app, 5, () => request(app.getHttpServer()).get('/api/v1/me'));
    for (const r of res) expect(r.status).not.toBe(429);
  });
});
