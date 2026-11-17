import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

/** Phase 4 analytics warehouse (PRD v1.1: "analytics warehouse").
 *  DatabaseService is @Global (DatabaseModule), so this module needs no
 *  imports of its own.
 *
 *  INTEGRATOR — wiring this module in (this file is complete; only the two
 *  steps below are left, both in files this piece must not touch):
 *    1. backend/src/app.module.ts: add `AnalyticsModule` to the imports
 *       array (import from './modules/analytics/analytics.module').
 *    2. backend/openapi.yaml: add the 6 routes listed in
 *       AnalyticsController (POST /admin/analytics/etl/run,
 *       GET /admin/analytics/etl/status, GET /admin/analytics/funnel,
 *       GET /admin/analytics/revenue, GET /admin/analytics/supply-demand,
 *       GET /admin/analytics/export/{table}); the exact fragment is in
 *       docs/phase4-analytics.md.
 */
@Module({ controllers: [AnalyticsController], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
