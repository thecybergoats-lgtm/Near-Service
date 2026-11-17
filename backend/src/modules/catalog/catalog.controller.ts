import { Body, Controller, Get, Inject, Logger, Optional, Param, Put, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { Public } from '../../common/guards/public.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { SearchCacheService } from '../search/search-cache.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AtLeastOneCategory, CursorQueryDto, IsLat, IsLng, ToNumber } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { RateLimit } from '../../common/guards/rate-limit.guard';

export class FormSchemaDto { @IsObject() schema!: Record<string, unknown>; }

@AtLeastOneCategory()
export class FairRangeQueryDto {
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsString() @MaxLength(100) category_slug?: string;
  @IsOptional() @IsUUID() city_id?: string;
}

export class SearchQueryDto extends CursorQueryDto {
  @IsString() @IsNotEmpty() @MaxLength(100) q!: string;
  @IsOptional() @ToNumber() @IsLat() lat?: number;
  @IsOptional() @ToNumber() @IsLng() lng?: number;
  @IsOptional() @IsString() @IsIn(['en', 'ur', 'ur-roman']) locale?: string;
}

@Controller()
export class CatalogController {
  private readonly logger = new Logger(CatalogController.name);
  constructor(
    private svc: CatalogService,
    @Optional() @Inject(SearchCacheService) private searchCache?: SearchCacheService,
  ) {}
  @Public() @Get('categories') tree() { return this.svc.tree(); }
  @Public() @Get('categories/:id/form-schema') formSchema(@Param('id', uuidParamPipe) id: string) { return this.svc.formSchema(id); }
  @Roles('super_admin', 'marketing') @Put('admin/categories/:id/form-schema') async putFormSchema(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: FormSchemaDto) {
    const row = await this.svc.putFormSchema(id, dto.schema, u.id);
    // Phase 4, item 1: a form-schema change can change which providers
    // match a category search — invalidate best-effort, never fail the write.
    if (this.searchCache) {
      try {
        await this.searchCache.invalidateCategory(id);
      } catch (e) {
        this.logger.warn(`search cache invalidation failed for category ${id}: ${(e as Error).message}`);
      }
    }
    return row;
  }
  @Public() @Get('pricing/fair-range') fairRange(@Query() q: FairRangeQueryDto) { return this.svc.fairRange(q.category_id, q.category_slug, q.city_id); }
  @Public() @RateLimit('search') @Get('search') search(@Query() q: SearchQueryDto) {
    return this.svc.search(q.q, q.lat, q.lng, q.locale ?? 'en', q.cursor, q.limit ?? 20);
  }
}
