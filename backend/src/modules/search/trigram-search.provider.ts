// Default search provider (Phase 4, item 1a): the Phase 1 trigram +
// PostGIS implementation, moved verbatim from CatalogService.search into
// this provider. Behaviour is UNCHANGED — same SQL, same ranking, same
// empty-query short-circuit, same offset-cursor provider page. The only
// difference is the seam: callers now go through SearchProvider, so the
// gateway can swap this for the scaled or remote provider without any
// caller or API change.
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { offsetPage } from '../../common/utils/pagination';
import { SearchProvider } from './search-provider.interface';
import { SearchQuery, SearchResult, ProviderHit } from './search.types';

@Injectable()
export class TrigramSearchProvider implements SearchProvider {
  readonly name = 'trigram' as const;
  constructor(private db: DatabaseService) {}

  async search(query: SearchQuery): Promise<SearchResult> {
    const term = query.q.trim();
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    if (!term) return { categories: [], providers: { items: [], next_cursor: null } };
    const cats = (await this.db.query(
      `SELECT DISTINCT c.id, c.slug, c.name_en, c.name_ur, c.name_roman, c.level,
              GREATEST(similarity(c.name_en,$1), similarity(COALESCE(c.name_roman,''),$1), MAX(similarity(k.keyword,$1))) AS sim
       FROM categories c LEFT JOIN category_keywords k ON k.category_id=c.id
       WHERE c.is_active AND (c.name_en % $1 OR COALESCE(c.name_roman,'') % $1 OR COALESCE(c.name_ur,'') ILIKE '%'||$1||'%' OR k.keyword % $1 OR k.keyword ILIKE '%'||$1||'%')
       GROUP BY c.id ORDER BY sim DESC LIMIT 10`, [term])).rows;
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
    // v1.2 SearchResults: providers are a cursor-paginated ProviderPage
    // envelope (offset cursor — distance-ranked, no stable id key).
    return { categories: cats as never, providers: offsetPage(providers, query.cursor, limit) };
  }
}
