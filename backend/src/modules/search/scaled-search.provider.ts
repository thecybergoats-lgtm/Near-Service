// Scaled search provider (Phase 4, item 1b): pg full-text + trigram
// combined ranking, behind the same SearchProvider interface, with Redis
// query-result caching.
//
// RANKING — why combined, and the exact blend:
//   * Full-text (ts_rank on the generated `search_vector`, 'simple'
//     config) understands multi-word queries ("AC repair" matches the
//     AC Repair category on both words) and is backed by a GIN index, so
//     it stays fast as the category/keyword tables grow.
//   * Trigram similarity catches what full-text cannot: Roman Urdu
//     spellings, typos and partial words ("electrican" still finds
//     Electrician), which is exactly the Phase 1 behaviour users have.
//   * Blend: score = 0.6 * ts_rank + 0.4 * best-trigram-similarity.
//     The weights are fixed in this query, not config — changing them is
//     a relevance decision that belongs in a measured A/B, not an env var.
//   * The WHERE clause is the UNION of both signals (a row matches if
//     EITHER matches), so the scaled provider is a strict superset of
//     the trigram provider's recall: anything the default provider found,
//     this one finds too. Relevance (order) may differ; recall does not
//     shrink. That is asserted in the integration test.
//
// CACHE: results are cached per normalised query (see search-cache.service
// for the generation-counter invalidation design). A cache hit returns the
// exact same shape; the gateway records cache_hit=true on the event.
//
// NO cross-module joins: only categories, category_keywords,
// provider_profiles and provider_services are read — the search read
// model. See docs/phase4-search.md.
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { offsetPage } from '../../common/utils/pagination';
import { SearchProvider } from './search-provider.interface';
import { SearchQuery, SearchResult, ProviderHit } from './search.types';
import { SearchCacheService, buildSearchCacheKey } from './search-cache.service';
import { readSearchConfig } from './search.config';

@Injectable()
export class ScaledSearchProvider implements SearchProvider {
  readonly name = 'scaled' as const;
  constructor(
    private db: DatabaseService,
    private cache: SearchCacheService,
  ) {}

  async search(query: SearchQuery): Promise<SearchResult> {
    const term = query.q.trim();
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    if (!term) return { categories: [], providers: { items: [], next_cursor: null } };

    const cfg = readSearchConfig();
    if (cfg.cacheEnabled && cfg.cacheTtlSeconds > 0) {
      const gen = await this.cache.generation();
      const key = buildSearchCacheKey(query, gen);
      const hit = await this.cache.getCached<SearchResult>(key);
      if (hit) {
        // Mark the hit so the gateway can record cache_hit on the event.
        (hit as SearchResult & { __cacheHit?: boolean }).__cacheHit = true;
        return hit;
      }
      const fresh = await this.searchUncached(query, term, limit);
      await this.cache.setCached(key, fresh, cfg.cacheTtlSeconds);
      return fresh;
    }
    return this.searchUncached(query, term, limit);
  }

  private async searchUncached(query: SearchQuery, term: string, limit: number): Promise<SearchResult> {
    const cats = (await this.db.query(
      `SELECT DISTINCT c.id, c.slug, c.name_en, c.name_ur, c.name_roman, c.level,
              (0.6 * ts_rank(c.search_vector, plainto_tsquery('simple', $1))
               + 0.4 * GREATEST(similarity(c.name_en,$1), similarity(COALESCE(c.name_roman,''),$1), MAX(similarity(k.keyword,$1)))) AS sim
       FROM categories c LEFT JOIN category_keywords k ON k.category_id=c.id
       WHERE c.is_active AND (c.search_vector @@ plainto_tsquery('simple', $1)
              OR c.name_en % $1 OR COALESCE(c.name_roman,'') % $1 OR COALESCE(c.name_ur,'') ILIKE '%'||$1||'%'
              OR k.keyword % $1 OR k.keyword ILIKE '%'||$1||'%')
       GROUP BY c.id, c.search_vector ORDER BY sim DESC LIMIT 10`, [term])).rows;
    let providers: ProviderHit[] = [];
    if (query.lat != null && query.lng != null && cats.length) {
      const catIds = cats.map((c) => c.id);
      providers = (await this.db.query(
        `SELECT p.id, p.display_name, p.provider_type, p.tier, p.rating_bayes, p.jobs_completed,
                ST_Distance(p.base_point, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography)/1000 AS distance_km
         FROM provider_profiles p JOIN provider_services ps ON ps.provider_id=p.id
         WHERE ps.category_id = ANY($3::uuid[]) AND p.deleted_at IS NULL AND p.is_online
         ORDER BY distance_km ASC LIMIT 20`, [query.lat, query.lng, catIds])).rows as unknown as ProviderHit[];
    }
    return { categories: cats as never, providers: offsetPage(providers, query.cursor, limit) };
  }
}
