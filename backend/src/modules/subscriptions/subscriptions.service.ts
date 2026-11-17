// Subscriptions (Phase 3) — Free / Pro / Business plans for providers.
//
// COMMISSION INTEGRATION POINT (for the integrator — this module does NOT
// touch the commission engine):
//   OffersService.acceptOffer (src/modules/offers/offers.service.ts) resolves
//   the base rate with resolveCommissionRate(...) and snapshots it into
//   jobs.commission_rate. After that call, add:
//     const rate = await subscriptionsService.effectiveCommissionRate(
//       providerUserId, baseRate);
//   and snapshot `rate` instead. JobsService.confirmPayment already uses the
//   snapshotted jobs.commission_rate, so no change is needed there.
//   effectiveCommissionRate() applies the plan multiplier and clamps to the
//   0.05–0.15 band via applyPlanCommissionRate() below.
//
// FEATURED PLACEMENT INTEGRATION POINT:
//   ProvidersService.nearby() and getById() currently hard-code
//   `sponsored: false`. The integrator replaces that with
//   SubscriptionsService.isProviderFeatured(providerId), which returns
//   { sponsored: true, label: 'Sponsored' } for active Business plans and
//   { sponsored: false, label: null } otherwise. Featured placement is ALWAYS
//   labelled "Sponsored" — never shown as organic ranking.
//
// BILLING: paid plans are charged from the provider's existing wallet
// (wallet_accounts, one per user — v1.1). The charge writes balanced
// ledger_entries in one transaction, exactly like WalletService settlement:
//   D wallet / C subscription_revenue on the provider's own wallet, and
//   balance_paisa -= price. Free costs PKR 0 and writes no ledger rows.
//   A charge fails with 409 INSUFFICIENT_WALLET_BALANCE when the wallet is
//   short; the user tops up via the existing POST /wallet/topup flow.
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import { clampCommissionRate } from '../../common/utils/commission';
import { ensureWallet } from '../../common/utils/wallet';
import { pkrToPaisa, paisaToPkr } from '../../common/utils/money';
import { pageFromRows } from '../../common/utils/pagination';

export type PlanCode = 'free' | 'pro' | 'business';
export const PLAN_CODES = ['free', 'pro', 'business'] as const;

export interface PlanRow {
  id: string;
  code: PlanCode;
  name: string;
  price_pkr: string | number;
  commission_multiplier: string | number;
  max_staff_accounts: number;
  featured: boolean;
  analytics_enabled: boolean;
  is_active: boolean;
}

export interface SubscriptionView {
  id: string | null;
  provider_id: string;
  plan_code: PlanCode;
  plan_name: string;
  price_pkr: number;
  commission_multiplier: number;
  max_staff_accounts: number;
  featured: boolean;
  analytics_enabled: boolean;
  status: 'active' | 'cancelled' | 'expired' | 'none';
  current_period_start: string | null;
  current_period_end: string | null;
  pending_plan_code: PlanCode | null;
  cancel_at_period_end: boolean;
  // Featured placement is always labelled "Sponsored" when it applies.
  placement: { sponsored: boolean; label: string | null };
}

type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** Pure: plan-discounted commission rate, clamped to the 0.05–0.15 band.
 *  Free x1.00 (no discount), Pro x0.80, Business x0.60.
 *  e.g. base 0.10 -> Pro 0.08, Business 0.06; base 0.15 -> Pro 0.12,
 *  Business 0.09; base 0.05 -> Pro/Business stay 0.05 (band floor). */
export function applyPlanCommissionRate(baseRate: number, multiplier: number): number {
  return clampCommissionRate(baseRate * multiplier);
}

/** Pure: featured-placement label for a plan. Featured is always "Sponsored". */
export function featuredPlacementForPlan(featured: boolean): { sponsored: boolean; label: string | null } {
  return featured ? { sponsored: true, label: 'Sponsored' } : { sponsored: false, label: null };
}

function toPlanView(p: PlanRow) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    price_pkr: Number(p.price_pkr),
    commission_multiplier: Number(p.commission_multiplier),
    max_staff_accounts: Number(p.max_staff_accounts),
    featured: p.featured,
    analytics_enabled: p.analytics_enabled,
    is_active: p.is_active,
    placement: featuredPlacementForPlan(p.featured),
  };
}

@Injectable()
export class SubscriptionsService {
  constructor(private db: DatabaseService) {}

  // ---- Plans -----------------------------------------------------------
  async listPlans(): Promise<ReturnType<typeof toPlanView>[]> {
    const rows = (await this.db.query(
      `SELECT * FROM subscription_plans WHERE is_active ORDER BY price_pkr ASC`,
    )).rows as unknown as PlanRow[];
    return rows.map(toPlanView);
  }

  private async getPlanByCode(client: QueryClient, code: string): Promise<PlanRow> {
    const row = (await client.query(
      `SELECT * FROM subscription_plans WHERE code=$1 AND is_active`,
      [code],
    )).rows[0] as unknown as PlanRow | undefined;
    if (!row) throw Errors.notFound('Subscription plan');
    return row;
  }

  private async providerIdFor(client: QueryClient, userId: string): Promise<string> {
    const row = (await client.query(
      `SELECT id FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`,
      [userId],
    )).rows[0] as unknown as { id: string } | undefined;
    if (!row) throw Errors.forbidden('No provider profile for this account');
    return row.id;
  }

  private async activeSubscription(client: QueryClient, providerId: string) {
    return (await client.query(
      `SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.price_pkr, p.commission_multiplier,
              p.max_staff_accounts, p.featured, p.analytics_enabled,
              pp.code AS pending_plan_code
       FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id
       LEFT JOIN subscription_plans pp ON pp.id=s.pending_plan_id
       WHERE s.provider_id=$1 AND s.status='active'`,
      [providerId],
    )).rows[0] as unknown as Record<string, unknown> | undefined;
  }

  private toView(providerId: string, sub: Record<string, unknown> | undefined, plan: PlanRow): SubscriptionView {
    const featured = sub ? Boolean(sub.featured) : plan.featured;
    return {
      id: sub ? String(sub.id) : null,
      provider_id: providerId,
      plan_code: (sub ? String(sub.plan_code) : plan.code) as PlanCode,
      plan_name: sub ? String(sub.plan_name) : plan.name,
      price_pkr: sub ? Number(sub.price_pkr) : Number(plan.price_pkr),
      commission_multiplier: sub ? Number(sub.commission_multiplier) : Number(plan.commission_multiplier),
      max_staff_accounts: sub ? Number(sub.max_staff_accounts) : Number(plan.max_staff_accounts),
      featured,
      analytics_enabled: sub ? Boolean(sub.analytics_enabled) : plan.analytics_enabled,
      status: sub ? (String(sub.status) as SubscriptionView['status']) : 'none',
      current_period_start: sub ? String(sub.current_period_start) : null,
      current_period_end: sub ? String(sub.current_period_end) : null,
      pending_plan_code: sub && sub.pending_plan_code ? (String(sub.pending_plan_code) as PlanCode) : null,
      cancel_at_period_end: sub ? Boolean(sub.cancel_at_period_end) : false,
      placement: featuredPlacementForPlan(featured),
    };
  }

  /** Current subscription; providers with no row are on Free by default. */
  async getMySubscription(userId: string): Promise<SubscriptionView> {
    const providerId = await this.providerIdFor(this.db as unknown as QueryClient, userId);
    const sub = await this.activeSubscription(this.db as unknown as QueryClient, providerId);
    const free = await this.getPlanByCode(this.db as unknown as QueryClient, 'free');
    return this.toView(providerId, sub, free);
  }

  // ---- Billing (wallet ledger) ------------------------------------------
  /** Charge pricePkr from the user's wallet inside the caller's transaction.
   *  Throws 409 INSUFFICIENT_WALLET_BALANCE when short. Free (0) is a no-op. */
  private async chargeWallet(client: QueryClient, userId: string, pricePkr: number, memo: string): Promise<void> {
    const pricePaisa = pkrToPaisa(pricePkr);
    if (pricePaisa <= 0) return;
    const walletId = await ensureWallet(client, userId);
    const bal = (await client.query(
      `SELECT balance_paisa FROM wallet_accounts WHERE id=$1 FOR UPDATE`, [walletId],
    )).rows[0] as unknown as { balance_paisa: string } | undefined;
    if (!bal || Number(bal.balance_paisa) < pricePaisa) {
      throw Errors.conflict(
        'INSUFFICIENT_WALLET_BALANCE',
        `Wallet balance is short by PKR ${paisaToPkr(pricePaisa - Number(bal?.balance_paisa ?? 0))} — top up via /wallet/topup first`,
      );
    }
    const txnId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, memo) VALUES ($1,$2,$3,$4,$5,$6)`,
      [txnId, walletId, 'wallet', 'D', pricePaisa, memo],
    );
    await client.query(
      `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, memo) VALUES ($1,$2,$3,$4,$5,$6)`,
      [txnId, walletId, 'subscription_revenue', 'C', pricePaisa, memo],
    );
    await client.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2 WHERE id=$1`, [walletId, pricePaisa]);
  }

  // ---- Subscribe / change / cancel --------------------------------------
  async subscribe(userId: string, planCode: string): Promise<SubscriptionView> {
    const plan = await this.getPlanByCode(this.db as unknown as QueryClient, planCode);
    return this.db.withTransaction(async (c) => {
      const client = c as unknown as QueryClient;
      const providerId = await this.providerIdFor(client, userId);
      const existing = await this.activeSubscription(client, providerId);
      if (existing) {
        throw Errors.conflict('SUBSCRIPTION_EXISTS', 'An active subscription already exists — use /subscriptions/change to switch plans');
      }
      await this.chargeWallet(client, userId, Number(plan.price_pkr), `Subscription ${plan.code} (1 month)`);
      const row = (await client.query(
        `INSERT INTO subscriptions (provider_id, user_id, plan_id, status, current_period_start, current_period_end)
         VALUES ($1,$2,$3,'active', now(), now() + interval '1 month') RETURNING id`,
        [providerId, userId, plan.id],
      )).rows[0];
      await client.query(`UPDATE provider_profiles SET subscription_plan=$2, updated_at=now() WHERE id=$1`, [providerId, plan.code]);
      const sub = await this.activeSubscription(client, providerId);
      return this.toView(providerId, sub ?? { ...row, plan_code: plan.code }, plan);
    });
  }

  /**
   * Upgrade: charged in full immediately, new 1-month period starts now.
   * Downgrade (incl. to Free): no charge, no immediate loss of benefits —
   * pending_plan_id is applied at current_period_end by expireEndedSubscriptions.
   */
  async changePlan(userId: string, planCode: string): Promise<SubscriptionView> {
    const plan = await this.getPlanByCode(this.db as unknown as QueryClient, planCode);
    return this.db.withTransaction(async (c) => {
      const client = c as unknown as QueryClient;
      const providerId = await this.providerIdFor(client, userId);
      const existing = await this.activeSubscription(client, providerId);
      if (!existing) throw Errors.conflict('NO_SUBSCRIPTION', 'No active subscription — use POST /subscriptions to subscribe first');
      if (String(existing.plan_code) === plan.code) {
        throw Errors.conflict('SAME_PLAN', `Already on the ${plan.code} plan`);
      }
      if (Number(plan.price_pkr) > Number(existing.price_pkr)) {
        // Upgrade: charge new price now, restart the period.
        await this.chargeWallet(client, userId, Number(plan.price_pkr), `Subscription upgrade to ${plan.code} (1 month)`);
        await client.query(
          `UPDATE subscriptions SET plan_id=$2, current_period_start=now(), current_period_end=now() + interval '1 month',
                  pending_plan_id=NULL, cancel_at_period_end=false, updated_at=now() WHERE id=$1`,
          [existing.id, plan.id],
        );
        await client.query(`UPDATE provider_profiles SET subscription_plan=$2, updated_at=now() WHERE id=$1`, [providerId, plan.code]);
      } else {
        // Downgrade: takes effect at period end.
        await client.query(
          `UPDATE subscriptions SET pending_plan_id=$2, cancel_at_period_end=false, updated_at=now() WHERE id=$1`,
          [existing.id, plan.id],
        );
      }
      const sub = await this.activeSubscription(client, providerId);
      return this.toView(providerId, sub, plan);
    });
  }

  /** Cancel at period end: benefits stay until current_period_end. */
  async cancel(userId: string): Promise<SubscriptionView> {
    return this.db.withTransaction(async (c) => {
      const client = c as unknown as QueryClient;
      const providerId = await this.providerIdFor(client, userId);
      const existing = await this.activeSubscription(client, providerId);
      if (!existing) throw Errors.conflict('NO_SUBSCRIPTION', 'No active subscription to cancel');
      await client.query(
        `UPDATE subscriptions SET status='cancelled', cancel_at_period_end=true, pending_plan_id=NULL, updated_at=now() WHERE id=$1`,
        [existing.id],
      );
      const free = await this.getPlanByCode(client, 'free');
      // A cancelled row no longer counts as 'active', so report it directly.
      const row = { ...existing, status: 'cancelled', cancel_at_period_end: true };
      return this.toView(providerId, row, free);
    });
  }

  /**
   * Period-end sweep (called by POST /admin/subscriptions/expire; a future
   * cron may call the same endpoint). For each active subscription whose
   * period ended: cancelled -> expired + provider back to Free; pending
   * downgrade -> plan applied, new 1-month period starts, provider plan
   * synced; otherwise (paid, no pending change) -> expired + provider Free
   * until they renew (no auto-charge: wallet auto-debit is not in scope).
   * Returns the number of subscriptions processed.
   */
  async expireEndedSubscriptions(): Promise<{ processed: number }> {
    const due = (await this.db.query(
      `SELECT s.id, s.provider_id, s.user_id, s.pending_plan_id, s.cancel_at_period_end,
              pp.code AS pending_plan_code
       FROM subscriptions s LEFT JOIN subscription_plans pp ON pp.id=s.pending_plan_id
       WHERE s.status='active' AND s.current_period_end <= now()`,
    )).rows as unknown as Record<string, unknown>[];
    let processed = 0;
    for (const row of due) {
      await this.db.withTransaction(async (c) => {
        const client = c as unknown as QueryClient;
        if (row.pending_plan_id) {
          await client.query(
            `UPDATE subscriptions SET plan_id=$2, status='active', current_period_start=now(),
                    current_period_end=now() + interval '1 month', pending_plan_id=NULL, updated_at=now() WHERE id=$1`,
            [row.id, row.pending_plan_id],
          );
          await client.query(`UPDATE provider_profiles SET subscription_plan=$2, updated_at=now() WHERE id=$1`, [row.provider_id, String(row.pending_plan_code)]);
        } else {
          await client.query(`UPDATE subscriptions SET status='expired', updated_at=now() WHERE id=$1`, [row.id]);
          await client.query(`UPDATE provider_profiles SET subscription_plan='free', updated_at=now() WHERE id=$1`, [row.provider_id]);
        }
      });
      processed += 1;
    }
    return { processed };
  }

  // ---- Commission effect -------------------------------------------------
  /** Effective commission rate for a provider: base engine rate x the plan
   *  multiplier, clamped to 0.05–0.15. Providers without a subscription are
   *  Free (multiplier 1.00 — no discount). */
  async effectiveCommissionRate(providerUserId: string, baseRate: number): Promise<number> {
    const providerId = await this.providerIdFor(this.db as unknown as QueryClient, providerUserId);
    const sub = await this.activeSubscription(this.db as unknown as QueryClient, providerId);
    const multiplier = sub ? Number(sub.commission_multiplier) : 1;
    return applyPlanCommissionRate(baseRate, multiplier);
  }

  /** Featured lookup for search/nearby (integrator): always "Sponsored". */
  async isProviderFeatured(providerId: string): Promise<{ sponsored: boolean; label: string | null }> {
    const sub = await this.activeSubscription(this.db as unknown as QueryClient, providerId);
    return featuredPlacementForPlan(Boolean(sub?.featured));
  }

  // ---- Provider analytics (Pro/Business only) ---------------------------
  async getAnalytics(userId: string, days = 30): Promise<Record<string, unknown>> {
    const safeDays = Math.min(Math.max(days || 30, 1), 365);
    const providerId = await this.providerIdFor(this.db as unknown as QueryClient, userId);
    const sub = await this.activeSubscription(this.db as unknown as QueryClient, providerId);
    if (!sub || !sub.analytics_enabled) {
      throw Errors.forbidden('Provider analytics requires a Pro or Business subscription');
    }
    const since = new Date(Date.now() - safeDays * 24 * 3600 * 1000).toISOString();
    const totals = (await this.db.query(
      `SELECT COUNT(*) AS jobs_total,
              COUNT(*) FILTER (WHERE state='PAYMENT_SETTLED' OR state='RATED') AS jobs_settled,
              COALESCE(SUM(final_price),0) AS gross_pkr,
              COALESCE(SUM(commission_amount),0) AS commission_pkr
       FROM jobs WHERE provider_id=$1 AND created_at >= $2`,
      [providerId, since],
    )).rows[0] as unknown as Record<string, unknown>;
    const rating = (await this.db.query(
      `SELECT COALESCE(AVG(stars),0) AS avg_stars, COUNT(*) AS review_count
       FROM reviews WHERE reviewee_id=$1 AND created_at >= $2`,
      [userId, since],
    )).rows[0] as unknown as Record<string, unknown>;
    const byState = (await this.db.query(
      `SELECT state, COUNT(*) AS n FROM jobs WHERE provider_id=$1 AND created_at >= $2 GROUP BY state`,
      [providerId, since],
    )).rows as unknown as Record<string, unknown>[];
    const gross = Number(totals.gross_pkr ?? 0);
    const commission = Number(totals.commission_pkr ?? 0);
    return {
      provider_id: providerId,
      plan_code: String(sub.plan_code),
      period_days: safeDays,
      jobs_total: Number(totals.jobs_total ?? 0),
      jobs_settled: Number(totals.jobs_settled ?? 0),
      gross_pkr: gross,
      commission_pkr: commission,
      net_earnings_pkr: gross - commission,
      avg_stars: Number(Number(rating.avg_stars ?? 0).toFixed(2)),
      review_count: Number(rating.review_count ?? 0),
      jobs_by_state: Object.fromEntries(byState.map((r) => [String(r.state), Number(r.n)])),
    };
  }

  // ---- Admin plan management ---------------------------------------------
  async createPlan(dto: { code: string; name: string; price_pkr: number; commission_multiplier: number; max_staff_accounts: number; featured: boolean; analytics_enabled: boolean }) {
    const row = (await this.db.query(
      `INSERT INTO subscription_plans (code, name, price_pkr, commission_multiplier, max_staff_accounts, featured, analytics_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [dto.code, dto.name, dto.price_pkr, dto.commission_multiplier, dto.max_staff_accounts, dto.featured, dto.analytics_enabled],
    )).rows[0] as unknown as PlanRow;
    return toPlanView(row);
  }

  async updatePlan(id: string, dto: Partial<{ name: string; price_pkr: number; commission_multiplier: number; max_staff_accounts: number; featured: boolean; analytics_enabled: boolean; is_active: boolean }>) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (col: string, v: unknown) => { params.push(v); sets.push(`${col}=$${params.length}`); };
    if (dto.name !== undefined) push('name', dto.name);
    if (dto.price_pkr !== undefined) push('price_pkr', dto.price_pkr);
    if (dto.commission_multiplier !== undefined) push('commission_multiplier', dto.commission_multiplier);
    if (dto.max_staff_accounts !== undefined) push('max_staff_accounts', dto.max_staff_accounts);
    if (dto.featured !== undefined) push('featured', dto.featured);
    if (dto.analytics_enabled !== undefined) push('analytics_enabled', dto.analytics_enabled);
    if (dto.is_active !== undefined) push('is_active', dto.is_active);
    if (sets.length === 0) throw Errors.unprocessable('EMPTY_UPDATE', 'Provide at least one field to update');
    sets.push('updated_at=now()');
    const row = (await this.db.query(
      `UPDATE subscription_plans SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, params,
    )).rows[0] as unknown as PlanRow | undefined;
    if (!row) throw Errors.notFound('Subscription plan');
    return toPlanView(row);
  }

  async listSubscriptionsAdmin(cursor?: string, limit = 20) {
    const lim = Math.min(Math.max(limit || 20, 1), 100);
    const params: unknown[] = [cursor ?? null, lim + 1];
    const rows = (await this.db.query(
      `SELECT s.*, p.code AS plan_code FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id
       WHERE ($1::text IS NULL OR (s.created_at, s.id) < (SELECT created_at, id FROM subscriptions WHERE id=$1::uuid))
       ORDER BY s.created_at DESC, s.id DESC LIMIT $2`,
      params,
    )).rows as unknown as Record<string, unknown>[];
    const page = pageFromRows(rows as unknown as Record<string, unknown>[], lim);
    return { items: page.items, next_cursor: page.next_cursor };
  }
}
