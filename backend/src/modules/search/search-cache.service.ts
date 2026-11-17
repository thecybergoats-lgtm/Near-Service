// Search result cache (Phase 4, item 1b): Redis query-result caching for
// the scaled provider, with invalidation.
//
// KEY DESIGN — generation counter, not key scans:
//   Every cached entry is keyed `search:v1:gen:{generation}:{params-hash}`.
//   Invalidation does NOT scan Redis (the shared RedisService has no SCAN
//   / delete-by-pattern, and editing it is out of this item's scope — see
//   docs/phase4-search.md). Instead it bumps ONE counter,
//   `search:cache:generation`, via INCR. The next read uses the new
//   generation, so every entry written under an old generation is simply
//   never read again and dies on its TTL. Correct, O(1), and race-free.
//
//   The trade-off is coarse: invalidating ONE category or provider
//   invalidates ALL cached searches. That is the honest cost of the
//   no-SCAN design, and it is acceptable because (a) the TTL is short
//   (default 120s), so the cache is a burst absorber, not a source of
//   truth, and (b) provider/service/category mutations are far rarer
//   than searches. Fine-grained per-category invalidation is a documented
//   follow-up once RedisService gains a scan/delete-by-pattern method.
//
//   Invalidation call sites (who calls invalidateAll / invalidateCategory /
//   invalidateProvider) are wiring, not code in this module: the catalog
//   admin write, the provider profile/service writes and the category
//   writes must call SearchCacheService after a successful mutation —
//   see docs/phase4-search.md for the exact call sites. Until they are
//   wired, cached results can be at most TTL-seconds stale.
import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../database/redis.service';
import { SearchQuery } from './search.types';

export const SEARCH_CACHE_GENERATION_KEY = 'search:cache:generation';
export const SEARCH_CACHE_KEY_PREFIX = 'search:v1';

export function normaliseSearchParams(q: SearchQuery): string {
  // Lat/lng rounded to ~100m so near-identical locations share a cache
  // entry instead of each phone's GPS jitter missing the cache.
  const lat = q.lat != null ? q.lat.toFixed(3) : '';
  const lng = q.lng != null ? q.lng.toFixed(3) : '';
  return JSON.stringify({
    q: q.q.trim().toLowerCase(),
    lat, lng,
    locale: q.locale ?? 'en',
    cursor: q.cursor ?? '',
    limit: Math.min(Math.max(q.limit ?? 20, 1), 100),
  });
}

/** Stable cache key for a query at a given generation. Pure — unit-tested. */
export function buildSearchCacheKey(q: SearchQuery, generation: number): string {
  const hash = createHash('sha256').update(normaliseSearchParams(q)).digest('hex').slice(0, 32);
  return `${SEARCH_CACHE_KEY_PREFIX}:gen:${generation}:${hash}`;
}

@Injectable()
export class SearchCacheService {
  private readonly logger = new Logger(SearchCacheService.name);
  constructor(private redis: RedisService) {}

  async generation(): Promise<number> {
    const raw = await this.redis.get(SEARCH_CACHE_GENERATION_KEY);
    const n = raw == null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /** Bump the generation; returns the new generation. All entries cached
   *  under older generations become unreachable immediately. */
  async bumpGeneration(): Promise<number> {
    return this.redis.incr(SEARCH_CACHE_GENERATION_KEY);
  }

  /** Invalidate every cached search (provider / service / category change
   *  that can affect results). Returns the new generation. */
  async invalidateAll(reason: string): Promise<number> {
    const gen = await this.bumpGeneration();
    this.logger.log(`search cache invalidated (reason=${reason}, generation=${gen})`);
    return gen;
  }

  /** Invalidate results that could include this category. Coarse today:
   *  bumps the global generation (see header). Kept as a separate method
   *  so call sites already name the category, and a future fine-grained
   *  implementation only changes this method. */
  async invalidateCategory(categoryId: string): Promise<number> {
    return this.invalidateAll(`category:${categoryId}`);
  }

  /** Invalidate results that could include this provider. Same coarse
   *  semantics as invalidateCategory. */
  async invalidateProvider(providerId: string): Promise<number> {
    return this.invalidateAll(`provider:${providerId}`);
  }

  async getCached<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (e) {
      this.logger.warn(`search cache read failed for ${key}: ${(e as Error).message}`);
      return null;
    }
  }

  async setCached(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    try {
      await this.redis.set(key, JSON.stringify(value), ttlSeconds);
    } catch (e) {
      // Cache failures must never fail a search.
      this.logger.warn(`search cache write failed for ${key}: ${(e as Error).message}`);
    }
  }
}
