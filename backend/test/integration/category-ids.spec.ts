// Fix A — every category id returned by GET /categories must be accepted
// as category_id everywhere it is sent (RFC-4122 v4 UUIDs since
// db/0021_fix_seed_uuids.sql rewrote the old version-0 seeds).
// Regression test for POST /requests returning 422 VALIDATION_FAILED
// "category_id must be a UUID" on ids copied from GET /categories.
//
// For EVERY id from GET /categories (all levels, flattened from the tree)
// this test calls, with that id as category_id:
//   POST /requests, GET /pricing/fair-range, POST /waitlist,
//   PUT /providers/me/services, GET /providers/nearby
// and expects NO 422 on any of them. Ids are read live — none are
// hard-coded here, so the test also catches any future seed regression.
//
// REAL Postgres 16 + PostGIS 3 and REAL Redis. Run with:
//   DATABASE_URL=<redacted>
//   REDIS_URL=redis://localhost:6379 NODE_ENV=test npm test -- category-ids --runInBand
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0021. Only ever point it at a dedicated test DB.
// Skipped entirely when DATABASE_URL or REDIS_URL is not set.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { Client } from 'pg';
import Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { createValidationPipe } from '../../src/common/validation/validation-pipe';
import { env } from '../../src/config/env';

jest.setTimeout(120000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
const PHONE = (prefix: string, d: string) => `+92${prefix}${RUN}${d}`;
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

maybeDescribe('Fix A: seeded category ids are accepted as category_id (real DB + Redis)', () => {
  let app: INestApplication;
  let admin: Client;
  let providerUserId: string;
  let categoryIds: string[] = [];

  const tokenFor = (userId: string, roles: string[]) =>
    jwt.sign({ sub: userId, phone: `+92301${RUN}`, roles }, env.jwtAccessSecret, { expiresIn: 3600 });
  const api = () => request(app.getHttpServer());

  async function makeUser(phone: string): Promise<string> {
    return (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Category Ids Test','ur') RETURNING id`,
      [phone],
    )).rows[0].id as string;
  }

  // GET /providers/nearby is rate-limited 60/min per IP (anonymous) and
  // the Redis is shared across suites in a full run, so windows leak in
  // from earlier suites (same pattern as test/unit/rate-limit.spec.ts).
  // Flush them before and after this suite so its 33 nearby calls — and
  // later suites' calls — start from a clean window.
  async function flushRateLimits() {
    const raw = new Redis(process.env.REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    const keys = await raw.keys('rl:*');
    if (keys.length) await raw.del(...keys);
    raw.disconnect();
  }

  function flatten(nodes: any[], out: string[] = []): string[] {
    for (const n of nodes) {
      out.push(n.id as string);
      if (Array.isArray(n.children) && n.children.length) flatten(n.children, out);
    }
    return out;
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

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await flushRateLimits();

    // Provider actor for PUT /providers/me/services (needs a profile row).
    providerUserId = await makeUser(PHONE('301', '1'));
    await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, shop_name, base_point, tier, is_online)
       VALUES ($1,'SHOP','Category Ids Provider','Category Ids Shop',ST_SetSRID(ST_MakePoint(66.975,30.1798),4326)::geography,2,true)`,
      [providerUserId],
    );

    // The ids under test: every id GET /categories returns, all levels.
    const cats = await api().get('/api/v1/categories');
    expect(cats.status).toBe(200);
    categoryIds = flatten(cats.body as any[]);
    expect(categoryIds.length).toBe(33);
    for (const id of categoryIds) expect(id).toMatch(V4);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (admin) await admin.end();
    await flushRateLimits();
  });

  it('accepts every GET /categories id as category_id on all five endpoints (no 422)', async () => {
    const providerToken = tokenFor(providerUserId, ['provider']);
    const failures: string[] = [];
    let i = 0;
    for (const categoryId of categoryIds) {
      i += 1;
      // Fresh customer per POST /requests: create-request is rate-limited
      // 30/hour per user, and this loop posts 33 requests. Phone is unique
      // per iteration (+92 + '30' + RUN(6) + 2-digit i = 10 digits).
      const customerId = await makeUser(`+9230${RUN}${String(i).padStart(2, '0')}`);
      const customerToken = tokenFor(customerId, ['customer']);
      const lat = 30.1798 + i * 0.002;
      const lng = 66.975;

      const req = await api()
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('idempotency-key', `fix-a-${RUN}-${i}`)
        .send({ category_id: categoryId, fulfillment: 'PROVIDER_COMES', lat, lng, description: 'Fix A probe' });
      if (req.status !== 201) failures.push(`POST /requests ${categoryId} -> ${req.status} ${JSON.stringify(req.body).slice(0, 200)}`);

      const fair = await api().get('/api/v1/pricing/fair-range').query({ category_id: categoryId });
      if (fair.status !== 200) failures.push(`GET /pricing/fair-range ${categoryId} -> ${fair.status} ${JSON.stringify(fair.body).slice(0, 200)}`);

      const wait = await api()
        .post('/api/v1/waitlist')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ category_id: categoryId, lat, lng });
      if (wait.status !== 201 && wait.status !== 200) failures.push(`POST /waitlist ${categoryId} -> ${wait.status} ${JSON.stringify(wait.body).slice(0, 200)}`);

      const svc = await api()
        .put('/api/v1/providers/me/services')
        .set('Authorization', `Bearer ${providerToken}`)
        .send({ services: [{ category_id: categoryId, starting_price: 1000 }] });
      if (svc.status !== 200) failures.push(`PUT /providers/me/services ${categoryId} -> ${svc.status} ${JSON.stringify(svc.body).slice(0, 200)}`);

      const nearby = await api()
        .get('/api/v1/providers/nearby')
        .query({ lat: 30.1798, lng: 66.975, category_id: categoryId });
      if (nearby.status !== 200) failures.push(`GET /providers/nearby ${categoryId} -> ${nearby.status} ${JSON.stringify(nearby.body).slice(0, 200)}`);
    }
    expect(failures).toEqual([]);
  });
});
