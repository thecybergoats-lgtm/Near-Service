// Shared search shapes (Phase 4, item 1). The wire shape of GET /search
// (OpenAPI v1.2 SearchResults) is UNCHANGED by the scale-out: every
// provider must return exactly this, so the endpoint, the mobile client
// and the contract tests never see a difference when the provider swaps.
import { PageEnvelope } from '../../common/utils/pagination';

export type SearchProviderName = 'trigram' | 'scaled' | 'remote';

export interface SearchQuery {
  q: string;
  lat?: number;
  lng?: number;
  locale?: string;
  cursor?: string;
  limit?: number;
}

export interface CategoryHit {
  id: string;
  slug: string;
  name_en: string;
  name_ur: string | null;
  name_roman: string | null;
  level: number;
  /** Ranking signal: trigram similarity (default provider) or the
   *  combined full-text + trigram score (scaled provider). */
  sim: number;
}

export interface ProviderHit {
  id: string;
  display_name: string;
  provider_type: string;
  tier: number;
  rating_bayes: number;
  jobs_completed: number;
  distance_km: number;
}

export interface SearchResult {
  categories: CategoryHit[];
  providers: PageEnvelope<ProviderHit>;
}
