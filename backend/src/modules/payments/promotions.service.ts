// Promotions + referrals (Phase 2).
// Validation is SIDE-EFFECT FREE: it only reads. A redemption row is
// written ONLY at a successful payment (WalletService.payWithWallet),
// never at validation. Promo kinds: 'percent' (value = % off) and
// 'fixed' (value = PKR off). All money in integer paisa.
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import { pkrToPaisa } from '../../common/utils/money';
import { referralCodeFor } from '../../common/utils/referral';
import { offsetPage, PageEnvelope } from '../../common/utils/pagination';

export interface PromoRow {
  id: string;
  code: string;
  kind: string;
  value: number | string;
  max_uses: number | null;
  per_user_limit: number | null;
  per_device_limit?: number | null;
  category_id?: string | null;
  city_id?: string | null;
  first_job_only?: boolean;
  valid_from: string | null;
  valid_to: string | null;
  is_active: boolean;
}

export interface PromoValidation {
  valid: boolean;
  kind: string;
  value: number;
  discount_paisa: number;
  promo_id?: string;
  reason?: string;
}

export interface ReferralInfo {
  code: string;
  referred_count: number;
  credit_paisa: number;
  pending_count: number;
}

type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

@Injectable()
export class PromotionsService {
  constructor(private db: DatabaseService) {}

  /** Validate a promo code. Pure read — no redemption is recorded here. */
  async validatePromo(input: {
    code: string;
    categoryId?: string | null;
    cityId?: string | null;
    amountPkr?: number;
    userId: string;
    deviceFingerprint?: string | null;
  }): Promise<PromoValidation> {
    const invalid = (reason: string, promo?: PromoRow): PromoValidation => ({
      valid: false,
      kind: promo?.kind ?? '',
      value: promo ? Number(promo.value) : 0,
      discount_paisa: 0,
      reason,
    });
    const promo = (await this.db.query<PromoRow>(
      `SELECT * FROM promos WHERE code=$1`,
      [input.code.trim().toUpperCase()],
    )).rows[0] as unknown as PromoRow | undefined;
    if (!promo) return invalid('PROMO_NOT_FOUND');
    if (!promo.is_active) return invalid('PROMO_INACTIVE', promo);
    const now = new Date();
    if (promo.valid_from && new Date(promo.valid_from) > now) return invalid('PROMO_NOT_STARTED', promo);
    if (promo.valid_to && new Date(promo.valid_to) < now) return invalid('PROMO_EXPIRED', promo);
    if (promo.category_id && promo.category_id !== input.categoryId) return invalid('PROMO_CATEGORY_MISMATCH', promo);
    if (promo.city_id && promo.city_id !== input.cityId) return invalid('PROMO_CITY_MISMATCH', promo);
    const count = async (sql: string, params: unknown[]): Promise<number> =>
      Number(((await this.db.query<{ cnt: string }>(sql, params)).rows[0] as unknown as { cnt: string }).cnt);
    if (promo.max_uses !== null && promo.max_uses !== undefined) {
      const used = await count(`SELECT COUNT(*) AS cnt FROM promo_redemptions WHERE promo_id=$1`, [promo.id]);
      if (used >= promo.max_uses) return invalid('PROMO_MAX_USES_REACHED', promo);
    }
    const perUser = promo.per_user_limit ?? 1;
    const userUses = await count(
      `SELECT COUNT(*) AS cnt FROM promo_redemptions WHERE promo_id=$1 AND user_id=$2`,
      [promo.id, input.userId],
    );
    if (userUses >= perUser) return invalid('PROMO_PER_USER_LIMIT', promo);
    const perDevice = promo.per_device_limit ?? 1;
    if (input.deviceFingerprint) {
      const deviceUses = await count(
        `SELECT COUNT(*) AS cnt FROM promo_redemptions WHERE promo_id=$1 AND device_fingerprint=$2`,
        [promo.id, input.deviceFingerprint],
      );
      if (deviceUses >= perDevice) return invalid('PROMO_PER_DEVICE_LIMIT', promo);
    }
    if (promo.first_job_only) {
      const settled = await count(
        `SELECT COUNT(*) AS cnt FROM jobs WHERE customer_id=$1 AND payment_status='settled'`,
        [input.userId],
      );
      if (settled > 0) return invalid('PROMO_FIRST_JOB_ONLY', promo);
    }
    const amountPaisa = input.amountPkr !== undefined ? pkrToPaisa(input.amountPkr) : 0;
    let discount = 0;
    if (promo.kind === 'percent') discount = Math.round((amountPaisa * Number(promo.value)) / 100);
    else if (promo.kind === 'fixed') discount = Math.min(pkrToPaisa(Number(promo.value)), amountPaisa);
    else return invalid('PROMO_UNKNOWN_KIND', promo);
    return { valid: true, kind: promo.kind, value: Number(promo.value), discount_paisa: discount, promo_id: promo.id };
  }

  /** Record a redemption. Call ONLY from inside a successful payment
   *  transaction — never from validation. */
  async recordRedemption(
    client: QueryClient,
    promoId: string,
    userId: string,
    jobId: string,
    deviceFingerprint?: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO promo_redemptions (promo_id, user_id, job_id, device_fingerprint) VALUES ($1,$2,$3,$4)`,
      [promoId, userId, jobId, deviceFingerprint ?? null],
    );
  }

  /** Batch 2 (§5): currently-active promos for the mobile home banner.
   *  Public, read-only. Only promos that are active, in their validity
   *  window, and (when max_uses is set) not yet exhausted. The promos
   *  table has no title column, so title echoes the code; discount_text
   *  is derived from kind/value ("10% off" / "PKR 500 off"). No promo
   *  code is invented here — every row comes from the promos table. */
  async listActivePromos(): Promise<{ items: { code: string; title: string; discount_text: string }[] }> {
    const rows = (await this.db.query<PromoRow>(
      `SELECT * FROM promos WHERE is_active AND (valid_from IS NULL OR valid_from <= now()) AND (valid_to IS NULL OR valid_to >= now()) ORDER BY valid_from DESC NULLS LAST, code ASC`,
    )).rows as unknown as PromoRow[];
    const items: { code: string; title: string; discount_text: string }[] = [];
    for (const r of rows) {
      if (r.max_uses !== null && r.max_uses !== undefined) {
        const used = Number(((await this.db.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM promo_redemptions WHERE promo_id=$1`, [r.id])).rows[0] as unknown as { cnt: string }).cnt);
        if (used >= r.max_uses) continue;
      }
      const discountText = r.kind === 'percent'
        ? `${Number(r.value)}% off`
        : r.kind === 'fixed' ? `PKR ${Number(r.value)} off` : '';
      items.push({ code: r.code, title: r.code, discount_text: discountText });
    }
    return { items };
  }

  /** Batch 3: "Deals of the day" — the same active promos as
   *  listActivePromos (same table, same validity window, no parallel
   *  system), plus valid_from/valid_to and ends_today so the home
   *  section can highlight deals expiring today. Admins create a deal
   *  for today with POST /admin/promos and valid_from/valid_to set to
   *  today; first_job_only promos (e.g. FIRSTJOB10) are included too
   *  — eligibility is still checked at validation time, not here.
   *  ends_today compares the valid_to date in Asia/Karachi. */
  async listTodayDeals(): Promise<{ items: { code: string; title: string; discount_text: string; valid_from: string | null; valid_to: string | null; ends_today: boolean }[] }> {
    const rows = (await this.db.query<PromoRow>(
      `SELECT * FROM promos WHERE is_active AND (valid_from IS NULL OR valid_from <= now()) AND (valid_to IS NULL OR valid_to >= now()) ORDER BY valid_to ASC NULLS LAST, code ASC`,
    )).rows as unknown as PromoRow[];
    const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' });
    const todayPkt = dayFmt.format(new Date());
    const items: { code: string; title: string; discount_text: string; valid_from: string | null; valid_to: string | null; ends_today: boolean }[] = [];
    for (const r of rows) {
      if (r.max_uses !== null && r.max_uses !== undefined) {
        const used = Number(((await this.db.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM promo_redemptions WHERE promo_id=$1`, [r.id])).rows[0] as unknown as { cnt: string }).cnt);
        if (used >= r.max_uses) continue;
      }
      const discountText = r.kind === 'percent'
        ? `${Number(r.value)}% off`
        : r.kind === 'fixed' ? `PKR ${Number(r.value)} off` : '';
      items.push({
        code: r.code, title: r.code, discount_text: discountText,
        valid_from: r.valid_from ? new Date(r.valid_from).toISOString() : null,
        valid_to: r.valid_to ? new Date(r.valid_to).toISOString() : null,
        ends_today: r.valid_to ? dayFmt.format(new Date(r.valid_to)) === todayPkt : false,
      });
    }
    return { items };
  }

  // ---- Referrals -------------------------------------------------------
  async getReferralInfo(userId: string): Promise<ReferralInfo> {
    const rows = (await this.db.query<{ status: string; credit_paisa: string }>(
      `SELECT status, credit_paisa FROM referrals WHERE referrer_id=$1`,
      [userId],
    )).rows;
    return {
      code: referralCodeFor(userId),
      referred_count: rows.length,
      credit_paisa: rows.reduce((s, r) => s + (r.status === 'credited' ? Number(r.credit_paisa) : 0), 0),
      pending_count: rows.filter((r) => r.status === 'pending').length,
    };
  }

  /** Link the caller to a referrer by code. One referrer per user, never
   *  yourself, code must belong to a real user. */
  async claimReferral(userId: string, code: string): Promise<ReferralInfo> {
    const clean = code.trim().toUpperCase();
    if (!/^NS-[0-9A-F]{8}$/.test(clean)) throw Errors.badRequest('INVALID_REFERRAL_CODE', 'Referral code must look like NS-XXXXXXXX');
    const suffix = clean.slice(3);
    const referrer = (await this.db.query<{ id: string }>(
      `SELECT id FROM users WHERE UPPER(LEFT(REPLACE(id::text,'-',''),8))=$1`,
      [suffix],
    )).rows[0] as unknown as { id: string } | undefined;
    if (!referrer) throw Errors.notFound('Referral code');
    if (referrer.id === userId) throw Errors.badRequest('SELF_REFERRAL', 'You cannot refer yourself');
    const row = (await this.db.query(
      `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1,$2) ON CONFLICT (referred_id) DO NOTHING RETURNING *`,
      [referrer.id, userId],
    )).rows[0];
    if (!row) throw Errors.conflict('ALREADY_REFERRED', 'This account already has a referrer');
    return this.getReferralInfo(userId);
  }

  // ---- Admin promo CRUD (roles super_admin / marketing) ----------------
  /** Promo list (v1.3 PromoPage envelope). FIX 7 latent bug: the old query
   *  ordered by `created_at`, which does not exist on promos (db/0003) —
   *  it 500'd on real Postgres. Ordered now by valid_from DESC, code ASC,
   *  with an opaque offset cursor (no stable created_at key exists). */
  async listPromos(cursor?: string, limit = 20): Promise<PageEnvelope<PromoRow>> {
    const rows = (await this.db.query<PromoRow>(
      `SELECT * FROM promos ORDER BY valid_from DESC NULLS LAST, code ASC`)).rows as unknown as PromoRow[];
    const lim = Math.min(Math.max(limit, 1), 100);
    // pg returns numeric columns as strings — coerce value to a JSON number
    // (the Promo schema declares it number), as listCommissionRules does.
    return offsetPage(rows.map((r) => ({ ...r, value: Number(r.value) })), cursor, lim);
  }

  async createPromo(dto: {
    code: string; kind: string; value: number; max_uses?: number | null; per_user_limit?: number;
    per_device_limit?: number; category_id?: string | null; city_id?: string | null;
    first_job_only?: boolean; valid_from?: string | null; valid_to?: string | null; is_active?: boolean;
  }): Promise<PromoRow> {
    if (!['percent', 'fixed'].includes(dto.kind)) throw Errors.badRequest('INVALID_PROMO_KIND', "kind must be 'percent' or 'fixed'");
    if (dto.kind === 'percent' && (dto.value <= 0 || dto.value > 100)) throw Errors.badRequest('INVALID_PROMO_VALUE', 'percent value must be 1–100');
    if (dto.kind === 'fixed' && dto.value <= 0) throw Errors.badRequest('INVALID_PROMO_VALUE', 'fixed value must be > 0');
    const row = (await this.db.query(
      `INSERT INTO promos (id, code, kind, value, max_uses, per_user_limit, per_device_limit, category_id, city_id, first_job_only, valid_from, valid_to, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [randomUUID(), dto.code.trim().toUpperCase(), dto.kind, dto.value, dto.max_uses ?? null, dto.per_user_limit ?? 1,
       dto.per_device_limit ?? 1, dto.category_id ?? null, dto.city_id ?? null, dto.first_job_only ?? false,
       dto.valid_from ?? null, dto.valid_to ?? null, dto.is_active ?? true],
    )).rows[0];
    return row as unknown as PromoRow;
  }

  async updatePromo(id: string, dto: Partial<{ value: number; max_uses: number | null; per_user_limit: number; per_device_limit: number; valid_to: string | null; is_active: boolean; first_job_only: boolean }>): Promise<PromoRow> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, v: unknown) => { params.push(v); sets.push(`${col}=$${params.length}`); };
    if (dto.value !== undefined) push('value', dto.value);
    if (dto.max_uses !== undefined) push('max_uses', dto.max_uses);
    if (dto.per_user_limit !== undefined) push('per_user_limit', dto.per_user_limit);
    if (dto.per_device_limit !== undefined) push('per_device_limit', dto.per_device_limit);
    if (dto.valid_to !== undefined) push('valid_to', dto.valid_to);
    if (dto.is_active !== undefined) push('is_active', dto.is_active);
    if (dto.first_job_only !== undefined) push('first_job_only', dto.first_job_only);
    if (sets.length === 0) throw Errors.badRequest('NO_FIELDS', 'Nothing to update');
    params.push(id);
    const row = (await this.db.query(
      `UPDATE promos SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params,
    )).rows[0];
    if (!row) throw Errors.notFound('Promo');
    return row as unknown as PromoRow;
  }
}
