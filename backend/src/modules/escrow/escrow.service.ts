// Escrow release + provider payouts (Phase 3, item 8 — carried forward
// from Phase 2, where escrow was recorded only as
// wallet_accounts.escrow_held_paisa and release was NOT in scope).
//
// Money model — all integer paisa, every movement a balanced double-entry
// pair (or triple) under ONE txn_id, checked at COMMIT by the deferred
// trigger from db/0008 (SUM(D) = SUM(C) per txn_id):
//   HOLD:    D wallet / C escrow_held on the customer wallet (full amount).
//   RELEASE: D escrow_held (customer wallet, full amount)
//            = C wallet (provider wallet, amount - commission)
//            + C commission_rev (provider wallet, commission).
//   PAYOUT:  D wallet (provider wallet, gross)
//            = C payout_out (net) + C payout_fee_rev (fee, if > 0)
//            + C payout_tax_payable (tax, if > 0).
// Only 'wallet'-coded legs move wallet_accounts.balance_paisa (the same
// rule the reconciliation job uses); 'escrow_held' legs move
// wallet_accounts.escrow_held_paisa instead.
//
// SANDBOX ONLY — live JazzCash/Easypaisa payout execution does NOT exist
// in this build: no live merchant keys exist (same as Phase 2). Payout
// execution calls the Phase 2 sandbox providers (gateway-sandbox.ts),
// which never touch the network, never move real money, and label every
// reference sandbox. PAYMENT_GATEWAY_MODE=live refuses to boot instead
// of silently falling back to sandbox (assertGatewayConfig).
//
// FINANCE APPROVAL / ADMIN INTEGRATION POINT (for the integrator — the
// admin Next.js app is NOT edited by this piece):
//   * Payouts are NEVER executed on request. A provider request creates
//     status 'requested' (instant) or 'scheduled' (scheduled).
//   * Finance (roles super_admin / finance) approves via
//     POST /api/v1/admin/payouts/:id/approve — for an instant payout this
//     executes it immediately (sandbox); for a scheduled payout it marks
//     it 'approved' and execution waits for its scheduled_for.
//   * Finance rejects via POST /api/v1/admin/payouts/:id/reject.
//   * Finance queue: GET /api/v1/admin/payouts?status=requested and
//     GET /api/v1/admin/escrow/holds?status=held.
//   * Auto-release sweep (due holds with no open dispute):
//     POST /api/v1/admin/escrow/auto-release — call on a schedule, e.g.
//     every hour: 0 * * * * curl -X POST <host>/api/v1/admin/escrow/auto-release
//   * Due scheduled payouts: POST /api/v1/admin/payouts/run-due — call on
//     a schedule, e.g. every 15 minutes.
//   * Escrow config (auto-release hours, min amount, fee/tax):
//     GET/PATCH /api/v1/admin/escrow/config.
//   The admin UI must surface the `sandbox: true` flag on every payout
//   response until a live gateway lands — never present a sandbox payout
//   as real money moved.
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { Errors } from '../../common/errors/api-error';
import { commissionPaisa, paisaToPkr, pkrToPaisa } from '../../common/utils/money';
import { ensureWallet } from '../../common/utils/wallet';
import { withIdempotency } from '../../common/utils/idempotency';
import { createGatewayProviders } from '../payments/gateway-sandbox';
import { PaymentProvider } from '../payments/gateway.interface';
import { autoReleaseAt, isAutoReleaseDue, payoutBreakdown, validateEscrowConfig } from './escrow-calc';

export interface EscrowConfig {
  auto_release_hours: number;
  min_amount_paisa: number;
  payout_fee_flat_paisa: number;
  payout_fee_rate: number;
  payout_tax_rate: number;
}

export interface EscrowHoldView {
  id: string;
  job_id: string;
  customer_id: string;
  provider_id: string;
  provider_user_id: string;
  amount_paisa: number;
  amount_pkr: number;
  commission_paisa: number;
  status: string;
  held_at: string;
  auto_release_at: string;
  released_at: string | null;
  released_by: string | null;
  release_txn_id: string | null;
}

export interface PayoutView {
  id: string;
  wallet_id: string;
  job_id: string | null;
  escrow_hold_id: string | null;
  amount_paisa: number;
  amount_pkr: number;
  fee_paisa: number;
  tax_paisa: number;
  net_paisa: number;
  net_pkr: number;
  destination: string;
  destination_phone: string | null;
  provider_method: string | null;
  kind: 'instant' | 'scheduled';
  status: string;
  scheduled_for: string | null;
  executed_at: string | null;
  provider_ref: string | null;
  approved_by: string | null;
  sandbox: boolean;
  created_at: string;
}

const DEFAULT_CONFIG: EscrowConfig = {
  auto_release_hours: 48,
  min_amount_paisa: 500000, // PKR 5,000 — escrow is for high-value jobs only
  payout_fee_flat_paisa: 0,
  payout_fee_rate: 0,
  payout_tax_rate: 0,
};

type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

function toHold(row: Record<string, unknown>): EscrowHoldView {
  return {
    id: String(row.id),
    job_id: String(row.job_id),
    customer_id: String(row.customer_id),
    provider_id: String(row.provider_id),
    provider_user_id: String(row.provider_user_id),
    amount_paisa: Number(row.amount_paisa),
    amount_pkr: paisaToPkr(Number(row.amount_paisa)),
    commission_paisa: Number(row.commission_paisa),
    status: String(row.status),
    held_at: String(row.held_at),
    auto_release_at: String(row.auto_release_at),
    released_at: row.released_at ? String(row.released_at) : null,
    released_by: row.released_by ? String(row.released_by) : null,
    release_txn_id: row.release_txn_id ? String(row.release_txn_id) : null,
  };
}

function toPayout(row: Record<string, unknown>): PayoutView {
  const amountPaisa = Number(row.amount_paisa ?? 0);
  const feePaisa = Number(row.fee_paisa ?? 0);
  const taxPaisa = Number(row.tax_paisa ?? 0);
  return {
    id: String(row.id),
    wallet_id: String(row.wallet_id),
    job_id: row.job_id ? String(row.job_id) : null,
    escrow_hold_id: row.escrow_hold_id ? String(row.escrow_hold_id) : null,
    amount_paisa: amountPaisa,
    amount_pkr: paisaToPkr(amountPaisa),
    fee_paisa: feePaisa,
    tax_paisa: taxPaisa,
    net_paisa: Number(row.net_paisa ?? amountPaisa - feePaisa - taxPaisa),
    net_pkr: paisaToPkr(Number(row.net_paisa ?? amountPaisa - feePaisa - taxPaisa)),
    destination: String(row.destination ?? ''),
    destination_phone: row.destination_phone ? String(row.destination_phone) : null,
    provider_method: row.provider_method ? String(row.provider_method) : null,
    kind: (row.kind as 'instant' | 'scheduled') ?? 'instant',
    status: String(row.status),
    scheduled_for: row.scheduled_for ? String(row.scheduled_for) : null,
    executed_at: row.executed_at ? String(row.executed_at) : null,
    provider_ref: row.provider_ref ? String(row.provider_ref) : null,
    approved_by: row.approved_by ? String(row.approved_by) : null,
    // Sandbox-only build: every payout response is a sandbox payout.
    sandbox: true,
    created_at: String(row.created_at),
  };
}

@Injectable()
export class EscrowService {
  private providers: Record<'cash' | 'jazzcash' | 'easypaisa', PaymentProvider>;

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private realtime: RealtimeService,
  ) {
    // Throws at boot in live mode without live credentials (never silently
    // falls back to sandbox) — same guard as WalletService.
    this.providers = createGatewayProviders();
  }

  // ---- Config ------------------------------------------------------------
  async getConfig(): Promise<EscrowConfig> {
    const cfg = { ...DEFAULT_CONFIG };
    const read = async (key: string): Promise<Record<string, unknown> | undefined> => {
      const rows = (await this.db.query(`SELECT config FROM feature_flags WHERE key=$1`, [key])).rows;
      return rows[0]?.config as Record<string, unknown> | undefined;
    };
    const hours = (await read('escrow_auto_release_hours'))?.value_hours;
    if (typeof hours === 'number') cfg.auto_release_hours = hours;
    const minAmt = (await read('escrow_min_amount_paisa'))?.value_paisa;
    if (typeof minAmt === 'number') cfg.min_amount_paisa = minAmt;
    const feeFlat = (await read('payout_fee_flat_paisa'))?.value_paisa;
    if (typeof feeFlat === 'number') cfg.payout_fee_flat_paisa = feeFlat;
    const feeRate = (await read('payout_fee_rate'))?.value_rate;
    if (typeof feeRate === 'number') cfg.payout_fee_rate = feeRate;
    const taxRate = (await read('payout_tax_rate'))?.value_rate;
    if (typeof taxRate === 'number') cfg.payout_tax_rate = taxRate;
    return cfg;
  }

  async updateConfig(adminId: string, dto: Partial<EscrowConfig>): Promise<EscrowConfig> {
    try {
      validateEscrowConfig(dto);
    } catch (e) {
      throw Errors.unprocessable('INVALID_ESCROW_CONFIG', (e as Error).message);
    }
    const writes: [string, Record<string, unknown>][] = [];
    if (dto.auto_release_hours !== undefined) writes.push(['escrow_auto_release_hours', { value_hours: dto.auto_release_hours }]);
    if (dto.min_amount_paisa !== undefined) writes.push(['escrow_min_amount_paisa', { value_paisa: dto.min_amount_paisa }]);
    if (dto.payout_fee_flat_paisa !== undefined) writes.push(['payout_fee_flat_paisa', { value_paisa: dto.payout_fee_flat_paisa }]);
    if (dto.payout_fee_rate !== undefined) writes.push(['payout_fee_rate', { value_rate: dto.payout_fee_rate }]);
    if (dto.payout_tax_rate !== undefined) writes.push(['payout_tax_rate', { value_rate: dto.payout_tax_rate }]);
    if (writes.length === 0) throw Errors.badRequest('NO_FIELDS', 'Nothing to update');
    for (const [key, config] of writes) {
      await this.db.query(
        `INSERT INTO feature_flags (key, enabled, config) VALUES ($1, true, $2) ON CONFLICT (key) DO UPDATE SET config=EXCLUDED.config, updated_by=$3, updated_at=now()`,
        [key, JSON.stringify(config), adminId],
      );
    }
    return this.getConfig();
  }

  // ---- Escrow holds ------------------------------------------------------
  async createHold(jobId: string, customerId: string, idempotencyKey?: string): Promise<EscrowHoldView> {
    return withIdempotency(this.redis, `escrow-hold:${jobId}`, idempotencyKey, async () =>
      this.createHoldInner(jobId, customerId));
  }

  private async createHoldInner(jobId: string, customerId: string): Promise<EscrowHoldView> {
    const cfg = await this.getConfig();
    const hold = await this.db.withTransaction(async (c) => {
      const client = c as unknown as QueryClient;
      const job = (await c.query(
        `SELECT j.*, p.user_id AS provider_user_id FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1 FOR UPDATE`,
        [jobId],
      )).rows[0] as unknown as Record<string, unknown> | undefined;
      if (!job) throw Errors.notFound('Job');
      if (job.customer_id !== customerId) throw Errors.forbidden('Only the job customer can escrow funds');
      if (job.state !== 'COMPLETED') throw Errors.conflict('NOT_COMPLETED', 'Escrow hold is only allowed after the job is COMPLETED');
      if (job.payment_status === 'settled') throw Errors.conflict('ALREADY_SETTLED', 'Job is already settled');
      const existing = (await c.query(`SELECT * FROM escrow_holds WHERE job_id=$1 FOR UPDATE`, [jobId])).rows[0];
      if (existing) throw Errors.conflict('ESCROW_ALREADY_HELD', 'This job already has an escrow hold');
      const amountPaisa = pkrToPaisa(Number(job.final_price ?? job.agreed_price));
      if (amountPaisa < cfg.min_amount_paisa) {
        throw Errors.unprocessable('ESCROW_BELOW_THRESHOLD', `Escrow is for high-value jobs of at least PKR ${paisaToPkr(cfg.min_amount_paisa)}`);
      }
      const commission = commissionPaisa(amountPaisa, Number(job.commission_rate));
      const walletId = await ensureWallet(client, customerId);
      const bal = (await c.query(`SELECT balance_paisa FROM wallet_accounts WHERE id=$1 FOR UPDATE`, [walletId])).rows[0] as unknown as { balance_paisa: string };
      if (Number(bal.balance_paisa) < amountPaisa) {
        throw Errors.conflict('INSUFFICIENT_WALLET_BALANCE', `Wallet balance is short by PKR ${paisaToPkr(amountPaisa - Number(bal.balance_paisa))}`);
      }
      const txnId = randomUUID();
      // Balanced per txn_id: D wallet / C escrow_held, same customer wallet.
      await c.query(
        `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [txnId, walletId, 'wallet', 'D', amountPaisa, jobId, 'Escrow hold for job'],
      );
      await c.query(
        `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [txnId, walletId, 'escrow_held', 'C', amountPaisa, jobId, 'Escrow hold for job'],
      );
      await c.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2 WHERE id=$1`, [walletId, amountPaisa]);
      await c.query(`UPDATE wallet_accounts SET escrow_held_paisa = escrow_held_paisa + $2 WHERE id=$1`, [walletId, amountPaisa]);
      const row = (await c.query(
        `INSERT INTO escrow_holds (job_id, customer_id, provider_id, provider_user_id, amount_paisa, commission_paisa, status, auto_release_at) VALUES ($1,$2,$3,$4,$5,$6,'held',$7) RETURNING *`,
        [jobId, customerId, String(job.provider_id), String(job.provider_user_id), amountPaisa, commission, autoReleaseAt(new Date(), cfg.auto_release_hours).toISOString()],
      )).rows[0];
      await c.query(`UPDATE jobs SET payment_status='escrow_held', updated_at=now() WHERE id=$1`, [jobId]);
      await c.query(
        `INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
        [jobId, 'COMPLETED', 'COMPLETED', customerId, 'customer', JSON.stringify({ escrow_hold_id: row.id, amount_paisa: amountPaisa, auto_release_at: row.auto_release_at })],
      );
      return row;
    });
    this.realtime.emitToRoom(`job:${jobId}`, 'escrow.held', { job_id: jobId, hold_id: hold.id, amount_paisa: hold.amount_paisa });
    return toHold(hold);
  }

  async getHold(holdId: string, userId: string): Promise<EscrowHoldView> {
    const row = (await this.db.query(`SELECT * FROM escrow_holds WHERE id=$1`, [holdId])).rows[0];
    if (!row) throw Errors.notFound('Escrow hold');
    if (row.customer_id !== userId && row.provider_user_id !== userId) throw Errors.forbidden('Not a party to this escrow hold');
    return toHold(row);
  }

  async listHolds(userId: string, limit = 20): Promise<EscrowHoldView[]> {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = (await this.db.query(
      `SELECT * FROM escrow_holds WHERE customer_id=$1 OR provider_user_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [userId, lim],
    )).rows;
    return rows.map(toHold);
  }

  async listAdminHolds(status?: string, limit = 50): Promise<EscrowHoldView[]> {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = status
      ? (await this.db.query(`SELECT * FROM escrow_holds WHERE status=$1 ORDER BY created_at DESC LIMIT $2`, [status, lim])).rows
      : (await this.db.query(`SELECT * FROM escrow_holds ORDER BY created_at DESC LIMIT $1`, [lim])).rows;
    return rows.map(toHold);
  }

  /** Customer confirms completion: release the hold to the provider. */
  async releaseHold(holdId: string, actorId: string, idempotencyKey?: string): Promise<EscrowHoldView> {
    return withIdempotency(this.redis, `escrow-release:${holdId}`, idempotencyKey, async () =>
      this.db.withTransaction(async (c) => {
        const hold = await this.lockHold(c, holdId);
        if (hold.customer_id !== actorId) throw Errors.forbidden('Only the job customer can confirm completion and release escrow');
        return toHold(await this.releaseHoldInTxn(c, hold, actorId));
      }));
  }

  /** Finance/super_admin release override (same ledger path as customer release). */
  async releaseHoldAsAdmin(holdId: string, adminId: string): Promise<EscrowHoldView> {
    return this.db.withTransaction(async (c) => {
      const hold = await this.lockHold(c, holdId);
      return toHold(await this.releaseHoldInTxn(c, hold, adminId));
    });
  }

  private async lockHold(c: QueryClient & { query: QueryClient['query'] }, holdId: string): Promise<Record<string, unknown>> {
    const hold = (await c.query(`SELECT * FROM escrow_holds WHERE id=$1 FOR UPDATE`, [holdId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!hold) throw Errors.notFound('Escrow hold');
    if (hold.status !== 'held') throw Errors.conflict('ESCROW_NOT_HELD', `Escrow hold is ${hold.status}, not held`);
    return hold;
  }

  private async hasOpenDispute(c: QueryClient, jobId: string): Promise<boolean> {
    const row = (await c.query(
      `SELECT COUNT(*) AS cnt FROM disputes WHERE job_id=$1 AND status='open'`,
      [jobId],
    )).rows[0] as unknown as { cnt: string };
    return Number(row.cnt) > 0;
  }

  /**
   * The single release path used by customer confirmation, admin override
   * and auto-release. Caller must hold the hold row FOR UPDATE inside a
   * transaction. Throws ESCROW_DISPUTE_OPEN when a dispute is open.
   */
  private async releaseHoldInTxn(c: QueryClient, hold: Record<string, unknown>, releasedBy: string | null): Promise<Record<string, unknown>> {
    const jobId = String(hold.job_id);
    if (await this.hasOpenDispute(c, jobId)) {
      throw Errors.conflict('ESCROW_DISPUTE_OPEN', 'Escrow cannot be released while a dispute is open on this job');
    }
    const amountPaisa = Number(hold.amount_paisa);
    const commission = Number(hold.commission_paisa);
    const providerCredit = amountPaisa - commission;
    if (providerCredit <= 0) throw Errors.unprocessable('ESCROW_RELEASE_ZERO', 'Provider credit after commission is not positive');
    const customerWalletId = await ensureWallet(c, String(hold.customer_id));
    const providerWalletId = await ensureWallet(c, String(hold.provider_user_id));
    const txnId = randomUUID();
    // Balanced per txn_id: D escrow_held (amount) =
    // C wallet (provider, amount - commission) + C commission_rev (commission).
    await c.query(
      `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [txnId, customerWalletId, 'escrow_held', 'D', amountPaisa, jobId, 'Escrow release for job'],
    );
    await c.query(
      `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [txnId, providerWalletId, 'wallet', 'C', providerCredit, jobId, 'Escrow release received'],
    );
    if (commission > 0) {
      await c.query(
        `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [txnId, providerWalletId, 'commission_rev', 'C', commission, jobId, 'Commission revenue'],
      );
    }
    await c.query(`UPDATE wallet_accounts SET escrow_held_paisa = escrow_held_paisa - $2 WHERE id=$1`, [customerWalletId, amountPaisa]);
    await c.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa + $2 WHERE id=$1`, [providerWalletId, providerCredit]);
    const updated = (await c.query(
      `UPDATE escrow_holds SET status='released', released_at=$2, released_by=$3, release_txn_id=$4, updated_at=now() WHERE id=$1 RETURNING *`,
      [String(hold.id), new Date().toISOString(), releasedBy, txnId],
    )).rows[0];
    await c.query(
      `UPDATE jobs SET state='PAYMENT_SETTLED', payment_status='settled', commission_amount=$2, updated_at=now() WHERE id=$1`,
      [jobId, commission / 100],
    );
    await c.query(
      `INSERT INTO payments (job_id, payer_id, method, provider_name, amount, status) VALUES ($1,$2,'escrow','wallet',$3,'confirmed') RETURNING *`,
      [jobId, String(hold.customer_id), paisaToPkr(amountPaisa)],
    );
    await c.query(
      `INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
      [jobId, 'COMPLETED', 'PAYMENT_SETTLED', releasedBy, releasedBy ? 'customer' : 'system', JSON.stringify({ escrow_hold_id: hold.id, release_txn_id: txnId, commission_paisa: commission })],
    );
    this.realtime.emitToRoom(`job:${jobId}`, 'escrow.released', { job_id: jobId, hold_id: String(hold.id), release_txn_id: txnId });
    return updated;
  }

  /**
   * Auto-release sweep: every held hold past its admin-set deadline with
   * NO open dispute is released; holds with an open dispute are skipped
   * (reported, not released). Idempotent: re-running releases nothing
   * twice because released holds are no longer status='held'. Intended
   * to be called on a schedule by POST /admin/escrow/auto-release.
   */
  async releaseDueHolds(now: Date = new Date()): Promise<{ released: string[]; skipped_dispute: string[]; checked_at: string }> {
    const due = (await this.db.query(
      `SELECT * FROM escrow_holds WHERE status='held' AND auto_release_at <= $1 ORDER BY auto_release_at ASC`,
      [now.toISOString()],
    )).rows;
    const released: string[] = [];
    const skipped: string[] = [];
    for (const row of due) {
      const holdId = String(row.id);
      // Pure eligibility check first (cheap, no lock): dispute state may
      // have changed since the list query, so releaseHoldInTxn re-checks
      // inside its own transaction — the sweep never trusts this read.
      const openDispute = await this.hasOpenDispute(this.db as unknown as QueryClient, String(row.job_id));
      if (!isAutoReleaseDue(String(row.status) as 'held', String(row.auto_release_at), now, openDispute)) {
        skipped.push(holdId);
        continue;
      }
      try {
        await this.db.withTransaction(async (c) => {
          const hold = await this.lockHold(c, holdId);
          await this.releaseHoldInTxn(c, hold, null);
        });
        released.push(holdId);
      } catch (e) {
        // A dispute opened between the check and the release, or a
        // concurrent release: skip, do not fail the whole sweep.
        if (e instanceof Error && (e as { code?: string }).code === 'ESCROW_DISPUTE_OPEN') skipped.push(holdId);
        else if (e instanceof Error && (e as { code?: string }).code === 'ESCROW_NOT_HELD') continue;
        else throw e;
      }
    }
    return { released, skipped_dispute: skipped, checked_at: now.toISOString() };
  }

  // ---- Provider payouts --------------------------------------------------
  async requestPayout(
    userId: string,
    dto: { amount_pkr: number; method: 'jazzcash' | 'easypaisa'; destination_phone: string; kind: 'instant' | 'scheduled'; scheduled_for?: string | null },
    idempotencyKey?: string,
  ): Promise<PayoutView> {
    return withIdempotency(this.redis, `payout:${userId}`, idempotencyKey, async () =>
      this.requestPayoutInner(userId, dto));
  }

  private async requestPayoutInner(
    userId: string,
    dto: { amount_pkr: number; method: 'jazzcash' | 'easypaisa'; destination_phone: string; kind: 'instant' | 'scheduled'; scheduled_for?: string | null },
  ): Promise<PayoutView> {
    if (dto.kind === 'scheduled' && !dto.scheduled_for) {
      throw Errors.unprocessable('PAYOUT_SCHEDULE_MISSING', 'scheduled_for is required for a scheduled payout');
    }
    if (dto.kind === 'scheduled' && new Date(dto.scheduled_for as string).getTime() <= Date.now()) {
      throw Errors.unprocessable('PAYOUT_SCHEDULE_PAST', 'scheduled_for must be in the future');
    }
    if (dto.kind === 'instant' && dto.scheduled_for) {
      throw Errors.unprocessable('PAYOUT_SCHEDULE_UNEXPECTED', 'scheduled_for must not be set for an instant payout');
    }
    const cfg = await this.getConfig();
    const amountPaisa = pkrToPaisa(dto.amount_pkr);
    const { fee_paisa, tax_paisa, net_paisa } = payoutBreakdown(amountPaisa, cfg.payout_fee_flat_paisa, cfg.payout_fee_rate, cfg.payout_tax_rate);
    if (net_paisa <= 0) throw Errors.unprocessable('PAYOUT_NET_ZERO', 'Payout net amount after fee and tax is not positive');
    const row = await this.db.withTransaction(async (c) => {
      const client = c as unknown as QueryClient;
      const prof = (await c.query(`SELECT id FROM provider_profiles WHERE user_id=$1`, [userId])).rows[0];
      if (!prof) throw Errors.forbidden('Only providers can request a payout');
      const walletId = await ensureWallet(client, userId);
      const bal = (await c.query(`SELECT balance_paisa FROM wallet_accounts WHERE id=$1 FOR UPDATE`, [walletId])).rows[0] as unknown as { balance_paisa: string };
      if (Number(bal.balance_paisa) < amountPaisa) {
        throw Errors.conflict('INSUFFICIENT_WALLET_BALANCE', `Wallet balance is short by PKR ${paisaToPkr(amountPaisa - Number(bal.balance_paisa))}`);
      }
      // Funds are NOT debited at request time — only on finance-approved
      // execution — so a rejected payout never moves money.
      return (await c.query(
        `INSERT INTO payouts (wallet_id, job_id, escrow_hold_id, amount, amount_paisa, fee, fee_paisa, tax, tax_paisa, net_paisa, destination, destination_phone, provider_method, kind, status, scheduled_for) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [walletId, null, null, dto.amount_pkr, amountPaisa, paisaToPkr(fee_paisa), fee_paisa, JSON.stringify({ rate: cfg.payout_tax_rate, amount_paisa: tax_paisa }), tax_paisa, net_paisa, dto.method, dto.destination_phone, dto.method, dto.kind, dto.kind === 'scheduled' ? 'scheduled' : 'requested', dto.scheduled_for ?? null],
      )).rows[0];
    });
    return toPayout(row);
  }

  async getPayout(payoutId: string, userId: string): Promise<PayoutView> {
    const row = (await this.db.query(
      `SELECT p.* FROM payouts p JOIN wallet_accounts w ON w.id=p.wallet_id WHERE p.id=$1`,
      [payoutId],
    )).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) throw Errors.notFound('Payout');
    const owner = (await this.db.query(`SELECT user_id FROM wallet_accounts WHERE id=$1`, [String(row.wallet_id)])).rows[0] as unknown as { user_id: string };
    if (owner?.user_id !== userId) throw Errors.forbidden('Not your payout');
    return toPayout(row);
  }

  async listPayouts(userId: string, limit = 20): Promise<PayoutView[]> {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = (await this.db.query(
      `SELECT p.* FROM payouts p JOIN wallet_accounts w ON w.id=p.wallet_id WHERE w.user_id=$1 ORDER BY p.created_at DESC LIMIT $2`,
      [userId, lim],
    )).rows;
    return rows.map(toPayout);
  }

  async listAdminPayouts(status?: string, limit = 50): Promise<PayoutView[]> {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = status
      ? (await this.db.query(`SELECT * FROM payouts WHERE status=$1 ORDER BY created_at DESC LIMIT $2`, [status, lim])).rows
      : (await this.db.query(`SELECT * FROM payouts ORDER BY created_at DESC LIMIT $1`, [lim])).rows;
    return rows.map(toPayout);
  }

  /**
   * FINANCE APPROVAL. Instant payouts execute immediately (sandbox) once
   * approved; scheduled payouts become 'approved' and wait for their
   * scheduled_for, executed by executeDuePayouts().
   */
  async approvePayout(payoutId: string, adminId: string): Promise<PayoutView> {
    const row = await this.db.withTransaction(async (c) => {
      const payout = (await c.query(`SELECT * FROM payouts WHERE id=$1 FOR UPDATE`, [payoutId])).rows[0] as unknown as Record<string, unknown> | undefined;
      if (!payout) throw Errors.notFound('Payout');
      if (!['requested', 'scheduled'].includes(String(payout.status))) {
        throw Errors.conflict('PAYOUT_NOT_APPROVABLE', `Payout is ${payout.status}, not awaiting approval`);
      }
      if (payout.kind === 'scheduled') {
        return (await c.query(
          `UPDATE payouts SET status='approved', approved_by=$2, updated_at=now() WHERE id=$1 RETURNING *`,
          [payoutId, adminId],
        )).rows[0];
      }
      return this.executePayoutInTxn(c, payout, adminId);
    });
    return toPayout(row);
  }

  async rejectPayout(payoutId: string, adminId: string, reason?: string): Promise<PayoutView> {
    const row = (await this.db.query(
      `UPDATE payouts SET status='rejected', approved_by=$2, updated_at=now() WHERE id=$1 AND status IN ('requested','scheduled','approved') RETURNING *`,
      [payoutId, adminId],
    )).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) {
      const exists = (await this.db.query(`SELECT * FROM payouts WHERE id=$1`, [payoutId])).rows[0];
      if (!exists) throw Errors.notFound('Payout');
      throw Errors.conflict('PAYOUT_NOT_REJECTABLE', `Payout is ${exists.status} and cannot be rejected`);
    }
    void reason; // Reason is recorded in the admin audit log by the caller (admin service); payouts has no note column.
    return toPayout(row);
  }

  /**
   * Execute one approved payout: SANDBOX gateway call first, then the
   * balanced ledger write in the same transaction. If the gateway call
   * fails, the transaction rolls back and nothing is debited.
   * Caller must hold the payout row FOR UPDATE inside a transaction.
   */
  private async executePayoutInTxn(c: QueryClient, payout: Record<string, unknown>, adminId: string): Promise<Record<string, unknown>> {
    const walletId = String(payout.wallet_id);
    const grossPaisa = Number(payout.amount_paisa);
    const feePaisa = Number(payout.fee_paisa ?? 0);
    const taxPaisa = Number(payout.tax_paisa ?? 0);
    const netPaisa = Number(payout.net_paisa);
    const method = String(payout.provider_method ?? payout.destination) as 'jazzcash' | 'easypaisa';
    const bal = (await c.query(`SELECT balance_paisa FROM wallet_accounts WHERE id=$1 FOR UPDATE`, [walletId])).rows[0] as unknown as { balance_paisa: string } | undefined;
    if (!bal || Number(bal.balance_paisa) < grossPaisa) {
      throw Errors.conflict('INSUFFICIENT_WALLET_BALANCE', 'Wallet balance no longer covers this payout');
    }
    // SANDBOX ONLY: mock provider — no network, no real money, reference
    // labelled sandbox. Live execution needs merchant onboarding + live
    // keys, which do not exist in this build.
    const provider = this.providers[method];
    const result = await provider.payout(walletId, String(payout.destination_phone ?? ''), netPaisa);
    if (result.status !== 'initiated') throw Errors.conflict('GATEWAY_PAYOUT_FAILED', 'Gateway did not initiate the payout');
    const txnId = randomUUID();
    // Balanced per txn_id: D wallet (gross) = C payout_out (net)
    // + C payout_fee_rev (fee) + C payout_tax_payable (tax).
    await c.query(
      `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [txnId, walletId, 'wallet', 'D', grossPaisa, payout.job_id ?? null, 'Provider payout'],
    );
    await c.query(
      `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [txnId, walletId, 'payout_out', 'C', netPaisa, payout.job_id ?? null, 'Provider payout'],
    );
    if (feePaisa > 0) {
      await c.query(
        `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [txnId, walletId, 'payout_fee_rev', 'C', feePaisa, payout.job_id ?? null, 'Payout fee revenue'],
      );
    }
    if (taxPaisa > 0) {
      await c.query(
        `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [txnId, walletId, 'payout_tax_payable', 'C', taxPaisa, payout.job_id ?? null, 'Payout tax payable'],
      );
    }
    await c.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2 WHERE id=$1`, [walletId, grossPaisa]);
    return (await c.query(
      `UPDATE payouts SET status='executed', approved_by=$2, executed_at=$3, provider_ref=$4, updated_at=now() WHERE id=$1 RETURNING *`,
      [String(payout.id), adminId, new Date().toISOString(), result.payout_id],
    )).rows[0];
  }

  /**
   * Execute due scheduled payouts (approved + scheduled_for passed).
   * Intended to be called on a schedule by POST /admin/payouts/run-due.
   * A payout whose balance no longer covers it, or whose gateway call
   * fails, is marked 'failed' and reported — the sweep continues.
   */
  async executeDuePayouts(now: Date = new Date()): Promise<{ executed: string[]; failed: string[]; checked_at: string }> {
    const due = (await this.db.query(
      `SELECT * FROM payouts WHERE status='approved' AND kind='scheduled' AND scheduled_for <= $1 ORDER BY scheduled_for ASC`,
      [now.toISOString()],
    )).rows;
    const executed: string[] = [];
    const failed: string[] = [];
    for (const row of due) {
      const payoutId = String(row.id);
      try {
        await this.db.withTransaction(async (c) => {
          const payout = (await c.query(`SELECT * FROM payouts WHERE id=$1 FOR UPDATE`, [payoutId])).rows[0] as unknown as Record<string, unknown> | undefined;
          if (!payout || payout.status !== 'approved') return;
          await this.executePayoutInTxn(c, payout, String(payout.approved_by ?? ''));
        });
        executed.push(payoutId);
      } catch {
        await this.db.query(`UPDATE payouts SET status='failed', updated_at=now() WHERE id=$1`, [payoutId]);
        failed.push(payoutId);
      }
    }
    return { executed, failed, checked_at: now.toISOString() };
  }
}
