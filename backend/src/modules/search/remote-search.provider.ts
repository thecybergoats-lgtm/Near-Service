// Remote search provider (Phase 4, item 1c): forwards the search to an
// extracted search service over HTTP when SEARCH_SERVICE_URL is set.
//
// The remote service must implement the SAME contract as GET /search:
//   GET {SEARCH_SERVICE_URL}/api/v1/search?q=...&lat=...&lng=...&locale=...
//       &cursor=...&limit=...
//   -> 200 { categories: [...], providers: { items: [...], next_cursor } }
// The gateway (not this provider) decides when to use it; this provider
// only knows how to forward and how to fail: a non-2xx response or a
// timeout surfaces as an error so the gateway can fall back to the
// in-process trigram provider instead of serving a partial answer.
// Timeout is 5s — a search service slower than that is worse than the
// local fallback. No auth is attached here: the extracted service runs
// inside the private network (see docs/phase4-search.md); if it ever
// leaves it, attach a service token here and nowhere else.
import { Injectable, Logger } from '@nestjs/common';
import { SearchProvider } from './search-provider.interface';
import { SearchQuery, SearchResult } from './search.types';

@Injectable()
export class RemoteSearchProvider implements SearchProvider {
  readonly name = 'remote' as const;
  private readonly logger = new Logger(RemoteSearchProvider.name);
  constructor(private readonly baseUrl: string) {}

  async search(query: SearchQuery): Promise<SearchResult> {
    const params = new URLSearchParams({ q: query.q });
    if (query.lat != null) params.set('lat', String(query.lat));
    if (query.lng != null) params.set('lng', String(query.lng));
    if (query.locale) params.set('locale', query.locale);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit != null) params.set('limit', String(query.limit));
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/v1/search?${params.toString()}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`remote search ${res.status} from ${this.baseUrl}`);
      const body = (await res.json()) as SearchResult;
      if (!body || !Array.isArray(body.categories) || !body.providers || !Array.isArray(body.providers.items)) {
        throw new Error(`remote search returned a malformed SearchResults body from ${this.baseUrl}`);
      }
      return body;
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        this.logger.warn(`remote search timed out after 5000ms (${this.baseUrl})`);
        throw new Error(`remote search timed out (${this.baseUrl})`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
