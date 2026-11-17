// Risk scoring — Phase 3 risk engine (PRD p.8).
// Pure functions only (no DB, no Nest): the service in
// src/modules/risk/risk.service.ts gathers signal COUNTS from tables that
// already exist and feeds them here, so every number below is unit-testable
// without a database.
//
// Signals and where each count comes from (see RiskService.recomputeScore):
//   cancellation          jobs CANCELLED_BY_PROVIDER / CANCELLED_BY_CUSTOMER
//   no_show               risk_events only — no no-show column exists yet;
//                         the mobile/job flow records it via POST /risk/events
//   upheld_dispute        disputes resolved with outcome refund /
//                         partial_refund / compensation (resolution jsonb)
//   device_change         user_devices: distinct fingerprints beyond the first
//   sim_change            risk_events only — no SIM column exists in schema;
//                         the mobile client reports it via POST /risk/events
//   mock_location         risk_events only (no mock-location column exists;
//                         the client reports a failed integrity verdict)
//   teleport              fraud_signals signal='teleport_location' (written
//                         by the realtime gateway on implausible speed)
//   duplicate_account     other users sharing a device_fingerprint
//   payout_account_reuse  other providers sharing payout_account_encrypted
//   velocity              1 when service_requests in the last hour exceed
//                         velocity_max_requests_per_hour, else 0
//   report                risk_events only (POST /reports abuse reports)
//   ledger_anomaly        risk_events only (reconciliation writes
//                         fraud_signals without a user; an operator records
//                         the affected user here)
//
// A signal's contribution is weight * count, capped per signal at
// RISK_SIGNAL_CAP, and the total is capped at 100. Caps stop one noisy
// signal (e.g. many cancellations) from single-handedly maxing a score.

export const RISK_SIGNALS = [
  'cancellation',
  'no_show',
  'upheld_dispute',
  'device_change',
  'sim_change',
  'mock_location',
  'teleport',
  'duplicate_account',
  'payout_account_reuse',
  'velocity',
  'report',
  'ledger_anomaly',
] as const;
export type RiskSignal = (typeof RISK_SIGNALS)[number];

export const DEFAULT_RISK_WEIGHTS: Record<RiskSignal, number> = {
  cancellation: 5,
  no_show: 12,
  upheld_dispute: 20,
  device_change: 8,
  sim_change: 8,
  mock_location: 15,
  teleport: 15,
  duplicate_account: 18,
  payout_account_reuse: 15,
  velocity: 10,
  report: 3,
  ledger_anomaly: 10,
};

/** One signal cannot contribute more than this, however many times it fired. */
export const RISK_SIGNAL_CAP = 40;
/** Scores live on 0..100. */
export const RISK_SCORE_MAX = 100;

export interface RiskThresholds {
  review_threshold: number;
  block_threshold: number;
  hold_hours: number;
  window_days: number;
  velocity_max_requests_per_hour: number;
}
export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  review_threshold: 60,
  block_threshold: 85,
  hold_hours: 24,
  window_days: 90,
  velocity_max_requests_per_hour: 10,
};

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Levels are derived from the (configurable) thresholds, not hard-coded
 *  cut-offs: low < half the review threshold, medium < review threshold,
 *  high < block threshold, critical >= block threshold. */
export function levelForScore(score: number, t: RiskThresholds = DEFAULT_RISK_THRESHOLDS): RiskLevel {
  if (score >= t.block_threshold) return 'critical';
  if (score >= t.review_threshold) return 'high';
  if (score >= t.review_threshold / 2) return 'medium';
  return 'low';
}

export interface SignalBreakdown {
  count: number;
  weight: number;
  points: number;
}
export interface ScoredCounts {
  score: number;
  level: RiskLevel;
  breakdown: Record<string, SignalBreakdown>;
}

export function scoreFromCounts(
  counts: Partial<Record<RiskSignal, number>>,
  weights: Partial<Record<RiskSignal, number>> = {},
  thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS,
): ScoredCounts {
  const w = { ...DEFAULT_RISK_WEIGHTS, ...weights };
  const breakdown: Record<string, SignalBreakdown> = {};
  let total = 0;
  for (const signal of RISK_SIGNALS) {
    const count = Math.max(0, Math.floor(Number(counts[signal] ?? 0)) || 0);
    const weight = w[signal];
    const points = Math.min(RISK_SIGNAL_CAP, count * weight);
    breakdown[signal] = { count, weight, points };
    total += points;
  }
  const score = Math.min(RISK_SCORE_MAX, total);
  return { score, level: levelForScore(score, thresholds), breakdown };
}

/** Ranking penalty fed to ProvidersService.nearby (see
 *  risk.service.ts rankingPenaltyForUser and the integration note in
 *  risk.module.ts). 0 below the review threshold, rising linearly to
 *  RISK_MAX_RANKING_PENALTY at a score of 100 — so a high-risk provider
 *  sinks in results but is never silently hidden; blocking is a separate,
 *  explicit admin decision at the block threshold. */
export const RISK_MAX_RANKING_PENALTY = 0.5;
export function rankingPenaltyForScore(score: number, t: RiskThresholds = DEFAULT_RISK_THRESHOLDS): number {
  if (score < t.review_threshold) return 0;
  const span = Math.max(1, RISK_SCORE_MAX - t.review_threshold);
  return Math.min(RISK_MAX_RANKING_PENALTY, ((score - t.review_threshold) / span) * RISK_MAX_RANKING_PENALTY);
}

/** Apply the risk penalty to a rankScore() result (0..1), floored at 0. */
export function applyRiskPenaltyToRankScore(
  rankScore: number,
  riskScore: number,
  t: RiskThresholds = DEFAULT_RISK_THRESHOLDS,
): number {
  return Math.max(0, rankScore - rankingPenaltyForScore(riskScore, t));
}

/** True when the score reaches the block threshold: the account is held
 *  (risk_scores.hold_until) and must not receive new jobs until an admin
 *  reviews it. The engine never suspends by itself — it only flags. */
export function isRiskBlocked(score: number, t: RiskThresholds = DEFAULT_RISK_THRESHOLDS): boolean {
  return score >= t.block_threshold;
}

export function isRiskSignal(value: unknown): value is RiskSignal {
  return typeof value === 'string' && (RISK_SIGNALS as readonly string[]).includes(value);
}
