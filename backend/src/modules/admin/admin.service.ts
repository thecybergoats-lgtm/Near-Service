import { Injectable, Inject, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { Errors } from '../../common/errors/api-error';
import { isLegalTransition } from '../../common/utils/job-state-machine';
import { ensureWallet } from '../../common/utils/wallet';
import { pageFromRows } from '../../common/utils/pagination';
import { toJob } from '../offers/offers.service';
import { pkrToPaisa } from '../../common/utils/money';
import { ProvidersService } from '../providers/providers.service';
import { VerificationService } from '../verification/verification.service';

const IDENTITY_DOCS = ['cnic_front', 'cnic_back', 'selfie'];

export type DisputeOutcome = 'refund' | 'partial_refund' | 'compensation' | 'no_action';

/** Map a pre-dispute job state to the state no_action restores. The state
 *  machine only allows DISPUTED -> REFUNDED | PAYMENT_SETTLED | IN_PROGRESS,
 *  so IN_PROGRESS restores exactly and everything else restores to
 *  PAYMENT_SETTLED (the pre-dispute state is kept in the resolution jsonb
 *  and the job_events payload for the record). */
export function restoreStateFor(preDisputeState: string | null): string {
  return preDisputeState === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'PAYMENT_SETTLED';
}

@Injectable()
export class AdminService {
  // Phase 3: VerificationService is @Optional so direct construction with
  // (db, realtime, providers) in older tests keeps working. It supplies
  // SUPPORTING EVIDENCE ONLY — it never approves anything; tier upgrades
  // stay gated on the officer's explicit approved decision below.
  constructor(
    private db: DatabaseService,
    private realtime: RealtimeService,
    private providers: ProvidersService,
    @Optional() @Inject(VerificationService) private verification?: VerificationService,
  ) {}
  private async audit(actorId: string, action: string, entity: string, entityId: string | null, before: unknown, after: unknown) {
    await this.db.query(`INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
      [actorId, action, entity, entityId, JSON.stringify(before ?? null), JSON.stringify(after ?? null)]);
  }
  /** Manual verification queue (v1.1): pending documents with the provider's
   *  CNIC front/back + selfie side-by-side for a HUMAN decision only.
   *  No automated checks run in Phase 1. v1.2 VerificationPage envelope;
   *  cursor is a document id, newest first. */
  async verifications(cursor?: string, limit = 20) {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = (await this.db.query(
      `SELECT d.id AS document_id, d.provider_id, d.doc_type, d.storage_key, d.review_status, d.created_at,
              p.display_name, p.provider_type, p.tier, u.phone, u.full_name
       FROM provider_documents d JOIN provider_profiles p ON p.id=d.provider_id JOIN users u ON u.id=p.user_id
       WHERE d.review_status='pending'
         AND ($1::text IS NULL OR (d.created_at, d.id) < (SELECT created_at, id FROM provider_documents WHERE id=$1::uuid))
       ORDER BY d.created_at DESC, d.id DESC LIMIT $2`, [cursor ?? null, lim + 1])).rows;
    // VerificationPage items are keyed by document_id, not id.
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return { items: page, next_cursor: hasMore ? String(page[page.length - 1].document_id) : null };
  }
  /** One verification case for the officer view: the document, the provider,
   *  and the decrypted CNIC (for comparing with the CNIC photo). The decrypt
   *  is audited (action field.decrypt:cnic) and the plaintext is returned
   *  ONLY to verification officers on this endpoint — never in list views. */
  async verificationDetail(adminId: string, documentId: string) {
    const doc = (await this.db.query(
      `SELECT d.*, p.display_name, p.provider_type, p.tier, p.payout_method, u.phone, u.full_name
       FROM provider_documents d JOIN provider_profiles p ON p.id=d.provider_id JOIN users u ON u.id=p.user_id
       WHERE d.id=$1`, [documentId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!doc) throw Errors.notFound('Document');
    const cnic = await this.providers.decryptProviderField(adminId, String(doc.provider_id), 'cnic');
    return { ...doc, cnic };
  }
  /** Decide ONE document (OpenAPI adminDecideVerification). Approving the
   *  last pending identity document (CNIC front/back + selfie) upgrades the
   *  provider Tier 0 -> 1. Rejection keeps Tier 0 with a note. */
  async decideVerification(adminId: string, documentId: string, decision: 'approved' | 'rejected', note?: string) {
    const doc = (await this.db.query<{ id: string; provider_id: string; doc_type: string; review_status: string }>(
      `SELECT * FROM provider_documents WHERE id=$1`, [documentId])).rows[0];
    if (!doc) throw Errors.notFound('Document');
    if (doc.review_status !== 'pending') throw Errors.conflict('DOCUMENT_DECIDED', 'Document already decided');
    const before = { ...doc };
    const updated = (await this.db.query(
      `UPDATE provider_documents SET review_status=$2, reviewed_by=$3, review_note=$4 WHERE id=$1 RETURNING *`,
      [documentId, decision, adminId, note ?? null])).rows[0];
    let tierUpgraded = false;
    if (decision === 'approved' && IDENTITY_DOCS.includes(doc.doc_type)) {
      const pending = (await this.db.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM provider_documents WHERE provider_id=$1 AND doc_type = ANY($2::text[]) AND review_status='pending'`,
        [doc.provider_id, IDENTITY_DOCS])).rows[0];
      if (Number(pending.c) === 0) {
        const prof = (await this.db.query<{ tier: number }>(`SELECT tier FROM provider_profiles WHERE id=$1`, [doc.provider_id])).rows[0];
        if (prof && prof.tier === 0) {
          await this.db.query(`UPDATE provider_profiles SET tier=1, updated_at=now() WHERE id=$1`, [doc.provider_id]);
          tierUpgraded = true;
        }
      }
    }
    // Phase 3: attach the automated assists (face-match, liveness, OCR)
    // as SUPPORTING EVIDENCE on the decision record only. Advisory: a
    // high face-match score never approves, a low one never rejects —
    // the tier upgrade above stays gated on this explicit decision.
    // A lookup failure degrades to null evidence, never blocks the decision.
    let verificationEvidence: unknown = null;
    try {
      if (this.verification) verificationEvidence = await this.verification.evidenceForProvider(doc.provider_id);
    } catch { verificationEvidence = null; }
    await this.audit(adminId, `verification.${decision}`, 'provider_documents', documentId, before, { ...updated, tier_upgraded: tierUpgraded, verification_evidence: verificationEvidence });
    return { ...updated, tier_upgraded: tierUpgraded, verification_evidence: verificationEvidence };
  }
  /** Admin user list (v1.2 UserPage envelope; cursor is a user id, newest
   *  first). Only the fields the admin UI needs — no secrets. */
  async listUsers(cursor?: string, limit = 50) {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = (await this.db.query(
      `SELECT id, phone, full_name, language, status, created_at FROM users WHERE deleted_at IS NULL
         AND ($1::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM users WHERE id=$1::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $2`, [cursor ?? null, lim + 1])).rows;
    return pageFromRows(rows, lim);
  }
  /** Admin category list (v1.2 CategoryPage envelope). Flat list ordered by
   *  (level, sort_order, id); the cursor is a category id. */
  async listCategories(cursor?: string, limit = 50) {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = (await this.db.query(
      `SELECT id, parent_id, level, slug, name_en, name_ur, name_roman, icon_key, sort_order FROM categories
       WHERE ($1::text IS NULL OR (level, sort_order, id) > (SELECT level, sort_order, id FROM categories WHERE id=$1::uuid))
       ORDER BY level, sort_order, id LIMIT $2`, [cursor ?? null, lim + 1])).rows;
    return pageFromRows(rows, lim);
  }
  /** Admin job list (v1.2 JobPage envelope; cursor is a job id, newest first).
   *  Rows go through toJob so numeric prices come back as JSON numbers, not
   *  pg's numeric-as-string (FIX 7, same class as listOffers/listPromos). */
  async listJobs(cursor?: string, limit = 50) {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = (await this.db.query(
      `SELECT id, request_id, agreed_price, final_price, state, payment_method, payment_status FROM jobs
       WHERE ($1::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM jobs WHERE id=$1::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $2`, [cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = (hasMore ? rows.slice(0, lim) : rows).map((r) => toJob(r as unknown as Record<string, unknown>));
    return { items: page, next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }
  /** Admin audit log (v1.2 AuditLogPage envelope; cursor is a bigint log id,
   *  newest first). */
  async listAuditLogs(limit = 50, cursor?: string) {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = cursor
      ? (await this.db.query(`SELECT * FROM audit_logs WHERE id < $2::bigint ORDER BY id DESC LIMIT $1`, [lim + 1, cursor])).rows
      : (await this.db.query(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT $1`, [lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return { items: page, next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }

  // ---- Phase 2: KPIs, requests, suspend, categories ----

  /** Admin KPIs from real tables. Definitions: GMV = sum of final prices of
   *  settled/rated jobs; take_rate = commission / GMV; active_users = live
   *  users with status 'active'; acceptance_rate = accepted offers / all
   *  offers; time_to_first_offer_seconds = mean request->first-offer lag;
   *  cancellation_rate = cancelled jobs / all jobs. */
  async kpis() {
    const row = (await this.db.query(
      `SELECT
         (SELECT COALESCE(SUM(final_price),0) FROM jobs WHERE state IN ('PAYMENT_SETTLED','RATED')) AS gmv_pkr,
         (SELECT COUNT(*)::int FROM jobs) AS jobs_total,
         (SELECT COALESCE(SUM(commission_amount),0) FROM jobs WHERE state IN ('PAYMENT_SETTLED','RATED')) AS commission_pkr,
         (SELECT COUNT(*)::int FROM users WHERE deleted_at IS NULL AND status='active') AS active_users,
         (SELECT COUNT(*)::int FROM provider_profiles WHERE deleted_at IS NULL AND is_online) AS active_providers,
         (SELECT COUNT(*)::int FROM offers WHERE status='accepted') AS accepted_offers,
         (SELECT COUNT(*)::int FROM offers) AS total_offers,
         (SELECT AVG(EXTRACT(EPOCH FROM (first_offer_at - r.created_at))) FROM
            (SELECT r2.id, r2.created_at, MIN(o.created_at) AS first_offer_at FROM service_requests r2
             JOIN offers o ON o.request_id=r2.id GROUP BY r2.id, r2.created_at) r) AS time_to_first_offer_seconds,
         (SELECT COUNT(*)::int FROM jobs WHERE state IN ('CANCELLED_BY_CUSTOMER','CANCELLED_BY_PROVIDER')) AS cancelled_jobs,
         (SELECT COUNT(*)::int FROM disputes WHERE status='open') AS disputes_open`)).rows[0] as unknown as Record<string, unknown>;
    const gmv = Number(row.gmv_pkr);
    const commission = Number(row.commission_pkr);
    const jobsTotal = Number(row.jobs_total);
    const totalOffers = Number(row.total_offers);
    return {
      gmv_pkr: gmv,
      jobs_total: jobsTotal,
      take_rate: gmv > 0 ? Number((commission / gmv).toFixed(4)) : 0,
      active_users: Number(row.active_users),
      active_providers: Number(row.active_providers),
      acceptance_rate: totalOffers > 0 ? Number((Number(row.accepted_offers) / totalOffers).toFixed(4)) : 0,
      time_to_first_offer_seconds: row.time_to_first_offer_seconds != null ? Number(Number(row.time_to_first_offer_seconds).toFixed(1)) : null,
      cancellation_rate: jobsTotal > 0 ? Number((Number(row.cancelled_jobs) / jobsTotal).toFixed(4)) : 0,
      disputes_open: Number(row.disputes_open),
    };
  }

  /** Admin request queue: service_requests with customer phone + category. */
  async listRequests(opts: { status?: string; cursor?: string; limit?: number }) {
    const lim = Math.min(Math.max(opts.limit || 20, 1), 100);
    const rows = (await this.db.query(
      `SELECT r.*, u.phone AS customer_phone, c.slug AS category_slug, c.name_en AS category_name
       FROM service_requests r JOIN users u ON u.id=r.customer_id JOIN categories c ON c.id=r.category_id
       WHERE r.deleted_at IS NULL
         AND ($1::varchar IS NULL OR r.status=$1::varchar)
         AND ($2::text IS NULL OR (r.created_at, r.id) < (SELECT created_at, id FROM service_requests WHERE id=$2::uuid))
       ORDER BY r.created_at DESC, r.id DESC LIMIT $3`,
      [opts.status ?? null, opts.cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return { items: page, next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }

  /** Suspend / unsuspend a user (status flag + audit log). This flips the
   *  account status; auth-guard enforcement of 'suspended' is a separate
   *  concern and is not changed here. */
  async suspendUser(adminId: string, userId: string, suspended: boolean) {
    const before = (await this.db.query(`SELECT id, phone, full_name, status FROM users WHERE id=$1`, [userId])).rows[0];
    if (!before) throw Errors.notFound('User');
    const updated = (await this.db.query(
      `UPDATE users SET status=$2, updated_at=now() WHERE id=$1 RETURNING id, phone, full_name, status`,
      [userId, suspended ? 'suspended' : 'active'])).rows[0];
    await this.audit(adminId, suspended ? 'user.suspend' : 'user.unsuspend', 'users', userId, before, updated);
    return updated;
  }

  async createCategory(adminId: string, dto: { slug: string; name_en: string; name_ur?: string; name_roman?: string; parent_id?: string; level: number; icon_key?: string }) {
    if (!dto.slug || !dto.name_en || dto.level == null) throw Errors.unprocessable('INVALID_CATEGORY', 'slug, name_en and level are required');
    if (dto.parent_id) {
      const parent = (await this.db.query(`SELECT id FROM categories WHERE id=$1`, [dto.parent_id])).rows[0];
      if (!parent) throw Errors.notFound('Parent category');
    }
    try {
      const row = (await this.db.query(
        `INSERT INTO categories (parent_id, level, slug, name_en, name_ur, name_roman, icon_key, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0) RETURNING *`,
        [dto.parent_id ?? null, dto.level, dto.slug, dto.name_en, dto.name_ur ?? null, dto.name_roman ?? null, dto.icon_key ?? null])).rows[0];
      await this.audit(adminId, 'category.create', 'categories', row.id, null, row);
      return row;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw Errors.conflict('CATEGORY_SLUG_EXISTS', `A category with slug '${dto.slug}' already exists`);
      throw e;
    }
  }

  async updateCategory(adminId: string, categoryId: string, dto: { name_en?: string; name_ur?: string; name_roman?: string; is_active?: boolean; sort_order?: number }) {
    const before = (await this.db.query(`SELECT * FROM categories WHERE id=$1`, [categoryId])).rows[0];
    if (!before) throw Errors.notFound('Category');
    const updated = (await this.db.query(
      `UPDATE categories SET name_en=COALESCE($2,name_en), name_ur=COALESCE($3,name_ur), name_roman=COALESCE($4,name_roman),
         is_active=COALESCE($5,is_active), sort_order=COALESCE($6,sort_order) WHERE id=$1 RETURNING *`,
      [categoryId, dto.name_en ?? null, dto.name_ur ?? null, dto.name_roman ?? null, dto.is_active ?? null, dto.sort_order ?? null])).rows[0];
    await this.audit(adminId, 'category.update', 'categories', categoryId, before, updated);
    return updated;
  }

  // ---- Phase 2: dispute centre (admin side) ----

  /** Admin dispute list with evidence + SLA breach flags. A dispute is
   *  breached when it is still open and a deadline has passed. */
  async listDisputes(opts: { status?: string; cursor?: string; limit?: number }) {
    const lim = Math.min(Math.max(opts.limit || 20, 1), 100);
    const rows = (await this.db.query(
      `SELECT d.*, j.state AS job_state,
              (d.status='open' AND d.sla_first_response_at < now()) AS sla_first_response_breached,
              (d.status='open' AND d.sla_resolve_at < now()) AS sla_resolve_breached,
              COALESCE((SELECT json_agg(e ORDER BY e.created_at) FROM dispute_evidence e WHERE e.dispute_id=d.id), '[]'::json) AS evidence
       FROM disputes d JOIN jobs j ON j.id=d.job_id
       WHERE ($1::varchar IS NULL OR d.status=$1::varchar)
         AND ($2::text IS NULL OR (d.created_at, d.id) < (SELECT created_at, id FROM disputes WHERE id=$2::uuid))
       ORDER BY d.created_at DESC, d.id DESC LIMIT $3`,
      [opts.status ?? null, opts.cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return { items: page, next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }

  /** Open disputes whose first-response (4h) or resolve (48h) SLA has passed.
   *  Small list: returned as a Page envelope with next_cursor null, plus a
   *  count (v1.3 SlaBreachesResponse). */
  async slaBreaches() {
    const rows = (await this.db.query(
      `SELECT d.*, j.state AS job_state,
              (d.sla_first_response_at < now()) AS first_response_breached,
              (d.sla_resolve_at < now()) AS resolve_breached
       FROM disputes d JOIN jobs j ON j.id=d.job_id
       WHERE d.status='open' AND (d.sla_first_response_at < now() OR d.sla_resolve_at < now())
       ORDER BY d.sla_resolve_at ASC`)).rows;
    return { items: rows, next_cursor: null, count: rows.length };
  }

  async assignDispute(adminId: string, disputeId: string, assignedTo: string) {
    const before = (await this.db.query(`SELECT * FROM disputes WHERE id=$1`, [disputeId])).rows[0];
    if (!before) throw Errors.notFound('Dispute');
    const assignee = (await this.db.query(`SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL`, [assignedTo])).rows[0];
    if (!assignee) throw Errors.notFound('Assignee user');
    const updated = (await this.db.query(
      `UPDATE disputes SET assigned_to=$2, updated_at=now() WHERE id=$1 RETURNING *`, [disputeId, assignedTo])).rows[0];
    await this.audit(adminId, 'dispute.assign', 'disputes', disputeId, before, updated);
    return updated;
  }

  /** Resolve a dispute with ledger-backed money movement. All money + state
   *  changes run in ONE transaction; the audit row is written inside it too.
   *  - refund: customer wallet credited the full final price (D refund_expense
   *    / C wallet); provider wallet debited the same amount IF the job was
   *    already settled; job -> REFUNDED.
   *  - partial_refund: same legs for amount_pkr; job -> PAYMENT_SETTLED,
   *    unless the amount equals the full price (then REFUNDED).
   *  - compensation: platform credit to the customer wallet
   *    (D compensation_expense / C wallet); job -> PAYMENT_SETTLED.
   *  - no_action: no money moves; job returns to its pre-dispute state via
   *    the legal DISPUTED exit (see restoreStateFor).
   *  Cash jobs: the platform never held the cash, so a refund is a wallet
   *  credit the customer can use on the next job; the provider debit above
   *  is how the platform recovers it when the job was settled. */
  async resolveDispute(adminId: string, disputeId: string, dto: { outcome: DisputeOutcome; amount_pkr?: number; note?: string }) {
    const outcome = dto.outcome;
    if (!['refund', 'partial_refund', 'compensation', 'no_action'].includes(outcome)) {
      throw Errors.unprocessable('INVALID_OUTCOME', "outcome must be 'refund', 'partial_refund', 'compensation' or 'no_action'");
    }
    const row = (await this.db.query(
      `SELECT d.*, j.state AS job_state, j.customer_id, j.final_price, j.agreed_price, j.payment_status,
              p.user_id AS provider_user_id
       FROM disputes d JOIN jobs j ON j.id=d.job_id JOIN provider_profiles p ON p.id=j.provider_id WHERE d.id=$1`,
      [disputeId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) throw Errors.notFound('Dispute');
    if (row.status !== 'open' || row.job_state !== 'DISPUTED') {
      throw Errors.conflict('DISPUTE_NOT_OPEN', 'Only an open dispute on a DISPUTED job can be resolved');
    }
    const finalPrice = Number(row.final_price ?? row.agreed_price);
    let amountPkr = 0;
    let targetState: string;
    let preDisputeState: string | null = null;
    if (outcome === 'refund') {
      if (dto.amount_pkr != null && Number(dto.amount_pkr) !== finalPrice) {
        throw Errors.unprocessable('INVALID_REFUND_AMOUNT', 'A full refund must equal the job final price; use partial_refund for a smaller amount');
      }
      amountPkr = finalPrice;
      targetState = 'REFUNDED';
    } else if (outcome === 'partial_refund') {
      if (dto.amount_pkr == null || !(Number(dto.amount_pkr) > 0) || Number(dto.amount_pkr) > finalPrice) {
        throw Errors.unprocessable('INVALID_REFUND_AMOUNT', 'partial_refund needs amount_pkr with 0 < amount <= final price');
      }
      amountPkr = Number(dto.amount_pkr);
      targetState = amountPkr >= finalPrice ? 'REFUNDED' : 'PAYMENT_SETTLED';
    } else if (outcome === 'compensation') {
      if (dto.amount_pkr == null || !(Number(dto.amount_pkr) > 0)) {
        throw Errors.unprocessable('INVALID_COMPENSATION_AMOUNT', 'compensation needs amount_pkr > 0');
      }
      amountPkr = Number(dto.amount_pkr);
      targetState = 'PAYMENT_SETTLED';
    } else {
      const pre = (await this.db.query(
        `SELECT from_state FROM job_events WHERE job_id=$1 AND to_state='DISPUTED' ORDER BY created_at DESC, id DESC LIMIT 1`,
        [row.job_id])).rows[0] as unknown as { from_state: string } | undefined;
      preDisputeState = pre?.from_state ?? null;
      targetState = restoreStateFor(preDisputeState);
    }
    if (!isLegalTransition('DISPUTED', targetState as never)) {
      throw Errors.conflict('ILLEGAL_TRANSITION', `Cannot move DISPUTED -> ${targetState}`);
    }
    const amountPaisa = pkrToPaisa(amountPkr);
    const jobId = String(row.job_id);
    const customerId = String(row.customer_id);
    const providerUserId = String(row.provider_user_id);
    const wasSettled = row.payment_status === 'settled';
    const resolvedAt = new Date().toISOString();
    const resolution = { outcome, amount_pkr: amountPkr, note: dto.note ?? null, resolved_by: adminId, resolved_at: resolvedAt, pre_dispute_state: preDisputeState };
    const before = { ...row };
    const txnId = randomUUID();
    await this.db.withTransaction(async (c) => {
      const q = c.query.bind(c);
      const postLegs = async (walletId: string, debitAccount: string, creditAccount: string) => {
        await q(`INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,'D',$4,$5,$6)`,
          [txnId, walletId, debitAccount, amountPaisa, jobId, `Dispute ${outcome} ${disputeId}`]);
        await q(`INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,$3,'C',$4,$5,$6)`,
          [txnId, walletId, creditAccount, amountPaisa, jobId, `Dispute ${outcome} ${disputeId}`]);
      };
      if (amountPaisa > 0 && (outcome === 'refund' || outcome === 'partial_refund')) {
        const customerWallet = await ensureWallet(c as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, customerId);
        await postLegs(customerWallet, 'refund_expense', 'wallet');
        await q(`UPDATE wallet_accounts SET balance_paisa = balance_paisa + $2 WHERE id=$1`, [customerWallet, amountPaisa]);
        // FIX 14(b) (Stage 3): a refund is also a payments row, in the SAME
        // transaction as the ledger legs, so the row and the ledger can
        // never disagree. status 'refunded' (full) / 'partially_refunded'
        // (partial); amount is PKR like every other payments row. The
        // ledger stays the source of truth for balances — this row is the
        // auditable refund record (reconciliation checks amount == ledger).
        await q(
          `INSERT INTO payments (job_id, payer_id, method, provider_name, amount, status) VALUES ($1,$2,'wallet','wallet',$3,$4)`,
          [jobId, customerId, amountPkr, outcome === 'refund' ? 'refunded' : 'partially_refunded'],
        );
        if (wasSettled) {
          const providerWallet = await ensureWallet(c as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, providerUserId);
          await postLegs(providerWallet, 'wallet', 'refund_expense');
          await q(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2 WHERE id=$1`, [providerWallet, amountPaisa]);
        }
      }
      if (amountPaisa > 0 && outcome === 'compensation') {
        const customerWallet = await ensureWallet(c as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, customerId);
        await postLegs(customerWallet, 'compensation_expense', 'wallet');
        await q(`UPDATE wallet_accounts SET balance_paisa = balance_paisa + $2 WHERE id=$1`, [customerWallet, amountPaisa]);
      }
      await q(`UPDATE jobs SET state=$2, updated_at=now() WHERE id=$1`, [jobId, targetState]);
      await q(`INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload) VALUES ($1,'DISPUTED',$2,$3,'admin',$4)`,
        [jobId, targetState, adminId, JSON.stringify({ dispute_id: disputeId, outcome, amount_pkr: amountPkr, pre_dispute_state: preDisputeState })]);
      await q(`UPDATE disputes SET status='resolved', resolution=$2, updated_at=now() WHERE id=$1`,
        [disputeId, JSON.stringify(resolution)]);
      await q(`INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
        [adminId, `dispute.resolve:${outcome}`, 'disputes', disputeId, JSON.stringify(before), JSON.stringify({ ...before, status: 'resolved', resolution })]);
    });
    this.realtime.emitToRoom(`job:${jobId}`, 'job.state_changed', { job_id: jobId, from: 'DISPUTED', to: targetState, actor: adminId, at: resolvedAt });
    const updated = (await this.db.query(`SELECT * FROM disputes WHERE id=$1`, [disputeId])).rows[0];
    return { ...updated, job_state: targetState };
  }
}
