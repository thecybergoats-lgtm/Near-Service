// Pure warranty maths + claim state machine (Phase 4, item 4).
// No DB, no I/O — unit tested directly. All money is integer paisa.

export const WARRANTY_CLAIM_WINDOW_DAYS = 7;
export const WARRANTY_ELIGIBLE_TIER = 3;

export interface WarrantyConfig {
  fee_rate: number;
  fee_flat_paisa: number;
  fee_min_paisa: number;
  fee_max_paisa: number;
  claim_window_days: number;
}

export const DEFAULT_WARRANTY_CONFIG: WarrantyConfig = {
  fee_rate: 0.05, // 5% of the job price
  fee_flat_paisa: 0,
  fee_min_paisa: 5000, // PKR 50
  fee_max_paisa: 50000, // PKR 500
  claim_window_days: WARRANTY_CLAIM_WINDOW_DAYS,
};

/**
 * Warranty fee, in paisa:
 *   fee = clamp(flat + round(jobPrice * rate), min, max)
 * A zero/negative job price yields the minimum fee only when the caller
 * passes a positive price; for price <= 0 the fee is 0 (defensive —
 * the service rejects non-positive prices before calling this).
 */
export function computeWarrantyFee(jobPricePaisa: number, cfg: WarrantyConfig): number {
  if (jobPricePaisa <= 0) return 0;
  const raw = cfg.fee_flat_paisa + Math.round(jobPricePaisa * cfg.fee_rate);
  return Math.min(Math.max(raw, cfg.fee_min_paisa), cfg.fee_max_paisa);
}

/** Coverage ends `days` after completion (default 7). */
export function coverageEndsAt(completedAt: Date, days = WARRANTY_CLAIM_WINDOW_DAYS): Date {
  return new Date(completedAt.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Claim window is INCLUSIVE of the deadline instant: a claim filed
 * exactly at coverage_ends_at is in time; one second later is late.
 * (Day 8 after a completion at T is T + 8d > T + 7d, so it is rejected.)
 */
export function isWithinClaimWindow(now: Date, coverageEndsAtDate: Date | string): boolean {
  return now.getTime() <= new Date(coverageEndsAtDate).getTime();
}

export type ClaimStatus =
  | 'filed'
  | 'under_review'
  | 'rework_offered'
  | 'rework_done'
  | 'rework_failed'
  | 'refunded'
  | 'rejected'
  | 'closed';

export const CLAIM_TERMINAL: ClaimStatus[] = ['refunded', 'rejected', 'closed'];
export const CLAIM_OPEN: ClaimStatus[] = ['filed', 'under_review', 'rework_offered', 'rework_done', 'rework_failed'];

/**
 * Strict claim state machine (published rules: rework first, refund only
 * after rework fails or is refused):
 *   filed -> under_review -> rework_offered -> rework_done -> closed
 *                                  \-> rework_failed -> refunded
 *   filed | under_review -> rejected
 * There is deliberately NO direct filed -> refunded or
 * under_review -> refunded edge: a refund requires a failed/refused
 * rework first. No edge leaves a terminal state.
 */
export const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  filed: ['under_review', 'rejected'],
  under_review: ['rework_offered', 'rejected'],
  rework_offered: ['rework_done', 'rework_failed'],
  rework_done: ['closed'],
  rework_failed: ['refunded'],
  refunded: [],
  rejected: [],
  closed: [],
};

export function isLegalClaimTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return (CLAIM_TRANSITIONS[from] ?? []).includes(to);
}

export function legalNextClaimStates(from: ClaimStatus): ClaimStatus[] {
  return [...(CLAIM_TRANSITIONS[from] ?? [])];
}

/** Clamp/validate admin-set config values. Throws RangeError on bad input. */
export function validateWarrantyConfig(input: Partial<WarrantyConfig>): void {
  const { fee_rate, fee_flat_paisa, fee_min_paisa, fee_max_paisa, claim_window_days } = input;
  if (fee_rate !== undefined && (typeof fee_rate !== 'number' || fee_rate < 0 || fee_rate > 0.5)) {
    throw new RangeError('fee_rate must be between 0 and 0.5');
  }
  for (const [name, v] of [
    ['fee_flat_paisa', fee_flat_paisa],
    ['fee_min_paisa', fee_min_paisa],
    ['fee_max_paisa', fee_max_paisa],
  ] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
      throw new RangeError(`${name} must be an integer >= 0`);
    }
  }
  if (
    fee_min_paisa !== undefined && fee_max_paisa !== undefined &&
    fee_min_paisa > fee_max_paisa
  ) {
    throw new RangeError('fee_min_paisa must not exceed fee_max_paisa');
  }
  if (claim_window_days !== undefined && (!Number.isInteger(claim_window_days) || claim_window_days < 1 || claim_window_days > 30)) {
    throw new RangeError('claim_window_days must be an integer between 1 and 30');
  }
}
