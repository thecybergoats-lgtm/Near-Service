// Analytics warehouse — admin endpoints (Phase 4, item 2).
//   POST /admin/analytics/etl/run        — run the nightly ETL on demand
//   GET  /admin/analytics/etl/status     — latest ETL run + reconciliation
//   GET  /admin/analytics/funnel         — request→offer→accept→complete→rate
//   GET  /admin/analytics/revenue        — revenue/commission by city|category
//   GET  /admin/analytics/supply-demand  — provider supply vs demand by city/hour
//   GET  /admin/analytics/export/:table  — CSV export (FBR/PRA/SRB-style,
//                                          labelled subject to legal review)
//
// INTEGRATOR — wiring (this file is complete; the two steps below live in
// files this piece must not touch):
//   1. backend/src/app.module.ts: add `AnalyticsModule` to the imports
//      array (import from './modules/analytics/analytics.module').
//   2. backend/openapi.yaml: add the 6 routes listed above; see
//      docs/phase4-analytics.md for the exact OpenAPI fragment.
import { BadRequestException, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';
import { AnalyticsService } from './analytics.service';
import { Roles } from '../../common/guards/roles.decorator';

export class AnalyticsRangeDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class RevenueQueryDto extends AnalyticsRangeDto {
  @IsOptional() @IsEnum(['city', 'category']) group_by?: 'city' | 'category';
}

@Controller('admin/analytics')
export class AnalyticsController {
  constructor(private svc: AnalyticsService) {}

  @Roles('super_admin', 'finance') @Post('etl/run') @HttpCode(200)
  runEtl() { return this.svc.runEtl('manual'); }

  @Roles('super_admin', 'finance', 'city_manager') @Get('etl/status')
  status() { return this.svc.latestRun(); }

  @Roles('super_admin', 'finance', 'city_manager') @Get('funnel')
  funnel(@Query() q: AnalyticsRangeDto) { return this.svc.funnel(q.from, q.to); }

  @Roles('super_admin', 'finance', 'city_manager') @Get('revenue')
  revenue(@Query() q: RevenueQueryDto) { return this.svc.revenue(q.group_by ?? 'city', q.from, q.to); }

  @Roles('super_admin', 'finance', 'city_manager') @Get('supply-demand')
  supplyDemand(@Query() q: AnalyticsRangeDto) { return this.svc.supplyDemand(q.from, q.to); }

  @Roles('super_admin', 'finance') @Get('export/:table')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('X-Analytics-Disclaimer', AnalyticsService.DISCLAIMER)
  async exportCsv(@Param('table') table: string) {
    if (!(AnalyticsService.EXPORT_TABLES as readonly string[]).includes(table)) {
      throw new BadRequestException(`unknown export table: ${table}. Allowed: ${AnalyticsService.EXPORT_TABLES.join(', ')}`);
    }
    const { csv } = await this.svc.exportCsv(table);
    return csv;
  }
}
