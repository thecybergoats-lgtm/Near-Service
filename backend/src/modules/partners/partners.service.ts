// Partner integrations — provider parts ordering + affiliate fees
// (Phase 4, item 5; PRD v1.1: "Partnerships — Parts-supplier affiliate
// ordering (AC parts, hardware) — Phase 4, disclosed in-app").
//
// Money model — all integer paisa, every movement a balanced double-entry
// pair under ONE txn_id, checked at COMMIT by the deferred trigger from
// db/0008 (SUM(D) = SUM(C) per txn_id):
//   CONFIRM: D 'wallet' / C 'affiliate_fee_rev' on the provider wallet
//            (fee = order total x partner rate, default 5%). The wallet
//            may go negative, exactly like commission settlement (PRD p.18).
//   CANCEL after confirm: reversal under a NEW txn_id,
//            D 'affiliate_fee_rev' / C 'wallet', balance credited back.
//   PLACE / DELIVER / CANCEL from placed: no money moves; stock is
//            reserved on place and restored on cancel.
// A fee of 0 paisa writes no ledger entries.
//
// DISCLOSURE: every order view carries a partner_disclosure block, and
// the job's partner-orders view carries the same text for BOTH the
// customer and the provider. No affiliate order is ever silent.
//
// LOCAL CATALOG ONLY: the supplier behind this service is
// LocalPartnerProvider (Postgres catalog, seeded by db/0020). No live
// supplier API key or account exists — see docs/phase4-partners.md.
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { Errors } from '../../common/errors/api-error';
import { paisaToPkr, pkrToPaisa } from '../../common/utils/money';
import { ensureWallet } from '../../common/utils/wallet';
import { withIdempotency } from '../../common/utils/idempotency';
import {
  affiliateFeePaisa,
  isLegalPartnerOrderTransition,
  partnerDisclosureText,
  priceOrderLines,
  validateOrderLines,
  CatalogPrice,
  PartnerOrderStatus,
} from './domain/partner-order-math';
import {
  CatalogItemView,
  CatalogListOpts,
  LocalPartnerProvider,
  PartnerProvider,
} from './partner-provider.interface';
import type {
  AdminOrdersQueryDto,
  AffiliateFeeReportQueryDto,
  CancelPartnerOrderDto,
  CreateCatalogItemDto,
  CreatePartnerDto,
  CreatePartnerOrderDto,
  UpdateCatalogItemDto,
  UpdatePartnerDto,
} from './dto';

export const DEFAULT_AFFILIATE_FEE_RATE = 0.05;

/** Job states in which a provider may order parts for the job. Terminal
 *  states (COMPLETED onwards, cancelled, disputed, refunded) cannot. */
const ORDERABLE_JOB_STATES = [
  'ACCEPTED', 'PROVIDER_EN_ROUTE', 'CUSTOMER_EN_ROUTE', 'ITEM_PICKED_UP',
  'ARRIVED', 'IN_PROGRESS', 'PRICE_ADJUSTMENT_PENDING',
];

type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export interface PartnerDisclosure {
  is_partner_order: boolean;
  partner_name: string;
  partner_slug: string;
  affiliate_fee_paisa: number;
  affiliate_fee_pkr: number;
  text: string;
}

export interface PartnerOrderItemView {
  id: string;
  catalog_item_id: string;
  name: string | null;
  sku: string | null;
  quantity: number;
  unit_price_paisa: number;
  unit_price_pkr: number;
  line_total_paisa: number;
  line_total_pkr: number;
}

export interface PartnerOrderView {
  id: string;
  job_id: string;
  provider_id: string;
  customer_id: string;
  partner_id: string;
  partner_name: string;
  partner_slug: string;
  status: PartnerOrderStatus;
  total_paisa: number;
  total_pkr: number;
  affiliate_fee_paisa: number;
  affiliate_fee_pkr: number;
  affiliate_fee_rate: number;
  fee_txn_id: string | null;
  reversal_txn_id: string | null;
  cancel_reason: string | null;
  placed_at: string;
  confirmed_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  items: PartnerOrderItemView[];
  partner_disclosure: PartnerDisclosure;
}

export interface PartnerView {
  id: string;
  name: string;
  slug: string;
  kind: string;
  contact_name: string | null;
  contact_phone: string | null;
  website: string | null;
  city: string | null;
  affiliate_fee_rate: number;
  is_active: boolean;
  created_at: string;
}

function toPartner(row: Record<string, unknown>): PartnerView {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    kind: String(row.kind),
    contact_name: row.contact_name ? String(row.contact_name) : null,
    contact_phone: row.contact_phone ? String(row.contact_phone) : null,
    website: row.website ? String(row.website) : null,
    city: row.city ? String(row.city) : null,
    affiliate_fee_rate: Number(row.affiliate_fee_rate),
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at),
  };
}

function disclosureFor(partnerName: string, partnerSlug: string, feePaisa: number): PartnerDisclosure {
  return {
    is_partner_order: true,
    partner_name: partnerName,
    partner_slug: partnerSlug,
    affiliate_fee_paisa: feePaisa,
    affiliate_fee_pkr: paisaToPkr(feePaisa),
    text: partnerDisclosureText(partnerName, paisaToPkr(feePaisa)),
  };
}

@Injectable()
export class PartnersService {
  private provider: PartnerProvider;

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private realtime: RealtimeService,
  ) {
    this.provider = new LocalPartnerProvider(db);
  }

  /** Swap-in point: replace the supplier adapter (e.g. a live-supplier
   *  PartnerProvider) without touching the order flow, ledger or
   *  disclosure. See docs/phase4-partners.md. */
  setProvider(provider: PartnerProvider): void {
    this.provider = provider;
  }

  // ---- Catalog (via the PartnerProvider interface) ----------------------
  listCatalogItems(opts: CatalogListOpts): Promise<{ items: CatalogItemView[]; total: number }> {
    return this.provider.listCatalog(opts);
  }

  async getCatalogItem(id: string): Promise<CatalogItemView> {
    const item = await this.provider.getCatalogItem(id);
    if (!item) throw Errors.notFound('Catalog item');
    return item;
  }

  // ---- Orders ------------------------------------------------------------
  private async providerIdFor(userId: string): Promise<string> {
    const row = (await this.db.query<{ id: string }>(
      `SELECT id FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
    if (!row) throw Errors.forbidden('No provider profile for this account');
    return row.id;
  }

  private async loadOrderLines(orderId: string): Promise<PartnerOrderItemView[]> {
    const rows = (await this.db.query(
      `SELECT oi.*, i.name, i.sku FROM partner_order_items oi LEFT JOIN partner_catalog_items i ON i.id=oi.catalog_item_id WHERE oi.order_id=$1 ORDER BY oi.created_at ASC, oi.id ASC`,
      [orderId],
    )).rows;
    return rows.map((r) => ({
      id: String(r.id),
      catalog_item_id: String(r.catalog_item_id),
      name: r.name ? String(r.name) : null,
      sku: r.sku ? String(r.sku) : null,
      quantity: Number(r.quantity),
      unit_price_paisa: Number(r.unit_price_paisa),
      unit_price_pkr: paisaToPkr(Number(r.unit_price_paisa)),
      line_total_paisa: Number(r.line_total_paisa),
      line_total_pkr: paisaToPkr(Number(r.line_total_paisa)),
    }));
  }

  private async toOrderView(row: Record<string, unknown>): Promise<PartnerOrderView> {
    const fee = Number(row.affiliate_fee_paisa);
    const total = Number(row.total_paisa);
    return {
      id: String(row.id),
      job_id: String(row.job_id),
      provider_id: String(row.provider_id),
      customer_id: String(row.customer_id),
      partner_id: String(row.partner_id),
      partner_name: String(row.partner_name ?? ''),
      partner_slug: String(row.partner_slug ?? ''),
      status: String(row.status) as PartnerOrderStatus,
      total_paisa: total,
      total_pkr: paisaToPkr(total),
      affiliate_fee_paisa: fee,
      affiliate_fee_pkr: paisaToPkr(fee),
      affiliate_fee_rate: Number(row.affiliate_fee_rate),
      fee_txn_id: row.fee_txn_id ? String(row.fee_txn_id) : null,
      reversal_txn_id: row.reversal_txn_id ? String(row.reversal_txn_id) : null,
      cancel_reason: row.cancel_reason ? String(row.cancel_reason) : null,
      placed_at: String(row.placed_at ?? row.created_at),
      confirmed_at: row.confirmed_at ? String(row.confirmed_at) : null,
      delivered_at: row.delivered_at ? String(row.delivered_at) : null,
      cancelled_at: row.cancelled_at ? String(row.cancelled_at) : null,
      items: await this.loadOrderLines(String(row.id)),
      partner_disclosure: disclosureFor(String(row.partner_name ?? ''), String(row.partner_slug ?? ''), fee),
    };
  }

  private orderSelect(client: QueryClient, where: string, params: unknown[]) {
    return client.query(
      `SELECT o.*, p.name AS partner_name, p.slug AS partner_slug FROM partner_orders o JOIN partners p ON p.id=o.partner_id ${where}`,
      params,
    );
  }

  async createOrder(providerUserId: string, dto: CreatePartnerOrderDto, idempotencyKey?: string): Promise<PartnerOrderView> {
    return withIdempotency(this.redis, 'partner-order', idempotencyKey, async () =>
      this.db.withTransaction(async (c) => {
        const client = c as unknown as QueryClient;
        const providerId = await this.providerIdFor(providerUserId);
        const job = (await client.query(
          `SELECT j.*, p.user_id AS provider_user_id FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1 FOR UPDATE`,
          [dto.job_id],
        )).rows[0] as unknown as Record<string, unknown> | undefined;
        if (!job) throw Errors.notFound('Job');
        if (String(job.provider_id) !== providerId) throw Errors.forbidden('Only the job provider can order parts for this job');
        if (!ORDERABLE_JOB_STATES.includes(String(job.state))) {
          throw Errors.conflict('JOB_NOT_ORDERABLE', `Parts cannot be ordered while the job is ${job.state}`);
        }
        // Lock + price every line from the catalog (server-side pricing).
        const prices = new Map<string, CatalogPrice>();
        for (const line of dto.items) {
          const item = (await client.query(
            `SELECT id, partner_id, unit_price_paisa, stock_qty, is_active FROM partner_catalog_items WHERE id=$1 FOR UPDATE`,
            [line.catalog_item_id],
          )).rows[0] as unknown as Record<string, unknown> | undefined;
          if (!item) throw Errors.notFound('Catalog item');
          prices.set(line.catalog_item_id, {
            id: String(item.id),
            partner_id: String(item.partner_id),
            unit_price_paisa: Number(item.unit_price_paisa),
            stock_qty: Number(item.stock_qty),
            is_active: Boolean(item.is_active),
          });
        }
        const validationError = validateOrderLines(dto.items, prices, dto.total_pkr);
        if (validationError) {
          if (validationError === 'INSUFFICIENT_STOCK') throw Errors.conflict('INSUFFICIENT_STOCK', 'Not enough stock for one of the items');
          if (validationError === 'ITEM_NOT_FOUND') throw Errors.notFound('Catalog item');
          throw Errors.unprocessable(validationError, 'Order lines failed validation against the catalog');
        }
        const { priced, total_paisa } = priceOrderLines(dto.items, prices);
        const partnerId = priced[0].partner_id;
        const partner = (await client.query(`SELECT * FROM partners WHERE id=$1 FOR UPDATE`, [partnerId])).rows[0] as unknown as Record<string, unknown> | undefined;
        if (!partner) throw Errors.notFound('Partner');
        if (!partner.is_active) throw Errors.conflict('PARTNER_INACTIVE', 'This partner is not active');
        const rate = Number(partner.affiliate_fee_rate);
        const fee = affiliateFeePaisa(total_paisa, rate);
        const row = (await client.query(
          `INSERT INTO partner_orders (job_id, provider_id, customer_id, partner_id, status, total_paisa, affiliate_fee_paisa, affiliate_fee_rate)
           VALUES ($1,$2,$3,$4,'placed',$5,$6,$7) RETURNING *`,
          [dto.job_id, providerId, String(job.customer_id), partnerId, total_paisa, fee, rate],
        )).rows[0];
        for (const line of priced) {
          await client.query(
            `INSERT INTO partner_order_items (order_id, catalog_item_id, quantity, unit_price_paisa, line_total_paisa) VALUES ($1,$2,$3,$4,$5)`,
            [row.id, line.catalog_item_id, line.quantity, line.unit_price_paisa, line.line_total_paisa],
          );
          await this.provider.reserveStock(client, line.catalog_item_id, line.quantity);
        }
        const view = await this.toOrderViewInTxn(client, row);
        this.realtime.emitToRoom(`job:${dto.job_id}`, 'partner_order.placed', { order_id: view.id, job_id: dto.job_id, status: 'placed', total_paisa, affiliate_fee_paisa: fee });
        return view;
      }));
  }

  /** Order view built inside a transaction (lines read from the txn client). */
  private async toOrderViewInTxn(client: QueryClient, row: Record<string, unknown>): Promise<PartnerOrderView> {
    const partner = (await client.query(`SELECT name, slug FROM partners WHERE id=$1`, [String(row.partner_id)])).rows[0] as unknown as Record<string, unknown> | undefined;
    const lines = (await client.query(
      `SELECT oi.*, i.name, i.sku FROM partner_order_items oi LEFT JOIN partner_catalog_items i ON i.id=oi.catalog_item_id WHERE oi.order_id=$1 ORDER BY oi.created_at ASC, oi.id ASC`,
      [String(row.id)],
    )).rows;
    const fee = Number(row.affiliate_fee_paisa);
    const total = Number(row.total_paisa);
    return {
      id: String(row.id),
      job_id: String(row.job_id),
      provider_id: String(row.provider_id),
      customer_id: String(row.customer_id),
      partner_id: String(row.partner_id),
      partner_name: String(partner?.name ?? ''),
      partner_slug: String(partner?.slug ?? ''),
      status: String(row.status) as PartnerOrderStatus,
      total_paisa: total,
      total_pkr: paisaToPkr(total),
      affiliate_fee_paisa: fee,
      affiliate_fee_pkr: paisaToPkr(fee),
      affiliate_fee_rate: Number(row.affiliate_fee_rate),
      fee_txn_id: row.fee_txn_id ? String(row.fee_txn_id) : null,
      reversal_txn_id: row.reversal_txn_id ? String(row.reversal_txn_id) : null,
      cancel_reason: row.cancel_reason ? String(row.cancel_reason) : null,
      placed_at: String(row.placed_at ?? row.created_at),
      confirmed_at: row.confirmed_at ? String(row.confirmed_at) : null,
      delivered_at: row.delivered_at ? String(row.delivered_at) : null,
      cancelled_at: row.cancelled_at ? String(row.cancelled_at) : null,
      items: lines.map((r) => ({
        id: String(r.id),
        catalog_item_id: String(r.catalog_item_id),
        name: r.name ? String(r.name) : null,
        sku: r.sku ? String(r.sku) : null,
        quantity: Number(r.quantity),
        unit_price_paisa: Number(r.unit_price_paisa),
        unit_price_pkr: paisaToPkr(Number(r.unit_price_paisa)),
        line_total_paisa: Number(r.line_total_paisa),
        line_total_pkr: paisaToPkr(Number(r.line_total_paisa)),
      })),
      partner_disclosure: disclosureFor(String(partner?.name ?? ''), String(partner?.slug ?? ''), fee),
    };
  }

  async getOrder(orderId: string, userId: string): Promise<PartnerOrderView> {
    const row = (await this.orderSelect(this.db as unknown as QueryClient, `WHERE o.id=$1`, [orderId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) throw Errors.notFound('Partner order');
    const providerUser = (await this.db.query(
      `SELECT user_id FROM provider_profiles WHERE id=$1`, [String(row.provider_id)])).rows[0] as unknown as { user_id: string } | undefined;
    if (row.customer_id !== userId && providerUser?.user_id !== userId) throw Errors.forbidden('Not a party to this order');
    return this.toOrderView(row);
  }

  async listMyOrders(providerUserId: string, limit = 20): Promise<PartnerOrderView[]> {
    const providerId = await this.providerIdFor(providerUserId);
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = (await this.orderSelect(this.db as unknown as QueryClient,
      `WHERE o.provider_id=$1 ORDER BY o.created_at DESC LIMIT $2`, [providerId, lim])).rows;
    return Promise.all(rows.map((r) => this.toOrderView(r as Record<string, unknown>)));
  }

  /** Job partner-orders view — the disclosure surface for BOTH parties.
   *  Customer and provider of the job see the same orders and the same
   *  disclosure text. Anyone else gets 403. */
  async getJobPartnerOrders(jobId: string, userId: string): Promise<{ job_id: string; disclosure_text: string | null; orders: PartnerOrderView[] }> {
    const job = (await this.db.query(
      `SELECT j.customer_id, p.user_id AS provider_user_id FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1`,
      [jobId],
    )).rows[0] as unknown as { customer_id: string; provider_user_id: string } | undefined;
    if (!job) throw Errors.notFound('Job');
    if (job.customer_id !== userId && job.provider_user_id !== userId) throw Errors.forbidden('Not a party to this job');
    const rows = (await this.orderSelect(this.db as unknown as QueryClient,
      `WHERE o.job_id=$1 ORDER BY o.created_at ASC`, [jobId])).rows;
    const orders = await Promise.all(rows.map((r) => this.toOrderView(r as Record<string, unknown>)));
    const disclosureText = orders.length
      ? orders.map((o) => o.partner_disclosure.text).join(' ')
      : null;
    return { job_id: jobId, disclosure_text: disclosureText, orders };
  }

  // ---- Order state transitions -------------------------------------------
  async confirmOrder(orderId: string, userId: string, asAdmin = false, idempotencyKey?: string): Promise<PartnerOrderView> {
    return withIdempotency(this.redis, `partner-order-confirm:${orderId}`, idempotencyKey, async () =>
      this.transitionOrder(orderId, userId, 'confirmed', asAdmin, null));
  }

  async deliverOrder(orderId: string, userId: string, asAdmin = false, idempotencyKey?: string): Promise<PartnerOrderView> {
    return withIdempotency(this.redis, `partner-order-deliver:${orderId}`, idempotencyKey, async () =>
      this.transitionOrder(orderId, userId, 'delivered', asAdmin, null));
  }

  async cancelOrder(orderId: string, userId: string, dto: CancelPartnerOrderDto = {}, asAdmin = false, idempotencyKey?: string): Promise<PartnerOrderView> {
    return withIdempotency(this.redis, `partner-order-cancel:${orderId}`, idempotencyKey, async () =>
      this.transitionOrder(orderId, userId, 'cancelled', asAdmin, dto.reason ?? null));
  }

  private async transitionOrder(orderId: string, userId: string, to: PartnerOrderStatus, asAdmin: boolean, reason: string | null): Promise<PartnerOrderView> {
    const updated = await this.db.withTransaction(async (c) => {
      const client = c as unknown as QueryClient;
      const row = (await client.query(
        `SELECT o.*, p.name AS partner_name, p.slug AS partner_slug FROM partner_orders o JOIN partners p ON p.id=o.partner_id WHERE o.id=$1 FOR UPDATE`,
        [orderId],
      )).rows[0] as unknown as Record<string, unknown> | undefined;
      if (!row) throw Errors.notFound('Partner order');
      if (!asAdmin) {
        const providerUser = (await client.query(
          `SELECT user_id FROM provider_profiles WHERE id=$1`, [String(row.provider_id)])).rows[0] as unknown as { user_id: string } | undefined;
        if (providerUser?.user_id !== userId) throw Errors.forbidden('Only the ordering provider can change this order');
      }
      const from = String(row.status) as PartnerOrderStatus;
      if (!isLegalPartnerOrderTransition(from, to)) {
        throw Errors.conflict('ILLEGAL_PARTNER_ORDER_TRANSITION', `Illegal partner order transition ${from} -> ${to}`);
      }
      const fee = Number(row.affiliate_fee_paisa);
      let feeTxnId: string | null = row.fee_txn_id ? String(row.fee_txn_id) : null;
      let reversalTxnId: string | null = null;
      if (to === 'confirmed' && fee > 0) {
        // Balanced pair on the provider wallet: D wallet / C affiliate_fee_rev.
        const providerUser = (await client.query(
          `SELECT user_id FROM provider_profiles WHERE id=$1`, [String(row.provider_id)])).rows[0] as unknown as { user_id: string } | undefined;
        const walletId = await ensureWallet(client, String(providerUser?.user_id));
        const txnId = randomUUID();
        await client.query(
          `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,'wallet','D',$3,$4,$5)`,
          [txnId, walletId, fee, String(row.job_id), `Affiliate fee for partner order ${orderId}`],
        );
        await client.query(
          `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,'affiliate_fee_rev','C',$3,$4,$5)`,
          [txnId, walletId, fee, String(row.job_id), `Affiliate fee revenue for partner order ${orderId}`],
        );
        await client.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2 WHERE id=$1`, [walletId, fee]);
        feeTxnId = txnId;
      }
      if (to === 'cancelled') {
        // Restore reserved stock for every line.
        const lines = (await client.query(
          `SELECT catalog_item_id, quantity FROM partner_order_items WHERE order_id=$1`, [orderId])).rows;
        for (const line of lines) {
          await this.provider.releaseStock(client, String(line.catalog_item_id), Number(line.quantity));
        }
        if (from === 'confirmed' && fee > 0 && feeTxnId) {
          // Reverse the fee under a NEW txn_id: D affiliate_fee_rev / C wallet.
          const providerUser = (await client.query(
            `SELECT user_id FROM provider_profiles WHERE id=$1`, [String(row.provider_id)])).rows[0] as unknown as { user_id: string } | undefined;
          const walletId = await ensureWallet(client, String(providerUser?.user_id));
          const txnId = randomUUID();
          await client.query(
            `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,'affiliate_fee_rev','D',$3,$4,$5)`,
            [txnId, walletId, fee, String(row.job_id), `Affiliate fee reversal for partner order ${orderId}`],
          );
          await client.query(
            `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo) VALUES ($1,$2,'wallet','C',$3,$4,$5)`,
            [txnId, walletId, fee, String(row.job_id), `Affiliate fee refund for partner order ${orderId}`],
          );
          await client.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa + $2 WHERE id=$1`, [walletId, fee]);
          reversalTxnId = txnId;
        }
      }
      const stampCol = to === 'confirmed' ? 'confirmed_at' : to === 'delivered' ? 'delivered_at' : 'cancelled_at';
      const updatedRow = (await client.query(
        `UPDATE partner_orders SET status=$2::varchar, ${stampCol}=now(), fee_txn_id=COALESCE($3, fee_txn_id), reversal_txn_id=$4, cancel_reason=$5, updated_at=now() WHERE id=$1 RETURNING *`,
        [orderId, to, feeTxnId, reversalTxnId, reason],
      )).rows[0];
      return { ...updatedRow, partner_name: row.partner_name, partner_slug: row.partner_slug };
    });
    const view = await this.toOrderView(updated as Record<string, unknown>);
    this.realtime.emitToRoom(`job:${view.job_id}`, 'partner_order.status_changed', { order_id: view.id, job_id: view.job_id, status: to });
    return view;
  }

  // ---- Admin: partners ----------------------------------------------------
  private async defaultFeeRate(): Promise<number> {
    const row = (await this.db.query(
      `SELECT config FROM feature_flags WHERE key=$1`, ['partner_affiliate_fee_rate'])).rows[0] as unknown as { config: { value_rate?: number } } | undefined;
    return typeof row?.config?.value_rate === 'number' ? row.config.value_rate : DEFAULT_AFFILIATE_FEE_RATE;
  }

  async listPartners(includeInactive = false): Promise<PartnerView[]> {
    const rows = includeInactive
      ? (await this.db.query(`SELECT * FROM partners ORDER BY name ASC`)).rows
      : (await this.db.query(`SELECT * FROM partners WHERE is_active ORDER BY name ASC`)).rows;
    return rows.map((r) => toPartner(r as Record<string, unknown>));
  }

  async createPartner(dto: CreatePartnerDto): Promise<PartnerView> {
    const rate = dto.affiliate_fee_rate ?? (await this.defaultFeeRate());
    const kind = dto.kind ?? 'parts_supplier';
    if (!['parts_supplier', 'hardware_supplier', 'general_supplier'].includes(kind)) {
      throw Errors.unprocessable('INVALID_PARTNER_KIND', `kind must be one of parts_supplier, hardware_supplier, general_supplier`);
    }
    try {
      const row = (await this.db.query(
        `INSERT INTO partners (name, slug, kind, contact_name, contact_phone, website, city, affiliate_fee_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [dto.name, dto.slug, kind, dto.contact_name ?? null, dto.contact_phone ?? null, dto.website ?? null, dto.city ?? null, rate],
      )).rows[0] as Record<string, unknown> | undefined;
      if (!row) throw Errors.conflict('PARTNER_SLUG_EXISTS', `A partner with slug '${dto.slug}' already exists`);
      return toPartner(row);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw Errors.conflict('PARTNER_SLUG_EXISTS', `A partner with slug '${dto.slug}' already exists`);
      throw e;
    }
  }

  async updatePartner(partnerId: string, dto: UpdatePartnerDto): Promise<PartnerView> {
    const existing = (await this.db.query(`SELECT * FROM partners WHERE id=$1`, [partnerId])).rows[0];
    if (!existing) throw Errors.notFound('Partner');
    if (dto.kind && !['parts_supplier', 'hardware_supplier', 'general_supplier'].includes(dto.kind)) {
      throw Errors.unprocessable('INVALID_PARTNER_KIND', `kind must be one of parts_supplier, hardware_supplier, general_supplier`);
    }
    const row = (await this.db.query(
      `UPDATE partners SET name=COALESCE($2, name), kind=COALESCE($3, kind), contact_name=COALESCE($4, contact_name),
         contact_phone=COALESCE($5, contact_phone), website=COALESCE($6, website), city=COALESCE($7, city),
         affiliate_fee_rate=COALESCE($8, affiliate_fee_rate), is_active=COALESCE($9, is_active), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [partnerId, dto.name ?? null, dto.kind ?? null, dto.contact_name ?? null, dto.contact_phone ?? null,
       dto.website ?? null, dto.city ?? null, dto.affiliate_fee_rate ?? null, dto.is_active ?? null],
    )).rows[0];
    return toPartner(row as Record<string, unknown>);
  }

  // ---- Admin: catalog items ----------------------------------------------
  async createCatalogItem(dto: CreateCatalogItemDto): Promise<CatalogItemView> {
    const partner = (await this.db.query(`SELECT id, is_active FROM partners WHERE id=$1`, [dto.partner_id])).rows[0] as unknown as { id: string; is_active: boolean } | undefined;
    if (!partner) throw Errors.notFound('Partner');
    if (!partner.is_active) throw Errors.conflict('PARTNER_INACTIVE', 'Cannot add items to an inactive partner');
    const category = dto.category ?? 'hardware';
    try {
      const row = (await this.db.query(
        `INSERT INTO partner_catalog_items (partner_id, sku, name, category, description, unit_price_paisa, stock_qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [dto.partner_id, dto.sku, dto.name, category, dto.description ?? null, pkrToPaisa(dto.unit_price_pkr), dto.stock_qty],
      )).rows[0] as Record<string, unknown> | undefined;
      if (!row) throw Errors.conflict('CATALOG_SKU_EXISTS', `A catalog item with sku '${dto.sku}' already exists`);
      return this.getCatalogItem(String(row.id));
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw Errors.conflict('CATALOG_SKU_EXISTS', `A catalog item with sku '${dto.sku}' already exists`);
      throw e;
    }
  }

  async updateCatalogItem(itemId: string, dto: UpdateCatalogItemDto): Promise<CatalogItemView> {
    const existing = (await this.db.query(`SELECT id FROM partner_catalog_items WHERE id=$1`, [itemId])).rows[0];
    if (!existing) throw Errors.notFound('Catalog item');
    await this.db.query(
      `UPDATE partner_catalog_items SET name=COALESCE($2, name), category=COALESCE($3, category),
         description=COALESCE($4, description), unit_price_paisa=COALESCE($5, unit_price_paisa),
         stock_qty=COALESCE($6, stock_qty), is_active=COALESCE($7, is_active), updated_at=now() WHERE id=$1`,
      [itemId, dto.name ?? null, dto.category ?? null, dto.description ?? null,
       dto.unit_price_pkr !== undefined ? pkrToPaisa(dto.unit_price_pkr) : null,
       dto.stock_qty ?? null, dto.is_active ?? null],
    );
    return this.getCatalogItem(itemId);
  }

  // ---- Admin: order oversight + affiliate fee reporting -------------------
  async listAdminOrders(q: AdminOrdersQueryDto): Promise<{ items: PartnerOrderView[]; total: number }> {
    const lim = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) { params.push(q.status); where.push(`o.status=$${params.length}::varchar`); }
    if (q.partner_id) { params.push(q.partner_id); where.push(`o.partner_id=$${params.length}::uuid`); }
    if (q.job_id) { params.push(q.job_id); where.push(`o.job_id=$${params.length}::uuid`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await this.db.query(
      `SELECT COUNT(*)::text AS c FROM partner_orders o ${whereSql}`, params)).rows[0]?.c ?? 0);
    const rows = (await this.orderSelect(this.db as unknown as QueryClient,
      `${whereSql} ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, lim, Number(q.offset ?? 0) || 0])).rows;
    // AdminOrdersQueryDto extends CursorQueryDto (cursor/limit); offset is
    // read from the query object when present (admin UI pages by offset).
    const items = await Promise.all(rows.map((r) => this.toOrderView(r as Record<string, unknown>)));
    return { items, total };
  }

  async getAdminOrder(orderId: string): Promise<PartnerOrderView> {
    const row = (await this.orderSelect(this.db as unknown as QueryClient, `WHERE o.id=$1`, [orderId])).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) throw Errors.notFound('Partner order');
    return this.toOrderView(row);
  }

  async adminTransitionOrder(orderId: string, to: PartnerOrderStatus, adminId: string, reason?: string): Promise<PartnerOrderView> {
    void adminId;
    return this.transitionOrder(orderId, adminId, to, true, reason ?? null);
  }

  /**
   * Affiliate fee report: per-partner earned fees (confirmed + delivered
   * orders only — cancelled orders never earn, and a cancelled-after-
   * confirm order's fee is reversed), plus a ledger cross-check that
   * every fee_txn_id / reversal_txn_id in range is balanced
   * (SUM(D) = SUM(C)) in ledger_entries.
   */
  async affiliateFeeReport(q: AffiliateFeeReportQueryDto): Promise<{
    from: string | null; to: string | null;
    partners: { partner_id: string; partner_name: string; orders_placed: number; orders_confirmed: number; orders_delivered: number; orders_cancelled: number; gross_parts_paisa: number; gross_parts_pkr: number; affiliate_fee_earned_paisa: number; affiliate_fee_earned_pkr: number }[];
    totals: { gross_parts_paisa: number; affiliate_fee_earned_paisa: number; orders: number };
    ledger_check: { txns_checked: number; mismatches: { txn_id: string; diff_paisa: number }[] };
  }> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.from) { params.push(q.from); where.push(`o.created_at >= $${params.length}::timestamptz`); }
    if (q.to) { params.push(q.to); where.push(`o.created_at < $${params.length}::timestamptz`); }
    if (q.partner_id) { params.push(q.partner_id); where.push(`o.partner_id=$${params.length}::uuid`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = (await this.db.query(
      `SELECT o.partner_id, p.name AS partner_name,
              COUNT(*) FILTER (WHERE o.status='placed')::int AS placed,
              COUNT(*) FILTER (WHERE o.status='confirmed')::int AS confirmed,
              COUNT(*) FILTER (WHERE o.status='delivered')::int AS delivered,
              COUNT(*) FILTER (WHERE o.status='cancelled')::int AS cancelled,
              COALESCE(SUM(o.total_paisa) FILTER (WHERE o.status IN ('confirmed','delivered')),0)::bigint AS gross,
              COALESCE(SUM(o.affiliate_fee_paisa) FILTER (WHERE o.status IN ('confirmed','delivered')),0)::bigint AS earned
       FROM partner_orders o JOIN partners p ON p.id=o.partner_id ${whereSql}
       GROUP BY o.partner_id, p.name ORDER BY p.name`,
      params,
    )).rows;
    const partners = rows.map((r) => ({
      partner_id: String(r.partner_id),
      partner_name: String(r.partner_name),
      orders_placed: Number(r.placed),
      orders_confirmed: Number(r.confirmed),
      orders_delivered: Number(r.delivered),
      orders_cancelled: Number(r.cancelled),
      gross_parts_paisa: Number(r.gross),
      gross_parts_pkr: paisaToPkr(Number(r.gross)),
      affiliate_fee_earned_paisa: Number(r.earned),
      affiliate_fee_earned_pkr: paisaToPkr(Number(r.earned)),
    }));
    const totals = {
      gross_parts_paisa: partners.reduce((s, p) => s + p.gross_parts_paisa, 0),
      affiliate_fee_earned_paisa: partners.reduce((s, p) => s + p.affiliate_fee_earned_paisa, 0),
      orders: partners.reduce((s, p) => s + p.orders_placed + p.orders_confirmed + p.orders_delivered + p.orders_cancelled, 0),
    };
    // Ledger cross-check over every fee/reversal txn in range.
    const feeWhere = where.length
      ? `WHERE ${where.join(' AND ')} AND o.fee_txn_id IS NOT NULL`
      : `WHERE o.fee_txn_id IS NOT NULL`;
    const revWhere = where.length
      ? `WHERE ${where.join(' AND ')} AND o.reversal_txn_id IS NOT NULL`
      : `WHERE o.reversal_txn_id IS NOT NULL`;
    // Both branches reuse the same $n placeholders (same filter values),
    // so the param list is passed once.
    const txnRows = (await this.db.query(
      `SELECT fee_txn_id AS txn_id FROM partner_orders o ${feeWhere}
       UNION SELECT reversal_txn_id FROM partner_orders o ${revWhere}`,
      params,
    )).rows;
    const mismatches: { txn_id: string; diff_paisa: number }[] = [];
    for (const t of txnRows) {
      const txnId = String(t.txn_id);
      const sum = (await this.db.query(
        `SELECT COALESCE(SUM(CASE WHEN direction='D' THEN amount_paisa ELSE -amount_paisa END),0)::bigint AS diff FROM ledger_entries WHERE txn_id=$1`,
        [txnId],
      )).rows[0] as unknown as { diff: string };
      if (Number(sum.diff) !== 0) mismatches.push({ txn_id: txnId, diff_paisa: Number(sum.diff) });
    }
    return { from: q.from ?? null, to: q.to ?? null, partners, totals, ledger_check: { txns_checked: txnRows.length, mismatches } };
  }
}
