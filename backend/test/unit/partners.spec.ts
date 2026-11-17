// Partner integrations — unit tests (Phase 4, item 5).
// Service tests run against a scripted MockDb (no live Postgres): every
// SQL fragment the service emits is answered by a handler registered per
// test, so the tests pin the service's actual queries and their order.
// Pure domain checks (state machine, line validation, fee, disclosure)
// need no DB at all. The module itself is booted standalone with Nest's
// Test.createTestingModule({ imports: [PartnersModule] }) — NOT the full
// AppModule — with Database/Redis/Realtime overridden by fakes.
// Run: npm test -- partners --runInBand   (unit file only; integration
// file skips itself when DATABASE_URL/REDIS_URL are unset)
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DatabaseService } from '../../src/database/database.service';
import { DatabaseModule } from '../../src/database/database.module';
import { RedisService } from '../../src/database/redis.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { PartnersModule } from '../../src/modules/partners/partners.module';
import { PartnersService } from '../../src/modules/partners/partners.service';
import { PartnersController } from '../../src/modules/partners/partners.controller';
import {
  affiliateFeePaisa,
  isLegalPartnerOrderTransition,
  partnerDisclosureText,
  priceOrderLines,
  validateOrderLines,
} from '../../src/modules/partners/domain/partner-order-math';
import { CreatePartnerOrderDto } from '../../src/modules/partners/dto';
import { ApiError } from '../../src/common/errors/api-error';

type Row = Record<string, any>;
type Handler = (params: any[]) => Row[] | Row | undefined;

const CUSTOMER = 'c0000001-4000-4000-8000-000000000001';
const OTHER_CUSTOMER = 'c0000002-4000-4000-8000-000000000002';
const PROVIDER_USER = 'c0000011-4000-4000-8000-000000000011';
const OTHER_PROVIDER_USER = 'c0000012-4000-4000-8000-000000000012';
const PROVIDER_ID = '20000000-0011-4000-8000-000000000011';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = 'a0000000-0000-4000-8000-000000000001';
const ITEM_CAP = '30000000-0000-4000-8000-000000000001'; // AC Capacitor 35uF, PKR 850
const ITEM_GAS = '30000000-0000-4000-8000-000000000002'; // AC Gas R22 1kg, PKR 2800
const ITEM_TAPE = '30000000-0000-4000-8000-000000000003'; // PVC Tape, PKR 120
const WALLET_ID = '40000000-0000-4000-8000-000000000001';

const CAP_PRICE = 85000; // paisa
const GAS_PRICE = 280000;
const TAPE_PRICE = 12000;

function itemRow(id: string, over: Partial<Row> = {}): Row {
  const base: Record<string, Row> = {
    [ITEM_CAP]: { id: ITEM_CAP, partner_id: PARTNER_ID, unit_price_paisa: CAP_PRICE, stock_qty: 40, is_active: true },
    [ITEM_GAS]: { id: ITEM_GAS, partner_id: PARTNER_ID, unit_price_paisa: GAS_PRICE, stock_qty: 25, is_active: true },
    [ITEM_TAPE]: { id: ITEM_TAPE, partner_id: PARTNER_ID, unit_price_paisa: TAPE_PRICE, stock_qty: 200, is_active: true },
  };
  return { ...base[id], ...over };
}
function orderRow(over: Partial<Row> = {}): Row {
  return {
    id: ORDER_ID, job_id: JOB_ID, provider_id: PROVIDER_ID, customer_id: CUSTOMER,
    partner_id: PARTNER_ID, partner_name: 'Quetta AC Spares', partner_slug: 'quetta-ac-spares',
    status: 'placed', total_paisa: 2 * CAP_PRICE + GAS_PRICE, affiliate_fee_paisa: 22500,
    affiliate_fee_rate: 0.05, fee_txn_id: null, reversal_txn_id: null, cancel_reason: null,
    placed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    confirmed_at: null, delivered_at: null, cancelled_at: null,
    ...over,
  };
}
function orderLineRows(): Row[] {
  return [
    { id: randomUUID(), order_id: ORDER_ID, catalog_item_id: ITEM_CAP, name: 'AC Capacitor 35uF', sku: 'QAS-CAP-35', quantity: 2, unit_price_paisa: CAP_PRICE, line_total_paisa: 2 * CAP_PRICE, created_at: new Date().toISOString() },
    { id: randomUUID(), order_id: ORDER_ID, catalog_item_id: ITEM_GAS, name: 'AC Gas R22 (1 kg)', sku: 'QAS-GAS-R22', quantity: 1, unit_price_paisa: GAS_PRICE, line_total_paisa: GAS_PRICE, created_at: new Date().toISOString() },
  ];
}

class FakeRedis {
  private mem = new Map<string, string>();
  async get(k: string) { return this.mem.get(k) ?? null; }
  async set(k: string, v: string) { this.mem.set(k, v); }
  async del(k: string) { this.mem.delete(k); }
  async setNx(k: string, v: string) { if (this.mem.has(k)) return false; this.mem.set(k, v); return true; }
}
class FakeRealtime {
  events: { room: string; event: string; payload: unknown }[] = [];
  emitToRoom(room: string, event: string, payload: unknown) { this.events.push({ room, event, payload }); }
  emitToUser() { /* not used by partners */ }
}

class MockDb {
  handlers: { frag: string; fn: Handler }[] = [];
  calls: { text: string; params: unknown[] }[] = [];
  on(frag: string, fn: Handler) { this.handlers.push({ frag, fn }); return this; }
  async query(text: string, params: unknown[] = []) {
    this.calls.push({ text, params });
    for (const h of this.handlers) {
      if (text.includes(h.frag)) {
        const out = h.fn(params as any[]);
        return { rows: Array.isArray(out) ? out : out === undefined ? [] : [out] };
      }
    }
    return { rows: [] };
  }
  async withTransaction<T>(fn: (c: MockDb) => Promise<T>): Promise<T> { return fn(this); }
}

function buildService(db: MockDb) {
  const redis = new FakeRedis();
  const realtime = new FakeRealtime();
  const svc = new PartnersService(db as any, redis as any, realtime as any);
  return { svc, redis, realtime, db };
}

function expectApiError(p: Promise<unknown>, status: number, code: string) {
  return expect(p).rejects.toMatchObject({ status, code } as Partial<ApiError>);
}

describe('partner order domain (pure)', () => {
  it('state machine: placed -> confirmed -> delivered; placed/confirmed -> cancelled; terminal states have no exits', () => {
    expect(isLegalPartnerOrderTransition('placed', 'confirmed')).toBe(true);
    expect(isLegalPartnerOrderTransition('placed', 'delivered')).toBe(false);
    expect(isLegalPartnerOrderTransition('confirmed', 'delivered')).toBe(true);
    expect(isLegalPartnerOrderTransition('confirmed', 'cancelled')).toBe(true);
    expect(isLegalPartnerOrderTransition('placed', 'cancelled')).toBe(true);
    expect(isLegalPartnerOrderTransition('delivered', 'cancelled')).toBe(false);
    expect(isLegalPartnerOrderTransition('cancelled', 'placed')).toBe(false);
    expect(isLegalPartnerOrderTransition('delivered', 'confirmed')).toBe(false);
  });
  it('validates lines against the catalog: prices, totals, stock, single partner', () => {
    const prices = new Map([
      [ITEM_CAP, { id: ITEM_CAP, partner_id: PARTNER_ID, unit_price_paisa: CAP_PRICE, stock_qty: 40, is_active: true }],
      [ITEM_GAS, { id: ITEM_GAS, partner_id: PARTNER_ID, unit_price_paisa: GAS_PRICE, stock_qty: 25, is_active: true }],
    ]);
    const lines = [
      { catalog_item_id: ITEM_CAP, quantity: 2 },
      { catalog_item_id: ITEM_GAS, quantity: 1 },
    ];
    expect(validateOrderLines(lines, prices)).toBeNull();
    expect(validateOrderLines(lines, prices, 4500)).toBeNull();
    expect(priceOrderLines(lines, prices).total_paisa).toBe(2 * CAP_PRICE + GAS_PRICE);
    expect(validateOrderLines([{ catalog_item_id: ITEM_CAP, quantity: 2, unit_price_pkr: 851 }], prices)).toBe('PRICE_MISMATCH');
    expect(validateOrderLines([{ catalog_item_id: ITEM_CAP, quantity: 2, line_total_pkr: 1701 }], prices)).toBe('LINE_TOTAL_MISMATCH');
    expect(validateOrderLines(lines, prices, 4501)).toBe('ORDER_TOTAL_MISMATCH');
    expect(validateOrderLines([{ catalog_item_id: ITEM_CAP, quantity: 41 }], prices)).toBe('INSUFFICIENT_STOCK');
    expect(validateOrderLines([{ catalog_item_id: ITEM_CAP, quantity: 0 }], prices)).toBe('ITEM_INVALID');
    expect(validateOrderLines([], prices)).toBe('EMPTY_ITEMS');
    expect(validateOrderLines([{ catalog_item_id: 'missing', quantity: 1 }], prices)).toBe('ITEM_NOT_FOUND');
    const otherPartner = new Map([
      [ITEM_CAP, { id: ITEM_CAP, partner_id: PARTNER_ID, unit_price_paisa: CAP_PRICE, stock_qty: 40, is_active: true }],
      [ITEM_TAPE, { id: ITEM_TAPE, partner_id: 'a0000000-0000-4000-8000-000000000002', unit_price_paisa: TAPE_PRICE, stock_qty: 200, is_active: true }],
    ]);
    expect(validateOrderLines([
      { catalog_item_id: ITEM_CAP, quantity: 1 },
      { catalog_item_id: ITEM_TAPE, quantity: 1 },
    ], otherPartner)).toBe('MIXED_PARTNERS');
  });
  it('affiliate fee is 5% of the total, rounded half-up', () => {
    expect(affiliateFeePaisa(450000, 0.05)).toBe(22500);
    expect(affiliateFeePaisa(10010, 0.05)).toBe(501); // 500.5 -> 501
    expect(affiliateFeePaisa(0, 0.05)).toBe(0);
  });
  it('disclosure names the partner and the fee, and says the customer does not pay it', () => {
    const text = partnerDisclosureText('Quetta AC Spares', 225);
    expect(text).toContain('Quetta AC Spares');
    expect(text).toContain('225');
    expect(text).toMatch(/affiliate/i);
    expect(text).toMatch(/not to the customer/i);
  });
});

describe('partner DTO validation', () => {
  it('CreatePartnerOrderDto requires a job and at least one line', async () => {
    const bad = plainToInstance(CreatePartnerOrderDto, { items: [] });
    const errs = await validate(bad);
    expect(errs.map((e) => e.property)).toEqual(expect.arrayContaining(['job_id', 'items']));
  });
  it('a well-formed order DTO validates, including the optional price checks', async () => {
    const dto = plainToInstance(CreatePartnerOrderDto, {
      job_id: JOB_ID,
      items: [{ catalog_item_id: ITEM_CAP, quantity: 2, unit_price_pkr: 850 }],
      total_pkr: 1700,
    });
    expect(await validate(dto)).toEqual([]);
  });
});

describe('PartnersModule standalone (Nest Test.createTestingModule)', () => {
  it('compiles the module with fakes and resolves service + controller', async () => {
    const db = new MockDb();
    db.on('SELECT COUNT(*)::text AS c FROM partner_catalog_items', () => [{ c: '2' }]);
    db.on('FROM partner_catalog_items i JOIN partners p', () => [
      { id: ITEM_CAP, partner_id: PARTNER_ID, partner_name: 'Quetta AC Spares', partner_slug: 'quetta-ac-spares', sku: 'QAS-CAP-35', name: 'AC Capacitor 35uF', category: 'ac_parts', description: 'Run capacitor', unit_price_paisa: String(CAP_PRICE), stock_qty: 40, is_active: true },
    ]);
    // DatabaseModule is @Global and exports DatabaseService/RedisService,
    // so the overrides below replace the real ones; PartnersModule itself
    // is still booted standalone, without AppModule.
    const mod = await Test.createTestingModule({ imports: [PartnersModule, DatabaseModule] })
      .overrideProvider(DatabaseService).useValue(db)
      .overrideProvider(RedisService).useValue(new FakeRedis())
      .overrideProvider(RealtimeService).useValue(new FakeRealtime())
      .compile();
    const svc = mod.get(PartnersService);
    const ctl = mod.get(PartnersController);
    expect(svc).toBeDefined();
    expect(ctl).toBeDefined();
    const out = await ctl.catalog({} as never);
    expect(out.total).toBe(2);
    expect(out.items[0].name).toBe('AC Capacitor 35uF');
    expect(out.items[0].unit_price_pkr).toBe(850);
    await mod.close();
  });
});

describe('PartnersService.createOrder', () => {
  const dto = () => plainToInstance(CreatePartnerOrderDto, {
    job_id: JOB_ID,
    items: [
      { catalog_item_id: ITEM_CAP, quantity: 2 },
      { catalog_item_id: ITEM_GAS, quantity: 1 },
    ],
    total_pkr: 4500,
  });

  function baseDb() {
    const db = new MockDb();
    db.on('FROM provider_profiles WHERE user_id=$1', (p) => (p[0] === PROVIDER_USER ? [{ id: PROVIDER_ID }] : []));
    db.on('FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1 FOR UPDATE', () => [
      { id: JOB_ID, customer_id: CUSTOMER, provider_id: PROVIDER_ID, state: 'IN_PROGRESS' },
    ]);
    db.on('FROM partner_catalog_items WHERE id=$1 FOR UPDATE', (p) => [itemRow(String(p[0]))]);
    db.on('SELECT * FROM partners WHERE id=$1 FOR UPDATE', () => [{ id: PARTNER_ID, is_active: true, affiliate_fee_rate: 0.05 }]);
    db.on('INSERT INTO partner_order_items', () => ({ id: randomUUID() }));
    db.on('INSERT INTO partner_orders', () => orderRow());
    db.on('stock_qty = stock_qty - $2', (p) => [{ id: String(p[0]) }]);
    db.on('SELECT name, slug FROM partners WHERE id=$1', () => [{ name: 'Quetta AC Spares', slug: 'quetta-ac-spares' }]);
    db.on('FROM partner_order_items oi LEFT JOIN', () => orderLineRows());
    return db;
  }

  it('places an order priced from the catalog, reserves stock, discloses the partner', async () => {
    const db = baseDb();
    const { svc, realtime } = buildService(db);
    const out = await svc.createOrder(PROVIDER_USER, dto() as any);
    expect(out.status).toBe('placed');
    expect(out.total_paisa).toBe(2 * CAP_PRICE + GAS_PRICE);
    expect(out.total_pkr).toBe(4500);
    expect(out.affiliate_fee_paisa).toBe(22500);
    expect(out.affiliate_fee_pkr).toBe(225);
    expect(out.partner_disclosure.is_partner_order).toBe(true);
    expect(out.partner_disclosure.partner_name).toBe('Quetta AC Spares');
    expect(out.partner_disclosure.text).toContain('Quetta AC Spares');
    expect(out.items).toHaveLength(2);
    // Stock reserved for both lines.
    const reserves = db.calls.filter((c) => c.text.includes('stock_qty = stock_qty - $2'));
    expect(reserves).toHaveLength(2);
    expect(realtime.events.some((e) => e.event === 'partner_order.placed')).toBe(true);
  });
  it('422s on a client price that does not match the catalog', async () => {
    const { svc } = buildService(baseDb());
    const d = dto() as any;
    d.items[0].unit_price_pkr = 851;
    await expectApiError(svc.createOrder(PROVIDER_USER, d), 422, 'PRICE_MISMATCH');
  });
  it('422s on a client total that does not match the catalog-priced lines', async () => {
    const { svc } = buildService(baseDb());
    const d = dto() as any;
    d.total_pkr = 4501;
    await expectApiError(svc.createOrder(PROVIDER_USER, d), 422, 'ORDER_TOTAL_MISMATCH');
  });
  it('422s on quantity 0 and 409s when stock is short', async () => {
    const { svc } = buildService(baseDb());
    const badQty = dto() as any;
    badQty.items[0].quantity = 0;
    await expectApiError(svc.createOrder(PROVIDER_USER, badQty), 422, 'ITEM_INVALID');
    const db2 = baseDb();
    db2.handlers = db2.handlers.filter((h) => !h.frag.includes('FROM partner_catalog_items WHERE id=$1 FOR UPDATE'));
    db2.on('FROM partner_catalog_items WHERE id=$1 FOR UPDATE', (p) => [itemRow(String(p[0]), { stock_qty: 1 })]);
    const { svc: s2 } = buildService(db2);
    await expectApiError(s2.createOrder(PROVIDER_USER, dto() as any), 409, 'INSUFFICIENT_STOCK');
  });
  it('403s for a provider who does not own the job; 409s when the job is completed', async () => {
    const { svc } = buildService(baseDb());
    await expectApiError(svc.createOrder(OTHER_PROVIDER_USER, dto() as any), 403, 'FORBIDDEN');
    const db2 = baseDb();
    db2.handlers = db2.handlers.filter((h) => !h.frag.includes('FROM jobs j JOIN'));
    db2.on('FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1 FOR UPDATE', () => [
      { id: JOB_ID, customer_id: CUSTOMER, provider_id: PROVIDER_ID, state: 'COMPLETED' },
    ]);
    const { svc: s2 } = buildService(db2);
    await expectApiError(s2.createOrder(PROVIDER_USER, dto() as any), 409, 'JOB_NOT_ORDERABLE');
  });
});

describe('PartnersService order transitions + ledger', () => {
  function transitionDb(status = 'placed') {
    const db = new MockDb();
    db.on('FROM partner_orders o JOIN partners p ON p.id=o.partner_id WHERE o.id=$1 FOR UPDATE', () => [orderRow({ status })]);
    db.on('SELECT user_id FROM provider_profiles WHERE id=$1', () => [{ user_id: PROVIDER_USER }]);
    db.on('INSERT INTO wallet_accounts', () => [{ id: WALLET_ID }]);
    db.on('SELECT catalog_item_id, quantity FROM partner_order_items WHERE order_id=$1', () => [
      { catalog_item_id: ITEM_CAP, quantity: 2 },
      { catalog_item_id: ITEM_GAS, quantity: 1 },
    ]);
    db.on('UPDATE partner_orders SET status=', (p) => orderRow({ status: String(p[1]), fee_txn_id: p[2] ?? null, reversal_txn_id: p[3] ?? null }));
    db.on('SELECT o.*, p.name AS partner_name', () => [orderRow({ status })]);
    db.on('FROM partner_order_items oi LEFT JOIN', () => orderLineRows());
    return db;
  }

  it('confirm writes a balanced D wallet / C affiliate_fee_rev pair under one txn and debits the wallet', async () => {
    const db = transitionDb('placed');
    const { svc } = buildService(db);
    const out = await svc.confirmOrder(ORDER_ID, PROVIDER_USER);
    expect(out.status).toBe('confirmed');
    expect(out.fee_txn_id).toBeTruthy();
    const ledger = db.calls.filter((c) => c.text.includes('INSERT INTO ledger_entries'));
    expect(ledger).toHaveLength(2);
    expect(ledger[0].text).toContain(`'wallet','D'`);
    expect(ledger[0].params[2]).toBe(22500);
    expect(ledger[1].text).toContain(`'affiliate_fee_rev','C'`);
    expect(ledger[1].params[2]).toBe(22500);
    expect(ledger[0].params[0]).toBe(ledger[1].params[0]); // same txn_id
    expect(db.calls.some((c) => c.text.includes('balance_paisa = balance_paisa - $2') && c.params[1] === 22500)).toBe(true);
    expect(out.partner_disclosure.text).toContain('Quetta AC Spares');
  });
  it('deliver from placed is illegal (409); cancel from placed restores stock with no ledger', async () => {
    const { svc } = buildService(transitionDb('placed'));
    await expectApiError(svc.deliverOrder(ORDER_ID, PROVIDER_USER), 409, 'ILLEGAL_PARTNER_ORDER_TRANSITION');
    const db2 = transitionDb('placed');
    const { svc: s2 } = buildService(db2);
    const out = await s2.cancelOrder(ORDER_ID, PROVIDER_USER, { reason: 'customer changed mind' });
    expect(out.status).toBe('cancelled');
    expect(db2.calls.filter((c) => c.text.includes('INSERT INTO ledger_entries'))).toHaveLength(0);
    expect(db2.calls.filter((c) => c.text.includes('stock_qty = stock_qty + $2'))).toHaveLength(2);
  });
  it('cancel from confirmed reverses the fee with a balanced pair and credits the wallet', async () => {
    const feeTxn = randomUUID();
    const db = new MockDb();
    // FOR UPDATE handler registered BEFORE the generic order-select
    // fragment (the FOR UPDATE text also contains that fragment).
    db.on('FROM partner_orders o JOIN partners p ON p.id=o.partner_id WHERE o.id=$1 FOR UPDATE', () => [
      orderRow({ status: 'confirmed', fee_txn_id: feeTxn }),
    ]);
    db.on('SELECT user_id FROM provider_profiles WHERE id=$1', () => [{ user_id: PROVIDER_USER }]);
    db.on('INSERT INTO wallet_accounts', () => [{ id: WALLET_ID }]);
    db.on('SELECT catalog_item_id, quantity FROM partner_order_items WHERE order_id=$1', () => [
      { catalog_item_id: ITEM_CAP, quantity: 2 },
      { catalog_item_id: ITEM_GAS, quantity: 1 },
    ]);
    db.on('UPDATE partner_orders SET status=', (p) => orderRow({ status: String(p[1]), fee_txn_id: p[2] ?? null, reversal_txn_id: p[3] ?? null }));
    db.on('FROM partner_order_items oi LEFT JOIN', () => orderLineRows());
    const { svc } = buildService(db);
    const out = await svc.cancelOrder(ORDER_ID, PROVIDER_USER, { reason: 'supplier out of stock' });
    expect(out.status).toBe('cancelled');
    expect(out.reversal_txn_id).toBeTruthy();
    const ledger = db.calls.filter((c) => c.text.includes('INSERT INTO ledger_entries'));
    expect(ledger).toHaveLength(2);
    expect(ledger[0].text).toContain(`'affiliate_fee_rev','D'`);
    expect(ledger[1].text).toContain(`'wallet','C'`);
    expect(ledger[0].params[0]).toBe(ledger[1].params[0]);
    expect(ledger[0].params[2]).toBe(22500);
    expect(db.calls.some((c) => c.text.includes('balance_paisa = balance_paisa + $2') && c.params[1] === 22500)).toBe(true);
  });
  it('a non-party cannot transition; an admin can (oversight)', async () => {
    const { svc } = buildService(transitionDb('placed'));
    await expectApiError(svc.confirmOrder(ORDER_ID, OTHER_PROVIDER_USER), 403, 'FORBIDDEN');
    const db2 = transitionDb('placed');
    const { svc: s2 } = buildService(db2);
    const out = await s2.confirmOrder(ORDER_ID, 'admin-user', true);
    expect(out.status).toBe('confirmed');
  });
});

describe('PartnersService disclosure + admin', () => {
  it('job partner-orders view shows the same disclosure to customer and provider, 403 to strangers', async () => {
    const db = new MockDb();
    db.on('FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1', () => [
      { customer_id: CUSTOMER, provider_user_id: PROVIDER_USER },
    ]);
    db.on('SELECT o.*, p.name AS partner_name', () => [orderRow()]);
    db.on('FROM partner_order_items oi LEFT JOIN', () => orderLineRows());
    const { svc } = buildService(db);
    const asCustomer = await svc.getJobPartnerOrders(JOB_ID, CUSTOMER);
    const asProvider = await svc.getJobPartnerOrders(JOB_ID, PROVIDER_USER);
    expect(asCustomer.orders).toHaveLength(1);
    expect(asCustomer.disclosure_text).toContain('Quetta AC Spares');
    expect(asCustomer.disclosure_text).toBe(asProvider.disclosure_text);
    expect(asCustomer.orders[0].partner_disclosure.text).toBe(asProvider.orders[0].partner_disclosure.text);
    await expectApiError(svc.getJobPartnerOrders(JOB_ID, OTHER_CUSTOMER), 403, 'FORBIDDEN');
  });
  it('admin CRUD: create partner (default 5% fee), update it, create + update a catalog item', async () => {
    const db = new MockDb();
    db.on('SELECT config FROM feature_flags WHERE key=$1', () => [{ config: { value_rate: 0.05 } }]);
    db.on('INSERT INTO partners', () => ({
      id: randomUUID(), name: 'New Spares', slug: 'new-spares', kind: 'parts_supplier',
      contact_name: null, contact_phone: null, website: null, city: 'Quetta',
      affiliate_fee_rate: '0.05', is_active: true, created_at: new Date().toISOString(),
    }));
    db.on('SELECT * FROM partners WHERE id=$1', () => [{ id: PARTNER_ID }]);
    db.on('UPDATE partners SET name=', () => ({
      id: PARTNER_ID, name: 'Quetta AC Spares', slug: 'quetta-ac-spares', kind: 'parts_supplier',
      contact_name: null, contact_phone: null, website: null, city: 'Quetta',
      affiliate_fee_rate: '0.07', is_active: true, created_at: new Date().toISOString(),
    }));
    db.on('SELECT id, is_active FROM partners WHERE id=$1', () => [{ id: PARTNER_ID, is_active: true }]);
    db.on('INSERT INTO partner_catalog_items', () => ({ id: ITEM_TAPE }));
    db.on('SELECT id FROM partner_catalog_items WHERE id=$1', () => [{ id: ITEM_TAPE }]);
    db.on('SELECT i.*, p.name AS partner_name', () => [
      { id: ITEM_TAPE, partner_id: PARTNER_ID, partner_name: 'Quetta AC Spares', partner_slug: 'quetta-ac-spares', sku: 'QHH-TAPE-PVC', name: 'PVC Insulation Tape', category: 'hardware', description: null, unit_price_paisa: '12000', stock_qty: 200, is_active: true },
    ]);
    const { svc } = buildService(db);
    const partner = await svc.createPartner({ name: 'New Spares', slug: 'new-spares' });
    expect(partner.affiliate_fee_rate).toBe(0.05);
    const updated = await svc.updatePartner(PARTNER_ID, { affiliate_fee_rate: 0.07 });
    expect(updated.affiliate_fee_rate).toBe(0.07);
    const item = await svc.createCatalogItem({ partner_id: PARTNER_ID, sku: 'QHH-TAPE-PVC', name: 'PVC Insulation Tape', unit_price_pkr: 120, stock_qty: 200 });
    expect(item.sku).toBe('QHH-TAPE-PVC');
    expect(item.unit_price_pkr).toBe(120);
  });
  it('affiliate fee report sums earned fees per partner and cross-checks the ledger', async () => {
    const db = new MockDb();
    db.on('FROM partner_orders o JOIN partners p ON p.id=o.partner_id', () => [
      { partner_id: PARTNER_ID, partner_name: 'Quetta AC Spares', placed: 1, confirmed: 1, delivered: 1, cancelled: 1, gross: '900000', earned: '45000' },
    ]);
    db.on('SELECT fee_txn_id AS txn_id FROM partner_orders o', () => [{ txn_id: randomUUID() }]);
    db.on('FROM ledger_entries WHERE txn_id=$1', () => [{ diff: '0' }]);
    const { svc } = buildService(db);
    const report = await svc.affiliateFeeReport({});
    expect(report.partners).toHaveLength(1);
    expect(report.partners[0].affiliate_fee_earned_paisa).toBe(45000);
    expect(report.totals.affiliate_fee_earned_paisa).toBe(45000);
    expect(report.ledger_check.mismatches).toEqual([]);
    expect(report.ledger_check.txns_checked).toBe(1);
  });
});
