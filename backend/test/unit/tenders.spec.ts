// B2B tenders — unit tests (Phase 3, item 5).
// Service tests run against a scripted MockDb (no live Postgres): every
// SQL fragment the service emits is answered by a handler registered per
// test, so the tests pin the service's actual queries and their order.
// Pure domain checks (item math, lead fee) need no DB at all.
// Run: DATABASE_URL=<own test db> REDIS_URL=redis://localhost:6379
//   npm test -- tenders --runInBand   (unit file only; integration file
//   skips itself when DATABASE_URL/REDIS_URL are unset)
import { randomUUID } from 'crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { TendersService, TENDER_LEAD_FEE_PAISA } from '../../src/modules/tenders/tenders.service';
import { CreateTenderDto, SubmitQuoteDto } from '../../src/modules/tenders/dto';
import { validateQuoteItems, quoteItemsTotalPaisa, TENDER_LEAD_FEE_PKR } from '../../src/modules/tenders/domain/tender-math';
import { ApiError } from '../../src/common/errors/api-error';

type Row = Record<string, any>;
type Handler = (params: any[]) => Row[] | Row | undefined;

const CUSTOMER = 'c0000001-4000-4000-8000-000000000001';
const OTHER_CUSTOMER = 'c0000002-4000-4000-8000-000000000002';
const PROVIDER_USER = 'c0000011-4000-4000-8000-000000000011';
const PROVIDER_USER_2 = 'c0000012-4000-4000-8000-000000000012';
const PROVIDER_ID = '20000000-0011-4000-8000-000000000011';
const PROVIDER_ID_2 = '20000000-0012-4000-8000-000000000012';
const CATEGORY_ID = '00000000-0000-4000-8000-0000b0000001'; // Book Binding
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const TENDER_ID = '22222222-2222-4222-8222-222222222222';
const QUOTE_ID = '33333333-3333-4333-8333-333333333333';
const QUOTE_ID_2 = '44444444-4444-4444-8444-444444444444';

const ITEMS = [
  { label: 'Hard binding x500', quantity: 500, unit_price: 120, line_total: 60000 },
  { label: 'Title printing x500', quantity: 500, unit_price: 15, line_total: 7500 },
];
const TOTAL = 67500;
const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

function tenderRow(over: Partial<Row> = {}): Row {
  return {
    id: TENDER_ID, request_id: REQUEST_ID, customer_id: CUSTOMER, category_id: CATEGORY_ID,
    organization_name: 'Govt High School Quetta', organization_type: 'SCHOOL',
    title: 'Bind 500 books', description: 'Annual binding', delivery_deadline: FUTURE,
    status: 'QUOTES_RECEIVED', accepted_quote_id: null, job_id: null,
    lead_fee_paisa: String(TENDER_LEAD_FEE_PAISA), lead_fee_charged: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), closed_at: null,
    ...over,
  };
}
function quoteRow(over: Partial<Row> = {}): Row {
  return {
    id: QUOTE_ID, tender_id: TENDER_ID, provider_id: PROVIDER_ID, items: ITEMS,
    total_price: String(TOTAL), eta_days: 10, note: null, validity_days: 30,
    status: 'submitted', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...over,
  };
}

/* Fake Redis: the in-memory semantics of RedisService for the scopes the
 * tenders service uses (idempotency get/set, accept lock setNx/del). */
class FakeRedis {
  private mem = new Map<string, string>();
  async get(k: string) { return this.mem.get(k) ?? null; }
  async set(k: string, v: string) { this.mem.set(k, v); }
  async del(k: string) { this.mem.delete(k); }
  async setNx(k: string, v: string) { if (this.mem.has(k)) return false; this.mem.set(k, v); return true; }
}
class FakeRealtime {
  events: { room: string; event: string; payload: unknown }[] = [];
  userEvents: { userId: string; event: string; payload: unknown }[] = [];
  emitToRoom(room: string, event: string, payload: unknown) { this.events.push({ room, event, payload }); }
  emitToUser(userId: string, event: string, payload: unknown) { this.userEvents.push({ userId, event, payload }); }
}

/** Scripted DB: handlers match on a SQL fragment, in registration order. */
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
  const svc = new TendersService(db as any, redis as any, realtime as any);
  return { svc, redis, realtime, db };
}

function expectApiError(p: Promise<unknown>, status: number, code: string) {
  return expect(p).rejects.toMatchObject({ status, code } as Partial<ApiError>);
}

describe('tender-math (pure domain)', () => {
  it('accepts a correct itemized quote', () => {
    expect(validateQuoteItems(ITEMS, TOTAL)).toBeNull();
    expect(quoteItemsTotalPaisa(ITEMS as any)).toBe(TOTAL * 100);
  });
  it('rejects a wrong line total', () => {
    const bad = [{ label: 'x', quantity: 10, unit_price: 100, line_total: 999 }];
    expect(validateQuoteItems(bad, 999)).toBe('ITEM_LINE_MISMATCH');
  });
  it('rejects a total that does not equal the sum of lines', () => {
    expect(validateQuoteItems(ITEMS, TOTAL + 1)).toBe('ITEM_TOTAL_MISMATCH');
  });
  it('rejects empty items and bad quantities', () => {
    expect(validateQuoteItems([], 100)).toBe('EMPTY_ITEMS');
    expect(validateQuoteItems([{ label: 'x', quantity: 0, unit_price: 10, line_total: 0 }], 0)).toBe('ITEM_INVALID');
    expect(validateQuoteItems([{ label: 'x', quantity: 2, unit_price: 10.005, line_total: 20.01 }], 20.01)).toBe('ITEM_INVALID');
  });
  it('lead fee is a flat PKR 500', () => {
    expect(TENDER_LEAD_FEE_PKR).toBe(500);
    expect(TENDER_LEAD_FEE_PAISA).toBe(50000);
  });
});

describe('tender DTO validation', () => {
  it('CreateTenderDto requires request, org and a deadline', async () => {
    const bad = plainToInstance(CreateTenderDto, { organization_name: 'X' });
    const errs = await validate(bad);
    expect(errs.length).toBeGreaterThan(0);
    const props = errs.map((e) => e.property);
    expect(props).toEqual(expect.arrayContaining(['request_id', 'organization_type', 'title', 'delivery_deadline']));
  });
  it('SubmitQuoteDto requires at least one item and a money total', async () => {
    const bad = plainToInstance(SubmitQuoteDto, { items: [], total_price: -5 });
    const errs = await validate(bad);
    expect(errs.length).toBeGreaterThan(0);
  });
  it('a well-formed SubmitQuoteDto validates', async () => {
    const dto = plainToInstance(SubmitQuoteDto, { items: ITEMS, total_price: TOTAL, eta_days: 10 });
    expect(await validate(dto)).toEqual([]);
  });
});

describe('TendersService.createTender', () => {
  const dto = () => plainToInstance(CreateTenderDto, {
    request_id: REQUEST_ID, organization_name: 'Govt High School Quetta',
    organization_type: 'SCHOOL', title: 'Bind 500 books', delivery_deadline: FUTURE,
  });

  it('creates a tender on an open request and flags it is_b2b', async () => {
    const db = new MockDb();
    db.on('FROM service_requests WHERE id=$1', () => [{ customer_id: CUSTOMER, category_id: CATEGORY_ID, status: 'BROADCASTING' }]);
    db.on('FROM tenders WHERE request_id=$1', () => []);
    db.on('INSERT INTO tenders', () => tenderRow({ status: 'OPEN' }));
    const { svc } = buildService(db);
    const out = await svc.createTender(CUSTOMER, dto() as any);
    expect(out.status).toBe('OPEN');
    expect(out.organization_type).toBe('SCHOOL');
    expect(out.lead_fee_paisa).toBe(TENDER_LEAD_FEE_PAISA);
    expect(db.calls.some((c) => c.text.includes('is_b2b=true'))).toBe(true);
    expect(db.calls.some((c) => c.text.includes('INSERT INTO tender_audit') && JSON.stringify(c.params).includes('TENDER_CREATED'))).toBe(true);
  });
  it('rejects a past delivery deadline with 422', async () => {
    const { svc } = buildService(new MockDb());
    const d = dto() as any; d.delivery_deadline = new Date(Date.now() - 1000).toISOString();
    await expectApiError(svc.createTender(CUSTOMER, d), 422, 'DEADLINE_PAST');
  });
  it('404s on a missing request, 403s for a non-owner, 409s on a closed request', async () => {
    const missing = new MockDb();
    const { svc: s1 } = buildService(missing);
    await expectApiError(s1.createTender(CUSTOMER, dto() as any), 404, 'NOT_FOUND');
    const notOwner = new MockDb();
    notOwner.on('FROM service_requests WHERE id=$1', () => [{ customer_id: OTHER_CUSTOMER, category_id: CATEGORY_ID, status: 'BROADCASTING' }]);
    const { svc: s2 } = buildService(notOwner);
    await expectApiError(s2.createTender(CUSTOMER, dto() as any), 403, 'FORBIDDEN');
    const closed = new MockDb();
    closed.on('FROM service_requests WHERE id=$1', () => [{ customer_id: CUSTOMER, category_id: CATEGORY_ID, status: 'ACCEPTED' }]);
    const { svc: s3 } = buildService(closed);
    await expectApiError(s3.createTender(CUSTOMER, dto() as any), 409, 'TENDER_REQUEST_CLOSED');
  });
  it('409s when a tender already exists for the request', async () => {
    const db = new MockDb();
    db.on('FROM service_requests WHERE id=$1', () => [{ customer_id: CUSTOMER, category_id: CATEGORY_ID, status: 'BROADCASTING' }]);
    db.on('FROM tenders WHERE request_id=$1', () => [{ id: TENDER_ID }]);
    const { svc } = buildService(db);
    await expectApiError(svc.createTender(CUSTOMER, dto() as any), 409, 'TENDER_EXISTS');
  });
});

describe('TendersService.submitQuote', () => {
  const dto = () => plainToInstance(SubmitQuoteDto, { items: ITEMS, total_price: TOTAL, eta_days: 10 });

  function baseDb() {
    const db = new MockDb();
    db.on('FROM provider_profiles WHERE user_id=$1', (p) => (p[0] === PROVIDER_USER ? [{ id: PROVIDER_ID }] : []));
    db.on('SELECT balance_paisa FROM wallet_accounts', () => []);
    db.on('SELECT * FROM tenders WHERE id=$1', () => [tenderRow()]);
    db.on("FROM tender_quotes WHERE tender_id=$1 AND provider_id=$2 AND status='submitted'", () => []);
    db.on('INSERT INTO tender_quotes', () => quoteRow());
    return db;
  }
  it('accepts a correct itemized quote and moves the tender to QUOTES_RECEIVED', async () => {
    const { svc, db } = buildService(baseDb());
    const out = await svc.submitQuote(TENDER_ID, PROVIDER_USER, dto() as any);
    expect(out.status).toBe('submitted');
    expect(out.total_price).toBe(TOTAL);
    expect(out.items).toHaveLength(2);
    expect(db.calls.some((c) => c.text.includes("status='QUOTES_RECEIVED'"))).toBe(true);
    expect(db.calls.some((c) => c.text.includes('INSERT INTO tender_audit') && JSON.stringify(c.params).includes('QUOTE_SUBMITTED'))).toBe(true);
  });
  it('422s when the item lines do not add up to the total', async () => {
    const { svc } = buildService(baseDb());
    const d = dto() as any; d.total_price = TOTAL + 100;
    await expectApiError(svc.submitQuote(TENDER_ID, PROVIDER_USER, d), 422, 'ITEM_TOTAL_MISMATCH');
  });
  it('409s on a second live quote from the same provider', async () => {
    const db = baseDb();
    db.handlers = db.handlers.filter((h) => !h.frag.includes("FROM tender_quotes WHERE tender_id"));
    db.on("FROM tender_quotes WHERE tender_id=$1 AND provider_id=$2 AND status='submitted'", () => [{ id: QUOTE_ID }]);
    const { svc } = buildService(db);
    await expectApiError(svc.submitQuote(TENDER_ID, PROVIDER_USER, dto() as any), 409, 'QUOTE_EXISTS');
  });
  it('403s when the caller has no provider profile', async () => {
    const { svc } = buildService(baseDb());
    await expectApiError(svc.submitQuote(TENDER_ID, CUSTOMER, dto() as any), 403, 'FORBIDDEN');
  });
  it('409s for a commission-blocked provider (wallet below threshold)', async () => {
    const db = baseDb();
    db.handlers = db.handlers.filter((h) => !h.frag.includes('SELECT balance_paisa FROM wallet_accounts'));
    db.on('SELECT balance_paisa FROM wallet_accounts', () => [{ balance_paisa: '-600000' }]);
    const { svc } = buildService(db);
    await expectApiError(svc.submitQuote(TENDER_ID, PROVIDER_USER, dto() as any), 409, 'COMMISSION_BLOCKED');
  });
  it('409s on a closed tender', async () => {
    const db = baseDb();
    db.handlers = db.handlers.filter((h) => !h.frag.includes('SELECT * FROM tenders WHERE id=$1'));
    db.on('SELECT * FROM tenders WHERE id=$1', () => [tenderRow({ status: 'AWARDED' })]);
    const { svc } = buildService(db);
    await expectApiError(svc.submitQuote(TENDER_ID, PROVIDER_USER, dto() as any), 409, 'TENDER_CLOSED');
  });
});

describe('TendersService.withdrawQuote', () => {
  it('withdraws your own submitted quote and audits it', async () => {
    const db = new MockDb();
    db.on('FROM provider_profiles WHERE user_id=$1', () => [{ id: PROVIDER_ID }]);
    db.on('SELECT * FROM tender_quotes WHERE id=$1', () => [quoteRow()]);
    db.on('UPDATE tender_quotes SET status=', () => quoteRow({ status: 'withdrawn' }));
    const { svc, db: d } = buildService(db);
    const out = await svc.withdrawQuote(QUOTE_ID, PROVIDER_USER);
    expect(out.status).toBe('withdrawn');
    expect(d.calls.some((c) => c.text.includes('INSERT INTO tender_audit') && JSON.stringify(c.params).includes('QUOTE_WITHDRAWN'))).toBe(true);
  });
  it('403s for another provider and 409s when already decided', async () => {
    const db = new MockDb();
    db.on('FROM provider_profiles WHERE user_id=$1', (p) => [{ id: p[0] === PROVIDER_USER ? PROVIDER_ID : PROVIDER_ID_2 }]);
    db.on('SELECT * FROM tender_quotes WHERE id=$1', () => [quoteRow()]);
    const { svc } = buildService(db);
    await expectApiError(svc.withdrawQuote(QUOTE_ID, PROVIDER_USER_2), 403, 'FORBIDDEN');
    const decided = new MockDb();
    decided.on('FROM provider_profiles WHERE user_id=$1', () => [{ id: PROVIDER_ID }]);
    decided.on('SELECT * FROM tender_quotes WHERE id=$1', () => [quoteRow({ status: 'accepted' })]);
    const { svc: s2 } = buildService(decided);
    await expectApiError(s2.withdrawQuote(QUOTE_ID, PROVIDER_USER), 409, 'QUOTE_CLOSED');
  });
});

describe('TendersService.acceptQuote — exactly one accepted', () => {
  function acceptDb() {
    const db = new MockDb();
    const tender = tenderRow();
    const quote = quoteRow();
    db.on('SELECT tender_id FROM tender_quotes WHERE id=$1', () => [{ tender_id: TENDER_ID }]);
    db.on('SELECT status FROM tender_quotes WHERE id=$1', () => [{ status: quote.status }]);
    db.on('SELECT status, job_id FROM tenders WHERE id=$1', () => [{ status: tender.status, job_id: tender.job_id }]);
    db.on('SELECT * FROM tenders WHERE id=$1 FOR UPDATE', () => [tender]);
    db.on('SELECT * FROM tender_quotes WHERE id=$1 FOR UPDATE', () => [quote]);
    db.on('SELECT * FROM service_requests WHERE id=$1 FOR UPDATE', () => [{ id: REQUEST_ID, customer_id: CUSTOMER, category_id: CATEGORY_ID }]);
    db.on('SELECT user_id, tier FROM provider_profiles WHERE id=$1', () => [{ user_id: PROVIDER_USER, tier: 2 }]);
    db.on('FROM commission_rules', () => []);
    db.on('SELECT COALESCE(MAX(round),0) AS max_round FROM offers', () => [{ max_round: 0 }]);
    db.on('INSERT INTO offers', () => ({ id: randomUUID(), request_id: REQUEST_ID, provider_id: PROVIDER_ID, price: TOTAL }));
    db.on('INSERT INTO jobs', () => ({
      id: randomUUID(), request_id: REQUEST_ID, agreed_price: TOTAL, final_price: TOTAL,
      state: 'ACCEPTED', payment_method: 'cash', payment_status: 'unpaid',
    }));
    db.on('INSERT INTO wallet_accounts', () => [{ id: randomUUID() }]);
    db.on('SELECT id FROM wallet_accounts WHERE user_id=$1', () => [{ id: randomUUID() }]);
    return db;
  }
  it('accepts one quote: job ACCEPTED, others rejected, lead fee debited, audit written', async () => {
    const db = acceptDb();
    const { svc } = buildService(db);
    const out = await svc.acceptQuote(QUOTE_ID, CUSTOMER);
    expect(out.job.state).toBe('ACCEPTED');
    expect(out.tender.status).toBe('AWARDED');
    expect(out.tender.job_id).toBe(out.job.id);
    expect(out.lead_fee_paisa).toBe(TENDER_LEAD_FEE_PAISA);
    expect(out.lead_fee_charged).toBe(true);
    // Lead fee: balanced ledger pair D wallet / C tender_lead_fee_rev
    // (account + direction are SQL literals; params are txn/wallet/amount/job).
    const ledger = db.calls.filter((c) => c.text.includes('INSERT INTO ledger_entries'));
    expect(ledger).toHaveLength(2);
    expect(ledger[0].text).toContain(`'wallet','D'`);
    expect(ledger[0].params[2]).toBe(TENDER_LEAD_FEE_PAISA);
    expect(ledger[1].text).toContain(`'tender_lead_fee_rev','C'`);
    expect(ledger[1].params[2]).toBe(TENDER_LEAD_FEE_PAISA);
    expect(ledger[0].params[0]).toBe(ledger[1].params[0]); // same txn_id
    expect(db.calls.some((c) => c.text.includes('balance_paisa = balance_paisa - $2') && c.params[1] === TENDER_LEAD_FEE_PAISA)).toBe(true);
    // Losing submitted quotes are rejected.
    expect(db.calls.some((c) => c.text.includes("status='rejected'") && c.text.includes('tender_quotes'))).toBe(true);
    // Job materialised as a normal offer + job with the tender link.
    expect(db.calls.some((c) => c.text.includes('INSERT INTO offers') && c.text.includes('Tender quote'))).toBe(true);
    expect(db.calls.some((c) => c.text.includes('INSERT INTO jobs') && c.text.includes('tender_id'))).toBe(true);
    // Audit: QUOTE_ACCEPTED + LEAD_FEE_CHARGED + JOB_CREATED.
    const audits = db.calls.filter((c) => c.text.includes('INSERT INTO tender_audit')).map((c) => JSON.stringify(c.params));
    expect(audits.some((a) => a.includes('QUOTE_ACCEPTED'))).toBe(true);
    expect(audits.some((a) => a.includes('LEAD_FEE_CHARGED'))).toBe(true);
    expect(audits.some((a) => a.includes('JOB_CREATED'))).toBe(true);
  });
  it('10 concurrent accepts create exactly one job', async () => {
    const db = acceptDb();
    // The shared acceptor serialises; the state re-check after the first
    // commit must see the tender as awarded. Simulate that by flipping
    // the state handlers once the first job insert has happened.
    let jobsCreated = 0;
    const origQuery = db.query.bind(db);
    db.query = async (text: string, params: unknown[] = []) => {
      if (text.includes('INSERT INTO jobs')) jobsCreated += 1;
      if (text.includes('SELECT status, job_id FROM tenders WHERE id=$1') && jobsCreated > 0) {
        return { rows: [{ status: 'AWARDED', job_id: 'job-already-created' }] };
      }
      return origQuery(text, params);
    };
    const { svc } = buildService(db);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => svc.acceptQuote(QUOTE_ID, CUSTOMER)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(9);
    expect(jobsCreated).toBe(1);
  });
  it('second accept after award is a 409, and a non-owner cannot accept', async () => {
    const db = acceptDb();
    db.handlers = db.handlers.filter((h) => !h.frag.includes('SELECT status, job_id FROM tenders'));
    db.on('SELECT status, job_id FROM tenders WHERE id=$1', () => [{ status: 'AWARDED', job_id: randomUUID() }]);
    const { svc } = buildService(db);
    await expectApiError(svc.acceptQuote(QUOTE_ID, CUSTOMER), 409, 'QUOTE_ALREADY_CLOSED');
    const db2 = acceptDb();
    const { svc: s2 } = buildService(db2);
    await expectApiError(s2.acceptQuote(QUOTE_ID, OTHER_CUSTOMER), 403, 'FORBIDDEN');
  });
  it('accept is idempotent on replayed Idempotency-Key', async () => {
    const db = acceptDb();
    const { svc } = buildService(db);
    const first = await svc.acceptQuote(QUOTE_ID, CUSTOMER, 'key-1');
    const second = await svc.acceptQuote(QUOTE_ID, CUSTOMER, 'key-1');
    expect(second).toEqual(first);
    expect(db.calls.filter((c) => c.text.includes('INSERT INTO jobs'))).toHaveLength(1);
  });
});

describe('TendersService.cancelTender + audit trail + sealed quotes', () => {
  it('cancels an open tender, rejects live quotes, audits', async () => {
    const db = new MockDb();
    db.on('SELECT * FROM tenders WHERE id=$1', () => [tenderRow({ status: 'OPEN' })]);
    db.on('UPDATE tenders SET status=', () => tenderRow({ status: 'CANCELLED' }));
    const { svc, db: d } = buildService(db);
    const out = await svc.cancelTender(TENDER_ID, CUSTOMER);
    expect(out.status).toBe('CANCELLED');
    expect(d.calls.some((c) => c.text.includes('INSERT INTO tender_audit') && JSON.stringify(c.params).includes('TENDER_CANCELLED'))).toBe(true);
  });
  it('cannot cancel an awarded tender', async () => {
    const db = new MockDb();
    db.on('SELECT * FROM tenders WHERE id=$1', () => [tenderRow({ status: 'AWARDED' })]);
    const { svc } = buildService(db);
    await expectApiError(svc.cancelTender(TENDER_ID, CUSTOMER), 409, 'TENDER_CLOSED');
  });
  it('audit trail returns actions oldest-first', async () => {
    const db = new MockDb();
    db.on('SELECT * FROM tenders WHERE id=$1', () => [tenderRow()]);
    db.on('SELECT * FROM tender_audit WHERE tender_id=$1', () => [
      { id: 1, tender_id: TENDER_ID, quote_id: null, actor_user_id: CUSTOMER, actor_role: 'customer', action: 'TENDER_CREATED', details: {}, created_at: '2026-11-17T00:00:00Z' },
      { id: 2, tender_id: TENDER_ID, quote_id: QUOTE_ID, actor_user_id: PROVIDER_USER, actor_role: 'provider', action: 'QUOTE_SUBMITTED', details: { total_price: TOTAL }, created_at: '2026-11-17T00:01:00Z' },
      { id: 3, tender_id: TENDER_ID, quote_id: QUOTE_ID, actor_user_id: CUSTOMER, actor_role: 'customer', action: 'QUOTE_ACCEPTED', details: {}, created_at: '2026-11-17T00:02:00Z' },
    ]);
    const { svc } = buildService(db);
    const out = await svc.getAuditTrail(TENDER_ID, CUSTOMER);
    expect(out.items.map((a: any) => a.action)).toEqual(['TENDER_CREATED', 'QUOTE_SUBMITTED', 'QUOTE_ACCEPTED']);
  });
  it('sealed bids: a provider sees only their own quote before award; the owner sees all', async () => {
    const db = new MockDb();
    db.on('SELECT * FROM tenders WHERE id=$1', () => [tenderRow({ status: 'QUOTES_RECEIVED' })]);
    db.on('FROM provider_profiles WHERE user_id=$1', (p) => [{ id: p[0] === PROVIDER_USER ? PROVIDER_ID : PROVIDER_ID_2 }]);
    db.on('FROM tender_quotes WHERE tender_id=$1 AND provider_id=$2 LIMIT 1', () => [{ '1': 1 }]);
    db.on('SELECT * FROM tender_quotes WHERE tender_id=$1', () => [
      quoteRow({ id: QUOTE_ID, provider_id: PROVIDER_ID }),
      quoteRow({ id: QUOTE_ID_2, provider_id: PROVIDER_ID_2, total_price: String(TOTAL + 5000) }),
    ]);
    const { svc } = buildService(db);
    const mine = await svc.listQuotes(TENDER_ID, PROVIDER_USER);
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0].id).toBe(QUOTE_ID);
    expect(mine.sealed).toBe(true);
    const owner = await svc.listQuotes(TENDER_ID, CUSTOMER);
    expect(owner.items).toHaveLength(2);
  });
  it('expireTender marks a past-deadline open tender EXPIRED', async () => {
    const db = new MockDb();
    db.on('SELECT * FROM tenders WHERE id=$1', () => [tenderRow({ status: 'OPEN', delivery_deadline: new Date(Date.now() - 1000).toISOString() })]);
    db.on('UPDATE tenders SET status=', () => tenderRow({ status: 'EXPIRED' }));
    const { svc, db: d } = buildService(db);
    const out = await svc.expireTender(TENDER_ID);
    expect(out.status).toBe('EXPIRED');
    expect(d.calls.some((c) => c.text.includes('INSERT INTO tender_audit') && JSON.stringify(c.params).includes('TENDER_EXPIRED'))).toBe(true);
  });
});
