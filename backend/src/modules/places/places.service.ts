// Real-world shop discovery via OpenStreetMap (FREE — no key, no account).
//
// GET /places/nearby proxies to the Overpass API (the read-only query
// endpoint for OpenStreetMap data) and returns real shops near the user
// that match the selected service category — e.g. stationery / book shops
// for Book Binding. These are NOT registered Near Service providers; they
// are public map data, shown on the customer map as a separate pin colour
// with a Directions button (Google Maps intent, also free, no key).
//
// Two Overpass quirks, both verified live from this VM (2026-11-18):
//   * The server returns HTTP 406 unless the request carries a User-Agent
//     AND an Accept: application/json header.
//   * The query must be POSTed as form data (data=<Overpass QL>).
// Coverage note: Overpass only returns what volunteers mapped. In Quetta
// centre (30.18, 66.975) a 20 km stationery/books query returns 5 real
// shops; sparse areas may legitimately return none — that is an empty
// answer, not an error, and is reported as degraded: true so the app can
// say "no shops found" instead of failing.
//
// Failure policy: this endpoint NEVER returns 500 for an upstream problem.
// Overpass error / timeout / empty result -> HTTP 200
// {items: [], source: 'openstreetmap', degraded: true}. The registered-
// provider nearby search is unaffected (separate endpoint).
//
// Cache: results are cached in Redis for 15 minutes per
// (category, ~100 m cell, radius). A Redis failure never fails the
// request — cache read/write errors are logged and the live fetch runs.
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../database/redis.service';
import { Errors } from '../../common/errors/api-error';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const OVERPASS_USER_AGENT = 'NearService/1.0 (https://near-service.example)';
export const OVERPASS_TIMEOUT_MS = 25000;
export const PLACES_CACHE_TTL_SECONDS = 900; // 15 minutes
export const PLACES_MAX_ITEMS = 50;

/** The 5 launch categories (PRD p.2, slugs match the backend seed). */
export const LAUNCH_CATEGORY_SLUGS = [
  'book-binding',
  'ac-repair',
  'electrician',
  'plumber',
  'mobile-repair',
] as const;
export type LaunchCategorySlug = (typeof LAUNCH_CATEGORY_SLUGS)[number];

/** Category slug -> OpenStreetMap tag selectors. A shop matches a category
 *  when ANY selector matches. Selectors are deliberately close to the
 *  service: a stationery shop sells books and binds them; an electronics-
 *  repair craft fixes ACs and phones. */
export const CATEGORY_OSM_TAGS: Record<LaunchCategorySlug, Array<{ key: string; value: string }>> = {
  'book-binding': [
    { key: 'shop', value: 'stationery' },
    { key: 'shop', value: 'books' },
    { key: 'craft', value: 'bookbinder' },
  ],
  'ac-repair': [
    { key: 'shop', value: 'appliances' },
    { key: 'shop', value: 'electronics' },
    { key: 'craft', value: 'electronics_repair' },
  ],
  electrician: [
    { key: 'shop', value: 'electrical' },
    { key: 'craft', value: 'electrician' },
  ],
  plumber: [
    { key: 'shop', value: 'plumbing' },
    { key: 'craft', value: 'plumber' },
  ],
  'mobile-repair': [
    { key: 'shop', value: 'mobile_phone' },
    { key: 'craft', value: 'electronics_repair' },
  ],
};

export interface PlaceShop {
  name: string;
  lat: number;
  lng: number;
  distance_km: number;
  tags: { shop?: string; craft?: string };
  source: 'openstreetmap';
}

export interface PlacesResponse {
  items: PlaceShop[];
  source: 'openstreetmap';
  degraded: boolean;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

export function placesCacheKey(slug: string, lat: number, lng: number, radiusKm: number): string {
  // Round to 3 decimals (~100 m cells) so nearby users share cache entries.
  return `places:${slug}:${lat.toFixed(3)}:${lng.toFixed(3)}:${radiusKm}`;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

export function buildOverpassQuery(
  tags: Array<{ key: string; value: string }>,
  lat: number,
  lng: number,
  radiusM: number,
): string {
  const stmts = tags
    .map((t) => `node["${t.key}"="${t.value}"](around:${radiusM},${lat},${lng});`)
    .join('');
  return `[out:json][timeout:25];(${stmts});out 100;`;
}

/** Map raw Overpass elements to sorted PlaceShop items. Dedupes by node id
 *  (one node can match several selectors), drops elements without
 *  coordinates, sorts by distance, caps at PLACES_MAX_ITEMS. */
export function parseOverpassElements(
  elements: OverpassElement[],
  lat: number,
  lng: number,
): PlaceShop[] {
  const seen = new Set<string>();
  const items: PlaceShop[] = [];
  for (const el of elements ?? []) {
    if (typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = el.tags ?? {};
    items.push({
      name: t.name?.trim() ? t.name : 'Unnamed shop',
      lat: el.lat,
      lng: el.lon,
      distance_km: Math.round(haversineKm(lat, lng, el.lat, el.lon) * 100) / 100,
      tags: { ...(t.shop ? { shop: t.shop } : {}), ...(t.craft ? { craft: t.craft } : {}) },
      source: 'openstreetmap',
    });
  }
  items.sort((a, b) => a.distance_km - b.distance_km);
  return items.slice(0, PLACES_MAX_ITEMS);
}

@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);
  /** Overridable in tests (direct assignment) so the Overpass call can be
   *  mocked without touching the network. Production always uses the
   *  global fetch and the public Overpass endpoint. */
  fetchImpl: typeof fetch = fetch;
  overpassUrl = OVERPASS_URL;

  constructor(private readonly redis: RedisService) {}

  async nearby(q: {
    lat: number;
    lng: number;
    category_slug: string;
    radius_km?: number;
  }): Promise<PlacesResponse> {
    const radiusKm = q.radius_km ?? 20;
    const tags = (CATEGORY_OSM_TAGS as Record<string, Array<{ key: string; value: string }>>)[
      q.category_slug
    ];
    // The controller DTO rejects unknown slugs with 422 first; this is
    // defence-in-depth for direct service callers.
    if (!tags) throw Errors.badRequest('INVALID_CATEGORY', `Unknown category_slug: ${q.category_slug}`);
    const key = placesCacheKey(q.category_slug, q.lat, q.lng, radiusKm);
    try {
      const cached = await this.redis.get(key);
      if (cached) return JSON.parse(cached) as PlacesResponse;
    } catch (e) {
      this.logger.warn(`places cache read failed, continuing live: ${(e as Error).message}`);
    }
    const live = await this.fetchLive(q.lat, q.lng, tags, radiusKm);
    // Cache only real results: a degraded (empty) answer must never hide
    // real shops for 15 minutes after a transient Overpass outage.
    if (!live.degraded) {
      try {
        await this.redis.set(key, JSON.stringify(live), PLACES_CACHE_TTL_SECONDS);
      } catch (e) {
        this.logger.warn(`places cache write failed: ${(e as Error).message}`);
      }
    }
    return live;
  }

  private async fetchLive(
    lat: number,
    lng: number,
    tags: Array<{ key: string; value: string }>,
    radiusKm: number,
  ): Promise<PlacesResponse> {
    const degraded: PlacesResponse = { items: [], source: 'openstreetmap', degraded: true };
    const query = buildOverpassQuery(tags, lat, lng, Math.round(radiusKm * 1000));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(this.overpassUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': OVERPASS_USER_AGENT,
          accept: 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.logger.warn(`overpass returned HTTP ${res.status}`);
        return degraded;
      }
      const body = (await res.json()) as { elements?: OverpassElement[] };
      const items = parseOverpassElements(body.elements ?? [], lat, lng);
      if (items.length === 0) return degraded;
      return { items, source: 'openstreetmap', degraded: false };
    } catch (e) {
      this.logger.warn(`overpass fetch failed: ${(e as Error).message}`);
      return degraded;
    } finally {
      clearTimeout(timer);
    }
  }
}
