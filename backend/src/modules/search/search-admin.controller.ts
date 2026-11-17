// Admin endpoints for the search metrics gate (Phase 4, item 1b).
//   GET   /admin/search/metrics          live window + gate + daily rollup
//   GET   /admin/search/gate             gate evaluation only
//   PATCH /admin/search/gate/thresholds   change gate thresholds
//
// Super-admin only. These are NEW routes: backend/openapi.yaml does not
// list them yet, so the contract route-diff test will report them as
// extra routes until the coordinator adds the two paths to the spec —
// the exact YAML to add is in docs/phase4-search.md (do NOT edit
// openapi.yaml from this item; it is shared with the other Phase 4
// workers).
import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Roles } from '../../common/guards/roles.decorator';
import { SearchMetricsService, GateThresholds } from './search-metrics.service';

export class UpdateGateThresholdsDto {
  @IsOptional() @IsInt() @Min(1) p95_latency_ms?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) zero_result_rate?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) ctr_floor?: number;
  @IsOptional() @IsInt() @Min(1) queries_per_day?: number;
  @IsOptional() @IsInt() @Min(0) min_queries_for_gate?: number;
  @IsOptional() @IsInt() @Min(1) @Max(720) window_hours?: number;
}

export class SearchMetricsQueryDto {
  @IsOptional() @IsInt() @Min(1) @Max(720) window_hours?: number;
  @IsOptional() @IsInt() @Min(1) @Max(90) days?: number;
}

@Controller('admin/search')
export class SearchAdminController {
  constructor(private metrics: SearchMetricsService) {}

  @Roles('super_admin') @Get('metrics')
  metricsView(@Query() q: SearchMetricsQueryDto) {
    return this.metrics.metricsView(q.window_hours ?? 24, q.days ?? 14);
  }

  @Roles('super_admin') @Get('gate')
  gate() {
    return this.metrics.evaluateGate();
  }

  @Roles('super_admin') @Patch('gate/thresholds')
  updateThresholds(@Body() dto: UpdateGateThresholdsDto): Promise<GateThresholds> {
    return this.metrics.updateThresholds(dto);
  }
}
