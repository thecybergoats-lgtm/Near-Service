// Search scale-out — integration tests (Phase 4, item 1).
// REAL Postgres 16 + PostGIS 3 and REAL Redis. Run with:
//   DATABASE_URL=postgresql://root@/nearservice_p4_search?host=/var/run/postgresql
//   REDIS_URL=redis://localhost:6379 NODE_ENV=test
//   npx jest --config test/jest.config.js --runInBand test/integration/search-scaleout.spec.ts
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies db/0001–0004 + 0016 (the only migrations this piece depends
// on — other Phase 4 workers' migrations are intentionally NOT applied
// here, so their state can never break this piece's tests).
// Only ever point it at the dedicated test DB nearservice_p4_search.
// Skipped entirely when DATABASE_URL or REDIS_URL is not set.
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { SearchModule } from '../../src/modules/search/search.module';
import { CatalogModule } from '../../src/modules/catalog/catalog.module';
import { CatalogService } from '../../src/modules/catalog/catalog.service';
import { TrigramSearchProvider } from '../../src/modules/search/trigram-search.provider';
import { ScaledSearchProvider } from '../../src/modules/search/scaled-search.provider';
import { SearchGatewayService } from '../../src/modules/search/search-gateway.service';
import { SearchMetricsService } from '../../src/modules/search/search-metrics.service';
import { SearchCacheService } from '../../src/modules/search/search-cache.service';
import { SearchAdminController } from '../../src/modules/search/search-admin.controller';

jest.setTimeout(60000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const MIGRATIONS = [
  '0001_init.sql', '0002_requests_jobs.sql', '0003_money_trust.sql',
  '0004_seed.sql', '0016_search_scaleout.sql',
];

// Quetta centre (seeded providers sit within a few km of here).
const LAT = 30.1798;
const LNG = 66.9750;

/** Poll the DB until `check` returns true (metrics recording is
 *  fire-and-forget in the gateway, so events land just after the call). */
async function waitFor(admin: Client, check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

maybeDescribe('search scale-out (real DB + Redis)', () => {
  let admin: Client;
  let trigram: TrigramSearchProvider;
  let scaled: ScaledSearchProvider;
  let gateway: SearchGatewayService;
  let metrics: SearchMetricsService;
  let cache: SearchCacheService;
  let controller: SearchAdminController;
  let catalog: CatalogService;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    for (const file of MIGRATIONS) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    const mod = await Test.createTestingModule({ imports: [SearchModule, CatalogModule] }).compile();
    trigram = mod.get(TrigramSearchProvider);
    scaled = mod.get(ScaledSearchProvider);
    gateway = mod.get(SearchGatewayService);
    metrics = mod.get(SearchMetricsService);
    cache = mod.get(SearchCacheService);
    controller = mod.get(SearchAdminController);
    catalog = mod.get(CatalogService);
    await mod.close().catch(() => undefined);
  });

  afterAll(async () => {
    delete process.env.SEARCH_PROVIDER;
    await admin?.end();
  });

  it('migration 0016 created the search tables, vectors and gate seeds', async () => {
    const tables = (await admin.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name LIKE 'search_%' ORDER BY 1`,
    )).rows.map((r) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining([
      'search_query_events', 'search_click_events', 'search_gate_config', 'search_metrics_daily',
    ]));
    const vec = (await admin.query(
      `SELECT to_tsvector('simple','book binding') IS NOT NULL AS ok,
              (SELECT count(*)::int FROM categories WHERE search_vector @@ plainto_tsquery('simple','binding')) AS hits`,
    )).rows[0];
    expect(vec.ok).toBe(true);
    expect(vec.hits).toBeGreaterThan(0);
    const cfg = (await admin.query(`SELECT count(*)::int AS n FROM search_gate_config`)).rows[0].n;
    expect(cfg).toBe(6);
  });

  it('trigram provider finds the seeded Book Binding category + nearby providers', async () => {
    const res = await trigram.search({ q: 'book binding', lat: LAT, lng: LNG });
    expect(res.categories.map((c) => c.slug)).toContain('book-binding');
    expect(res.providers.items.length).toBeGreaterThan(0);
    expect(res.providers.items[0]).toHaveProperty('distance_km');
    expect(res.providers.next_cursor).toBeNull();
  });

  it('trigram provider returns the empty shape for a blank query', async () => {
    const res = await trigram.search({ q: '   ' });
    expect(res).toEqual({ categories: [], providers: { items: [], next_cursor: null } });
  });

  it('scaled provider recall is a superset of the trigram provider', async () => {
    const queries = ['book binding', 'ac repair', 'bijli wala', 'electrican', 'jild saazi'];
    for (const q of queries) {
      const a = await trigram.search({ q, lat: LAT, lng: LNG });
      const b = await scaled.search({ q, lat: LAT, lng: LNG });
      const aIds = new Set(a.categories.map((c) => c.id));
      const bIds = new Set(b.categories.map((c) => c.id));
      for (const id of aIds) expect(bIds.has(id)).toBe(true);
    }
    // Typo tolerance comes from the trigram half of the blend.
    const typo = await scaled.search({ q: 'electrican', lat: LAT, lng: LNG });
    expect(typo.categories.map((c) => c.slug)).toContain('electrician');
  });

  it('scaled provider caches in Redis and invalidation forces a fresh miss', async () => {
    process.env.SEARCH_PROVIDER = 'scaled';
    try {
      await cache.invalidateAll('test-setup');
      const before = (await admin.query(`SELECT count(*)::int AS n FROM search_query_events`)).rows[0].n as number;
      await gateway.search({ q: 'plumber', lat: LAT, lng: LNG });
      await gateway.search({ q: 'plumber', lat: LAT, lng: LNG });
      await waitFor(admin, async () => {
        const n = (await admin.query(`SELECT count(*)::int AS n FROM search_query_events`)).rows[0].n as number;
        return n >= before + 2;
      }, 'two search events to be recorded');
      const hits = (await admin.query(
        `SELECT cache_hit FROM search_query_events WHERE query='plumber' ORDER BY created_at ASC LIMIT 2`,
      )).rows.map((r) => r.cache_hit);
      expect(hits).toEqual([false, true]);
      // Invalidate: the next identical search must miss the cache again.
      await cache.invalidateAll('test-invalidation');
      await gateway.search({ q: 'plumber', lat: LAT, lng: LNG });
      await waitFor(admin, async () => {
        const rows = (await admin.query(
          `SELECT cache_hit FROM search_query_events WHERE query='plumber' ORDER BY created_at DESC LIMIT 1`,
        )).rows;
        return rows.length === 1 && rows[0].cache_hit === false;
      }, 'post-invalidation search to be recorded as a miss');
    } finally {
      delete process.env.SEARCH_PROVIDER;
    }
  });

  it('gateway strips the internal cache-hit marker from the response', async () => {
    process.env.SEARCH_PROVIDER = 'scaled';
    try {
      await cache.invalidateAll('test-marker');
      await gateway.search({ q: 'ac repair', lat: LAT, lng: LNG });
      const res = await gateway.search({ q: 'ac repair', lat: LAT, lng: LNG });
      expect((res as unknown as Record<string, unknown>).__cacheHit).toBeUndefined();
    } finally {
      delete process.env.SEARCH_PROVIDER;
    }
  });

  it('metrics window stats, clicks, gate and rollup all work end to end', async () => {
    const eventId = await metrics.recordQuery({ query: 'gate probe', provider: 'trigram', cacheHit: false, latencyMs: 42, resultCount: 3 });
    expect(eventId).toBeTruthy();
    await metrics.recordClick({ queryEventId: eventId, targetType: 'category', targetId: '00000000-0000-4000-8000-0000b0000001' });
    const s = await metrics.windowStats(24);
    expect(s.queries).toBeGreaterThan(0);
    expect(s.clicks).toBeGreaterThan(0);
    expect(s.click_through_rate).not.toBeNull();
    expect(s.latency_p50_ms).not.toBeNull();

    // Gate with default thresholds: too few queries to judge.
    const g1 = await metrics.evaluateGate();
    expect(g1.decision).toBe('stay_in_process');
    expect(g1.reasons[0]).toMatch(/insufficient data/);

    // Lower the bar so the gate can judge, then force a breach.
    const saved = await metrics.thresholds();
    await metrics.updateThresholds({ min_queries_for_gate: 1, p95_latency_ms: 1 });
    const g2 = await metrics.evaluateGate();
    expect(g2.decision).toBe('switch_on_dedicated_tier');
    expect(g2.breached).toContain('p95_latency');
    await metrics.updateThresholds(saved);

    // Rollup writes the daily row.
    const today = new Date().toISOString().slice(0, 10);
    await metrics.rollupDaily(today);
    const rows = (await admin.query(
      `SELECT queries FROM search_metrics_daily WHERE day=$1::date AND provider='all'`, [today],
    )).rows;
    expect(rows.length).toBe(1);
    expect(rows[0].queries).toBeGreaterThan(0);
  });

  it('admin controller exposes metrics + gate + threshold update', async () => {
    const view = await controller.metricsView({ window_hours: 24, days: 7 });
    expect(view.window.queries).toBeGreaterThan(0);
    expect(view.gate).toHaveProperty('decision');
    expect(Array.isArray(view.daily)).toBe(true);
    const gate = await controller.gate();
    expect(gate.thresholds.p95_latency_ms).toBe(500);
    const updated = await controller.updateThresholds({ p95_latency_ms: 600 });
    expect(updated.p95_latency_ms).toBe(600);
    await controller.updateThresholds({ p95_latency_ms: 500 });
  });

  it('CatalogService.search still serves GET /search through the gateway', async () => {
    const res = await catalog.search('book binding', LAT, LNG, 'en', undefined, 20);
    expect(res.categories.map((c) => c.slug)).toContain('book-binding');
    expect(res.providers.items.length).toBeGreaterThan(0);
  });
});
