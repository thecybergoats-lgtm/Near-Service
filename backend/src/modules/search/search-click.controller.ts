// Public click endpoint for search CTR (Phase 4, item 1 — integrator
// wiring; docs/phase4-search.md). Until this existed, recordClick() had
// no HTTP caller, clicks stayed 0 and the gate treated CTR as "no data".
//   POST /search/click  { query_event_id?, target_type, target_id? }
// Public (no login — the clicker may be an anonymous searcher) and
// rate-limited on the same 'search' bucket as GET /search. Recording
// never throws: a failed insert returns { recorded: false }.
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Public } from '../../common/guards/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { SearchGatewayService } from './search-gateway.service';

export class SearchClickDto {
  /** search_query_events id returned implicitly by the search that was
   *  clicked (clients that do not track it may omit it; the click still
   *  counts towards the window CTR). */
  @IsOptional() @IsUUID() query_event_id?: string;
  @IsIn(['category', 'provider']) target_type!: 'category' | 'provider';
  @IsOptional() @IsString() @MaxLength(100) target_id?: string;
}

@Public()
@Controller('search')
export class SearchClickController {
  constructor(private gateway: SearchGatewayService) {}

  @RateLimit('search')
  @Post('click')
  @HttpCode(200)
  async click(@Body() dto: SearchClickDto): Promise<{ recorded: boolean }> {
    const recorded = await this.gateway.recordClick({
      queryEventId: dto.query_event_id ?? null,
      targetType: dto.target_type,
      targetId: dto.target_id,
    });
    return { recorded };
  }
}
