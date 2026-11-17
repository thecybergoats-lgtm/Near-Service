// Wallet + gateway top-up + wallet-paid settlement (Phase 2).
// ONE wallet per user (v1.1): customer/provider are profile-level VIEWS
// derived over ledger_entries/jobs — never separate wallets.
// All money is integer paisa; every money movement writes balanced D/C
// ledger_entries per txn_id. Escrow is recorded only (escrow_held_paisa);
// escrow release is NOT in scope.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { WarrantyService } from '../warranty/warranty.service';
import { Errors } from '../../common/errors/api-error';
import { commissionPaisa, isValidPkrAmount, paisaToPkr, pkrToPaisa } from '../../common/utils/money';
import { ensureWallet } from '../../common/utils/wallet';
import { withIdempotency } from '../../common/utils/idempotency';
import { isCommissionRateInBand } from '../../common/utils/commission';
import { creditReferrerIfFirstPaidJob } from '../../common/utils/referral';
import { createGatewayProviders } from './gateway-sandbox';
import { GatewayMethod, PaymentProvider } from './gateway.interface';
import { PromotionsService } from './promotions.service';
import { offsetPage } from '../../common/utils/pagination';
import { toJob } from '../offers/offers.service';

export interface WalletView {
  balance_paisa: number;
  balance_pkr: number;
  escrow_held_paisa: number;
  currency: 'PKR';
  profile_views: {
    customer: { balance_pkr: number; spent_pkr: number; pending_pkr: number };
    provider: { balance_pkr: number; earnings_pkr: number; commission_owed_pkr: number; pending_pkr: number };
  };
}

type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

const PAYMENT_METHODS = [
  { id: 'cash', label: 'Cash on completion', sandbox: false },
  { id: 'wallet', label: 'Near Service wallet', sandbox: false },
  { id: 'jazzcash', label: 'JazzCash', sandbox: true },
  { id: 'easypaisa', label: 'Easypaisa', sandbox: true },
];

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private providers: Record<'cash' | 'jazzcash' | 'easypaisa', PaymentProvider>;

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private realtime: RealtimeService,
    private promos: PromotionsService,
    // Phase 4, item 4 (warranty): @Optional so unit tests that construct
    // this service directly with (db, redis, realtime, promos) keep working.
    @Optional() @Inject(WarrantyService) private warranty?: WarrantyService,
  ) {
    // Throws at boot in live mode without live credentials (never silently
    // falls back to sandbox).
    this.providers = createGatewayProviders();
  }

  private providerFor(method: 'jazzcash' | 'easypaisa'): PaymentProvider {
    return this.providers[method];
  }

  // ---- Wallet views ----------------------------------------------------
  async getWalletView(userId: string): Promise<WalletView> {
    const walletId = await ensureWallet(
      this.db as unknown as QueryClient,
      userId,
    );
    const w = (await this.db.query<{ balance_paisa: string; escrow_held_paisa: string; currency: string }>(
      `SELECT balance_paisa, escrow_held_paisa, currency FROM wallet_accounts WHERE id=$1`,
      [walletId],
    )).rows[0];
    const balancePaisa = Number(w.balance_paisa);
    const spent = await this.sumOne(
      `SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE payer_id=$1 AND method='wallet' AND status='confirmed'`,
      [userId],
    );
    const custPending = await this.sumOne(
      `SELECT COALESCE(SUM(final_price),0) AS total FROM jobs WHERE customer_id=$1 AND state='COMPLETED' AND payment_status='unpaid'`,
      [userId],
    );
    const earnings = await this.sumOne(
      `SELECT COALESCE(SUM(j.final_price - j.commission_amount),0) AS total FROM jobs j
       JOIN provider_profiles p ON p.id=j.provider_id WHERE p.user_id=$1 AND j.payment_status='settled'`,
      [userId],
    );
    const provPending = await this.sumOne(
      `SELECT COALESCE(SUM(j.final_price),0) AS total FROM jobs j
       JOIN provider_profiles p ON p.id=j.provider_id WHERE p.user_id=$1 AND j.state='COMPLETED' AND j.payment_status='unpaid'`,
      [userId],
    );
    const balancePkr = paisaToPkr(balancePaisa);
    return {
      balance_paisa: balancePaisa,
      balance_pkr: balancePkr,
      escrow_held_paisa: Number(w.escrow_held_paisa),
      currency: 'PKR',
      profile_views: {
        customer: { balance_pkr: balancePkr, spent_pkr: spent, pending_pkr: custPending },
        provider: {
          balance_pkr: balancePkr,
          earnings_pkr: earnings,
          commission_owed_pkr: balancePaisa < 0 ? paisaToPkr(-balancePaisa) : 0,
          pending_pkr: provPending,
        },
      },
    };
  }

  private async sumOne(sql: string, params: unknown[]): Promise<number> {
    const row = (await this.db.query<{ total: string }>(sql, params)).rows[0];
    return Number(row?.total ?? 0);
  }

  async listTransactions(userId: string, cursor?: string, limit = 20): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    const walletId = await ensureWallet(this.db as unknown as QueryClient, userId);
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const params: unknown[] = [walletId];
    let where = `WHERE wallet_id=$1`;
    if (cursor) {
      params.push(Number(cursor));
      where += ` AND id < $${params.length}`;
    }
    params.push(lim + 1);
    const rows = (await this.db.query(
      `SELECT id, txn_id, account_code, direction, amount_paisa, job_id, memo, created_at
       FROM ledger_entries ${where} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    )).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    const items = page.map((r) => ({
      id: String(r.id),
      txn_id: r.txn_id,
      account_code: r.account_code,
      // DB stores D/C; the API (and mobile client) use debit/credit.
      direction: r.direction === 'D' ? 'debit' : 'credit',
      amount_paisa: Number(r.amount_paisa),
      amount_pkr: paisaToPkr(Number(r.amount_paisa)),
      job_id: r.job_id ?? null,
      memo: r.memo ?? '',
      created_at: r.created_at,
    }));
    return { items, next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }

  getPaymentMethods() {
    return PAYMENT_METHODS;
  }

  // ---- Gateway top-up (sandbox) ----------------------------------------
  async initiateTopup(userId: string, method: 'jazzcash' | 'easypaisa', amountPkr: number, phone: string, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'wallet-topup', idempotencyKey, async () =>
      this.initiateTopupInner(userId, method, amountPkr, phone, idempotencyKey));
  }

  private async initiateTopupInner(userId: string, method: 'jazzcash' | 'easypaisa', amountPkr: number, phone: string, idempotencyKey?: string) {
    if (!isValidPkrAmount(amountPkr)) throw Errors.badRequest('INVALID_AMOUNT', 'amount_pkr must be > 0 with at most 2 decimals');
    if (!/^\+?\d{10,15}$/.test(phone)) throw Errors.badRequest('INVALID_PHONE', 'phone must be 10–15 digits, optional leading +');
    const provider = this.providerFor(method);
    const intent = await provider.initiate({ kind: 'topup', refId: userId, amountPaisa: pkrToPaisa(amountPkr), method, phone });
    const row = (await this.db.query(
      `INSERT INTO payments (job_id, payer_id, method, provider_name, provider_ref, amount, status, idempotency_key)
       VALUES (NULL,$1,'gateway',$2,$3,$4,'initiated',$5) RETURNING *`,
      [userId, method, intent.reference, amountPkr, idempotencyKey ?? null],
    )).rows[0];
    return { payment_id: row.id, provider: method, status: 'initiated', reference: intent.reference, sandbox: true };
  }

  async confirmTopup(userId: string, paymentId: string, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'wallet-topup-confirm', idempotencyKey, async () =>
      this.confirmTopupInner(userId, paymentId));
  }

  private async confirmTopupInner(userId: string, paymentId: string) {
    const out = await this.db.withTransaction(async (c) => {
      const row = (await c.query(`SELECT * FROM payments WHERE id=$1 FOR UPDATE`, [paymentId])).rows[0];
      if (!row) throw Errors.notFound('Payment');
      if (row.payer_id !== userId) throw Errors.forbidden('Only the payer can confirm this top-up');
      if (row.method !== 'gateway') throw Errors.conflict('NOT_A_TOPUP', 'This payment is not a gateway top-up');
      if (row.status === 'confirmed') return { alreadyConfirmed: true, row };
      if (row.status !== 'initiated') throw Errors.conflict('TOPUP_NOT_CONFIRMABLE', `Top-up is ${row.status}`);
      const provider = this.providerFor(row.provider_name as 'jazzcash' | 'easypaisa');
      // Sandbox confirm is deterministic (mock) — the payment row id is the
      // opaque intent handle; no network is called.
      const status = await provider.confirm(String(row.id));
      if (status.status !== 'confirmed') throw Errors.conflict('GATEWAY_NOT_CONFIRMED', 'Gateway did not confirm the top-up');
      const amountPaisa = pkrToPaisa(Number(row.amount));
      const walletId = await ensureWallet(c as unknown as QueryClient, userId);
      const txnId = randomUUID();
      // Balanced double-entry: D cash_in / C wallet.
      await c.query(
        `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, memo) VALUES ($1,$2,$3,$4,$5,$6)`,
        [txnId, walletId, 'cash_in', 'D', amountPaisa, 'Gateway top-up'],
      );
      await c.query(
        `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, memo) VALUES ($1,$2,$3,$4,$5,$6)`,
        [txnId, walletId, 'wallet', 'C', amountPaisa, 'Gateway top-up'],
      );
      await c.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa + $2 WHERE id=$1`, [walletId, amountPaisa]);
      const updated = (await c.query(
        `UPDATE payments SET status='confirmed', updated_at=now() WHERE id=$1 RETURNING *`,
        [paymentId],
      )).rows[0];
      return { alreadyConfirmed: false, row: updated };
    });
    const wallet = await this.getWalletView(userId);
    return { wallet, payment_id: out.row.id, status: 'confirmed', reference: out.row.provider_ref, sandbox: true };
  }

  // ---- Wallet-paid job settlement --------------------------------------
  async payWithWallet(jobId: string, userId: string, promoCode?: string, deviceFingerprint?: string, idempotencyKey?: string) {
    return withIdempotency(this.redis, `job-pay-wallet:${jobId}`, idempotencyKey, async () =>
      this.payWithWalletInner(jobId, userId, promoCode, deviceFingerprint));
  }

  private async payWithWalletInner(jobId: string, userId: string, promoCode?: string, deviceFingerprint?: string) {
    const settled = await this.db.withTransaction(async (c) => {
      const client = c as unknown as QueryClient;
      const job = (await c.query(
        `SELECT j.*, p.user_id AS provider_user_id FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1 FOR UPDATE`,
        [jobId],
      )).rows[0] as unknown as Record<string, unknown> | undefined;
      if (!job) throw Errors.notFound('Job');
      if (job.state !== 'COMPLETED') throw Errors.conflict('NOT_COMPLETED', 'Wallet payment is only allowed after COMPLETED');
      if (job.customer_id !== userId) throw Errors.forbidden('Only the job customer can pay from wallet');
      const finalPaisa = pkrToPaisa(Number(job.final_price ?? job.agreed_price));
      const rate = Number(job.commission_rate);
      const commission = commissionPaisa(finalPaisa, rate);
      // Promo (validated side-effect free; redemption recorded below, only
      // on successful payment). Provider still gets full price − commission.
      let discountPaisa = 0;
      let promoId: string | null = null;
      if (promoCode) {
        const v = await this.promos.validatePromo({
          code: promoCode, amountPkr: paisaToPkr(finalPaisa), userId, deviceFingerprint,
        });
        if (!v.valid) throw Errors.conflict('PROMO_INVALID', `Promo code is not valid: ${v.reason ?? 'unknown'}`);
        discountPaisa = v.discount_paisa;
        promoId = v.promo_id ?? null;
      }
      const payablePaisa = finalPaisa - discountPaisa;
      const customerWalletId = await ensureWallet(client, userId);
      const custBal = (await c.query(
        `SELECT balance_paisa FROM wallet_accounts WHERE id=$1 FOR UPDATE`,
        [customerWalletId],
      )).rows[0] as unknown as { balance_paisa: string };
      if (Number(custBal.balance_paisa) < payablePaisa) {
        throw Errors.conflict('INSUFFICIENT_WALLET_BALANCE', `Wallet balance is short by PKR ${paisaToPkr(payablePaisa - Number(custBal.balance_paisa))}`);
      }
      const providerWalletId = await ensureWallet(client, String(job.provider_user_id));
      const providerCredit = finalPaisa - commission;
      const txnId = randomUUID();
      // Balanced per txn_id: D customer wallet (payable) + D promo_expense
      // (discount) = C provider wallet (final − commission) + C commission_rev.
      if (payablePaisa > 0) {
        await c.query(
          `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [txnId, customerWalletId, 'wallet', 'D', payablePaisa, jobId, 'Wallet payment for job'],
        );
      }
      if (discountPaisa > 0) {
        await c.query(
          `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [txnId, customerWalletId, 'promo_expense', 'D', discountPaisa, jobId, 'Platform promo discount absorbed'],
        );
      }
      if (providerCredit > 0) {
        await c.query(
          `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [txnId, providerWalletId, 'wallet', 'C', providerCredit, jobId, 'Wallet payment received'],
        );
      }
      if (commission > 0) {
        await c.query(
          `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [txnId, providerWalletId, 'commission_rev', 'C', commission, jobId, 'Commission revenue'],
        );
      }
      if (payablePaisa > 0) {
        await c.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2 WHERE id=$1`, [customerWalletId, payablePaisa]);
      }
      if (providerCredit > 0) {
        await c.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa + $2 WHERE id=$1`, [providerWalletId, providerCredit]);
      }
      const payment = (await c.query(
        `INSERT INTO payments (job_id, payer_id, method, provider_name, amount, status) VALUES ($1,$2,'wallet','wallet',$3,'confirmed') RETURNING *`,
        [jobId, userId, paisaToPkr(payablePaisa)],
      )).rows[0];
      if (promoId) {
        // FIX 14(a) (Stage 3): close the validate -> redeem race. The old
        // code re-COUNTed redemptions inside the txn but without a lock,
        // so two concurrent payments on DIFFERENT jobs both saw 0 and both
        // redeemed (the promo_redemptions PK is (promo_id, user_id, job_id),
        // so it cannot stop that). Locking the promo row FOR UPDATE
        // serialises concurrent redemptions of the same promo: the second
        // txn blocks until the first commits, then sees the new count and
        // fails with PROMO_PER_USER_LIMIT. Exactly one success.
        const promoRow = (await c.query(
          `SELECT per_user_limit FROM promos WHERE id=$1 FOR UPDATE`,
          [promoId],
        )).rows[0] as unknown as { per_user_limit: number | null } | undefined;
        const perUserLimit = promoRow?.per_user_limit ?? 1;
        const used = (await c.query(
          `SELECT COUNT(*) AS cnt FROM promo_redemptions WHERE promo_id=$1 AND user_id=$2`,
          [promoId, userId],
        )).rows[0] as unknown as { cnt: string };
        if (Number(used.cnt) >= perUserLimit) throw Errors.conflict('PROMO_PER_USER_LIMIT', 'Promo already redeemed by this user');
        await this.promos.recordRedemption(client, promoId, userId, jobId, deviceFingerprint);
      }
      await c.query(
        `UPDATE jobs SET state='PAYMENT_SETTLED', payment_status='settled', payment_method='wallet', commission_amount=$2, updated_at=now() WHERE id=$1`,
        [jobId, commission / 100],
      );
      // Referral credit (first paid job only) in the same transaction.
      await creditReferrerIfFirstPaidJob(client, userId, jobId);
      await c.query(
        `INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload) VALUES ($1,'COMPLETED','PAYMENT_SETTLED',$2,'customer',$3)`,
        [jobId, userId, JSON.stringify({ method: 'wallet', commission_paisa: commission, discount_paisa: discountPaisa })],
      );
      const updatedJob = (await c.query(`SELECT * FROM jobs WHERE id=$1`, [jobId])).rows[0];
      return { job: updatedJob, payment, commission, discountPaisa };
    });
    // Phase 4, item 4 (warranty): collect the warranty fee now that the
    // job has settled. collectFeeAtSettlement is a no-op when the job
    // never opted in and never throws, so settlement can never fail here
    // after committing. (On the wallet path the customer has already
    // paid from the wallet, so insufficient-balance is unlikely — the
    // fee is still collected as a separate wallet debit.)
    const warrantyOutcome = await this.warranty?.collectFeeAtSettlement(jobId, userId);
    if (warrantyOutcome && !warrantyOutcome.collected && warrantyOutcome.reason !== 'not_opted_in') {
      this.logger.warn(`warranty fee not collected at wallet settlement for job ${jobId}: ${warrantyOutcome.reason}`);
    }
    this.realtime.emitToRoom(`job:${jobId}`, 'job.state_changed', { job_id: jobId, from: 'COMPLETED', to: 'PAYMENT_SETTLED', method: 'wallet' });
    return {
      job: toJob(settled.job),
      payment_id: settled.payment.id,
      commission_paisa: settled.commission,
      discount_paisa: settled.discountPaisa,
    };
  }

  // ---- Admin: commission rules (roles super_admin / finance) -----------
  /** Commission rules (v1.3 CommissionRulePage envelope). No created_at
   *  column exists on commission_rules, so the cursor is an opaque offset
   *  token over the (valid_from DESC) ordering — see pagination.ts. */
  async listCommissionRules(cursor?: string, limit = 20) {
    const rows = (await this.db.query(
      `SELECT * FROM commission_rules ORDER BY valid_from DESC, category_id NULLS LAST, city_id NULLS LAST`,
    )).rows;
    const lim = Math.min(Math.max(limit, 1), 100);
    const page = offsetPage(rows.map((r) => ({ ...r, rate: Number(r.rate) })), cursor, lim);
    return page;
  }

  async createCommissionRule(dto: { category_id?: string | null; city_id?: string | null; tier?: number | null; rate: number; valid_from: string; valid_to?: string | null; is_promo?: boolean }) {
    if (!isCommissionRateInBand(dto.rate)) {
      throw Errors.unprocessable('COMMISSION_RATE_OUT_OF_BAND', `Commission rate must be between ${0.05} and ${0.15}`);
    }
    const row = (await this.db.query(
      `INSERT INTO commission_rules (category_id, city_id, tier, rate, valid_from, valid_to, is_promo)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [dto.category_id ?? null, dto.city_id ?? null, dto.tier ?? null, dto.rate, dto.valid_from, dto.valid_to ?? null, dto.is_promo ?? false],
    )).rows[0];
    return { ...row, rate: Number(row.rate) };
  }

  async updateCommissionRule(id: string, dto: { rate?: number; valid_to?: string | null; is_promo?: boolean }) {
    if (dto.rate !== undefined && !isCommissionRateInBand(dto.rate)) {
      throw Errors.unprocessable('COMMISSION_RATE_OUT_OF_BAND', 'Commission rate must be between 0.05 and 0.15');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, v: unknown) => { params.push(v); sets.push(`${col}=$${params.length}`); };
    if (dto.rate !== undefined) push('rate', dto.rate);
    if (dto.valid_to !== undefined) push('valid_to', dto.valid_to);
    if (dto.is_promo !== undefined) push('is_promo', dto.is_promo);
    if (sets.length === 0) throw Errors.badRequest('NO_FIELDS', 'Nothing to update');
    params.push(id);
    const row = (await this.db.query(
      `UPDATE commission_rules SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params,
    )).rows[0];
    if (!row) throw Errors.notFound('Commission rule');
    return { ...row, rate: Number(row.rate) };
  }
}
