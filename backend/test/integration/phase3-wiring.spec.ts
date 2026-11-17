// Phase 3 wiring test — proves every new module is actually registered in
// the Nest app (not just present on disk), by booting the REAL AppModule
// and hitting at least one route per new module.
//
// No-DB checks run always (public health + auth-guard 401s + 422s).
// DB checks run only when DATABASE_URL + REDIS_URL are set: the DB part
// drops the public schema and re-applies db/0001–0015, exactly like the
// other integration specs — point it at a DEDICATED test DB only, e.g.:
//   DATABASE_URL=postgresql://localhost/nearservice_p3_tenders
//   REDIS_URL=redis://localhost:6379 NODE_ENV=test
//   npx jest --runInBand --forceExit test/integration/phase3-wiring.spec.ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { createValidationPipe } from '../../src/common/validation/validation-pipe';
import { env } from '../../src/config/env';

jest.setTimeout(60000);

async function bootApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

function tokenFor(userId: string, roles: string[]): string {
  return jwt.sign(
    { sub: userId, phone: '+923001234567', roles },
    env.jwtAccessSecret,
    { expiresIn: 600 },
  );
}

describe('Phase 3 wiring — every new module answers on the real app', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
  });
  const api = () => request(app.getHttpServer());

  it('AI Gateway: GET /ai/health is public and reports the local provider', async () => {
    const res = await api().get('/api/v1/ai/health');
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('local');
    expect(res.body.capabilities).toMatchObject({ intent: true, photo: true, voiceStt: false, translation: true });
  });

  it('AI Gateway: POST /ai/intent parses without a DB (built-in taxonomy fallback)', async () => {
    const res = await api().post('/api/v1/ai/intent').send({ text: 'AC repair karwana hai' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('confidence');
    // The service spreads the provider's ParsedIntent verbatim (camelCase).
    expect(res.body).toHaveProperty('fallbackToKeywordSearch');
    expect(res.body.service.category_slug).toBe('ac-repair');
    expect(res.body.provider).toBe('local');
  });

  it('AI Gateway: POST /ai/intent rejects an empty body with 422', async () => {
    const res = await api().post('/api/v1/ai/intent').send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('AI Gateway: POST /ai/voice-search without a transcript is 401 (Bearer required)', async () => {
    const res = await api().post('/api/v1/ai/voice-search').send({ transcript: 'test' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('wiring: every other new module rejects unauthenticated calls with 401 (route exists, guard wired)', async () => {
    const unauthenticated: Array<[string, string]> = [
      ['get', '/api/v1/risk/me'],
      ['get', '/api/v1/subscription-plans'],
      ['get', '/api/v1/subscriptions/me'],
      ['get', '/api/v1/teams'],
      ['get', '/api/v1/tenders/open'],
      ['get', '/api/v1/verification/review-queue'],
      ['get', '/api/v1/admin/escrow/config'],
      ['get', '/api/v1/admin/risk/settings'],
      ['get', '/api/v1/admin/subscriptions'],
      ['get', '/api/v1/escrow/holds'],
      ['get', '/api/v1/payouts'],
    ];
    for (const [method, url] of unauthenticated) {
      const res = await (api() as any)[method](url);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });
});

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

maybeDescribe('Phase 3 wiring — authenticated checks (real Postgres + Redis)', () => {
  let app: INestApplication;
  let admin: Client;
  const api = () => request(app.getHttpServer());

  const providerUserId = crypto.randomUUID();
  const officerUserId = crypto.randomUUID();
  const superAdminUserId = crypto.randomUUID();
  // Per-run unique phones: the seed data already holds fixed demo phones,
  // and users.phone is unique — fixed phones collide (uq_users_phone_live).
  const RUN = String(crypto.randomInt(100000, 999999));
  const providerToken = tokenFor(providerUserId, ['provider']);
  const officerToken = tokenFor(officerUserId, ['verification_officer']);
  const superAdminToken = tokenFor(superAdminUserId, ['super_admin']);

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    const files = fs.readdirSync(dbDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(files).toContain('0015_escrow_payouts.sql');
    for (const file of files) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    for (const [id, phone, role] of [
      [providerUserId, `+92301${RUN}11`, 'provider'],
      [officerUserId, `+92301${RUN}22`, 'verification_officer'],
      [superAdminUserId, `+92301${RUN}33`, 'super_admin'],
    ] as const) {
      await admin.query(`INSERT INTO users (id, phone, full_name, language) VALUES ($1,$2,'Phase3 Wiring','en')`, [id, phone]);
      await admin.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name=$2`, [id, role]);
    }
    await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, base_point) VALUES ($1,'INDIVIDUAL','Wiring Provider', ST_SetSRID(ST_MakePoint(66.975,30.1798),4326)::geography)`,
      [providerUserId],
    );
    app = await bootApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.end();
  });

  it('Risk: GET /risk/me returns a zero score for a never-scored user', async () => {
    const res = await api().get('/api/v1/risk/me').set('Authorization', `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(0);
    expect(res.body.level).toBe('low');
  });

  it('Subscriptions: GET /subscription-plans lists plans; GET /subscriptions/me is Free', async () => {
    const plans = await api().get('/api/v1/subscription-plans').set('Authorization', `Bearer ${providerToken}`);
    expect(plans.status).toBe(200);
    expect(Array.isArray(plans.body)).toBe(true);
    expect(plans.body.map((p: any) => p.code)).toEqual(expect.arrayContaining(['free']));
    const mine = await api().get('/api/v1/subscriptions/me').set('Authorization', `Bearer ${providerToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.plan_code).toBe('free');
  });

  it('Teams: GET /teams returns an empty page for a provider with no team', async () => {
    const res = await api().get('/api/v1/teams').set('Authorization', `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.next_cursor).toBeNull();
  });

  it('Tenders: GET /tenders/open returns an empty page for providers', async () => {
    const res = await api().get('/api/v1/tenders/open').set('Authorization', `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('Tenders: POST /admin/tenders/expire-due sweeps zero due tenders', async () => {
    const res = await api().post('/api/v1/admin/tenders/expire-due').set('Authorization', `Bearer ${superAdminToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.expired_count).toBe(0);
    expect(res.body.checked_count).toBe(0);
  });

  it('Verification: GET /verification/review-queue is empty for officers', async () => {
    const res = await api().get('/api/v1/verification/review-queue').set('Authorization', `Bearer ${officerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('Escrow: GET /admin/escrow/config returns the sandbox defaults', async () => {
    const res = await api().get('/api/v1/admin/escrow/config').set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.auto_release_hours).toBe(48);
    expect(res.body.min_amount_paisa).toBe(500000);
  });

  it('AI Gateway: GET /ai/fair-price answers for a seeded category', async () => {
    const res = await api().get('/api/v1/ai/fair-price').query({ category_slug: 'book-binding' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('category_id');
    expect(res.body).toHaveProperty('sample_size');
  });
});
