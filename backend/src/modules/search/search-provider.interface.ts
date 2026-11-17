// SearchProvider interface — the seam search sits behind (Phase 4,
// item 1a). The gateway ONLY talks to this interface; it never knows
// whether the query ran in-process (trigram / scaled) or over HTTP
// against an extracted search service (remote).
//
// Contract every provider must honour:
//   1. It returns the OpenAPI SearchResults shape (see search.types.ts)
//      — same fields, same provider page envelope — so swapping the
//      provider never changes the API.
//   2. It never throws on an empty/blank query: it returns empty
//      categories and an empty provider page, exactly like the Phase 1
//      implementation did.
//   3. It never writes metrics or cache state belonging to another
//      provider; the gateway owns metrics, each provider owns its cache.
//   4. It never joins across module boundaries in SQL: the only tables a
//      provider may read are categories, category_keywords,
//      provider_profiles and provider_services (the search read model).
//      Anything else is a cross-module join and breaks extraction
//      (see docs/phase4-search.md).
import { SearchQuery, SearchResult, SearchProviderName } from './search.types';

export interface SearchProvider {
  readonly name: SearchProviderName;
  search(query: SearchQuery): Promise<SearchResult>;
}
