import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';
import { SearchModule } from '../search/search.module';
/** Phase 4, item 1: CatalogService.search delegates to the search gateway
 *  (SearchProvider interface) instead of running SQL inline. The endpoint
 *  and its response shape are unchanged. */
@Module({ imports: [SearchModule], controllers: [CatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
