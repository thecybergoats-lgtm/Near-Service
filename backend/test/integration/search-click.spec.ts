// POST /search/click — click recording for search CTR (Phase 4, item 1,
// integrator wiring). REAL Postgres 16 + PostGIS 3 and REAL Redis. Run with:
//   DATABASE_URL="postgresql://root@/nearservice_p4_click?host=/var/run/postgresql" \
//   REDIS_URL=redis://localhost:6379 NODE_ENV=test \
//   npx jest --config test/jest.config.js --runInBand test/integration/search-click.spec.ts
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies db/0001–0004 + 0016. Only ever point it at the dedicated test
// DB nearservice_p4_click. Skipped entirely when DATABASE_URL or REDIS_URL
// is not set.
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { SearchModule } from '../../src/modules/search/search.module';
import { SearchMetricsService } from '../../src/modules/search/search-metrics.service';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { createValidationPipe } from '../../src/common/validation/validation-pipe';

jest.setTimeout(60000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const MIGRATIONS = [
  '0001_init.sql', '0002_requests_jobs.sql', '0003_money_trust.sql',
  '0004_seed.sql', '0016_search_scaleout.sql',
];

maybeDescribe('POST /search/click (real DB + Redis)', () => {
  let admin: Client;
  let app: INestApplication;
  let metrics: SearchMetricsService;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    for (const file of MIGRATIONS) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    const mod = await Test.createTestingModule({ imports: [SearchModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    metrics = mod.get(SearchMetricsService);
  });

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  it('records a click without a query event id', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/search/click')
      .send({ target_type: 'provider', target_id: '00000000-0000-4000-8000-000000000101' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recorded: true });
    const n = (await admin.query(`SELECT count(*)::int AS n FROM search_click_events`)).rows[0].n as number;
    expect(n).toBe(1);
  });

  it('records a click against a real query event and the window CTR sees it', async () => {
    const eventId = await metrics.recordQuery({
      query: 'ac repair', provider: 'trigram', cacheHit: false, latencyMs: 42, resultCount: 3,
    });
    expect(eventId).toBeTruthy();
    const res = await request(app.getHttpServer())
      .post('/api/v1/search/click')
      .send({ query_event_id: eventId, target_type: 'category', target_id: '00000000-0000-4000-8000-000000000002' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recorded: true });
    const row = (await admin.query(
      `SELECT query_event_id, target_type FROM search_click_events WHERE query_event_id=$1`,
      [eventId],
    )).rows[0];
    expect(row.target_type).toBe('category');
    const stats = await metrics.windowStats(24);
    expect(stats.clicks).toBeGreaterThanOrEqual(2);
    expect(stats.click_through_rate).not.toBeNull();
  });

  it('rejects an invalid target_type with 422 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/search/click')
      .send({ target_type: 'shop', target_id: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
