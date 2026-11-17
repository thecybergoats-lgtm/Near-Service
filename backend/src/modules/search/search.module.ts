// Search module (Phase 4, item 1 — search scale-out).
//
// What lives here:
//   * SearchProvider interface + three providers (trigram = Phase 1
//     behaviour, scaled = full-text + trigram + Redis cache, remote =
//     HTTP forward to an extracted search service).
//   * SearchGatewayService — the only thing callers use; it picks the
//     provider, falls back to trigram on failure, and records metrics.
//   * SearchMetricsService + SearchAdminController — latency /
//     zero-result / CTR metrics and the dedicated-tier gate.
//   * SearchCacheService — Redis result cache with generation-counter
//     invalidation.
//
// EXTRACTION SEAM (item 1c): this module reads ONLY categories,
// category_keywords, provider_profiles and provider_services, and only
// through DatabaseService / RedisService. It imports DatabaseModule and
// nothing else. To extract it as a standalone service, copy this folder
// + DatabaseService + RedisService into a new Nest app, point
// SEARCH_SERVICE_URL at it, and GET /search keeps working with zero API
// changes. Full seam notes: docs/phase4-search.md.
//
// NOTE: this module used to re-export CatalogModule (search endpoints
// lived on CatalogController). That re-export is gone: CatalogModule now
// imports THIS module and CatalogService.search delegates to the gateway.
// AppModule already imports both modules, so no AppModule change was
// needed.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { TrigramSearchProvider } from './trigram-search.provider';
import { ScaledSearchProvider } from './scaled-search.provider';
import { SearchCacheService } from './search-cache.service';
import { SearchMetricsService } from './search-metrics.service';
import { SearchGatewayService } from './search-gateway.service';
import { SearchAdminController } from './search-admin.controller';
import { SearchClickController } from './search-click.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [SearchAdminController, SearchClickController],
  providers: [
    TrigramSearchProvider,
    ScaledSearchProvider,
    SearchCacheService,
    SearchMetricsService,
    SearchGatewayService,
  ],
  exports: [SearchGatewayService, SearchMetricsService, SearchCacheService, TrigramSearchProvider, ScaledSearchProvider],
})
export class SearchModule {}
