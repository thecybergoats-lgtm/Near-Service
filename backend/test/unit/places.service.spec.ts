// Places (OpenStreetMap) — unit tests. No database, no Redis, no network:
// the Overpass call is a mocked fetch, the Redis cache is a stub.
// Run with: npx jest --runInBand test/unit/places.service.spec.ts
import {
  buildOverpassQuery,
  CATEGORY_OSM_TAGS,
  haversineKm,
  parseOverpassElements,
  placesCacheKey,
  PlacesService,
} from '../../src/modules/places/places.service';
import { RedisService } from '../../src/database/redis.service';

/** The real 5-shop payload Overpass returned live for Quetta centre
 *  (30.18, 66.975), 20 km, stationery/books/bookbinder (2026-11-18). */
const QUETTA_PAYLOAD = {
  elements: [
    { type: 'node', id: 1, lat: 30.1807, lon: 66.9669, tags: { name: 'Honar stationary', shop: 'books' } },
    { type: 'node', id: 2, lat: 30.1805, lon: 66.9674, tags: { name: 'Azhari stationary', shop: 'books' } },
    { type: 'node', id: 3, lat: 30.2143, lon: 67.0244, tags: { shop: 'books' } },
    { type: 'node', id: 4, lat: 30.1924, lon: 67.0147, tags: { name: 'N.B.D Book Shop', shop: 'stationery' } },
    { type: 'node', id: 5, lat: 30.1785, lon: 67.0101, tags: { name: 'Nashaqbandia Stationery', shop: 'stationery' } },
  ],
};

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function stubRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
  };
}

function makeService() {
  const redis = stubRedis();
  const svc = new PlacesService(redis as unknown as RedisService);
  return { svc, redis };
}

describe('places mapping (pure helpers)', () => {
  it('maps every launch category to OSM tags', () => {
    expect(Object.keys(CATEGORY_OSM_TAGS).sort()).toEqual([
      'ac-repair',
      'book-binding',
      'electrician',
      'mobile-repair',
      'plumber',
    ]);
    expect(CATEGORY_OSM_TAGS['book-binding']).toContainEqual({ key: 'shop', value: 'stationery' });
    expect(CATEGORY_OSM_TAGS['book-binding']).toContainEqual({ key: 'craft', value: 'bookbinder' });
    expect(CATEGORY_OSM_TAGS['plumber']).toContainEqual({ key: 'craft', value: 'plumber' });
  });

  it('builds an Overpass query with the required selectors', () => {
    const q = buildOverpassQuery(CATEGORY_OSM_TAGS['book-binding'], 30.18, 66.975, 20000);
    expect(q).toContain('[out:json][timeout:50]');
    expect(q).toContain('node["shop"="stationery"](around:20000,30.18,66.975)');
    expect(q).toContain('node["craft"="bookbinder"](around:20000,30.18,66.975)');
  });

  it('haversine: Quetta centre to Honar stationary is under 1 km', () => {
    expect(haversineKm(30.18, 66.975, 30.1807, 66.9669)).toBeLessThan(1);
    expect(haversineKm(30.18, 66.975, 30.18, 66.975)).toBe(0);
  });

  it('cache keys round coordinates to 3 decimals (~100 m cells)', () => {
    expect(placesCacheKey('book-binding', 30.17981, 66.97501, 20)).toBe(
      placesCacheKey('book-binding', 30.17982, 66.97502, 20),
    );
    expect(placesCacheKey('book-binding', 30.18, 66.975, 20)).not.toBe(
      placesCacheKey('book-binding', 30.18, 66.975, 5),
    );
  });

  it('parses the real Quetta payload: 5 shops sorted by distance', () => {
    const items = parseOverpassElements(QUETTA_PAYLOAD.elements as never, 30.18, 66.975);
    expect(items).toHaveLength(5);
    // Azhari (0.73 km) is closer than Honar (0.78 km); distances ascend.
    expect(items.map((i) => i.name)).toEqual([
      'Azhari stationary',
      'Honar stationary',
      'Nashaqbandia Stationery',
      'N.B.D Book Shop',
      'Unnamed shop',
    ]);
    expect(items.map((i) => i.distance_km)).toEqual([...items.map((i) => i.distance_km)].sort((a, b) => a - b));
    expect(items.every((i) => i.source === 'openstreetmap')).toBe(true);
    expect(items.find((i) => i.lat === 30.2143)?.name).toBe('Unnamed shop');
    expect(items.find((i) => i.name === 'N.B.D Book Shop')?.tags).toEqual({ shop: 'stationery' });
  });

  it('dedupes a node matching two selectors and drops elements without coords', () => {
    const items = parseOverpassElements(
      [
        { type: 'node', id: 9, lat: 30.18, lon: 66.97, tags: { name: 'Dup', shop: 'books', craft: 'bookbinder' } },
        { type: 'node', id: 9, lat: 30.18, lon: 66.97, tags: { name: 'Dup', shop: 'books', craft: 'bookbinder' } },
        { type: 'node', id: 10, tags: { name: 'NoCoords', shop: 'books' } },
      ] as never,
      30.18,
      66.975,
    );
    expect(items).toHaveLength(1);
    expect(items[0].tags).toEqual({ shop: 'books', craft: 'bookbinder' });
  });
});

describe('places service (mocked Overpass + stub Redis)', () => {
  it('returns live shops and sends the required Overpass headers', async () => {
    const { svc } = makeService();
    const fetchMock = jest.fn(async () => okResponse(QUETTA_PAYLOAD));
    svc.fetchImpl = fetchMock as unknown as typeof fetch;
    const res = await svc.nearby({ lat: 30.18, lng: 66.975, category_slug: 'book-binding' });
    expect(res.degraded).toBe(false);
    expect(res.items).toHaveLength(5);
    expect(res.items[0].name).toBe('Azhari stationary');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/NearService/);
    expect((init.headers as Record<string, string>).accept).toBe('application/json');
    expect(init.body as string).toContain('data=');
    expect(decodeURIComponent(init.body as string)).toContain('node["shop"="stationery"]');
  });

  it('serves the second identical call from cache without refetching', async () => {
    const { svc } = makeService();
    const fetchMock = jest.fn(async () => okResponse(QUETTA_PAYLOAD));
    svc.fetchImpl = fetchMock as unknown as typeof fetch;
    const q = { lat: 30.18, lng: 66.975, category_slug: 'book-binding' };
    const first = await svc.nearby(q);
    const second = await svc.nearby(q);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('shares cache entries inside the same ~100 m cell', async () => {
    const { svc } = makeService();
    const fetchMock = jest.fn(async () => okResponse(QUETTA_PAYLOAD));
    svc.fetchImpl = fetchMock as unknown as typeof fetch;
    await svc.nearby({ lat: 30.17981, lng: 66.97501, category_slug: 'book-binding' });
    await svc.nearby({ lat: 30.17982, lng: 66.97502, category_slug: 'book-binding' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('degrades (200-shaped) on empty Overpass result', async () => {
    const { svc } = makeService();
    svc.fetchImpl = jest.fn(async () => okResponse({ elements: [] })) as unknown as typeof fetch;
    const res = await svc.nearby({ lat: 30.18, lng: 66.975, category_slug: 'plumber' });
    expect(res).toEqual({ items: [], source: 'openstreetmap', degraded: true });
  });

  it('does NOT cache a degraded result — the next call refetches live', async () => {
    const { svc } = makeService();
    const fetchMock = jest.fn(async () => okResponse({ elements: [] }));
    svc.fetchImpl = fetchMock as unknown as typeof fetch;
    const q = { lat: 30.18, lng: 66.975, category_slug: 'plumber' };
    const first = await svc.nearby(q);
    const second = await svc.nearby(q);
    expect(first.degraded).toBe(true);
    expect(second.degraded).toBe(true);
    // A cached empty answer would hide real shops for 15 minutes after a
    // transient Overpass outage, so degraded responses are never stored.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('degrades on Overpass HTTP 500', async () => {
    const { svc } = makeService();
    svc.fetchImpl = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await svc.nearby({ lat: 30.18, lng: 66.975, category_slug: 'electrician' });
    expect(res.degraded).toBe(true);
    expect(res.items).toEqual([]);
  });

  it('degrades on fetch throw (network down)', async () => {
    const { svc } = makeService();
    svc.fetchImpl = jest.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const res = await svc.nearby({ lat: 30.18, lng: 66.975, category_slug: 'ac-repair' });
    expect(res).toEqual({ items: [], source: 'openstreetmap', degraded: true });
  });

  it('times out after 25s and degrades', async () => {
    jest.useFakeTimers();
    try {
      const { svc } = makeService();
      const hanging = jest.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<never>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const e = new Error('The operation was aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }),
      );
      svc.fetchImpl = hanging as unknown as typeof fetch;
      const p = svc.nearby({ lat: 30.18, lng: 66.975, category_slug: 'book-binding' });
      // Batch 3: the service timeout is 50 s (raised from 25 s — Overpass
      // was taking ~28–37 s, so the old timeout aborted live queries).
      await jest.advanceTimersByTimeAsync(50000);
      const res = await p;
      expect(res).toEqual({ items: [], source: 'openstreetmap', degraded: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('still serves live results when Redis is down', async () => {
    const { svc, redis } = makeService();
    redis.get.mockRejectedValue(new Error('redis down'));
    redis.set.mockRejectedValue(new Error('redis down'));
    svc.fetchImpl = jest.fn(async () => okResponse(QUETTA_PAYLOAD)) as unknown as typeof fetch;
    const res = await svc.nearby({ lat: 30.18, lng: 66.975, category_slug: 'book-binding' });
    expect(res.degraded).toBe(false);
    expect(res.items).toHaveLength(5);
  });

  it('rejects an unknown category slug (defence-in-depth; the DTO 422s first)', async () => {
    const { svc } = makeService();
    svc.fetchImpl = jest.fn(async () => okResponse(QUETTA_PAYLOAD)) as unknown as typeof fetch;
    await expect(
      svc.nearby({ lat: 30.18, lng: 66.975, category_slug: 'plumbing-x' }),
    ).rejects.toMatchObject({ code: 'INVALID_CATEGORY' });
  });
});
