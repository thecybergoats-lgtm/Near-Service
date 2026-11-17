// Pure escrow / payout maths (Phase 3, item 8). No DB, no I/O — unit
// tested directly. All money is integer paisa; 1 PKR = 100 paisa.

export interface PayoutBreakdown {
  fee_paisa: number;
  tax_paisa: number;
  net_paisa: number;
}

/**
 * Payout fee + tax, in paisa.
 *   fee = feeFlatPaisa + round(gross * feeRate)
 *   tax = round((gross - fee) * taxRate)   — tax is charged on the
 *         post-fee amount, so fee + tax can never exceed gross when
 *         both rates are in [0, 1).
 *   net = gross - fee - tax
 * All three results are >= 0 for gross > 0 and rates in [0, 1).
 */
export function payoutBreakdown(
  grossPaisa: number,
  feeFlatPaisa: number,
  feeRate: number,
  taxRate: number,
): PayoutBreakdown {
  const feePaisa = feeFlatPaisa + Math.round(grossPaisa * feeRate);
  const taxPaisa = Math.round((grossPaisa - feePaisa) * taxRate);
  return { fee_paisa: feePaisa, tax_paisa: taxPaisa, net_paisa: grossPaisa - feePaisa - taxPaisa };
}

/** Auto-release deadline for a hold created at `heldAt`. */
export function autoReleaseAt(heldAt: Date, hours: number): Date {
  return new Date(heldAt.getTime() + hours * 60 * 60 * 1000);
}

export type EscrowHoldStatus = 'held' | 'released' | 'refunded' | 'cancelled';

/**
 * A held escrow may auto-release when the deadline has passed AND no
 * dispute is open on the job. An open dispute blocks auto-release
 * (and manual release) until the dispute is resolved — the funds then
 * follow the dispute outcome via the existing dispute resolver.
 */
export function isAutoReleaseDue(
  status: EscrowHoldStatus,
  autoReleaseAtIso: string | Date,
  now: Date,
  hasOpenDispute: boolean,
): boolean {
  if (status !== 'held') return false;
  if (hasOpenDispute) return false;
  return now.getTime() >= new Date(autoReleaseAtIso).getTime();
}

/** Clamp/validate admin-set config values. Throws RangeError on bad input. */
export function validateEscrowConfig(input: {
  auto_release_hours?: number;
  min_amount_paisa?: number;
  payout_fee_flat_paisa?: number;
  payout_fee_rate?: number;
  payout_tax_rate?: number;
}): void {
  const { auto_release_hours, min_amount_paisa, payout_fee_flat_paisa, payout_fee_rate, payout_tax_rate } = input;
  if (auto_release_hours !== undefined && (!Number.isInteger(auto_release_hours) || auto_release_hours < 1 || auto_release_hours > 720)) {
    throw new RangeError('auto_release_hours must be an integer between 1 and 720');
  }
  if (min_amount_paisa !== undefined && (!Number.isInteger(min_amount_paisa) || min_amount_paisa < 0)) {
    throw new RangeError('min_amount_paisa must be an integer >= 0');
  }
  if (payout_fee_flat_paisa !== undefined && (!Number.isInteger(payout_fee_flat_paisa) || payout_fee_flat_paisa < 0)) {
    throw new RangeError('payout_fee_flat_paisa must be an integer >= 0');
  }
  if (payout_fee_rate !== undefined && (typeof payout_fee_rate !== 'number' || payout_fee_rate < 0 || payout_fee_rate > 0.5)) {
    throw new RangeError('payout_fee_rate must be between 0 and 0.5');
  }
  if (payout_tax_rate !== undefined && (typeof payout_tax_rate !== 'number' || payout_tax_rate < 0 || payout_tax_rate > 0.5)) {
    throw new RangeError('payout_tax_rate must be between 0 and 0.5');
  }
}
