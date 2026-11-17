import { Module } from '@nestjs/common';
import { RiskService } from './risk.service';
import { RiskController } from './risk.controller';

/** Phase 3 risk engine (PRD p.8): automated risk scoring from signals
 *  already in the system, admin-configurable thresholds (risk_settings),
 *  every score change audited via audit_logs.
 *
 *  INTEGRATOR — wiring this module in (this file is complete; only the two
 *  steps below are left, both in files this piece must not touch):
 *    1. backend/src/app.module.ts: add `RiskModule` to the imports array
 *       (import from './modules/risk/risk.module').
 *    2. backend/openapi.yaml: add the 10 routes listed in
 *       RiskController (GET /risk/me, GET /risk/users/:id,
 *       POST /risk/users/:id/recompute, GET /risk/users/:id/events,
 *       POST /risk/events, GET /risk/users/:id/ranking-penalty,
 *       GET /risk/jobs/:id, GET /admin/risk/review-queue,
 *       GET /admin/risk/settings, PATCH /admin/risk/settings).
 *
 *  RANKING INTEGRATION POINT (no code change in this piece — the hook is
 *  ready, the call site is not):
 *    File: backend/src/modules/providers/providers.service.ts,
 *    method nearby(), the `ranked = rows.map(...)` block that calls
 *    rankScore({... cancellations: 0, noShows: 0, upheldDisputes: 0 }).
 *    That call site currently hard-codes all three penalty counts to 0 —
 *    it never reads risk at all. The integrator should:
 *      a. Add RiskModule to ProvidersModule imports and inject RiskService
 *         into ProvidersService (constructor).
 *      b. Before the map, fetch penalties for the candidate provider
 *         user-ids in ONE query via RiskService.rankingPenaltyForUser
 *         (one call per candidate; candidates are capped at 50 rows) —
 *         or add a batch method later; do NOT call recomputeScore here,
 *         it is far too heavy for a search request.
 *      c. Replace `rankScore({...})` with
 *         `applyRiskPenaltyToRankScore(rankScore({...}),
 *         penalty.score)` from src/common/utils/risk-scoring.ts, and
 *         keep the existing `rank_score` field as the penalised value.
 *         Optionally also surface `risk_level` per provider for the admin
 *         UI — never for customers (scores are not customer-visible).
 *    Blocking (score >= block_threshold) is NOT applied in ranking: a
 *    blocked provider is held for admin review, and hiding them from
 *    search is a product decision for the integrator/admin, not an
 *    automatic engine side effect.
 */
@Module({ controllers: [RiskController], providers: [RiskService], exports: [RiskService] })
export class RiskModule {}
