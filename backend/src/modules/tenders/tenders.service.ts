import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { Errors } from '../../common/errors/api-error';
import { withIdempotency } from '../../common/utils/idempotency';
import { ensureWallet } from '../../common/utils/wallet';
import {
  getCommissionBlockThresholdPaisa,
  isCommissionBlocked,
  resolveCommissionRate,
} from '../../common/utils/commission';
import { AtomicOfferAcceptor, OfferAlreadyClosedError } from '../offers/domain/atomic-accept';
import { toJob } from '../offers/offers.service';
import { TENDER_LEAD_FEE_PAISA, validateQuoteItems } from './domain/tender-math';
import type { CreateTenderDto, SubmitQuoteDto } from './dto';

export { TENDER_LEAD_FEE_PAISA };

export type TenderStatus = 'OPEN' | 'QUOTES_RECEIVED' | 'AWARDED' | 'CANCELLED' | 'EXPIRED';
export type TenderQuoteStatus = 'submitted' | 'withdrawn' | 'accepted' | 'rejected' | 'expired';

const OPEN_STATUSES = ['OPEN', 'QUOTES_RECEIVED'];
const ACCEPT_LOCK_TTL_SECONDS = 15;

export function toTender(row: Record<string, unknown>) {
  return {
    id: row.id,
    request_id: row.request_id,
    customer_id: row.customer_id,
    category_id: row.category_id,
    organization_name: row.organization_name,
    organization_type: row.organization_type,
    title: row.title,
    description: row.description ?? null,
    delivery_deadline: row.delivery_deadline,
    status: row.status,
    accepted_quote_id: row.accepted_quote_id ?? null,
    job_id: row.job_id ?? null,
    lead_fee_paisa: Number(row.lead_fee_paisa),
    lead_fee_charged: Boolean(row.lead_fee_charged),
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at ?? null,
  };
}

export function toTenderQuote(row: Record<string, unknown>) {
  const items = typeof row.items === 'string' ? JSON.parse(row.items as string) : row.items;
  return {
    id: row.id,
    tender_id: row.tender_id,
    provider_id: row.provider_id,
    items,
    total_price: Number(row.total_price),
    eta_days: row.eta_days ?? null,
    note: row.note ?? null,
    validity_days: row.validity_days ?? null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toAudit(row: Record<string, unknown>) {
  const details = typeof row.details === 'string' ? JSON.parse(row.details as string) : (row.details ?? {});
  return {
    id: Number(row.id),
    tender_id: row.tender_id,
    quote_id: row.quote_id ?? null,
    actor_user_id: row.actor_user_id ?? null,
    actor_role: row.actor_role ?? null,
    action: row.action,
    details,
    created_at: row.created_at,
  };
}

type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

@Injectable()
export class TendersService {
  /** Shared with the offers flow: serialises concurrent accepts per tender
   *  in-process, on top of the Redis lock + DB transaction, so exactly one
   *  quote is ever accepted and exactly one job is created. */
  private acceptor = new AtomicOfferAcceptor();

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private realtime: RealtimeService,
  ) {}

  private async audit(
    client: QueryClient,
    tenderId: string,
    action: string,
    actorId: string,
    role: string,
    quoteId: string | null = null,
    details: Record<string, unknown> = {},
  ) {
    await client.query(
      `INSERT INTO tender_audit (tender_id, quote_id, actor_user_id, actor_role, action, details)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenderId, quoteId, actorId, role, action, JSON.stringify(details)],
    );
  }

  private async providerIdFor(userId: string): Promise<string> {
    const row = (await this.db.query<{ id: string }>(
      `SELECT id FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
    if (!row) throw Errors.forbidden('No provider profile for this account');
    return row.id;
  }

  private async hasQuoted(tenderId: string, userId: string, providerId?: string): Promise<boolean> {
    const pid = providerId ?? (await this.providerIdFor(userId).catch(() => null));
    if (!pid) return false;
    return (await this.db.query(
      `SELECT 1 FROM tender_quotes WHERE tender_id=$1 AND provider_id=$2 LIMIT 1`, [tenderId, pid])).rows.length > 0;
  }

  private async isProvider(userId: string): Promise<boolean> {
    return (await this.db.query(
      `SELECT 1 FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`, [userId])).rows.length > 0;
  }

  /** A tender is created on top of an existing bulk service_request (the
   *  customer already posted e.g. "bind 500 books" as a request). The
   *  request is flagged is_b2b so the normal broadcast/offer flow knows
   *  this job runs in tender mode. */
  async createTender(customerId: string, dto: CreateTenderDto, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'tender', idempotencyKey, async () => {
      if (Number.isNaN(Date.parse(dto.delivery_deadline)) || new Date(dto.delivery_deadline).getTime() <= Date.now()) {
        throw Errors.unprocessable('DEADLINE_PAST', 'delivery_deadline must be in the future');
      }
      const req = (await this.db.query<{ customer_id: string; category_id: string; status: string }>(
        `SELECT customer_id, category_id, status FROM service_requests WHERE id=$1 AND deleted_at IS NULL`, [dto.request_id])).rows[0];
      if (!req) throw Errors.notFound('Request');
      if (req.customer_id !== customerId) throw Errors.forbidden('Only the request customer can open a tender');
      if (!['BROADCASTING', 'OFFERS_RECEIVED'].includes(req.status)) {
        throw Errors.conflict('TENDER_REQUEST_CLOSED', `Request is ${req.status}`);
      }
      const existing = (await this.db.query(
        `SELECT id FROM tenders WHERE request_id=$1`, [dto.request_id])).rows[0];
      if (existing) throw Errors.conflict('TENDER_EXISTS', 'A tender already exists for this request');
      const row = (await this.db.query(
        `INSERT INTO tenders (request_id, customer_id, category_id, organization_name, organization_type, title, description, delivery_deadline, status, lead_fee_paisa)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9) RETURNING *`,
        [dto.request_id, customerId, req.category_id, dto.organization_name, dto.organization_type,
         dto.title, dto.description ?? null, dto.delivery_deadline, TENDER_LEAD_FEE_PAISA])).rows[0];
      await this.db.query(`UPDATE service_requests SET is_b2b=true, updated_at=now() WHERE id=$1`, [dto.request_id]);
      await this.audit(this.db as unknown as QueryClient, String(row.id), 'TENDER_CREATED', customerId, 'customer', null,
        { request_id: dto.request_id, organization_type: dto.organization_type });
      this.realtime.emitToRoom(`tender:${row.id}`, 'tender.created', { tender_id: row.id });
      return toTender(row as Record<string, unknown>);
    });
  }

  async getTender(id: string, userId: string) {
    const row = (await this.db.query(`SELECT * FROM tenders WHERE id=$1`, [id])).rows[0];
    if (!row) throw Errors.notFound('Tender');
    if (row.customer_id !== userId && !(await this.isProvider(userId))) {
      throw Errors.forbidden('Not your tender');
    }
    const count = (await this.db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tender_quotes WHERE tender_id=$1 AND status='submitted'`, [id])).rows[0];
    return { ...toTender(row as Record<string, unknown>), submitted_quote_count: Number(count?.c ?? 0) };
  }

  async listMyTenders(customerId: string, status?: string, cursor?: string, limit = 20) {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = (await this.db.query(
      `SELECT * FROM tenders WHERE customer_id=$1 AND ($2::text IS NULL OR status=$2::varchar)
         AND ($3::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM tenders WHERE id=$3::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [customerId, status ?? null, cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = (hasMore ? rows.slice(0, lim) : rows).map((r) => toTender(r as Record<string, unknown>));
    return { items: page, next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }

  /** Providers browse tenders that are still open for quotes. */
  async listOpenTenders(cursor?: string, limit = 20) {
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = (await this.db.query(
      `SELECT * FROM tenders WHERE status IN ('OPEN','QUOTES_RECEIVED')
         AND ($1::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM tenders WHERE id=$1::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = (hasMore ? rows.slice(0, lim) : rows).map((r) => toTender(r as Record<string, unknown>));
    return { items: page, next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }

  async submitQuote(tenderId: string, providerUserId: string, dto: SubmitQuoteDto, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'tender-quote', idempotencyKey, async () => {
      const validationError = validateQuoteItems(dto.items, dto.total_price);
      if (validationError) {
        throw Errors.unprocessable(validationError, 'Itemized quote does not add up: check line totals and the total price');
      }
      const providerId = await this.providerIdFor(providerUserId);
      // Same commission-block rule as offers: a provider whose wallet is
      // below the admin-set threshold cannot quote until they top up.
      const walletRow = (await this.db.query<{ balance_paisa: string }>(
        `SELECT balance_paisa FROM wallet_accounts WHERE user_id=$1`, [providerUserId])).rows[0];
      if (walletRow) {
        const threshold = await getCommissionBlockThresholdPaisa(this.db as unknown as QueryClient);
        if (isCommissionBlocked(Number(walletRow.balance_paisa), threshold)) {
          throw Errors.conflict('COMMISSION_BLOCKED', `Your wallet balance is below the allowed limit (PKR ${threshold / 100}). Top up your wallet to submit quotes.`);
        }
      }
      const tender = (await this.db.query(
        `SELECT * FROM tenders WHERE id=$1`, [tenderId])).rows[0] as unknown as Record<string, unknown> | undefined;
      if (!tender) throw Errors.notFound('Tender');
      if (!OPEN_STATUSES.includes(String(tender.status))) {
        throw Errors.conflict('TENDER_CLOSED', `Tender is ${tender.status}`);
      }
      if (new Date(String(tender.delivery_deadline)).getTime() <= Date.now()) {
        await this.expireTenderInternal(String(tenderId), 'system');
        throw Errors.conflict('TENDER_EXPIRED', 'The tender delivery deadline has passed');
      }
      const existing = (await this.db.query(
        `SELECT id FROM tender_quotes WHERE tender_id=$1 AND provider_id=$2 AND status='submitted'`,
        [tenderId, providerId])).rows[0];
      if (existing) throw Errors.conflict('QUOTE_EXISTS', 'You already have a live quote on this tender — withdraw it first to re-quote');
      const row = (await this.db.query(
        `INSERT INTO tender_quotes (tender_id, provider_id, items, total_price, eta_days, note, validity_days, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'submitted') RETURNING *`,
        [tenderId, providerId, JSON.stringify(dto.items), dto.total_price, dto.eta_days ?? null, dto.note ?? null, dto.validity_days ?? null])).rows[0];
      await this.db.query(
        `UPDATE tenders SET status='QUOTES_RECEIVED', updated_at=now() WHERE id=$1 AND status='OPEN'`, [tenderId]);
      await this.audit(this.db as unknown as QueryClient, tenderId, 'QUOTE_SUBMITTED', providerUserId, 'provider',
        String(row.id), { provider_id: providerId, total_price: dto.total_price, item_count: dto.items.length });
      this.realtime.emitToUser(String(tender.customer_id), 'tender.quote_received', { tender_id: tenderId, quote_id: row.id });
      return toTenderQuote(row as Record<string, unknown>);
    });
  }

  async withdrawQuote(quoteId: string, providerUserId: string) {
    const providerId = await this.providerIdFor(providerUserId);
    const quote = (await this.db.query(
      `SELECT * FROM tender_quotes WHERE id=$1`, [quoteId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!quote) throw Errors.notFound('Quote');
    if (quote.provider_id !== providerId) throw Errors.forbidden('Only the quoting provider can withdraw this quote');
    if (quote.status !== 'submitted') throw Errors.conflict('QUOTE_CLOSED', `Quote is ${quote.status}`);
    const row = (await this.db.query(
      `UPDATE tender_quotes SET status='withdrawn', updated_at=now() WHERE id=$1 RETURNING *`, [quoteId])).rows[0];
    await this.audit(this.db as unknown as QueryClient, String(quote.tender_id), 'QUOTE_WITHDRAWN', providerUserId, 'provider', quoteId);
    return toTenderQuote(row as Record<string, unknown>);
  }

  /**
   * Accept one quote — ATOMIC, exactly one winner. Layers (see 0013):
   * Redis lock -> AtomicOfferAcceptor serialiser -> DB transaction with
   * SELECT ... FOR UPDATE on tender + quote -> partial unique index.
   * The win materialises as a NORMAL offer + job (state ACCEPTED) so the
   * job flows through the existing state machine; the flat PKR 500 lead
   * fee is debited from the winner's wallet in the same transaction.
   */
  async acceptQuote(quoteId: string, customerId: string, idempotencyKey?: string) {
    if (idempotencyKey) {
      const cached = await this.redis.get(`idem:tender-accept:${idempotencyKey}`);
      if (cached) return JSON.parse(cached);
    }
    const quoteHead = (await this.db.query<{ tender_id: string }>(
      `SELECT tender_id FROM tender_quotes WHERE id=$1`, [quoteId])).rows[0];
    if (!quoteHead) throw Errors.notFound('Quote');
    const tenderId = quoteHead.tender_id;
    const lockKey = `lock:tender-accept:${tenderId}`;
    const locked = await this.redis.setNx(lockKey, customerId, ACCEPT_LOCK_TTL_SECONDS);
    if (!locked) throw Errors.conflict('ACCEPT_IN_PROGRESS', 'Another accept is in progress for this tender');
    try {
      const result = await this.acceptor.accept(tenderId,
        async () => {
          const q = (await this.db.query<{ status: string }>(
            `SELECT status FROM tender_quotes WHERE id=$1`, [quoteId])).rows[0];
          const t = (await this.db.query<{ status: string; job_id: string | null }>(
            `SELECT status, job_id FROM tenders WHERE id=$1`, [tenderId])).rows[0];
          return {
            requestStatus: t?.job_id || t?.status === 'AWARDED' ? 'ACCEPTED' : (t?.status ?? ''),
            // The acceptor speaks offers: a 'submitted' tender quote is
            // the analogue of a 'pending' offer.
            offerStatus: q?.status === 'submitted' ? 'pending' : (q?.status ?? ''),
            existingJobId: t?.job_id ?? null,
          };
        },
        async () => this.db.withTransaction(async (c) => this.acceptQuoteInner(c, tenderId, quoteId, customerId)),
      );
      if (idempotencyKey) await this.redis.set(`idem:tender-accept:${idempotencyKey}`, JSON.stringify(result), 24 * 3600);
      this.realtime.emitToRoom(`tender:${tenderId}`, 'tender.awarded', { tender_id: tenderId, accepted_quote_id: quoteId, job_id: result.job.id });
      return result;
    } catch (e) {
      if (e instanceof OfferAlreadyClosedError) throw Errors.conflict('QUOTE_ALREADY_CLOSED', 'This quote was already accepted or closed');
      throw e;
    } finally {
      await this.redis.del(lockKey);
    }
  }

  private async acceptQuoteInner(
    c: QueryClient,
    tenderId: string, quoteId: string, customerId: string,
  ) {
    const tender = (await c.query(`SELECT * FROM tenders WHERE id=$1 FOR UPDATE`, [tenderId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!tender) throw Errors.notFound('Tender');
    const quote = (await c.query(`SELECT * FROM tender_quotes WHERE id=$1 FOR UPDATE`, [quoteId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!quote) throw Errors.notFound('Quote');
    if (tender.customer_id !== customerId) throw Errors.forbidden('Only the tender customer can accept a quote');
    if (!OPEN_STATUSES.includes(String(tender.status)) || tender.job_id || tender.accepted_quote_id) {
      throw new OfferAlreadyClosedError();
    }
    if (quote.status !== 'submitted') throw new OfferAlreadyClosedError();
    const req = (await c.query(`SELECT * FROM service_requests WHERE id=$1 FOR UPDATE`, [tender.request_id])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!req) throw Errors.notFound('Request');
    const providerUser = (await c.query(
      `SELECT user_id, tier FROM provider_profiles WHERE id=$1`, [quote.provider_id])).rows[0] as unknown as { user_id: string; tier: number } | undefined;
    if (!providerUser) throw Errors.notFound('Provider');
    // Normal commission engine (most specific rule wins, else default),
    // exactly as offers accept resolves it for a job snapshot.
    const rate = await resolveCommissionRate(c as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, { categoryId: String(tender.category_id), tier: providerUser.tier ?? null });
    const totalPrice = Number(quote.total_price);
    // Materialise the win as a normal offer row (breakdown = itemized
    // quote) so the job, chat and job_events machinery is reused as-is.
    // Round is max+1 for this provider+request: a provider may already
    // hold a normal offer round on the same request (unique constraint).
    const roundRow = (await c.query(
      `SELECT COALESCE(MAX(round),0) AS max_round FROM offers WHERE request_id=$1 AND provider_id=$2`,
      [tender.request_id, quote.provider_id])).rows[0] as unknown as { max_round: number };
    const offer = (await c.query(
      `INSERT INTO offers (request_id, provider_id, offered_by, round, price, breakdown, eta_minutes, note, status, expires_at)
       VALUES ($1,$2,'provider',$3,$4,$5,NULL,'Tender quote — formal itemized quote','accepted', now() + interval '10 minutes') RETURNING *`,
      [tender.request_id, quote.provider_id, Number(roundRow.max_round) + 1, totalPrice,
       JSON.stringify({ tender_id: tenderId, quote_id: quoteId, items: quote.items })])).rows[0];
    const job = (await c.query(
      `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price, commission_rate, commission_amount, state, payment_method, payment_status, tender_id)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,'ACCEPTED','cash','unpaid',$8) RETURNING *`,
      [tender.request_id, offer.id, tender.customer_id, quote.provider_id, totalPrice, rate,
       Math.round(totalPrice * rate * 100) / 100, tenderId])).rows[0];
    await c.query(`UPDATE tender_quotes SET status='accepted', updated_at=now() WHERE id=$1`, [quoteId]);
    await c.query(`UPDATE tender_quotes SET status='rejected', updated_at=now() WHERE tender_id=$1 AND id<>$2 AND status='submitted'`,
      [tenderId, quoteId]);
    await c.query(
      `UPDATE tenders SET status='AWARDED', accepted_quote_id=$2, job_id=$3, closed_at=now(), updated_at=now() WHERE id=$1`,
      [tenderId, quoteId, job.id]);
    await c.query(`UPDATE service_requests SET status='ACCEPTED', updated_at=now() WHERE id=$1`, [tender.request_id]);
    await c.query(
      `INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role) VALUES ($1,'OFFERS_RECEIVED','ACCEPTED',$2,'customer')`,
      [job.id, customerId]);
    await c.query(
      `INSERT INTO chats (job_id, request_id, customer_id, provider_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [job.id, tender.request_id, tender.customer_id, quote.provider_id]);
    // Flat lead fee (PKR 500): balanced double-entry in the same txn.
    // The winner's wallet may go negative, exactly like the cash
    // commission settlement in JobsService (PRD p.18).
    const walletId = await ensureWallet(c, String(providerUser.user_id));
    const txnId = randomUUID();
    await c.query(
      `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,'wallet','D',$3,$4,'Tender lead fee')`,
      [txnId, walletId, TENDER_LEAD_FEE_PAISA, job.id]);
    await c.query(
      `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,'tender_lead_fee_rev','C',$3,$4,'Tender lead fee revenue')`,
      [txnId, walletId, TENDER_LEAD_FEE_PAISA, job.id]);
    await c.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2 WHERE id=$1`, [walletId, TENDER_LEAD_FEE_PAISA]);
    await c.query(`UPDATE tenders SET lead_fee_charged=true WHERE id=$1`, [tenderId]);
    await this.audit(c, tenderId, 'QUOTE_ACCEPTED', customerId, 'customer', quoteId,
      { total_price: totalPrice, job_id: job.id, offer_id: offer.id });
    await this.audit(c, tenderId, 'LEAD_FEE_CHARGED', customerId, 'customer', quoteId,
      { lead_fee_paisa: TENDER_LEAD_FEE_PAISA, txn_id: txnId, provider_user_id: providerUser.user_id });
    await this.audit(c, tenderId, 'JOB_CREATED', customerId, 'customer', quoteId,
      { job_id: job.id, state: 'ACCEPTED' });
    return {
      tender: toTender({ ...(tender as Record<string, unknown>), status: 'AWARDED', accepted_quote_id: quoteId, job_id: job.id, lead_fee_charged: true }),
      quote: toTenderQuote({ ...(quote as Record<string, unknown>), status: 'accepted' }),
      job: toJob(job as Record<string, unknown>),
      lead_fee_paisa: TENDER_LEAD_FEE_PAISA,
      lead_fee_charged: true,
    };
  }

  async cancelTender(tenderId: string, customerId: string, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'tender-cancel', idempotencyKey, async () => {
      const tender = (await this.db.query(`SELECT * FROM tenders WHERE id=$1`, [tenderId])).rows[0] as unknown as Record<string, unknown> | undefined;
      if (!tender) throw Errors.notFound('Tender');
      if (tender.customer_id !== customerId) throw Errors.forbidden('Only the tender customer can cancel it');
      if (!OPEN_STATUSES.includes(String(tender.status))) {
        throw Errors.conflict('TENDER_CLOSED', `Tender is ${tender.status}`);
      }
      const row = (await this.db.query(
        `UPDATE tenders SET status='CANCELLED', closed_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [tenderId])).rows[0];
      await this.db.query(
        `UPDATE tender_quotes SET status='rejected', updated_at=now() WHERE tender_id=$1 AND status='submitted'`, [tenderId]);
      await this.audit(this.db as unknown as QueryClient, tenderId, 'TENDER_CANCELLED', customerId, 'customer');
      return toTender(row as Record<string, unknown>);
    });
  }

  /** Full audit trail, oldest first. Owner or a provider who quoted. */
  async getAuditTrail(tenderId: string, userId: string) {
    const tender = (await this.db.query(`SELECT * FROM tenders WHERE id=$1`, [tenderId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!tender) throw Errors.notFound('Tender');
    if (tender.customer_id !== userId && !(await this.hasQuoted(tenderId, userId))) {
      throw Errors.forbidden('Not your tender');
    }    const rows = (await this.db.query(
      `SELECT * FROM tender_audit WHERE tender_id=$1 ORDER BY created_at ASC, id ASC LIMIT 200`, [tenderId])).rows;
    return { tender_id: tenderId, items: rows.map((r) => toAudit(r as Record<string, unknown>)) };
  }

  /**
   * Quotes on a tender — SEALED BID until award: the owner sees every
   * quote in full; a provider sees only their own quote; after AWARDED
   * every participating provider sees all quotes (transparency).
   */
  async listQuotes(tenderId: string, userId: string) {
    const tender = (await this.db.query(`SELECT * FROM tenders WHERE id=$1`, [tenderId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!tender) throw Errors.notFound('Tender');
    const isOwner = tender.customer_id === userId;
    let providerId: string | null = null;
    if (!isOwner) {
      providerId = await this.providerIdFor(userId).catch(() => null);
      if (!providerId || !(await this.hasQuoted(tenderId, userId, providerId))) {
        throw Errors.forbidden('Not your tender');
      }
    }
    const rows = (await this.db.query(
      `SELECT * FROM tender_quotes WHERE tender_id=$1 ORDER BY created_at ASC, id ASC`, [tenderId])).rows;
    const awarded = tender.status === 'AWARDED';
    const visible = rows.filter((r) => isOwner || awarded || String((r as Record<string, unknown>).provider_id) === providerId);
    return {
      tender_id: tenderId,
      items: visible.map((r) => toTenderQuote(r as Record<string, unknown>)),
      sealed: !awarded,
    };
  }

  /** Mark a tender EXPIRED once its delivery deadline has passed. Wired
   *  by the integrator to a scheduled job; also called lazily when a late
   *  quote is attempted. Returns the tender, or null when not due. */
  async expireTender(tenderId: string, actorId = 'system') {
    const tender = (await this.db.query(`SELECT * FROM tenders WHERE id=$1`, [tenderId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!tender) throw Errors.notFound('Tender');
    if (!OPEN_STATUSES.includes(String(tender.status))) return toTender(tender);
    if (new Date(String(tender.delivery_deadline)).getTime() > Date.now()) return toTender(tender);
    return this.expireTenderInternal(tenderId, actorId);
  }

  /** Sweep: expire EVERY open tender whose delivery deadline has passed.
   *  This is the scheduled-job entry point (the integrator wires it to
   *  POST /api/v1/admin/tenders/expire-due — run hourly by the operator;
   *  there is no in-process scheduler in this repo, by design, so the
   *  sweep is an explicit admin call, not a hidden timer). Idempotent:
   *  tenders already EXPIRED/AWARDED/CANCELLED are untouched, and
   *  expireTender() itself is a no-op for tenders not yet due. */
  async expireDueTenders(actorId = 'system') {
    const due = (await this.db.query<{ id: string }>(
      `SELECT id FROM tenders WHERE status = ANY($1::text[]) AND delivery_deadline <= now() ORDER BY delivery_deadline ASC`,
      [OPEN_STATUSES])).rows;
    const expired: string[] = [];
    for (const row of due) {
      const tender = await this.expireTender(row.id, actorId);
      if (tender.status === 'EXPIRED') expired.push(row.id);
    }
    return { expired_count: expired.length, expired_tender_ids: expired, checked_count: due.length };
  }

  private async expireTenderInternal(tenderId: string, actorId: string) {
    const row = (await this.db.query(
      `UPDATE tenders SET status='EXPIRED', closed_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [tenderId])).rows[0];
    await this.db.query(
      `UPDATE tender_quotes SET status='expired', updated_at=now() WHERE tender_id=$1 AND status='submitted'`, [tenderId]);
    await this.audit(this.db as unknown as QueryClient, tenderId, 'TENDER_EXPIRED', actorId, 'system');
    return toTender(row as Record<string, unknown>);
  }
}
