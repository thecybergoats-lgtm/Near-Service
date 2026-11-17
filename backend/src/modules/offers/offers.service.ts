import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { Errors } from '../../common/errors/api-error';
import { AtomicOfferAcceptor, OfferAlreadyClosedError } from './domain/atomic-accept';
import { withIdempotency } from '../../common/utils/idempotency';
import { getCommissionBlockThresholdPaisa, isCommissionBlocked, resolveCommissionRate } from '../../common/utils/commission';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { NotificationsService } from '../notifications/notifications.service';

export function toOffer(row: Record<string, unknown>) {
  return { id: row.id, request_id: row.request_id, provider_id: row.provider_id, offered_by: row.offered_by, round: Number(row.round), price: Number(row.price), eta_minutes: row.eta_minutes ?? null, status: row.status, expires_at: row.expires_at };
}

export function toJob(row: Record<string, unknown>) {
  return { id: row.id, request_id: row.request_id, agreed_price: Number(row.agreed_price), final_price: row.final_price != null ? Number(row.final_price) : null, state: row.state, payment_method: row.payment_method, payment_status: row.payment_status };
}

const MAX_ROUNDS = 3;
const OFFER_TTL_MINUTES = 10;

@Injectable()
export class OffersService {
  private acceptor = new AtomicOfferAcceptor();
  private readonly logger = new Logger(OffersService.name);
  // Phase 3: plan-discounted commission. @Optional so direct construction
  // with (db, redis, realtime) in older tests keeps working; when absent
  // the base engine rate is snapshotted unchanged.
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private realtime: RealtimeService,
    @Optional() @Inject(SubscriptionsService) private subscriptions?: SubscriptionsService,
    // Batch 2 push plumbing: @Optional for the same reason — when absent,
    // offer accept/counter simply sends no push.
    @Optional() @Inject(NotificationsService) private notifications?: NotificationsService,
  ) {}

  /** Batch 2 (§6b): validate an optional pickup-time commitment. Must be
   *  a valid ISO 8601 date-time in the future; a past value is 422. */
  private validateScheduledAt(scheduledAt?: string | null): Date | null {
    if (!scheduledAt) return null;
    const at = new Date(scheduledAt);
    if (Number.isNaN(at.getTime())) throw Errors.unprocessable('INVALID_SCHEDULED_AT', 'scheduled_at must be an ISO 8601 date-time');
    if (at.getTime() <= Date.now()) throw Errors.unprocessable('SCHEDULED_AT_PAST', 'scheduled_at must be in the future');
    return at;
  }

  private async providerIdFor(userId: string): Promise<string> {
    const row = (await this.db.query<{ id: string }>(`SELECT id FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
    if (!row) throw Errors.forbidden('No provider profile for this account');
    return row.id;
  }

  /** Provider accepts at the customer's price or counters (round-aware). */
  async createOffer(requestId: string, providerUserId: string, pricePkr: number, etaMinutes?: number, note?: string, breakdown?: Record<string, unknown>, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'offer', idempotencyKey, async () => this.createOfferInner(requestId, providerUserId, pricePkr, etaMinutes, note, breakdown));
  }
  private async createOfferInner(requestId: string, providerUserId: string, pricePkr: number, etaMinutes?: number, note?: string, breakdown?: Record<string, unknown>) {
    const providerId = await this.providerIdFor(providerUserId);
    // Phase 2 commission block: a provider whose wallet is below the
    // admin-set threshold (default -PKR 5,000) cannot create new offers
    // until they top up.
    const walletRow = (await this.db.query<{ balance_paisa: string }>(
      `SELECT balance_paisa FROM wallet_accounts WHERE user_id=$1`, [providerUserId])).rows[0];
    if (walletRow) {
      const threshold = await getCommissionBlockThresholdPaisa(this.db as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> });
      if (isCommissionBlocked(Number(walletRow.balance_paisa), threshold)) {
        throw Errors.conflict('COMMISSION_BLOCKED', `Your wallet balance is below the allowed limit (PKR ${threshold / 100}). Top up your wallet to create new offers.`);
      }
    }
    const req = (await this.db.query<{ status: string; customer_id: string }>(`SELECT status, customer_id FROM service_requests WHERE id=$1`, [requestId])).rows[0];
    if (!req) throw Errors.notFound('Request');
    if (!['BROADCASTING', 'OFFERS_RECEIVED'].includes(req.status)) throw Errors.conflict('REQUEST_CLOSED', `Request is ${req.status}`);
    const roundRow = (await this.db.query<{ max_round: number }>(`SELECT COALESCE(MAX(round),0) AS max_round FROM offers WHERE request_id=$1 AND provider_id=$2`, [requestId, providerId])).rows[0];
    const round = Number(roundRow.max_round) + 1;
    if (round > MAX_ROUNDS) throw Errors.conflict('ROUNDS_EXCEEDED', `Maximum ${MAX_ROUNDS} negotiation rounds reached`);
    const expiresAt = new Date(Date.now() + OFFER_TTL_MINUTES * 60 * 1000);
    const offer = (await this.db.query(
      `INSERT INTO offers (request_id, provider_id, offered_by, round, price, breakdown, eta_minutes, note, status, expires_at)
       VALUES ($1,$2,'provider',$3,$4,$5,$6,$7,'pending',$8) RETURNING *`,
      [requestId, providerId, round, pricePkr, breakdown ? JSON.stringify(breakdown) : null, etaMinutes ?? null, note ?? null, expiresAt])).rows[0];
    await this.db.query(`UPDATE service_requests SET status='OFFERS_RECEIVED', updated_at=now() WHERE id=$1 AND status='BROADCASTING'`, [requestId]);
    this.realtime.emitToUser(req.customer_id, 'offer.received', { offer, round });
    this.realtime.emitToRoom(`request:${requestId}`, 'offer.received', { offer, round });
    return toOffer(offer);
  }

  /** Customer accepts one offer — ATOMIC (PRD p.7): Redis lock +
   *  DB transaction (SELECT ... FOR UPDATE) + idempotency key. Exactly one
   *  job is created; all other offers close; 409 if already closed.
   *
   *  Batch 2 (§6b): optional scheduled_at commits the provider to a
   *  pickup date/time. It is stored on the linked service_requests row —
   *  the same single source of truth the Phase 2 reschedule flow writes —
   *  and surfaced by GET /jobs/:id and GET /jobs. */
  async acceptOffer(offerId: string, customerId: string, scheduledAt?: string | null, idempotencyKey?: string) {
    const scheduled = this.validateScheduledAt(scheduledAt);
    if (idempotencyKey) {
      const cached = await this.redis.get(`idem:offer-accept:${idempotencyKey}`);
      if (cached) return JSON.parse(cached);
    }
    const lockKey = `lock:offer-accept:${offerId}`;
    const locked = await this.redis.setNx(lockKey, customerId, 15);
    if (!locked) throw Errors.conflict('ACCEPT_IN_PROGRESS', 'Another accept is in progress for this offer');
    try {
      const job = await this.acceptor.accept(offerId,
        async () => {
          const o = (await this.db.query<{ request_id: string; status: string }>(`SELECT request_id, status FROM offers WHERE id=$1`, [offerId])).rows[0];
          if (!o) throw Errors.notFound('Offer');
          const r = (await this.db.query<{ status: string }>(`SELECT status FROM service_requests WHERE id=$1`, [o.request_id])).rows[0];
          const existing = (await this.db.query<{ id: string }>(`SELECT id FROM jobs WHERE offer_id=$1`, [offerId])).rows[0];
          return { requestStatus: r?.status ?? '', offerStatus: o.status, existingJobId: existing?.id ?? null };
        },
        async () => this.db.withTransaction(async (c) => {
          const offer = (await c.query(`SELECT * FROM offers WHERE id=$1 FOR UPDATE`, [offerId])).rows[0];
          const req = (await c.query(`SELECT * FROM service_requests WHERE id=$1 FOR UPDATE`, [offer.request_id])).rows[0];
          if (req.customer_id !== customerId) throw Errors.forbidden('Only the request customer can accept');
          if (req.status === 'ACCEPTED') throw new OfferAlreadyClosedError();
          if (offer.status !== 'pending') throw new OfferAlreadyClosedError();
          // Phase 2 commission engine: most specific matching rule wins
          // (category+city+tier > … > global), else the env default.
          // Service requests carry no city_id, so city scope is unresolved
          // here; category + provider tier are resolved.
          const tierRow = (await c.query<{ tier: number }>(`SELECT tier FROM provider_profiles WHERE id=$1`, [offer.provider_id])).rows[0];
          const baseRate = await resolveCommissionRate(
            c as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
            { categoryId: req.category_id, tier: tierRow?.tier ?? null },
          );
          // Phase 3: the provider's plan multiplier applies on top of the
          // base engine rate (clamped to the 0.05–0.15 band); the
          // EFFECTIVE rate is what gets snapshotted into jobs.commission_rate
          // and what JobsService.confirmPayment later settles on. A lookup
          // failure falls back to the base rate so accepting an offer can
          // never break on the subscription lookup.
          let rate = baseRate;
          try {
            if (this.subscriptions) {
              const userRow = (await c.query<{ user_id: string }>(`SELECT user_id FROM provider_profiles WHERE id=$1`, [offer.provider_id])).rows[0];
              if (userRow?.user_id) rate = await this.subscriptions.effectiveCommissionRate(userRow.user_id, baseRate);
            }
          } catch { rate = baseRate; }
          const job = (await c.query(
            `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price, commission_rate, commission_amount, state, payment_method, payment_status)
             VALUES ($1,$2,$3,$4,$5,$5,$6,$7,'ACCEPTED','cash','unpaid') RETURNING *`,
            [req.id, offer.id, req.customer_id, offer.provider_id, offer.price, rate, Math.round(Number(offer.price) * rate * 100) / 100])).rows[0];
          await c.query(`UPDATE offers SET status='accepted' WHERE id=$1`, [offer.id]);
          await c.query(`UPDATE offers SET status='closed' WHERE request_id=$1 AND id<>$2 AND status='pending'`, [req.id, offer.id]);
          await c.query(`UPDATE service_requests SET status='ACCEPTED', updated_at=now() WHERE id=$1`, [req.id]);
          // Batch 2 (§6b): pickup-time commitment, stored on the request
          // (same column reschedule writes). Validated up-front in
          // acceptOffer, so this write cannot fail the transaction.
          if (scheduled) {
            await c.query(`UPDATE service_requests SET scheduled_at=$2 WHERE id=$1`, [req.id, scheduled.toISOString()]);
          }
          await c.query(`INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role) VALUES ($1,'OFFERS_RECEIVED','ACCEPTED',$2,'customer')`, [job.id, customerId]);
          await c.query(`INSERT INTO chats (job_id, request_id, customer_id, provider_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [job.id, req.id, req.customer_id, offer.provider_id]);
          return job;
        }),
      );
      const result = { ...toJob(job), scheduled_at: scheduled ? scheduled.toISOString() : null };
      if (idempotencyKey) await this.redis.set(`idem:offer-accept:${idempotencyKey}`, JSON.stringify(result), 24 * 3600);
      this.realtime.emitToRoom(`request:${job.request_id}`, 'offer.closed', { request_id: job.request_id, accepted_offer_id: offerId });
      this.realtime.emitToRoom(`job:${job.id}`, 'job.state_changed', { job_id: job.id, from: 'OFFERS_RECEIVED', to: 'ACCEPTED' });
      // Batch 2 push (best-effort): tell the provider their offer was accepted.
      try {
        const providerUser = (await this.db.query<{ user_id: string }>(
          `SELECT user_id FROM provider_profiles WHERE id=$1`, [String(job.provider_id)])).rows[0];
        if (providerUser) await this.notifications?.sendToUser(providerUser.user_id, 'offer.accepted', { job_id: job.id, offer_id: offerId });
      } catch (e) {
        this.logger.warn(`offer-accepted push failed (best-effort) for job ${job.id}: ${(e as Error).message}`);
      }
      return result;
    } catch (e) {
      if (e instanceof OfferAlreadyClosedError) throw Errors.conflict('OFFER_ALREADY_CLOSED', 'This offer was already accepted or closed');
      throw e;
    } finally {
      await this.redis.del(lockKey);
    }
  }

  /** Customer counters back (max 3 rounds). */
  async counterOffer(offerId: string, customerId: string, pricePkr: number, note?: string, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'offer-counter', idempotencyKey, async () => this.counterOfferInner(offerId, customerId, pricePkr, note));
  }
  private async counterOfferInner(offerId: string, customerId: string, pricePkr: number, note?: string) {
    const offer = (await this.db.query(`SELECT * FROM offers WHERE id=$1`, [offerId])).rows[0];
    if (!offer) throw Errors.notFound('Offer');
    const req = (await this.db.query<{ customer_id: string; status: string }>(`SELECT customer_id, status FROM service_requests WHERE id=$1`, [offer.request_id])).rows[0];
    if (req.customer_id !== customerId) throw Errors.forbidden('Only the request customer can counter');
    if (offer.status !== 'pending') throw Errors.conflict('OFFER_CLOSED', 'Offer is no longer open');
    if (Number(offer.round) >= MAX_ROUNDS) throw Errors.conflict('ROUNDS_EXCEEDED', `Maximum ${MAX_ROUNDS} negotiation rounds reached`);
    const counter = (await this.db.query(
      `INSERT INTO offers (request_id, provider_id, offered_by, round, price, note, status, expires_at)
       VALUES ($1,$2,'customer',$3,$4,$5,'pending', now() + interval '${OFFER_TTL_MINUTES} minutes') RETURNING *`,
      [offer.request_id, offer.provider_id, Number(offer.round) + 1, pricePkr, note ?? null])).rows[0];
    await this.db.query(`UPDATE offers SET status='countered' WHERE id=$1`, [offer.id]);
    const providerUser = (await this.db.query<{ user_id: string }>(`SELECT user_id FROM provider_profiles WHERE id=$1`, [offer.provider_id])).rows[0];
    if (providerUser) this.realtime.emitToUser(providerUser.user_id, 'offer.updated', { offer: counter, round: counter.round });
    // Batch 2 push (best-effort): tell the provider about the counter.
    try {
      if (providerUser) await this.notifications?.sendToUser(providerUser.user_id, 'offer.countered', { offer_id: String(counter.id), request_id: String(offer.request_id) });
    } catch (e) {
      this.logger.warn(`offer-countered push failed (best-effort): ${(e as Error).message}`);
    }
    return toOffer(counter);
  }

  async declineOffer(offerId: string, providerUserId: string, reasonCode?: string) {
    const providerId = await this.providerIdFor(providerUserId);
    const row = (await this.db.query(
      `UPDATE offers SET status='rejected' WHERE id=$1 AND provider_id=$2 AND status='pending' RETURNING *`, [offerId, providerId])).rows[0];
    if (!row) throw Errors.conflict('OFFER_CLOSED', 'Offer cannot be declined (already closed or not yours)');
    return { ...toOffer(row), decline_reason: reasonCode ?? null };
  }
}
