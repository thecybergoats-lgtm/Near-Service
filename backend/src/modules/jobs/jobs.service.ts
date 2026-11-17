import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { WarrantyService } from '../warranty/warranty.service';
import { Errors } from '../../common/errors/api-error';
import { isLegalTransition, JobState } from '../../common/utils/job-state-machine';
import { commissionPaisa, pkrToPaisa } from '../../common/utils/money';
import { bayesianRating } from '../../common/utils/ranking';
import { ensureWallet } from '../../common/utils/wallet';
import { creditReferrerIfFirstPaidJob } from '../../common/utils/referral';
import { toJob } from '../offers/offers.service';
import { withIdempotency } from '../../common/utils/idempotency';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private realtime: RealtimeService,
    // Phase 4, item 4 (warranty): @Optional so unit tests that construct
    // this service directly with (db, redis, realtime) keep working.
    // When present, the warranty fee is collected at settlement.
    @Optional() @Inject(WarrantyService) private warranty?: WarrantyService,
  ) {}

  private async logEvent(client: { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, jobId: string, from: string | null, to: string, actorId: string, role: string, payload: Record<string, unknown> = {}) {
    await client.query(`INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
      [jobId, from, to, actorId, role, JSON.stringify(payload)]);
  }

  async transition(jobId: string, userId: string, to: JobState, lat?: number, lng?: number) {
    const job = (await this.db.query<{ state: string; customer_id: string; provider_id: string }>(
      `SELECT j.state, j.customer_id, p.user_id AS provider_user_id FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1`, [jobId])).rows[0] as unknown as { state: string; customer_id: string; provider_user_id: string } | undefined;
    if (!job) throw Errors.notFound('Job');
    const from = job.state as JobState;
    const role = userId === job.customer_id ? 'customer' : 'provider';
    if (!isLegalTransition(from, to)) {
      // Illegal transitions are still written to job_events (PRD p.8).
      await this.db.query(`INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
        [jobId, from, to, userId, role, JSON.stringify({ illegal: true })]);
      throw Errors.illegalTransition(from, to);
    }
    // FIX 7 latent bug: the same $2 parameter was used as state=$2 (varchar
    // column) and in CASE WHEN $2='…' (text context) — Postgres refuses to
    // infer one type for both (42P08). Cast every use to varchar.
    const updated = (await this.db.query(
      `UPDATE jobs SET state=$2::varchar, updated_at=now(), started_at=CASE WHEN $2::varchar='IN_PROGRESS' THEN COALESCE(started_at, now()) ELSE started_at END,
        completed_at=CASE WHEN $2::varchar='COMPLETED' THEN now() ELSE completed_at END WHERE id=$1 RETURNING *`, [jobId, to])).rows[0];
    await this.logEvent(this.db as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, jobId, from, to, userId, role, { lat, lng });
    this.realtime.emitToRoom(`job:${jobId}`, 'job.state_changed', { job_id: jobId, from, to, actor: userId, at: new Date().toISOString() });
    return toJob(updated);
  }

  async transitionIdempotent(jobId: string, userId: string, to: JobState, lat: number | undefined, lng: number | undefined, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'job-transition', idempotencyKey, async () => this.transition(jobId, userId, to, lat, lng));
  }

  async createAdjustment(jobId: string, userId: string, items: { label: string; amount: number }[], reason: string, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'job-adjustment', idempotencyKey, async () => this.createAdjustmentInner(jobId, userId, items, reason));
  }
  private async createAdjustmentInner(jobId: string, userId: string, items: { label: string; amount: number }[], reason: string) {
    const job = (await this.db.query<{ state: string }>(`SELECT state FROM jobs WHERE id=$1`, [jobId])).rows[0];
    if (!job) throw Errors.notFound('Job');
    if (job.state !== 'IN_PROGRESS') throw Errors.conflict('NOT_IN_PROGRESS', 'Adjustments are only allowed while IN_PROGRESS');
    const added = items.reduce((s, i) => s + i.amount, 0);
    const adj = (await this.db.query(
      `INSERT INTO job_price_adjustments (job_id, items, reason, added_amount, status) VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
      [jobId, JSON.stringify(items), reason, added])).rows[0];
    await this.transition(jobId, userId, 'PRICE_ADJUSTMENT_PENDING');
    return adj;
  }

  async decideAdjustment(adjustmentId: string, userId: string, approve: boolean) {
    const adj = (await this.db.query<{ job_id: string; status: string; added_amount: string }>(`SELECT * FROM job_price_adjustments WHERE id=$1`, [adjustmentId])).rows[0];
    if (!adj) throw Errors.notFound('Adjustment');
    if (adj.status !== 'pending') throw Errors.conflict('ADJUSTMENT_DECIDED', 'Adjustment already decided');
    const updated = (await this.db.query(
      `UPDATE job_price_adjustments SET status=$2, decided_at=now() WHERE id=$1 RETURNING *`, [adjustmentId, approve ? 'approved' : 'rejected'])).rows[0];
    if (approve) {
      await this.db.query(`UPDATE jobs SET final_price = COALESCE(final_price, agreed_price) + $2 WHERE id=$1`, [adj.job_id, Number(adj.added_amount)]);
    }
    await this.transition(adj.job_id, userId, 'IN_PROGRESS');
    return updated;
  }

  async complete(jobId: string, userId: string) { return this.transition(jobId, userId, 'COMPLETED'); }

  /** Cash confirmation: BOTH sides must confirm. On the second confirmation
   *  the job settles: payment row + double-entry ledger + provider wallet
   *  debited the 10% commission (wallet may go negative — PRD p.18). */
  async confirmPayment(jobId: string, userId: string, idempotencyKey?: string) {
    return withIdempotency(this.redis, `job-pay:${jobId}:${userId}`, idempotencyKey, async () => this.confirmPaymentInner(jobId, userId));
  }
  private async confirmPaymentInner(jobId: string, userId: string) {
    const job = (await this.db.query<{ state: string; customer_id: string; provider_id: string; final_price: string; agreed_price: string; commission_rate: string; commission_amount: string | null }>(
      `SELECT j.*, p.user_id AS provider_user_id FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1`, [jobId])).rows[0] as unknown as Record<string, unknown>;
    if (!job) throw Errors.notFound('Job');
    if (job.state !== 'COMPLETED') throw Errors.conflict('NOT_COMPLETED', 'Payment can only be confirmed after COMPLETED');
    const isCustomer = userId === job.customer_id;
    const isProvider = userId === job.provider_user_id;
    if (!isCustomer && !isProvider) throw Errors.forbidden('Only the job parties can confirm payment');
    const col = isCustomer ? 'customer_payment_confirmed_at' : 'provider_payment_confirmed_at';
    const row = (await this.db.query(
      `UPDATE jobs SET ${col}=now() WHERE id=$1 RETURNING customer_payment_confirmed_at, provider_payment_confirmed_at, final_price, commission_rate`,
      [jobId])).rows[0];
    if (!row.customer_payment_confirmed_at || !row.provider_payment_confirmed_at) {
      const pending = (await this.db.query(`SELECT * FROM jobs WHERE id=$1`, [jobId])).rows[0];
      return { ...toJob(pending), customer_confirmed: !!row.customer_payment_confirmed_at, provider_confirmed: !!row.provider_payment_confirmed_at };
    }
    const finalPaisa = pkrToPaisa(Number(row.final_price));
    const commission = commissionPaisa(finalPaisa, Number(row.commission_rate));
    const txnId = randomUUID();
    await this.db.withTransaction(async (c) => {
      // Single wallet per user (v1.1): get-or-create the provider user's ONE wallet.
      const walletId = await ensureWallet(c as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, String(job.provider_user_id));
      const wallet = { id: walletId };
      await c.query(`INSERT INTO payments (job_id, payer_id, method, provider_name, amount, status) VALUES ($1,$2,'cash','cash',$3,'confirmed')`,
        [jobId, job.customer_id, Number(row.final_price)]);
      // Double-entry, balanced per txn_id: D wallet (commission owed) / C commission_rev.
      await c.query(`INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,'wallet','D',$3,$4,'Cash commission owed')`,
        [txnId, wallet.id, commission, jobId]);
      await c.query(`INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,'commission_rev','C',$3,$4,'Commission revenue')`,
        [txnId, wallet.id, commission, jobId]);
      await c.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2 WHERE id=$1`, [wallet.id, commission]);
      await c.query(`UPDATE jobs SET state='PAYMENT_SETTLED', payment_status='settled', commission_amount=$2, updated_at=now() WHERE id=$1`, [jobId, commission / 100]);
      // Phase 2 referral: credit the referrer PKR 200 when this is the
      // referred customer's FIRST paid job — same transaction, same
      // settlement. (Wallet-paid jobs credit via WalletService instead.)
      await creditReferrerIfFirstPaidJob(c as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, String(job.customer_id), jobId);
    });
    // Phase 4, item 4 (warranty): collect the warranty fee now that the
    // job has settled. collectFeeAtSettlement is a no-op when the job
    // never opted in and never throws (a short customer wallet leaves
    // the warranty pending_payment — the customer can still pay it via
    // POST /jobs/:id/warranty/collect-fee), so settlement can never fail
    // here after committing.
    const warrantyOutcome = await this.warranty?.collectFeeAtSettlement(jobId, String(job.customer_id));
    if (warrantyOutcome && !warrantyOutcome.collected && warrantyOutcome.reason !== 'not_opted_in') {
      this.logger.warn(`warranty fee not collected at cash settlement for job ${jobId}: ${warrantyOutcome.reason}`);
    }
    await this.logEvent(this.db as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, jobId, 'COMPLETED', 'PAYMENT_SETTLED', userId, isCustomer ? 'customer' : 'provider', { method: 'cash', commission_paisa: commission });
    this.realtime.emitToRoom(`job:${jobId}`, 'job.state_changed', { job_id: jobId, from: 'COMPLETED', to: 'PAYMENT_SETTLED' });
    const settled = (await this.db.query(`SELECT * FROM jobs WHERE id=$1`, [jobId])).rows[0];
    return toJob(settled);
  }

  /** Review window (Fix B): admin-configurable via feature_flags key
   *  `review_window_days` (integer days), default 7. Same read pattern as
   *  WarrantyService.getConfig — a bad/missing flag falls back to 7, never
   *  fails the request. */
  static readonly REVIEW_WINDOW_DAYS_DEFAULT = 7;
  async getReviewWindowDays(): Promise<number> {
    try {
      const row = (await this.db.query<{ config: { value_days?: number } }>(
        `SELECT config FROM feature_flags WHERE key='review_window_days'`, [])).rows[0];
      const d = Number(row?.config?.value_days);
      if (Number.isInteger(d) && d >= 1 && d <= 90) return d;
    } catch { /* fall through to the default */ }
    return JobsService.REVIEW_WINDOW_DAYS_DEFAULT;
  }

  /** When the review window for a job started: the latest job_events row
   *  with to_state='PAYMENT_SETTLED' (every settlement path — cash, wallet,
   *  escrow release, dispute resolution — writes that event). Falls back to
   *  the later payment-confirmation timestamp, then updated_at, so a job
   *  settled before this migration (or with a pruned event log) still gets
   *  a sane window start. */
  private async settledAtFor(jobId: string, client?: { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }): Promise<Date | null> {
    const q = client ?? this.db;
    const row = (await q.query(
      `SELECT COALESCE(
         (SELECT MAX(created_at) FROM job_events WHERE job_id=$1 AND to_state='PAYMENT_SETTLED'),
         (SELECT GREATEST(customer_payment_confirmed_at, provider_payment_confirmed_at) FROM jobs WHERE id=$1),
         (SELECT updated_at FROM jobs WHERE id=$1)) AS settled_at`,
      [jobId])).rows[0] as unknown as { settled_at: string | null } | undefined;
    return row?.settled_at ? new Date(row.settled_at) : null;
  }

  private reviewWindowClosed(settledAt: Date | null, windowDays: number, now: Date): boolean {
    if (!settledAt) return false; // no settlement timestamp — do not close on a guess
    return now.getTime() > settledAt.getTime() + windowDays * 86400000;
  }

  /** Move one PAYMENT_SETTLED job to RATED inside the caller's transaction
   *  (or its own, when called standalone). The UPDATE is guarded on the
   *  current state so two concurrent closers cannot double-transition;
   *  returns true only when this call performed the transition. The
   *  job_events row is written through the normal state machine path
   *  (PAYMENT_SETTLED -> RATED is legal), actor 'system' — nobody's
   *  personal action closed the window. */
  private async transitionToRated(
    client: { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    jobId: string, actorId: string | null, actorRole: string, reason: string, windowDays: number,
  ): Promise<boolean> {
    const updated = (await client.query(
      `UPDATE jobs SET state='RATED', updated_at=now() WHERE id=$1 AND state='PAYMENT_SETTLED' RETURNING *`,
      [jobId])).rows[0];
    if (!updated) return false;
    await this.logEvent(client, jobId, 'PAYMENT_SETTLED', 'RATED', actorId as unknown as string, actorRole,
      { reason, review_window_days: windowDays });
    return true;
  }

  /** Close review windows (Fix B): move every PAYMENT_SETTLED job whose
   *  review window has elapsed (settled_at + review_window_days < now) to
   *  RATED. Idempotent — a re-run finds nothing to close. `now` is a
   *  parameter (not read inside) so tests can pass a fake clock; the admin
   *  endpoint always passes the real current time. No in-process scheduler
   *  exists in this repo — an external scheduler must call
   *  POST /admin/jobs/close-review-windows (nightly, same pattern as
   *  POST /admin/recurring-jobs/run-due). */
  async closeReviewWindows(now: Date = new Date()): Promise<{ closed_count: number; closed_job_ids: string[]; review_window_days: number; checked_at: string }> {
    const windowDays = await this.getReviewWindowDays();
    const cutoff = new Date(now.getTime() - windowDays * 86400000);
    const candidates = (await this.db.query<{ id: string }>(
      `SELECT j.id FROM jobs j WHERE j.state='PAYMENT_SETTLED'
         AND COALESCE(
               (SELECT MAX(created_at) FROM job_events WHERE job_id=j.id AND to_state='PAYMENT_SETTLED'),
               GREATEST(j.customer_payment_confirmed_at, j.provider_payment_confirmed_at),
               j.updated_at) < $1`,
      [cutoff.toISOString()])).rows;
    const closed: string[] = [];
    for (const c of candidates) {
      const did = await this.db.withTransaction(async (tx) =>
        this.transitionToRated(tx as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
          String(c.id), null, 'system', 'review_window_closed', windowDays));
      if (did) {
        closed.push(String(c.id));
        this.realtime.emitToRoom(`job:${c.id}`, 'job.state_changed', { job_id: String(c.id), from: 'PAYMENT_SETTLED', to: 'RATED', actor: 'system', at: new Date().toISOString() });
      }
    }
    return { closed_count: closed.length, closed_job_ids: closed, review_window_days: windowDays, checked_at: now.toISOString() };
  }

  /** Reviews (Fix B): only after PAYMENT_SETTLED, one per side (PRD p.17),
   *  only by a job party. The job moves PAYMENT_SETTLED -> RATED when BOTH
   *  sides have now reviewed — checked inside the SAME transaction as the
   *  review insert, through the normal state machine so job_events records
   *  it (actor = the reviewer whose review completed the pair, reason
   *  'both_reviews_submitted'). Until both have reviewed the job stays
   *  PAYMENT_SETTLED. After RATED — or once the review window has elapsed
   *  (the late reviewer finds the job already closed to RATED) — any
   *  further review is 409 REVIEW_WINDOW_CLOSED. */
  async review(jobId: string, reviewerId: string, stars: number, tags?: string[], comment?: string) {
    const job = (await this.db.query<{ state: string; customer_id: string; provider_id: string }>(
      `SELECT j.state, j.customer_id, p.user_id AS provider_user_id FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1`, [jobId])).rows[0] as unknown as { state: string; customer_id: string; provider_user_id: string } | undefined;
    if (!job) throw Errors.notFound('Job');
    if (job.state === 'RATED') throw Errors.conflict('REVIEW_WINDOW_CLOSED', 'The review window for this job has closed — the job is already RATED');
    if (job.state !== 'PAYMENT_SETTLED') throw Errors.conflict('NOT_SETTLED', 'Reviews are only allowed after PAYMENT_SETTLED');
    const isCustomer = reviewerId === job.customer_id;
    const isProvider = reviewerId === job.provider_user_id;
    if (!isCustomer && !isProvider) throw Errors.forbidden('Only the job parties can review');
    const windowDays = await this.getReviewWindowDays();
    const settledAt = await this.settledAtFor(jobId);
    if (this.reviewWindowClosed(settledAt, windowDays, new Date())) {
      // Window elapsed but the nightly sweep has not run yet: close the job
      // now (its own transaction, so the close survives the 409 below) and
      // refuse the review — the window, not the sweep schedule, is the rule.
      await this.db.withTransaction(async (tx) =>
        this.transitionToRated(tx as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
          jobId, null, 'system', 'review_window_closed', windowDays));
      throw Errors.conflict('REVIEW_WINDOW_CLOSED', 'The review window for this job has closed');
    }
    const revieweeId = isCustomer ? job.provider_user_id : job.customer_id;
    const role = isCustomer ? 'customer' : 'provider';
    const out = await this.db.withTransaction(async (c) => {
      const client = c as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
      const review = (await c.query(
        `INSERT INTO reviews (job_id, reviewer_id, reviewee_id, stars, tags, comment) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (job_id, reviewer_id) DO NOTHING RETURNING *`,
        [jobId, reviewerId, revieweeId, stars, tags ?? [], comment ?? null])).rows[0];
      if (!review) throw Errors.conflict('ALREADY_REVIEWED', 'You have already reviewed this job');
      // Recompute the provider's Bayesian rating from all their reviews.
      const agg = (await c.query<{ avg: string; cnt: string }>(
        `SELECT AVG(stars)::text AS avg, COUNT(*)::text AS cnt FROM reviews WHERE reviewee_id=$1 AND NOT is_held`, [job.provider_user_id])).rows[0];
      if (agg && isCustomer) {
        const bayes = bayesianRating(Number(agg.avg), Number(agg.cnt));
        await c.query(`UPDATE provider_profiles SET rating_avg=$2, rating_bayes=$3, jobs_completed=jobs_completed+1 WHERE user_id=$1`,
          [job.provider_user_id, Number(agg.avg), bayes]);
      }
      // Both sides in? Count only party reviews — a non-party row can never
      // be inserted any more, but the filter keeps the rule exact regardless.
      const count = (await c.query<{ n: string }>(
        `SELECT COUNT(DISTINCT reviewer_id)::text AS n FROM reviews WHERE job_id=$1 AND reviewer_id IN ($2,$3)`,
        [jobId, job.customer_id, job.provider_user_id])).rows[0];
      let jobState: JobState = 'PAYMENT_SETTLED';
      if (Number(count?.n) >= 2) {
        const moved = await this.transitionToRated(client, jobId, reviewerId, role, 'both_reviews_submitted', windowDays);
        if (moved) jobState = 'RATED';
      }
      return { review, jobState };
    });
    if (out.jobState === 'RATED') {
      this.realtime.emitToRoom(`job:${jobId}`, 'job.state_changed', { job_id: jobId, from: 'PAYMENT_SETTLED', to: 'RATED', actor: reviewerId, at: new Date().toISOString() });
    }
    return { ...out.review, job_state: out.jobState };
  }
}
