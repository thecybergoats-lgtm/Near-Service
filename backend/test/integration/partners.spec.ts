// Partner integrations — integration test (REAL Postgres 16 + PostGIS 3 + Redis).
// Run with (own scratch database — never a shared test DB):
//   PGPASSFILE=~/.pgpass DATABASE_URL=postgresql://root@/nearservice_p4_partners?host=/var/run/postgresql \
//   REDIS_URL=redis://localhost:6379 NODE_ENV=test npm test -- partners --runInBand
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0020. Skipped entirely when DATABASE_URL or
// REDIS_URL is not set (same pattern as ledger-balance.spec.ts).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { DatabaseService } from '../../src/database/database.service';
import { RedisService } from '../../src/database/redis.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { PartnersService } from '../../src/modules/partners/partners.service';
import { ApiError } from '../../src/common/errors/api-error';

jest.setTimeout(60000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
const PHONE = (n: string) => `+92301${RUN}${n}`;
// Seeded by 0004_seed.sql.
const CATEGORY_ID = '00000000-0000-4000-8000-0000b0000002'; // AC Repair
const PARTNER_ID = 'a0000000-0000-4000-8000-000000000001'; // Quetta AC Spares (0020)

maybeDescribe('partners end-to-end (real DB + Redis)', () => {
  let dbSvc: DatabaseService;
  let redis: RedisService;
  let svc: PartnersService;
  let admin: Client;
  let customerId: string;
  let otherCustomerId: string;
  let providerUserId: string;
  let otherProviderUserId: string;
  let providerId: string;
  let jobId: string;
  let capId: string;
  let gasId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    const files = fs.readdirSync(dbDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    redis = new RedisService();
    dbSvc = new DatabaseService();
    svc = new PartnersService(dbSvc, redis, new RealtimeService());

    customerId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Parts Customer','ur') RETURNING id`, [PHONE('01')])).rows[0].id;
    otherCustomerId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Other Customer','ur') RETURNING id`, [PHONE('02')])).rows[0].id;
    providerUserId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'AC Technician','ur') RETURNING id`, [PHONE('03')])).rows[0].id;
    otherProviderUserId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Other Technician','ur') RETURNING id`, [PHONE('04')])).rows[0].id;
    for (const uid of [providerUserId, otherProviderUserId]) {
      await admin.query(`INSERT INTO wallet_accounts (user_id) VALUES ($1)`, [uid]);
    }
    providerId = (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, shop_name, base_point, tier, is_online)
       VALUES ($1,'SHOP','AC Technician','AC Tech',ST_SetSRID(ST_MakePoint(66.985,30.195),4326)::geography,2,true) RETURNING id`,
      [providerUserId])).rows[0].id;
    const requestId = (await admin.query(
      `INSERT INTO service_requests (customer_id, category_id, description, fulfillment, location, status)
       VALUES ($1,$2,'AC not cooling','PICKUP_DELIVERY',ST_SetSRID(ST_MakePoint(66.985,30.195),4326)::geography,'ACCEPTED') RETURNING id`,
      [customerId, CATEGORY_ID])).rows[0].id;
    const offerId = (await admin.query(
      `INSERT INTO offers (request_id, provider_id, offered_by, round, price, status, expires_at)
       VALUES ($1,$2,'provider',1,5000,'accepted', now() + interval '1 hour') RETURNING id`,
      [requestId, providerId])).rows[0].id;
    jobId = (await admin.query(
      `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price, commission_rate, state, payment_method, payment_status)
       VALUES ($1,$2,$3,$4,5000,5000,0.1,'IN_PROGRESS','cash','unpaid') RETURNING id`,
      [requestId, offerId, customerId, providerId])).rows[0].id;
    capId = (await admin.query(`SELECT id FROM partner_catalog_items WHERE sku='QAS-CAP-35'`)).rows[0].id;
    gasId = (await admin.query(`SELECT id FROM partner_catalog_items WHERE sku='QAS-GAS-R22'`)).rows[0].id;
  });

  afterAll(async () => {
    await redis.onModuleDestroy();
    await dbSvc.onModuleDestroy();
    await admin.end();
  });

  it('seeds the local catalog: 2 partners, 18 items with real prices', async () => {
    const partners = await admin.query(`SELECT COUNT(*)::int AS c FROM partners`);
    expect(partners.rows[0].c).toBe(2);
    const items = await admin.query(`SELECT COUNT(*)::int AS c FROM partner_catalog_items`);
    expect(items.rows[0].c).toBe(18);
    const cap = await admin.query(`SELECT unit_price_paisa, stock_qty FROM partner_catalog_items WHERE sku='QAS-CAP-35'`);
    expect(Number(cap.rows[0].unit_price_paisa)).toBe(85000); // PKR 850
    expect(Number(cap.rows[0].stock_qty)).toBe(40);
  });

  it('catalog search/list: text search, category filter, in-stock filter', async () => {
    const all = await svc.listCatalogItems({ limit: 50 });
    expect(all.total).toBe(18);
    const caps = await svc.listCatalogItems({ q: 'capacitor' });
    expect(caps.total).toBe(2);
    expect(caps.items.map((i) => i.sku).sort()).toEqual(['QAS-CAP-35', 'QAS-CAP-45']);
    const ac = await svc.listCatalogItems({ category: 'ac_parts', limit: 50 });
    expect(ac.total).toBe(10);
    expect(ac.items.every((i) => i.category === 'ac_parts')).toBe(true);
    const hw = await svc.listCatalogItems({ category: 'hardware', limit: 50 });
    expect(hw.total).toBe(4);
    const none = await svc.listCatalogItems({ q: 'zzz-no-such-part' });
    expect(none.total).toBe(0);
    const inStock = await svc.listCatalogItems({ in_stock_only: true, limit: 50 });
    expect(inStock.total).toBe(18);
    expect(inStock.items.every((i) => i.in_stock)).toBe(true);
  });

  let orderId: string;
  it('places an order priced from the catalog and reserves stock', async () => {
    const order = await svc.createOrder(providerUserId, {
      job_id: jobId,
      items: [
        { catalog_item_id: capId, quantity: 2 },
        { catalog_item_id: gasId, quantity: 1 },
      ],
    } as never);
    orderId = String(order.id);
    expect(order.status).toBe('placed');
    expect(order.total_paisa).toBe(2 * 85000 + 280000);
    expect(order.total_pkr).toBe(4500);
    expect(order.affiliate_fee_paisa).toBe(22500); // 5% of 450000
    expect(order.affiliate_fee_pkr).toBe(225);
    expect(order.partner_name).toBe('Quetta AC Spares');
    expect(order.partner_disclosure.is_partner_order).toBe(true);
    expect(order.partner_disclosure.text).toContain('Quetta AC Spares');
    const stock = await admin.query(`SELECT stock_qty FROM partner_catalog_items WHERE id=$1`, [capId]);
    expect(Number(stock.rows[0].stock_qty)).toBe(38); // 40 - 2 reserved
  });

  it('rejects invalid quantities and prices against the catalog', async () => {
    const badQty = svc.createOrder(providerUserId, {
      job_id: jobId, items: [{ catalog_item_id: capId, quantity: 0 }],
    } as never);
    await expect(badQty).rejects.toMatchObject({ status: 422, code: 'ITEM_INVALID' } as Partial<ApiError>);
    const badPrice = svc.createOrder(providerUserId, {
      job_id: jobId, items: [{ catalog_item_id: capId, quantity: 1, unit_price_pkr: 851 }],
    } as never);
    await expect(badPrice).rejects.toMatchObject({ status: 422, code: 'PRICE_MISMATCH' } as Partial<ApiError>);
    const badTotal = svc.createOrder(providerUserId, {
      job_id: jobId, items: [{ catalog_item_id: capId, quantity: 1 }], total_pkr: 851,
    } as never);
    await expect(badTotal).rejects.toMatchObject({ status: 422, code: 'ORDER_TOTAL_MISMATCH' } as Partial<ApiError>);
    const tooMuch = svc.createOrder(providerUserId, {
      job_id: jobId, items: [{ catalog_item_id: capId, quantity: 100 }],
    } as never);
    await expect(tooMuch).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' } as Partial<ApiError>);
    const wrongProvider = svc.createOrder(otherProviderUserId, {
      job_id: jobId, items: [{ catalog_item_id: capId, quantity: 1 }],
    } as never);
    await expect(wrongProvider).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' } as Partial<ApiError>);
  });

  it('illegal transition deliver-from-placed is rejected', async () => {
    await expect(svc.deliverOrder(orderId, providerUserId))
      .rejects.toMatchObject({ status: 409, code: 'ILLEGAL_PARTNER_ORDER_TRANSITION' } as Partial<ApiError>);
  });

  it('confirm records a balanced affiliate fee in the ledger (0008 trigger holds)', async () => {
    const before = (await admin.query(`SELECT balance_paisa FROM wallet_accounts WHERE user_id=$1`, [providerUserId])).rows[0];
    const confirmed = await svc.confirmOrder(orderId, providerUserId);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.fee_txn_id).toBeTruthy();
    const legs = await admin.query(
      `SELECT account_code, direction, amount_paisa FROM ledger_entries WHERE txn_id=$1 ORDER BY direction`,
      [confirmed.fee_txn_id]);
    expect(legs.rows).toHaveLength(2);
    expect(legs.rows.map((r) => [r.account_code, r.direction, Number(r.amount_paisa)]).sort()).toEqual([
      ['affiliate_fee_rev', 'C', 22500],
      ['wallet', 'D', 22500],
    ]);
    // Explicit balance check (the deferred trigger already enforced it at COMMIT).
    const sums = (await admin.query(
      `SELECT SUM(CASE WHEN direction='D' THEN amount_paisa ELSE -amount_paisa END)::bigint AS diff FROM ledger_entries WHERE txn_id=$1`,
      [confirmed.fee_txn_id])).rows[0];
    expect(Number(sums.diff)).toBe(0);
    const after = (await admin.query(`SELECT balance_paisa FROM wallet_accounts WHERE user_id=$1`, [providerUserId])).rows[0];
    expect(Number(after.balance_paisa)).toBe(Number(before.balance_paisa) - 22500);
  });

  it('job partner-orders view discloses the order to customer AND provider', async () => {
    const asCustomer = await svc.getJobPartnerOrders(jobId, customerId);
    expect(asCustomer.orders).toHaveLength(1);
    expect(asCustomer.disclosure_text).toContain('Quetta AC Spares');
    expect(asCustomer.disclosure_text).toContain('affiliate fee');
    const asProvider = await svc.getJobPartnerOrders(jobId, providerUserId);
    expect(asProvider.disclosure_text).toBe(asCustomer.disclosure_text);
    expect(asProvider.orders[0].partner_disclosure.text).toBe(asCustomer.orders[0].partner_disclosure.text);
    await expect(svc.getJobPartnerOrders(jobId, otherCustomerId))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' } as Partial<ApiError>);
    await expect(svc.getOrder(orderId, otherCustomerId))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' } as Partial<ApiError>);
  });

  it('deliver completes the order; admin fee report sees the earned fee', async () => {
    const delivered = await svc.deliverOrder(orderId, providerUserId);
    expect(delivered.status).toBe('delivered');
    const report = await svc.affiliateFeeReport({});
    expect(report.totals.affiliate_fee_earned_paisa).toBe(22500);
    expect(report.totals.orders).toBe(1);
    expect(report.partners).toHaveLength(1);
    expect(report.partners[0].partner_name).toBe('Quetta AC Spares');
    expect(report.partners[0].orders_delivered).toBe(1);
    expect(report.ledger_check.txns_checked).toBe(1);
    expect(report.ledger_check.mismatches).toEqual([]);
  });

  let cancelOrderId: string;
  it('cancel from confirmed reverses the fee and restores stock', async () => {
    const order = await svc.createOrder(providerUserId, {
      job_id: jobId, items: [{ catalog_item_id: capId, quantity: 1 }],
    } as never);
    cancelOrderId = String(order.id);
    await svc.confirmOrder(cancelOrderId, providerUserId);
    const stockBefore = Number((await admin.query(`SELECT stock_qty FROM partner_catalog_items WHERE id=$1`, [capId])).rows[0].stock_qty);
    const walletBefore = Number((await admin.query(`SELECT balance_paisa FROM wallet_accounts WHERE user_id=$1`, [providerUserId])).rows[0].balance_paisa);
    const cancelled = await svc.cancelOrder(cancelOrderId, providerUserId, { reason: 'supplier out of stock' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.reversal_txn_id).toBeTruthy();
    const legs = await admin.query(
      `SELECT account_code, direction, amount_paisa FROM ledger_entries WHERE txn_id=$1 ORDER BY direction`,
      [cancelled.reversal_txn_id]);
    expect(legs.rows.map((r) => [r.account_code, r.direction, Number(r.amount_paisa)]).sort()).toEqual([
      ['affiliate_fee_rev', 'D', 4250],
      ['wallet', 'C', 4250],
    ]);
    const stockAfter = Number((await admin.query(`SELECT stock_qty FROM partner_catalog_items WHERE id=$1`, [capId])).rows[0].stock_qty);
    expect(stockAfter).toBe(stockBefore + 1);
    const walletAfter = Number((await admin.query(`SELECT balance_paisa FROM wallet_accounts WHERE user_id=$1`, [providerUserId])).rows[0].balance_paisa);
    expect(walletAfter).toBe(walletBefore + 4250);
    // 3 fee/reversal txns so far: order 1 fee, order 2 fee, order 2 reversal.
    const report = await svc.affiliateFeeReport({});
    expect(report.totals.affiliate_fee_earned_paisa).toBe(22500);
    expect(report.ledger_check.txns_checked).toBe(3);
    expect(report.ledger_check.mismatches).toEqual([]);
  });

  it('admin CRUD + scoping: partner, catalog item, order list', async () => {
    const partner = await svc.createPartner({ name: 'Test Spares', slug: 'test-spares', kind: 'parts_supplier', city: 'Quetta' });
    expect(partner.affiliate_fee_rate).toBe(0.05);
    const updated = await svc.updatePartner(partner.id, { affiliate_fee_rate: 0.07 });
    expect(updated.affiliate_fee_rate).toBe(0.07);
    await expect(svc.createPartner({ name: 'Dup', slug: 'test-spares' }))
      .rejects.toMatchObject({ status: 409, code: 'PARTNER_SLUG_EXISTS' } as Partial<ApiError>);
    const item = await svc.createCatalogItem({
      partner_id: partner.id, sku: 'TST-001', name: 'Test Capacitor', category: 'ac_parts',
      unit_price_pkr: 500, stock_qty: 10,
    } as never);
    expect(item.unit_price_pkr).toBe(500);
    const edited = await svc.updateCatalogItem(item.id, { unit_price_pkr: 550, stock_qty: 12 });
    expect(edited.unit_price_pkr).toBe(550);
    expect(edited.stock_qty).toBe(12);
    const list = await svc.listAdminOrders({ partner_id: PARTNER_ID } as never);
    expect(list.total).toBe(2);
    expect(list.items.map((o) => o.status).sort()).toEqual(['cancelled', 'delivered']);
    const one = await svc.getAdminOrder(orderId);
    expect(one.partner_name).toBe('Quetta AC Spares');
    // Admin oversight: admin can confirm an order placed by the provider.
    const order = await svc.createOrder(providerUserId, {
      job_id: jobId, items: [{ catalog_item_id: gasId, quantity: 1 }],
    } as never);
    const adminConfirmed = await svc.adminTransitionOrder(order.id, 'confirmed', 'admin-user');
    expect(adminConfirmed.status).toBe('confirmed');
    await svc.adminTransitionOrder(order.id, 'cancelled', 'admin-user', 'admin cancelled');
    const report = await svc.affiliateFeeReport({ partner_id: PARTNER_ID });
    expect(report.partners).toHaveLength(1);
  });
});
