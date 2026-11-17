// Warranty Product (Phase 4, item 4 — PRD v1.1: optional 7-day
// workmanship guarantee on Tier 3 jobs, rework or refund per published
// rules, priced into the warranty fee; warranty only on-platform).
//
// Money model — all integer paisa, every movement a balanced
// double-entry pair under ONE txn_id, checked at COMMIT by the deferred
// trigger from db/0008 (SUM(D) = SUM(C) per txn_id). Reuses the
// settlement helpers the codebase already has: ensureWallet (one wallet
// per user) and the dispute resolver's refund shape (admin.service.ts:
// customer credit D refund_expense / C wallet, provider debit only when
// the job was already settled).
//   FEE (collectFee, at payment): D wallet / C warranty_fee_rev on the
//     CUSTOMER wallet. Balance -= fee. Fee is platform revenue.
//   REFUND (approveRefund, after rework failed/refused):
//     txn A (customer): D warranty_refund_expense (price) / C wallet
//       (price) + D warranty_fee_rev (fee) / C wallet (fee) — full job
//       price PLUS the warranty fee back, one txn_id.
//     txn B (provider, only if job payment_status='settled'):
//       D wallet / C warranty_refund_expense (price) on provider wallet.
// Claim flow is a strict state machine (see warranty-calc.ts):
//   filed -> under_review -> rework_offered -> rework_done -> closed
//                                  \-> rework_failed -> refunded
//   filed | under_review -> rejected
// Illegal transitions are rejected with 409 ILLEGAL_CLAIM_TRANSITION
// AND still written to warranty_claim_events (illegal=true), mirroring
// the jobs service's illegal-transition logging. Admin decisions are
// additionally written to audit_logs inside the same transaction.
//
// INTEGRATOR NOTE: this module is NOT wired into AppModule here —
// backend/src/app.module.ts is owned by the integrator. Add:
//   import { WarrantyModule } from './modules/warranty/warranty.module';
// and add WarrantyModule to the imports array, then add the routes
// listed in docs/phase4-warranty.md to backend/openapi.yaml (the
// route-diff contract test enforces spec == code, so both land together).
// DatabaseModule is @Global, so DatabaseService/RedisService resolve
// without an explicit import here.
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { Errors } from '../../common/errors/api-error';
import { paisaToPkr, pkrToPaisa } from '../../common/utils/money';
import { ensureWallet } from '../../common/utils/wallet';
import { withIdempotency } from '../../common/utils/idempotency';
import {
  CLAIM_OPEN,
  ClaimStatus,
  DEFAULT_WARRANTY_CONFIG,
  WARRANTY_CLAIM_WINDOW_DAYS,
  WARRANTY_ELIGIBLE_TIER,
  computeWarrantyFee,
  coverageEndsAt,
  isLegalClaimTransition,
  isWithinClaimWindow,
  validateWarrantyConfig,
  WarrantyConfig,
} from './warranty-calc';

export type { WarrantyConfig };
export { WARRANTY_CLAIM_WINDOW_DAYS, WARRANTY_ELIGIBLE_TIER };

export interface WarrantyView {
  id: string;
  job_id: string;
  customer_id: string;
  provider_id: string;
  provider_user_id: string;
  fee_paisa: number;
  fee_pkr: number;
  job_price_paisa: number;
  job_price_pkr: number;
  status: string;
  coverage_starts_at: string | null;
  coverage_ends_at: string | null;
  fee_txn_id: string | null;
  fee_collected_at: string | null;
  created_at: string;
}

export interface ClaimView {
  id: string;
  warranty_id: string;
  job_id: string;
  customer_id: string;
  provider_id: string;
  status: ClaimStatus;
  reason: string;
  description: string;
  rework_note: string | null;
  refund_amount_paisa: number | null;
  refund_amount_pkr: number | null;
  refund_txn_id: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  filed_at: string;
  reviewed_at: string | null;
  rework_offered_at: string | null;
  resolved_at: string | null;
}

export interface WarrantyRulesView {
  version: number;
  title: string;
  body_md: string;
  is_current: boolean;
  created_at: string;
}

export interface ProviderWarrantyBadge {
  provider_id: string;
  tier: number;
  tier_name: string;
  warranty_eligible: boolean;
  badge: string | null;
  coverage_days: number;
  fee_rate: number;
}

type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** pg returns timestamptz columns as JS Dates; String(date) drops the
 *  milliseconds (and is not ISO), so normalise to ISO explicitly. */
function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}
function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toWarranty(row: Record<string, unknown>): WarrantyView {
  const fee = Number(row.fee_paisa);
  const price = Number(row.job_price_paisa);
  return {
    id: String(row.id),
    job_id: String(row.job_id),
    customer_id: String(row.customer_id),
    provider_id: String(row.provider_id),
    provider_user_id: String(row.provider_user_id),
    fee_paisa: fee,
    fee_pkr: paisaToPkr(fee),
    job_price_paisa: price,
    job_price_pkr: paisaToPkr(price),
    status: String(row.status),
    coverage_starts_at: iso(row.coverage_starts_at),
    coverage_ends_at: iso(row.coverage_ends_at),
    fee_txn_id: row.fee_txn_id ? String(row.fee_txn_id) : null,
    fee_collected_at: iso(row.fee_collected_at),
    created_at: iso(row.created_at) as string,
  };
}

function toClaim(row: Record<string, unknown>): ClaimView {
  const refund = row.refund_amount_paisa == null ? null : Number(row.refund_amount_paisa);
  return {
    id: String(row.id),
    warranty_id: String(row.warranty_id),
    job_id: String(row.job_id),
    customer_id: String(row.customer_id),
    provider_id: String(row.provider_id),
    status: String(row.status) as ClaimStatus,
    reason: String(row.reason),
    description: String(row.description),
    rework_note: row.rework_note ? String(row.rework_note) : null,
    refund_amount_paisa: refund,
    refund_amount_pkr: refund == null ? null : paisaToPkr(refund),
    refund_txn_id: row.refund_txn_id ? String(row.refund_txn_id) : null,
    decided_by: row.decided_by ? String(row.decided_by) : null,
    decision_reason: row.decision_reason ? String(row.decision_reason) : null,
    filed_at: iso(row.filed_at) as string,
    reviewed_at: iso(row.reviewed_at),
    rework_offered_at: iso(row.rework_offered_at),
    resolved_at: iso(row.resolved_at),
  };
}

const OPT_IN_ALLOWED_STATES = [
  'ACCEPTED', 'PROVIDER_EN_ROUTE', 'CUSTOMER_EN_ROUTE', 'ITEM_PICKED_UP',
  'ARRIVED', 'IN_PROGRESS', 'PRICE_ADJUSTMENT_PENDING', 'COMPLETED',
];

@Injectable()
export class WarrantyService {
  private readonly logger = new Logger(WarrantyService.name);
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private realtime: RealtimeService,
  ) {}

  // ---- Config + pricing --------------------------------------------------
  async getConfig(): Promise<WarrantyConfig> {
    const cfg = { ...DEFAULT_WARRANTY_CONFIG };
    const read = async (key: string): Promise<Record<string, unknown> | undefined> => {
      const rows = (await this.db.query(`SELECT config FROM feature_flags WHERE key=$1`, [key])).rows;
      return rows[0]?.config as Record<string, unknown> | undefined;
    };
    const rate = (await read('warranty_fee_rate'))?.value_rate;
    if (typeof rate === 'number') cfg.fee_rate = rate;
    const flat = (await read('warranty_fee_flat_paisa'))?.value_paisa;
    if (typeof flat === 'number') cfg.fee_flat_paisa = flat;
    const min = (await read('warranty_fee_min_paisa'))?.value_paisa;
    if (typeof min === 'number') cfg.fee_min_paisa = min;
    const max = (await read('warranty_fee_max_paisa'))?.value_paisa;
    if (typeof max === 'number') cfg.fee_max_paisa = max;
    const days = (await read('warranty_claim_days'))?.value_days;
    if (typeof days === 'number') cfg.claim_window_days = days;
    return cfg;
  }

  async updateConfig(adminId: string, dto: Partial<WarrantyConfig>): Promise<WarrantyConfig> {
    try {
      validateWarrantyConfig(dto);
    } catch (e) {
      throw Errors.unprocessable('INVALID_WARRANTY_CONFIG', (e as Error).message);
    }
    const writes: [string, Record<string, unknown>][] = [];
    if (dto.fee_rate !== undefined) writes.push(['warranty_fee_rate', { value_rate: dto.fee_rate }]);
    if (dto.fee_flat_paisa !== undefined) writes.push(['warranty_fee_flat_paisa', { value_paisa: dto.fee_flat_paisa }]);
    if (dto.fee_min_paisa !== undefined) writes.push(['warranty_fee_min_paisa', { value_paisa: dto.fee_min_paisa }]);
    if (dto.fee_max_paisa !== undefined) writes.push(['warranty_fee_max_paisa', { value_paisa: dto.fee_max_paisa }]);
    if (dto.claim_window_days !== undefined) writes.push(['warranty_claim_days', { value_days: dto.claim_window_days }]);
    if (writes.length === 0) throw Errors.badRequest('NO_FIELDS', 'Nothing to update');
    // Min must not exceed max even when only one side is patched: check
    // the merged config before writing anything.
    const merged = { ...(await this.getConfig()), ...dto };
    if (merged.fee_min_paisa > merged.fee_max_paisa) {
      throw Errors.unprocessable('INVALID_WARRANTY_CONFIG', 'fee_min_paisa must not exceed fee_max_paisa');
    }
    for (const [key, config] of writes) {
      await this.db.query(
        `INSERT INTO feature_flags (key, enabled, config) VALUES ($1, true, $2) ON CONFLICT (key) DO UPDATE SET config=EXCLUDED.config, updated_by=$3, updated_at=now()`,
        [key, JSON.stringify(config), adminId],
      );
    }
    return this.getConfig();
  }

  /** Public quote: fee for a job price, before opting in. */
  async quoteFee(jobPricePkr: number): Promise<{ job_price_pkr: number; job_price_paisa: number; fee_paisa: number; fee_pkr: number; fee_rate: number; claim_window_days: number }> {
    const cfg = await this.getConfig();
    const pricePaisa = pkrToPaisa(jobPricePkr);
    if (pricePaisa <= 0) throw Errors.unprocessable('INVALID_JOB_PRICE', 'job_price_pkr must be positive');
    const fee = computeWarrantyFee(pricePaisa, cfg);
    return { job_price_pkr: jobPricePkr, job_price_paisa: pricePaisa, fee_paisa: fee, fee_pkr: paisaToPkr(fee), fee_rate: cfg.fee_rate, claim_window_days: cfg.claim_window_days };
  }

  // ---- Published rules ---------------------------------------------------
  async getRules(): Promise<WarrantyRulesView> {
    const row = (await this.db.query(
      `SELECT * FROM warranty_rules WHERE is_current ORDER BY version DESC LIMIT 1`,
    )).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) throw Errors.notFound('Warranty rules');
    return {
      version: Number(row.version),
      title: String(row.title),
      body_md: String(row.body_md),
      is_current: Boolean(row.is_current),
      created_at: iso(row.created_at) as string,
    };
  }

  async updateRules(adminId: string, title: string, bodyMd: string): Promise<WarrantyRulesView> {
    if (!title.trim() || !bodyMd.trim()) throw Errors.badRequest('EMPTY_RULES', 'title and body_md must not be empty');
    const row = await this.db.withTransaction(async (c) => {
      const cur = (await c.query(`SELECT MAX(version) AS v FROM warranty_rules`)).rows[0] as unknown as { v: string | null };
      const version = Number(cur?.v ?? 0) + 1;
      await c.query(`UPDATE warranty_rules SET is_current=false WHERE is_current`);
      return (await c.query(
        `INSERT INTO warranty_rules (version, title, body_md, is_current, created_by) VALUES ($1,$2,$3,true,$4) RETURNING *`,
        [version, title, bodyMd, adminId],
      )).rows[0] as Record<string, unknown>;
    });
    return {
      version: Number(row.version),
      title: String(row.title),
      body_md: String(row.body_md),
      is_current: true,
      created_at: iso(row.created_at) as string,
    };
  }

  // ---- Opt-in + fee collection -------------------------------------------
  async optIn(jobId: string, customerId: string, idempotencyKey?: string): Promise<WarrantyView> {
    return withIdempotency(this.redis, `warranty-optin:${jobId}`, idempotencyKey, async () =>
      this.db.withTransaction(async (c) => {
        const job = (await c.query(
          `SELECT j.*, p.tier, p.user_id AS provider_user_id FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1 FOR UPDATE`,
          [jobId],
        )).rows[0] as unknown as Record<string, unknown> | undefined;
        if (!job) throw Errors.notFound('Job');
        if (job.customer_id !== customerId) throw Errors.forbidden('Only the job customer can opt in to the warranty');
        if (Number(job.tier) !== WARRANTY_ELIGIBLE_TIER) {
          throw Errors.unprocessable(
            'WARRANTY_TIER_NOT_ELIGIBLE',
            `Warranty is only available on Tier ${WARRANTY_ELIGIBLE_TIER} (Trusted Pro) jobs — this provider is Tier ${Number(job.tier)}`,
          );
        }
        if (!OPT_IN_ALLOWED_STATES.includes(String(job.state))) {
          throw Errors.conflict('WARRANTY_TOO_LATE', `Warranty opt-in is no longer possible once a job is ${String(job.state)}`);
        }
        const existing = (await c.query(`SELECT * FROM job_warranties WHERE job_id=$1 FOR UPDATE`, [jobId])).rows[0];
        if (existing) throw Errors.conflict('WARRANTY_ALREADY_OPTED_IN', 'This job already has a warranty');
        const cfg = await this.getConfig();
        const pricePaisa = pkrToPaisa(Number(job.final_price ?? job.agreed_price));
        if (pricePaisa <= 0) throw Errors.unprocessable('INVALID_JOB_PRICE', 'Job price must be positive to price a warranty');
        const fee = computeWarrantyFee(pricePaisa, cfg);
        const row = (await c.query(
          `INSERT INTO job_warranties (job_id, customer_id, provider_id, provider_user_id, fee_paisa, job_price_paisa, status)
           VALUES ($1,$2,$3,$4,$5,$6,'pending_payment') RETURNING *`,
          [jobId, customerId, String(job.provider_id), String(job.provider_user_id), fee, pricePaisa],
        )).rows[0] as Record<string, unknown>;
        await c.query(`UPDATE jobs SET warranty_opted_in=true, warranty_fee_paisa=$2 WHERE id=$1`, [jobId, fee]);
        await c.query(
          `INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
          [jobId, String(job.state), String(job.state), customerId, 'customer', JSON.stringify({ warranty_id: row.id, fee_paisa: fee, warranty_opted_in: true })],
        );
        return toWarranty(row);
      }));
  }

  /**
   * Collect the warranty fee at payment time. The job must be COMPLETED,
   * PAYMENT_SETTLED or RATED (Fix B: a job can reach RATED — both reviews
   * in — before the fee is paid, e.g. a cash job whose customer pays the
   * fee late; refusing collection then would strand the warranty in
   * pending_payment forever) and the customer wallet must cover the fee.
   * Balanced ledger: D wallet / C warranty_fee_rev on the customer wallet;
   * balance -= fee. The 7-day coverage window starts at the job's
   * completed_at. Call this from the payment settlement step (see
   * docs/phase4-warranty.md).
   */
  async collectFee(jobId: string, customerId: string, idempotencyKey?: string): Promise<WarrantyView> {
    return withIdempotency(this.redis, `warranty-fee:${jobId}`, idempotencyKey, async () =>
      this.db.withTransaction(async (c) => {
        const client = c as unknown as QueryClient;
        const w = (await c.query(`SELECT * FROM job_warranties WHERE job_id=$1 FOR UPDATE`, [jobId])).rows[0] as unknown as Record<string, unknown> | undefined;
        if (!w) throw Errors.notFound('Warranty for this job');
        if (w.customer_id !== customerId) throw Errors.forbidden('Only the job customer can pay the warranty fee');
        if (w.status !== 'pending_payment') throw Errors.conflict('WARRANTY_FEE_STATE', `Warranty fee cannot be collected while the warranty is ${String(w.status)}`);
        const job = (await c.query(`SELECT state, completed_at FROM jobs WHERE id=$1`, [jobId])).rows[0] as unknown as Record<string, unknown> | undefined;
        if (!job) throw Errors.notFound('Job');
        if (!['COMPLETED', 'PAYMENT_SETTLED', 'RATED'].includes(String(job.state))) {
          throw Errors.conflict('WARRANTY_FEE_TOO_EARLY', 'Warranty fee is collected at payment time, after the job is COMPLETED');
        }
        const fee = Number(w.fee_paisa);
        const walletId = await ensureWallet(client, customerId);
        const bal = (await c.query(`SELECT balance_paisa FROM wallet_accounts WHERE id=$1 FOR UPDATE`, [walletId])).rows[0] as unknown as { balance_paisa: string };
        if (Number(bal.balance_paisa) < fee) {
          throw Errors.conflict('INSUFFICIENT_WALLET_BALANCE', `Wallet balance is short by PKR ${paisaToPkr(fee - Number(bal.balance_paisa))} for the warranty fee`);
        }
        const cfg = await this.getConfig();
        const startsAt = job.completed_at ? asDate(job.completed_at) : new Date();
        const endsAt = coverageEndsAt(startsAt, cfg.claim_window_days);
        const txnId = randomUUID();
        await c.query(
          `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [txnId, walletId, 'wallet', 'D', fee, jobId, 'Warranty fee for job'],
        );
        await c.query(
          `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [txnId, walletId, 'warranty_fee_rev', 'C', fee, jobId, 'Warranty fee revenue'],
        );
        await c.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2 WHERE id=$1`, [walletId, fee]);
        const updated = (await c.query(
          `UPDATE job_warranties SET status='active', coverage_starts_at=$2, coverage_ends_at=$3, fee_txn_id=$4, fee_collected_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
          [String(w.id), startsAt.toISOString(), endsAt.toISOString(), txnId],
        )).rows[0] as Record<string, unknown>;
        this.realtime.emitToRoom(`job:${jobId}`, 'warranty.activated', { job_id: jobId, warranty_id: String(w.id), coverage_ends_at: endsAt.toISOString() });
        return toWarranty(updated);
      }));
  }

  /**
   * Settlement hook (Phase 4 integrator — wired from
   * JobsService.confirmPaymentInner for cash and
   * WalletService.payWithWalletInner for wallet payments).
   *
   * No-op when the job never opted in (`not_opted_in`) or the fee was
   * already collected (`already_active` / other status). NEVER throws:
   * settlement has already committed by the time this runs, so a fee
   * failure (e.g. the customer wallet is short — possible on cash jobs,
   * which settle without touching the wallet) must not turn a settled
   * payment into a 500. In that case the warranty stays
   * `pending_payment` and the customer can still pay it via
   * POST /jobs/:id/warranty/collect-fee; the reason is returned so the
   * caller can log it. A failure here never activates coverage.
   *
   * ESCROW GAP (honest, not coordinated): if the job is escrow-held
   * (not yet released) and a warranty claim is later refunded, the
   * refund path does not release/refund the escrow hold — see
   * docs/phase4-api-addendum.md. This hook only collects the fee; it
   * does not touch escrow.
   */
  async collectFeeAtSettlement(jobId: string, customerId: string): Promise<{ collected: boolean; reason: string }> {
    const w = (await this.db.query(`SELECT id, status FROM job_warranties WHERE job_id=$1`, [jobId])).rows[0] as
      | { id: string; status: string }
      | undefined;
    if (!w) return { collected: false, reason: 'not_opted_in' };
    if (w.status !== 'pending_payment') return { collected: false, reason: `already_${String(w.status)}` };
    try {
      await this.collectFee(jobId, customerId);
      return { collected: true, reason: 'collected' };
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'UNKNOWN';
      this.logger.warn(`warranty fee collection at settlement failed for job ${jobId} (${code}): ${(e as Error).message} — warranty stays pending_payment`);
      return { collected: false, reason: code === 'INSUFFICIENT_WALLET_BALANCE' ? 'insufficient_wallet_balance' : 'fee_collection_failed' };
    }
  }

  // ---- Reads: warranty, badge, receipt ------------------------------------
  async getWarranty(jobId: string, userId: string, roles: string[] = []): Promise<WarrantyView & { claim: ClaimView | null }> {
    const w = await this.loadWarrantyForParty(jobId, userId, roles);
    const claim = (await this.db.query(
      `SELECT * FROM warranty_claims WHERE warranty_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [String(w.id)],
    )).rows[0] as unknown as Record<string, unknown> | undefined;
    return { ...toWarranty(w), claim: claim ? toClaim(claim) : null };
  }

  async providerBadge(providerId: string): Promise<ProviderWarrantyBadge> {
    const p = (await this.db.query(
      `SELECT p.tier, COALESCE(t.name, '') AS tier_name FROM provider_profiles p LEFT JOIN provider_tiers t ON t.tier=p.tier WHERE p.id=$1`,
      [providerId],
    )).rows[0] as unknown as { tier: number; tier_name: string } | undefined;
    if (!p) throw Errors.notFound('Provider');
    const cfg = await this.getConfig();
    const eligible = Number(p.tier) === WARRANTY_ELIGIBLE_TIER;
    return {
      provider_id: providerId,
      tier: Number(p.tier),
      tier_name: String(p.tier_name || ''),
      warranty_eligible: eligible,
      badge: eligible ? 'WARRANTY_7_DAY' : null,
      coverage_days: cfg.claim_window_days,
      fee_rate: cfg.fee_rate,
    };
  }

  /** Job receipt: job price, warranty fee, coverage window, claim status. */
  async getReceipt(jobId: string, userId: string, roles: string[] = []): Promise<Record<string, unknown>> {
    const w = await this.loadWarrantyForParty(jobId, userId, roles);
    const job = (await this.db.query(
      `SELECT j.id, j.state, j.payment_status, j.agreed_price, j.final_price, j.commission_rate, j.completed_at,
              p.display_name AS provider_name, p.tier AS provider_tier
       FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1`,
      [jobId],
    )).rows[0] as unknown as Record<string, unknown>;
    const claim = (await this.db.query(
      `SELECT * FROM warranty_claims WHERE warranty_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [String(w.id)],
    )).rows[0] as unknown as Record<string, unknown> | undefined;
    const pricePkr = Number(job.final_price ?? job.agreed_price);
    return {
      job_id: jobId,
      job_state: String(job.state),
      payment_status: String(job.payment_status),
      provider_name: String(job.provider_name),
      provider_tier: Number(job.provider_tier),
      job_price_pkr: pricePkr,
      warranty_opted_in: true,
      warranty_fee_pkr: paisaToPkr(Number(w.fee_paisa)),
      warranty_fee_paisa: Number(w.fee_paisa),
      warranty_status: String(w.status),
      coverage_starts_at: w.coverage_starts_at ? String(w.coverage_starts_at) : null,
      coverage_ends_at: w.coverage_ends_at ? String(w.coverage_ends_at) : null,
      total_charged_pkr: pricePkr + paisaToPkr(Number(w.fee_paisa)),
      claim: claim ? toClaim(claim) : null,
    };
  }

  private async loadWarrantyForParty(jobId: string, userId: string, roles: string[]): Promise<Record<string, unknown>> {
    const w = (await this.db.query(`SELECT * FROM job_warranties WHERE job_id=$1`, [jobId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!w) throw Errors.notFound('Warranty for this job');
    const isAdmin = roles.includes('super_admin') || roles.includes('finance') || roles.includes('support_agent');
    if (!isAdmin && w.customer_id !== userId && w.provider_user_id !== userId) {
      throw Errors.forbidden('Not a party to this warranty');
    }
    return w;
  }

  // ---- Claims ---------------------------------------------------------------
  async fileClaim(
    jobId: string,
    customerId: string,
    dto: { reason: string; description: string },
    now: Date = new Date(),
    idempotencyKey?: string,
  ): Promise<ClaimView> {
    return withIdempotency(this.redis, `warranty-claim:${jobId}`, idempotencyKey, async () =>
      this.db.withTransaction(async (c) => {
        const w = (await c.query(`SELECT * FROM job_warranties WHERE job_id=$1 FOR UPDATE`, [jobId])).rows[0] as unknown as Record<string, unknown> | undefined;
        if (!w) throw Errors.notFound('Warranty for this job');
        if (w.customer_id !== customerId) throw Errors.forbidden('Only the job customer can file a warranty claim');
        if (w.status !== 'active' && w.status !== 'claimed') {
          throw Errors.conflict('WARRANTY_NOT_ACTIVE', `Claims can only be filed on an active warranty (warranty is ${String(w.status)})`);
        }
        if (!w.coverage_ends_at || !isWithinClaimWindow(now, asDate(w.coverage_ends_at))) {
          throw Errors.unprocessable('WARRANTY_CLAIM_WINDOW_CLOSED', 'The 7-day claim window has closed — claims must be filed within 7 days of completion');
        }
        const open = (await c.query(
          `SELECT id FROM warranty_claims WHERE warranty_id=$1 AND status = ANY($2::varchar[]) LIMIT 1`,
          [String(w.id), CLAIM_OPEN],
        )).rows[0];
        if (open) throw Errors.conflict('WARRANTY_CLAIM_ALREADY_OPEN', 'This warranty already has an open claim');
        const claim = (await c.query(
          `INSERT INTO warranty_claims (warranty_id, job_id, customer_id, provider_id, provider_user_id, status, reason, description)
           VALUES ($1,$2,$3,$4,$5,'filed',$6,$7) RETURNING *`,
          [String(w.id), jobId, customerId, String(w.provider_id), String(w.provider_user_id), dto.reason, dto.description],
        )).rows[0] as Record<string, unknown>;
        await c.query(
          `INSERT INTO warranty_claim_events (claim_id, from_status, to_status, actor_user_id, actor_role, note) VALUES ($1,NULL,'filed',$2,'customer',$3)`,
          [String(claim.id), customerId, dto.reason],
        );
        await c.query(`UPDATE job_warranties SET status='claimed', updated_at=now() WHERE id=$1`, [String(w.id)]);
        this.realtime.emitToRoom(`job:${jobId}`, 'warranty.claim_filed', { job_id: jobId, claim_id: String(claim.id) });
        return toClaim(claim);
      }));
  }

  async getClaim(claimId: string, userId: string, roles: string[] = []): Promise<ClaimView & { events: Record<string, unknown>[] }> {
    const claim = await this.loadClaimForParty(claimId, userId, roles);
    const events = (await this.db.query(
      `SELECT * FROM warranty_claim_events WHERE claim_id=$1 ORDER BY created_at ASC, id ASC`,
      [claimId],
    )).rows;
    return { ...toClaim(claim), events };
  }

  async listClaimsForUser(userId: string, limit = 20): Promise<ClaimView[]> {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = (await this.db.query(
      `SELECT * FROM warranty_claims WHERE customer_id=$1 OR provider_user_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [userId, lim],
    )).rows;
    return rows.map(toClaim);
  }

  async listAdminClaims(status?: string, limit = 50): Promise<ClaimView[]> {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = status
      ? (await this.db.query(`SELECT * FROM warranty_claims WHERE status=$1 ORDER BY created_at DESC LIMIT $2`, [status, lim])).rows
      : (await this.db.query(`SELECT * FROM warranty_claims ORDER BY created_at DESC LIMIT $1`, [lim])).rows;
    return rows.map(toClaim);
  }

  // ---- Claim transitions (single choke point: state machine + audit) -------
  async reviewClaim(claimId: string, adminId: string): Promise<ClaimView> {
    return this.transitionClaim(claimId, adminId, 'admin', 'under_review', 'Claim taken up for review', true);
  }

  async offerRework(claimId: string, actorId: string, actorRole: 'admin' | 'provider', note?: string): Promise<ClaimView> {
    const claim = await this.peekClaim(claimId);
    if (actorRole === 'provider' && claim.provider_user_id !== actorId) {
      throw Errors.forbidden('Only the job provider can offer rework');
    }
    return this.transitionClaim(claimId, actorId, actorRole, 'rework_offered', note ?? 'Rework offered — provider will return and fix the work', actorRole === 'admin');
  }

  async reportReworkDone(claimId: string, actorId: string, actorRole: 'customer' | 'provider' | 'admin', note?: string): Promise<ClaimView> {
    const claim = await this.peekClaim(claimId);
    if (actorRole === 'customer' && claim.customer_id !== actorId) throw Errors.forbidden('Only the job customer can confirm rework is done');
    if (actorRole === 'provider' && claim.provider_user_id !== actorId) throw Errors.forbidden('Only the job provider can report rework done');
    return this.transitionClaim(claimId, actorId, actorRole, 'rework_done', note ?? 'Rework completed', actorRole === 'admin');
  }

  async reportReworkFailed(claimId: string, actorId: string, actorRole: 'customer' | 'provider' | 'admin', note?: string): Promise<ClaimView> {
    const claim = await this.peekClaim(claimId);
    if (actorRole === 'customer' && claim.customer_id !== actorId) throw Errors.forbidden('Only the job customer can report rework failed');
    if (actorRole === 'provider' && claim.provider_user_id !== actorId) throw Errors.forbidden('Only the job provider can report rework failed');
    return this.transitionClaim(claimId, actorId, actorRole, 'rework_failed', note ?? 'Rework failed or refused', actorRole === 'admin');
  }

  async closeClaim(claimId: string, actorId: string, actorRole: 'customer' | 'admin', note?: string): Promise<ClaimView> {
    const claim = await this.peekClaim(claimId);
    if (actorRole === 'customer' && claim.customer_id !== actorId) throw Errors.forbidden('Only the job customer can close the claim');
    const out = await this.transitionClaim(claimId, actorId, actorRole, 'closed', note ?? 'Rework accepted — claim closed', actorRole === 'admin');
    // Coverage continues after a successful rework: the warranty goes
    // back to active (the expiry sweep closes it when the window ends).
    await this.db.query(`UPDATE job_warranties SET status='active', updated_at=now() WHERE id=$1 AND status='claimed'`, [String(claim.warranty_id)]);
    return out;
  }

  async rejectClaim(claimId: string, adminId: string, reason: string): Promise<ClaimView> {
    if (!reason?.trim()) throw Errors.badRequest('REASON_REQUIRED', 'A reason is required to reject a claim');
    const out = await this.transitionClaim(claimId, adminId, 'admin', 'rejected', reason, true, reason);
    const claim = await this.peekClaim(claimId);
    await this.db.query(`UPDATE job_warranties SET status='active', updated_at=now() WHERE id=$1 AND status='claimed'`, [String(claim.warranty_id)]);
    return out;
  }

  /**
   * Refund after rework failed/refused. Only legal from rework_failed.
   * Ledger (see header): customer credited price + fee in ONE txn_id;
   * provider debited the price in a second txn ONLY if the job was
   * already settled. Warranty -> 'refunded', claim -> 'refunded'.
   */
  async approveRefund(claimId: string, adminId: string, reason: string): Promise<ClaimView> {
    if (!reason?.trim()) throw Errors.badRequest('REASON_REQUIRED', 'A reason is required to approve a refund');
    return this.db.withTransaction(async (c) => {
      const claim = (await c.query(`SELECT * FROM warranty_claims WHERE id=$1 FOR UPDATE`, [claimId])).rows[0] as unknown as Record<string, unknown> | undefined;
      if (!claim) throw Errors.notFound('Warranty claim');
      const from = String(claim.status) as ClaimStatus;
      if (!isLegalClaimTransition(from, 'refunded')) {
        await c.query(
          `INSERT INTO warranty_claim_events (claim_id, from_status, to_status, actor_user_id, actor_role, note, illegal) VALUES ($1,$2,'refunded',$3,'admin',$4,true)`,
          [claimId, from, adminId, reason],
        );
        // The illegal attempt must be committed even though the refund
        // is refused: commit it in its own transaction below by throwing
        // a sentinel the outer caller converts — simpler: the event row
        // above is inside this txn, so roll it back and re-log outside.
        // (withTransaction rolls back on throw; re-log after the catch.)
        const err = Errors.conflict('ILLEGAL_CLAIM_TRANSITION', `Illegal claim transition ${from} -> refunded`);
        (err as unknown as { _illegalClaimEvent?: unknown })._illegalClaimEvent = { claimId, from, adminId, reason };
        throw err;
      }
      const w = (await c.query(`SELECT * FROM job_warranties WHERE id=$1 FOR UPDATE`, [String(claim.warranty_id)])).rows[0] as unknown as Record<string, unknown>;
      const job = (await c.query(`SELECT final_price, agreed_price, payment_status FROM jobs WHERE id=$1`, [String(claim.job_id)])).rows[0] as unknown as Record<string, unknown>;
      const pricePaisa = pkrToPaisa(Number(job.final_price ?? job.agreed_price));
      const feePaisa = Number(w.fee_paisa);
      const refundPaisa = pricePaisa + feePaisa;
      const customerWalletId = await ensureWallet(c as unknown as QueryClient, String(claim.customer_id));
      const txnId = randomUUID();
      const postLeg = async (walletId: string, account: string, dir: 'D' | 'C', amount: number) => {
        await c.query(
          `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [txnId, walletId, account, dir, amount, String(claim.job_id), `Warranty refund for claim ${claimId}`],
        );
      };
      await postLeg(customerWalletId, 'warranty_refund_expense', 'D', pricePaisa);
      await postLeg(customerWalletId, 'wallet', 'C', pricePaisa);
      if (feePaisa > 0) {
        await postLeg(customerWalletId, 'warranty_fee_rev', 'D', feePaisa);
        await postLeg(customerWalletId, 'wallet', 'C', feePaisa);
      }
      await c.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa + $2 WHERE id=$1`, [customerWalletId, refundPaisa]);
      await c.query(
        `INSERT INTO payments (job_id, payer_id, method, provider_name, amount, status) VALUES ($1,$2,'wallet','wallet',$3,'refunded')`,
        [String(claim.job_id), String(claim.customer_id), paisaToPkr(refundPaisa)],
      );
      if (String(job.payment_status) === 'settled') {
        // Provider recovery: separate txn_id (own balanced pair).
        const recoveryTxn = randomUUID();
        const providerWalletId = await ensureWallet(c as unknown as QueryClient, String(claim.provider_user_id));
        await c.query(
          `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [recoveryTxn, providerWalletId, 'wallet', 'D', pricePaisa, String(claim.job_id), `Warranty refund recovery for claim ${claimId}`],
        );
        await c.query(
          `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [recoveryTxn, providerWalletId, 'warranty_refund_expense', 'C', pricePaisa, String(claim.job_id), `Warranty refund recovery for claim ${claimId}`],
        );
        await c.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2 WHERE id=$1`, [providerWalletId, pricePaisa]);
      }
      const resolvedAt = new Date().toISOString();
      const updated = (await c.query(
        `UPDATE warranty_claims SET status='refunded', refund_amount_paisa=$2, refund_txn_id=$3, decided_by=$4, decision_reason=$5, resolved_at=$6, updated_at=now() WHERE id=$1 RETURNING *`,
        [claimId, refundPaisa, txnId, adminId, reason, resolvedAt],
      )).rows[0] as Record<string, unknown>;
      await c.query(`UPDATE job_warranties SET status='refunded', updated_at=now() WHERE id=$1`, [String(claim.warranty_id)]);
      await this.logClaimEvent(c, claimId, from, 'refunded', adminId, 'admin', reason, false);
      await this.audit(c, adminId, 'warranty.claim.refund', 'warranty_claims', claimId, claim, updated);
      this.realtime.emitToRoom(`job:${String(claim.job_id)}`, 'warranty.claim_refunded', { job_id: String(claim.job_id), claim_id: claimId, refund_paisa: refundPaisa });
      return toClaim(updated);
    }).catch(async (e: unknown) => {
      // Re-log an illegal refund attempt outside the rolled-back txn so
      // the attempt itself is still auditable (mirrors jobs' illegal
      // transition logging, which writes before throwing).
      const marker = (e as { _illegalClaimEvent?: { claimId: string; from: string; adminId: string; reason: string } })._illegalClaimEvent;
      if (marker) {
        await this.db.query(
          `INSERT INTO warranty_claim_events (claim_id, from_status, to_status, actor_user_id, actor_role, note, illegal) VALUES ($1,$2,'refunded',$3,'admin',$4,true)`,
          [marker.claimId, marker.from, marker.adminId, marker.reason],
        );
      }
      throw e;
    });
  }

  /** Expire active warranties whose coverage window has passed (sweep). */
  async expireWarranties(now: Date = new Date()): Promise<{ expired: string[]; checked_at: string }> {
    const rows = (await this.db.query(
      `SELECT id FROM job_warranties WHERE status='active' AND coverage_ends_at <= $1 ORDER BY coverage_ends_at ASC`,
      [now.toISOString()],
    )).rows;
    const expired: string[] = [];
    for (const r of rows) {
      await this.db.query(`UPDATE job_warranties SET status='expired', updated_at=now() WHERE id=$1 AND status='active'`, [String(r.id)]);
      expired.push(String(r.id));
    }
    return { expired, checked_at: now.toISOString() };
  }

  // ---- Internals ------------------------------------------------------------
  private async peekClaim(claimId: string): Promise<Record<string, unknown>> {
    const claim = (await this.db.query(`SELECT * FROM warranty_claims WHERE id=$1`, [claimId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!claim) throw Errors.notFound('Warranty claim');
    return claim;
  }

  private async loadClaimForParty(claimId: string, userId: string, roles: string[]): Promise<Record<string, unknown>> {
    const claim = await this.peekClaim(claimId);
    const isAdmin = roles.includes('super_admin') || roles.includes('finance') || roles.includes('support_agent');
    if (!isAdmin && claim.customer_id !== userId && claim.provider_user_id !== userId) {
      throw Errors.forbidden('Not a party to this warranty claim');
    }
    return claim;
  }

  private async logClaimEvent(
    c: QueryClient,
    claimId: string,
    from: string | null,
    to: string,
    actorId: string,
    actorRole: string,
    note: string | null,
    illegal: boolean,
  ): Promise<void> {
    await c.query(
      `INSERT INTO warranty_claim_events (claim_id, from_status, to_status, actor_user_id, actor_role, note, illegal) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [claimId, from, to, actorId, actorRole, note, illegal],
    );
  }

  private async audit(c: QueryClient, actorId: string, action: string, entity: string, entityId: string, before: unknown, after: unknown): Promise<void> {
    await c.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
      [actorId, action, entity, entityId, JSON.stringify(before), JSON.stringify(after)],
    );
  }

  private async transitionClaim(
    claimId: string,
    actorId: string,
    actorRole: string,
    to: ClaimStatus,
    note: string | null,
    audited: boolean,
    decisionReason?: string,
  ): Promise<ClaimView> {
    const out = await this.db.withTransaction(async (c) => {
      const claim = (await c.query(`SELECT * FROM warranty_claims WHERE id=$1 FOR UPDATE`, [claimId])).rows[0] as unknown as Record<string, unknown> | undefined;
      if (!claim) throw Errors.notFound('Warranty claim');
      const from = String(claim.status) as ClaimStatus;
      if (!isLegalClaimTransition(from, to)) {
        // Log the illegal attempt, then throw — the log must survive, so
        // write it in a nested savepoint-free way: insert first, then
        // throw a sentinel the outer catch re-logs (see approveRefund).
        // Here the whole txn rolls back, so re-log outside (below).
        const err = Errors.conflict('ILLEGAL_CLAIM_TRANSITION', `Illegal claim transition ${from} -> ${to}`);
        (err as unknown as { _illegalClaimEvent?: unknown })._illegalClaimEvent = { claimId, from, to, actorId, actorRole, note };
        throw err;
      }
      const patch: Record<string, unknown> = { status: to };
      if (to === 'under_review') patch.reviewed_at = new Date().toISOString();
      if (to === 'rework_offered') {
        patch.rework_offered_at = new Date().toISOString();
        if (note) patch.rework_note = note;
      }
      if (to === 'rework_done' && note) patch.rework_note = note;
      if (to === 'rework_failed' && note) patch.rework_note = note;
      if (to === 'rejected' || to === 'closed') patch.resolved_at = new Date().toISOString();
      if (decisionReason !== undefined) patch.decision_reason = decisionReason;
      if (audited) patch.decided_by = actorId;
      const sets = Object.keys(patch).map((k, i) => `${k}=$${i + 2}`).join(', ');
      const updated = (await c.query(
        `UPDATE warranty_claims SET ${sets}, updated_at=now() WHERE id=$1 RETURNING *`,
        [claimId, ...Object.values(patch)],
      )).rows[0] as Record<string, unknown>;
      await this.logClaimEvent(c, claimId, from, to, actorId, actorRole, note, false);
      if (audited) await this.audit(c, actorId, `warranty.claim.${to}`, 'warranty_claims', claimId, claim, updated);
      return toClaim(updated);
    }).catch(async (e: unknown) => {
      const marker = (e as { _illegalClaimEvent?: { claimId: string; from: string; to: string; actorId: string; actorRole: string; note: string | null } })._illegalClaimEvent;
      if (marker) {
        await this.db.query(
          `INSERT INTO warranty_claim_events (claim_id, from_status, to_status, actor_user_id, actor_role, note, illegal) VALUES ($1,$2,$3,$4,$5,$6,true)`,
          [marker.claimId, marker.from, marker.to, marker.actorId, marker.actorRole, marker.note],
        );
      }
      throw e;
    });
    // Realtime after commit (never inside the txn).
    const claim = await this.peekClaim(claimId);
    this.realtime.emitToRoom(`job:${String(claim.job_id)}`, 'warranty.claim_updated', { job_id: String(claim.job_id), claim_id: claimId, status: to });
    return out;
  }
}
