// Search scale-out — unit tests (Phase 4, item 1). No database, no
// Redis: pure gate logic, cache keys, config parsing, gateway provider
// selection + fallback, and the remote provider against a local HTTP
// server. Run with: npx jest --runInBand test/unit/search-scaleout.spec.ts
import * as http from 'http';
import { AddressInfo } from 'net';
import {
  evaluateGateDecision,
  DEFAULT_GATE_THRESHOLDS,
  SearchWindowStats,
} from '../../src/modules/search/search-metrics.service';
import { buildSearchCacheKey, normaliseSearchParams } from '../../src/modules/search/search-cache.service';
import { readSearchConfig } from '../../src/modules/search/search.config';
import { SearchGatewayService } from '../../src/modules/search/search-gateway.service';
import { RemoteSearchProvider } from '../../src/modules/search/remote-search.provider';
import { SearchProvider } from '../../src/modules/search/search-provider.interface';
import { SearchQuery, SearchResult } from '../../src/modules/search/search.types';

function stats(over: Partial<SearchWindowStats>): SearchWindowStats {
  return {
    window_hours: 24, queries: 200, zero_result_queries: 10, zero_result_rate: 0.05,
    cache_hits: 50, cache_hit_rate: 0.25, clicks: 20, click_through_rate: 0.1,
    latency_p50_ms: 80, latency_p95_ms: 200, queries_per_day: 200, ...over,
  };
}

const EMPTY_RESULT: SearchResult = { categories: [], providers: { items: [], next_cursor: null } };
const stubProvider = (name: 'trigram' | 'scaled', result: SearchResult = EMPTY_RESULT, fail = false): SearchProvider => ({
  name,
  search: async () => {
    if (fail) throw new Error(`${name} boom`);
    return JSON.parse(JSON.stringify(result)) as SearchResult;
  },
});
const stubMetrics = () => {
  const calls: unknown[] = [];
  return {
    calls,
    recordQuery: async (e: unknown) => { calls.push(e); return 'event-id'; },
    recordClick: async () => true,
  };
};

describe('search metrics gate (pure decision)', () => {
  it('stays in-process when every metric is within thresholds', () => {
    const r = evaluateGateDecision(stats({}), DEFAULT_GATE_THRESHOLDS);
    expect(r.decision).toBe('stay_in_process');
    expect(r.breached).toEqual([]);
  });

  it('abstains (stay) when the sample is below min_queries_for_gate', () => {
    const r = evaluateGateDecision(
      stats({ queries: 5, latency_p95_ms: 9999, zero_result_rate: 0.9 }),
      DEFAULT_GATE_THRESHOLDS,
    );
    expect(r.decision).toBe('stay_in_process');
    expect(r.reasons[0]).toMatch(/insufficient data/);
  });

  it('switches on when p95 latency breaches', () => {
    const r = evaluateGateDecision(stats({ latency_p95_ms: 501 }), DEFAULT_GATE_THRESHOLDS);
    expect(r.decision).toBe('switch_on_dedicated_tier');
    expect(r.breached).toContain('p95_latency');
  });

  it('switches on when the zero-result rate breaches', () => {
    const r = evaluateGateDecision(
      stats({ zero_result_queries: 60, zero_result_rate: 0.3 }),
      DEFAULT_GATE_THRESHOLDS,
    );
    expect(r.decision).toBe('switch_on_dedicated_tier');
    expect(r.breached).toContain('zero_result_rate');
  });

  it('switches on when CTR falls below the floor — but only when clicks exist', () => {
    const withClicks = evaluateGateDecision(
      stats({ clicks: 4, click_through_rate: 0.02 }),
      DEFAULT_GATE_THRESHOLDS,
    );
    expect(withClicks.decision).toBe('switch_on_dedicated_tier');
    expect(withClicks.breached).toContain('click_through_rate');
    // No clicks recorded at all: CTR is null (no data), never a breach.
    const noClicks = evaluateGateDecision(
      stats({ clicks: 0, click_through_rate: null }),
      DEFAULT_GATE_THRESHOLDS,
    );
    expect(noClicks.breached).not.toContain('click_through_rate');
  });

  it('switches on when volume breaches', () => {
    const r = evaluateGateDecision(stats({ queries_per_day: 10001 }), DEFAULT_GATE_THRESHOLDS);
    expect(r.decision).toBe('switch_on_dedicated_tier');
    expect(r.breached).toContain('query_volume');
  });

  it('lists every breached condition, not just the first', () => {
    const r = evaluateGateDecision(
      stats({ latency_p95_ms: 900, zero_result_queries: 80, zero_result_rate: 0.4 }),
      DEFAULT_GATE_THRESHOLDS,
    );
    expect(r.breached).toEqual(expect.arrayContaining(['p95_latency', 'zero_result_rate']));
  });
});

describe('search cache keys', () => {
  const q: SearchQuery = { q: 'AC Repair', lat: 30.17981, lng: 66.97501, locale: 'en', limit: 20 };
  it('is deterministic for the same query', () => {
    expect(buildSearchCacheKey(q, 3)).toBe(buildSearchCacheKey(q, 3));
  });
  it('changes with the generation (invalidation) and with the query', () => {
    expect(buildSearchCacheKey(q, 3)).not.toBe(buildSearchCacheKey(q, 4));
    expect(buildSearchCacheKey(q, 3)).not.toBe(buildSearchCacheKey({ ...q, q: 'plumber' }, 3));
  });
  it('is case-insensitive and rounds GPS jitter so near-identical locations share an entry', () => {
    const a = normaliseSearchParams(q);
    const b = normaliseSearchParams({ ...q, q: '  ac repair ', lat: 30.17984, lng: 66.97504 });
    expect(a).toBe(b);
  });
});

describe('search config', () => {
  it('defaults to the trigram provider, cache on, 120s TTL', () => {
    expect(readSearchConfig({})).toEqual({ provider: 'trigram', serviceUrl: undefined, cacheEnabled: true, cacheTtlSeconds: 120 });
  });
  it('honours SEARCH_PROVIDER=scaled, SEARCH_SERVICE_URL and TTL', () => {
    const cfg = readSearchConfig({ SEARCH_PROVIDER: 'scaled', SEARCH_SERVICE_URL: 'http://search:3000', SEARCH_CACHE_TTL_SECONDS: '30' });
    expect(cfg.provider).toBe('scaled');
    expect(cfg.serviceUrl).toBe('http://search:3000');
    expect(cfg.cacheTtlSeconds).toBe(30);
  });
  it('falls back to trigram on an unknown provider name and to 120 on a bad TTL', () => {
    const cfg = readSearchConfig({ SEARCH_PROVIDER: 'elastic', SEARCH_CACHE_TTL_SECONDS: 'nope' });
    expect(cfg.provider).toBe('trigram');
    expect(cfg.cacheTtlSeconds).toBe(120);
  });
  it('SEARCH_CACHE_ENABLED=false disables the cache', () => {
    expect(readSearchConfig({ SEARCH_CACHE_ENABLED: 'false' }).cacheEnabled).toBe(false);
  });
});

describe('search gateway selection + fallback', () => {
  it('selects remote when a service URL is set, scaled when configured, trigram otherwise', () => {
    expect(SearchGatewayService.selectProviderName({ provider: 'trigram', serviceUrl: 'http://s:3000' })).toBe('remote');
    expect(SearchGatewayService.selectProviderName({ provider: 'scaled', serviceUrl: undefined })).toBe('scaled');
    expect(SearchGatewayService.selectProviderName({ provider: 'trigram', serviceUrl: undefined })).toBe('trigram');
  });

  it('uses the trigram provider by default and records the serving provider', async () => {
    const metrics = stubMetrics();
    const gw = new SearchGatewayService(
      stubProvider('trigram') as never, stubProvider('scaled') as never, metrics as never,
    );
    const res = await gw.search({ q: 'test' });
    expect(res).toEqual(EMPTY_RESULT);
    expect(metrics.calls).toHaveLength(1);
    expect(metrics.calls[0]).toMatchObject({ provider: 'trigram', query: 'test', cacheHit: false });
  });

  it('falls back to trigram when the scaled provider throws, and records trigram as the server', async () => {
    const metrics = stubMetrics();
    const OLD = process.env.SEARCH_PROVIDER;
    process.env.SEARCH_PROVIDER = 'scaled';
    try {
      const gw = new SearchGatewayService(
        stubProvider('trigram') as never, stubProvider('scaled', EMPTY_RESULT, true) as never, metrics as never,
      );
      const res = await gw.search({ q: 'test' });
      expect(res).toEqual(EMPTY_RESULT);
      expect(metrics.calls[0]).toMatchObject({ provider: 'trigram' });
    } finally {
      if (OLD === undefined) delete process.env.SEARCH_PROVIDER; else process.env.SEARCH_PROVIDER = OLD;
    }
  });

  it('strips the scaled provider __cacheHit marker before returning', async () => {
    const metrics = stubMetrics();
    const scaled = stubProvider('scaled', { ...EMPTY_RESULT, __cacheHit: true } as unknown as SearchResult);
    const OLD = process.env.SEARCH_PROVIDER;
    process.env.SEARCH_PROVIDER = 'scaled';
    try {
      const gw = new SearchGatewayService(
        stubProvider('trigram') as never, scaled as never, metrics as never,
      );
      const res = await gw.search({ q: 'test' });
      expect((res as unknown as Record<string, unknown>).__cacheHit).toBeUndefined();
      expect(metrics.calls[0]).toMatchObject({ cacheHit: true });
    } finally {
      if (OLD === undefined) delete process.env.SEARCH_PROVIDER; else process.env.SEARCH_PROVIDER = OLD;
    }
  });
});

describe('remote search provider', () => {
  let server: http.Server;
  let baseUrl: string;
  let mode: 'ok' | 'error' | 'malformed' = 'ok';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (mode === 'error') { res.writeHead(500); res.end('boom'); return; }
      if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"nope":true}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ categories: [{ id: 'c1', slug: 'ac-repair', name_en: 'AC Repair', name_ur: null, name_roman: null, level: 2, sim: 0.9 }], providers: { items: [], next_cursor: null } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('forwards the query and returns the remote SearchResults body', async () => {
    mode = 'ok';
    const p = new RemoteSearchProvider(baseUrl);
    const res = await p.search({ q: 'AC repair', lat: 30.18, lng: 66.97 });
    expect(res.categories[0].slug).toBe('ac-repair');
  });

  it('throws on a remote 500 so the gateway can fall back', async () => {
    mode = 'error';
    const p = new RemoteSearchProvider(baseUrl);
    await expect(p.search({ q: 'x' })).rejects.toThrow(/remote search 500/);
  });

  it('throws on a malformed remote body instead of passing it through', async () => {
    mode = 'malformed';
    const p = new RemoteSearchProvider(baseUrl);
    await expect(p.search({ q: 'x' })).rejects.toThrow(/malformed/);
  });
});
