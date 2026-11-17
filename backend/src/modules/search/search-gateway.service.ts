// Search gateway (Phase 4, item 1): the single entry point for search.
// Callers (today: CatalogService.search) call gateway.search() and never
// a provider directly. The gateway:
//   1. Picks the provider: SEARCH_SERVICE_URL set -> remote (extracted
//      service); else SEARCH_PROVIDER=scaled -> scaled; else trigram.
//   2. Falls back to the trigram provider when the selected provider
//      throws, so a scaled-cache or remote-service failure degrades to
//      the proven Phase 1 search instead of failing the request.
//   3. Records metrics for EVERY served search (latency, provider that
//      actually served, cache hit, result count) — the gate's input.
//   4. Strips the scaled provider's internal __cacheHit marker before
//      returning, so it never leaks into the API response.
import { Injectable, Logger } from '@nestjs/common';
import { SearchProvider } from './search-provider.interface';
import { SearchQuery, SearchResult, SearchProviderName } from './search.types';
import { TrigramSearchProvider } from './trigram-search.provider';
import { ScaledSearchProvider } from './scaled-search.provider';
import { RemoteSearchProvider } from './remote-search.provider';
import { SearchMetricsService } from './search-metrics.service';
import { readSearchConfig } from './search.config';

@Injectable()
export class SearchGatewayService {
  private readonly logger = new Logger(SearchGatewayService.name);
  constructor(
    private trigram: TrigramSearchProvider,
    private scaled: ScaledSearchProvider,
    private metrics: SearchMetricsService,
  ) {}

  /** Provider that would serve the next query under current config.
   *  Pure selection logic, extracted for tests. */
  static selectProviderName(cfg: { provider: 'trigram' | 'scaled'; serviceUrl: string | undefined }): SearchProviderName {
    if (cfg.serviceUrl) return 'remote';
    return cfg.provider;
  }

  activeProviderName(): SearchProviderName {
    return SearchGatewayService.selectProviderName(readSearchConfig());
  }

  private providerFor(name: SearchProviderName): SearchProvider {
    if (name === 'scaled') return this.scaled;
    if (name === 'remote') return new RemoteSearchProvider(readSearchConfig().serviceUrl!);
    return this.trigram;
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const started = Date.now();
    const selected = this.activeProviderName();
    let servedBy: SearchProviderName = selected;
    let result: SearchResult;
    try {
      result = await this.providerFor(selected).search(query);
    } catch (e) {
      if (selected === 'trigram') throw e;
      this.logger.warn(`search provider '${selected}' failed (${(e as Error).message}) — falling back to trigram`);
      servedBy = 'trigram';
      result = await this.trigram.search(query);
    }
    // Strip the scaled provider's internal cache-hit marker.
    const cacheHit = (result as SearchResult & { __cacheHit?: boolean }).__cacheHit === true;
    if (cacheHit) delete (result as SearchResult & { __cacheHit?: boolean }).__cacheHit;
    const latencyMs = Date.now() - started;
    const resultCount = result.categories.length + result.providers.items.length;
    // Fire-and-forget: metrics must never delay or fail the response.
    void this.metrics.recordQuery({ query: query.q, provider: servedBy, cacheHit, latencyMs, resultCount });
    return result;
  }

  /** Record a click on a search result (feeds the CTR metric). */
  recordClick(input: { queryEventId?: string | null; targetType: 'category' | 'provider'; targetId?: string }): Promise<boolean> {
    return this.metrics.recordClick(input);
  }
}
