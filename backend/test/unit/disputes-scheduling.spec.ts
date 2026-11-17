// Phase 2 unit tests: dispute centre flows + scheduling + contract gaps.
// Services run against a scripted in-memory FakeDb (no live Postgres/Redis).
import { AdminService, restoreStateFor } from '../../src/modules/admin/admin.service';
import { TrustService } from '../../src/modules/trust/trust.service';
import { SchedulingService, advanceNextRun } from '../../src/modules/jobs/scheduling.service';
import { JobsQueryService } from '../../src/modules/jobs/jobs-query.service';
import { RequestsService } from '../../src/modules/requests/requests.service';
import { validateFormSchema } from '../../src/modules/catalog/catalog.service';
import { ApiError } from '../../src/common/errors/api-error';

type Handler = (text: string, params: unknown[]) => { rows: Record<string, unknown>[] } | undefined;
class FakeDb {
  queries: { text: string; params: unknown[] }[] = [];
  private handlers: { re: RegExp; fn: Handler }[] = [];
  on(re: RegExp, fn: Handler) { this.handlers.push({ re, fn }); return this; }
  onRows(re: RegExp, rows: Record<string, unknown>[]) { return this.on(re, () => ({ rows })); }
  async query(text: string, params: unknown[] = []) {
    this.queries.push({ text, params });
    for (const h of this.handlers) {
      if (h.re.test(text)) {
        const out = h.fn(text, params);
        if (out) return out;
      }
    }
    return { rows: [] as Record<string, unknown>[] };
  }
  async withTransaction<T>(fn: (c: unknown) => Promise<T>): Promise<T> { return fn(this as unknown); }
  matching(re: RegExp) { return this.queries.filter((q) => re.test(q.text)); }
}
const redisStub = { get: async () => null as string | null, set: async () => undefined };
const realtimeStub = { emitToRoom: jest.fn(), emitToUser: jest.fn() };
const noRealtime = { emitToRoom: () => undefined, emitToUser: () => undefined };

const DISPUTE_JOB = {
  id: 'disp-1', job_id: 'job-1', opened_by: 'cust-1', status: 'open',
  job_state: 'DISPUTED', customer_id: 'cust-1', provider_user_id: 'prov-1',
  final_price: '2500', agreed_price: '2500', payment_status: 'settled',
  sla_first_response_at: '2026-11-17T10:00:00Z', sla_resolve_at: '2026-11-19T06:00:00Z',
};

function disputeDb(overrides: Partial<typeof DISPUTE_JOB> = {}, preDispute: string | null = null) {
  const db = new FakeDb();
  const row = { ...DISPUTE_JOB, ...overrides };
  db.onRows(/FROM disputes d JOIN jobs j/, [row]);
  db.on(/SELECT id FROM wallet_accounts WHERE user_id/, (_t, p) => ({
    rows: [{ id: p[0] === 'cust-1' ? 'wallet-cust' : 'wallet-prov' }],
  }));
  db.onRows(/SELECT \* FROM disputes WHERE id/, [{ ...row, status: 'resolved', resolution: { outcome: 'refund' } }]);
  if (preDispute) db.onRows(/FROM job_events WHERE job_id.*to_state='DISPUTED'/, [{ from_state: preDispute }]);
  return { db, row };
}

describe('dispute resolve — ledger-backed flows', () => {
  it('full refund -> REFUNDED + balanced ledger + wallets correct', async () => {
    const { db } = disputeDb();
    const svc = new AdminService(db as never, realtimeStub as never, {} as never);
    const out = await svc.resolveDispute('admin-1', 'disp-1', { outcome: 'refund', note: 'work not done' });
    expect(out.job_state).toBe('REFUNDED');
    const legs = db.matching(/INSERT INTO ledger_entries/);
    expect(legs).toHaveLength(4); // customer D/C + provider D/C
    // Direction is a SQL literal ('D'/'C'), not a param: amount_paisa is params[3].
    const debits = legs.filter((q) => q.text.includes("'D'")).reduce((s, q) => s + Number(q.params[3]), 0);
    const credits = legs.filter((q) => q.text.includes("'C'")).reduce((s, q) => s + Number(q.params[3]), 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(500000); // 2 x PKR 2,500 in paisa
    const custLegs = legs.filter((q) => q.params[1] === 'wallet-cust');
    expect(custLegs.map((q) => [q.params[2], q.text.includes("'D'") ? 'D' : 'C'])).toEqual(expect.arrayContaining([['refund_expense', 'D'], ['wallet', 'C']]));
    expect(custLegs.every((q) => Number(q.params[3]) === 250000)).toBe(true);
    const provLegs = legs.filter((q) => q.params[1] === 'wallet-prov');
    expect(provLegs.map((q) => [q.params[2], q.text.includes("'D'") ? 'D' : 'C'])).toEqual(expect.arrayContaining([['wallet', 'D'], ['refund_expense', 'C']]));
    const walletUpdates = db.matching(/UPDATE wallet_accounts SET balance_paisa/);
    expect(walletUpdates.map((q) => [q.params[0], q.params[1], /balance_paisa \+/.test(q.text) ? '+' : '-'])).toEqual(
      expect.arrayContaining([['wallet-cust', 250000, '+'], ['wallet-prov', 250000, '-']]));
    const jobUpdate = db.matching(/UPDATE jobs SET state/);
    expect(jobUpdate[0].params).toEqual(['job-1', 'REFUNDED']);
    const dispUpdate = db.matching(/UPDATE disputes SET status='resolved'/);
    expect(dispUpdate).toHaveLength(1);
    expect(JSON.parse(String(dispUpdate[0].params[1]))).toMatchObject({ outcome: 'refund', amount_pkr: 2500, resolved_by: 'admin-1' });
    const events = db.matching(/INSERT INTO job_events/);
    expect(events[0].text).toContain("'DISPUTED'");
    expect(events[0].params[1]).toBe('REFUNDED');
    expect(realtimeStub.emitToRoom).toHaveBeenCalledWith('job:job-1', 'job.state_changed', expect.objectContaining({ from: 'DISPUTED', to: 'REFUNDED' }));
  });

  it('partial refund -> PAYMENT_SETTLED with the partial amount', async () => {
    const { db } = disputeDb();
    const svc = new AdminService(db as never, realtimeStub as never, {} as never);
    const out = await svc.resolveDispute('admin-1', 'disp-1', { outcome: 'partial_refund', amount_pkr: 1000 });
    expect(out.job_state).toBe('PAYMENT_SETTLED');
    const legs = db.matching(/INSERT INTO ledger_entries/);
    expect(legs.every((q) => Number(q.params[3]) === 100000)).toBe(true);
    const debits = legs.filter((q) => q.text.includes("'D'")).reduce((s, q) => s + Number(q.params[3]), 0);
    const credits = legs.filter((q) => q.text.includes("'C'")).reduce((s, q) => s + Number(q.params[3]), 0);
    expect(debits).toBe(credits);
  });

  it('partial refund equal to the full price -> REFUNDED', async () => {
    const { db } = disputeDb();
    const svc = new AdminService(db as never, realtimeStub as never, {} as never);
    const out = await svc.resolveDispute('admin-1', 'disp-1', { outcome: 'partial_refund', amount_pkr: 2500 });
    expect(out.job_state).toBe('REFUNDED');
  });

  it('compensation -> platform credit, job stays PAYMENT_SETTLED, no provider leg', async () => {
    const { db } = disputeDb();
    const svc = new AdminService(db as never, realtimeStub as never, {} as never);
    const out = await svc.resolveDispute('admin-1', 'disp-1', { outcome: 'compensation', amount_pkr: 500 });
    expect(out.job_state).toBe('PAYMENT_SETTLED');
    const legs = db.matching(/INSERT INTO ledger_entries/);
    expect(legs).toHaveLength(2);
    expect(legs.map((q) => [q.params[2], q.text.includes("'D'") ? 'D' : 'C'])).toEqual(expect.arrayContaining([['compensation_expense', 'D'], ['wallet', 'C']]));
    expect(legs.every((q) => q.params[1] === 'wallet-cust')).toBe(true);
  });

  it('no_action restores the pre-dispute state (IN_PROGRESS) and moves no money', async () => {
    const { db } = disputeDb({}, 'IN_PROGRESS');
    const svc = new AdminService(db as never, realtimeStub as never, {} as never);
    const out = await svc.resolveDispute('admin-1', 'disp-1', { outcome: 'no_action', note: 'no fault found' });
    expect(out.job_state).toBe('IN_PROGRESS');
    expect(db.matching(/INSERT INTO ledger_entries/)).toHaveLength(0);
    expect(db.matching(/UPDATE wallet_accounts/)).toHaveLength(0);
    expect(restoreStateFor('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(restoreStateFor('COMPLETED')).toBe('PAYMENT_SETTLED'); // only legal DISPUTED exits
    expect(restoreStateFor(null)).toBe('PAYMENT_SETTLED');
  });

  it('illegal resolve on a non-disputed job -> 409', async () => {
    const { db } = disputeDb({ job_state: 'PAYMENT_SETTLED' });
    const svc = new AdminService(db as never, realtimeStub as never, {} as never);
    await expect(svc.resolveDispute('admin-1', 'disp-1', { outcome: 'refund' }))
      .rejects.toMatchObject({ status: 409, code: 'DISPUTE_NOT_OPEN' });
    expect(db.matching(/INSERT INTO ledger_entries/)).toHaveLength(0);
  });

  it('refund of an unsettled job credits the customer but debits no provider', async () => {
    const { db } = disputeDb({ payment_status: 'unpaid' });
    const svc = new AdminService(db as never, realtimeStub as never, {} as never);
    const out = await svc.resolveDispute('admin-1', 'disp-1', { outcome: 'refund' });
    expect(out.job_state).toBe('REFUNDED');
    const legs = db.matching(/INSERT INTO ledger_entries/);
    expect(legs).toHaveLength(2);
    expect(legs.every((q) => q.params[1] === 'wallet-cust')).toBe(true);
  });
});

describe('dispute evidence + list', () => {
  it('party can add evidence; stranger gets 403', async () => {
    const db = new FakeDb();
    db.onRows(/FROM disputes d\s*JOIN jobs j/, [{ id: 'disp-1', opened_by: 'cust-1', customer_id: 'cust-1', provider_user_id: 'prov-1', status: 'open' }]);
    db.onRows(/FROM user_roles ur/, []);
    db.onRows(/INSERT INTO dispute_evidence/, [{ id: 'ev-1', kind: 'photo' }]);
    const svc = new TrustService(db as never);
    await expect(svc.addEvidence('disp-1', 'someone-else', { kind: 'photo' })).rejects.toBeInstanceOf(ApiError);
    // FIX 14(c): a photo key must have been issued for THIS dispute by
    // requestEvidenceUpload — the old hand-typed key is now rejected.
    await expect(svc.addEvidence('disp-1', 'cust-1', { kind: 'photo', storage_key: 'disputes/disp-1/a.jpg' }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_EVIDENCE_KEY' });
    await expect(svc.addEvidence('disp-1', 'cust-1', { kind: 'photo', storage_key: 'disputes/other-disp/evidence-x.bin' }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_EVIDENCE_KEY' });
    await expect(svc.addEvidence('disp-1', 'cust-1', { kind: 'photo' }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_EVIDENCE_KEY' });
    const row = await svc.addEvidence('disp-1', 'cust-1', { kind: 'photo', storage_key: 'disputes/disp-1/evidence-abc123.bin' });
    expect(row.id).toBe('ev-1');
    await expect(svc.addEvidence('disp-1', 'cust-1', { kind: 'video' })).rejects.toMatchObject({ status: 422 });
  });

  it('requestEvidenceUpload issues a dispute-namespaced key (FIX 14c)', async () => {
    const db = new FakeDb();
    db.onRows(/FROM disputes d\s*JOIN jobs j/, [{ id: 'disp-1', opened_by: 'cust-1', customer_id: 'cust-1', provider_user_id: 'prov-1', status: 'open' }]);
    db.onRows(/FROM user_roles ur/, []);
    const svc = new TrustService(db as never);
    const up = await svc.requestEvidenceUpload('disp-1', 'cust-1');
    expect(up.storage_key.startsWith('disputes/disp-1/evidence-')).toBe(true);
    expect(up.upload_url).toContain(encodeURIComponent(up.storage_key));
    await expect(svc.requestEvidenceUpload('disp-1', 'someone-else')).rejects.toMatchObject({ status: 403 });
  });

  it('listDisputes returns the {items, next_cursor} envelope', async () => {
    const db = new FakeDb();
    const rows = [
      { id: 'd3', status: 'open' }, { id: 'd2', status: 'open' }, { id: 'd1', status: 'open' },
    ];
    db.onRows(/FROM disputes d JOIN jobs j/, rows);
    const svc = new TrustService(db as never);
    const page = await svc.listDisputes('cust-1', { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBe('d2');
  });
});

describe('scheduling — reschedule', () => {
  const JOB_ROW = {
    id: 'job-1', state: 'ACCEPTED', customer_id: 'cust-1', provider_user_id: 'prov-1',
    agreed_price: '2000', final_price: null, request_id: 'req-1', current_scheduled_at: '2026-11-20T10:00:00Z',
  };
  it('reschedule keeps the price and notifies both parties', async () => {
    const db = new FakeDb();
    db.onRows(/FROM jobs j JOIN provider_profiles/, [JOB_ROW]);
    const svc = new SchedulingService(db as never, redisStub as never, { create: jest.fn() } as never);
    const out = await svc.reschedule('job-1', 'cust-1', { scheduled_at: '2026-11-21T10:00:00Z', reason: 'customer asked' });
    expect(out.scheduled_at).toBe('2026-11-21T10:00:00.000Z');
    expect(out.agreed_price).toBe(2000);
    expect(out.final_price).toBeNull();
    const reqUpdate = db.matching(/UPDATE service_requests SET scheduled_at/);
    expect(reqUpdate).toHaveLength(1);
    expect(reqUpdate[0].params[1]).toBe('2026-11-21T10:00:00.000Z');
    expect(db.matching(/UPDATE jobs SET/)).toHaveLength(0); // price/state untouched
    const notifs = db.matching(/INSERT INTO notifications/);
    expect(notifs).toHaveLength(2);
    expect(notifs.map((q) => q.params[0]).sort()).toEqual(['cust-1', 'prov-1']);
    expect(notifs.every((q) => q.text.includes("'job.reminder'"))).toBe(true); // template_key is a SQL literal
    const events = db.matching(/INSERT INTO job_events/);
    expect(JSON.parse(String(events[0].params[4]))).toMatchObject({ event: 'rescheduled' });
  });

  it('scope_changed -> 409 and the date is not moved', async () => {
    const db = new FakeDb();
    db.onRows(/FROM jobs j JOIN provider_profiles/, [JOB_ROW]);
    const svc = new SchedulingService(db as never, redisStub as never, { create: jest.fn() } as never);
    await expect(svc.reschedule('job-1', 'cust-1', { scheduled_at: '2026-11-21T10:00:00Z', scope_changed: true }))
      .rejects.toMatchObject({ status: 409, code: 'SCOPE_CHANGED_REQUIRES_RENEGOTIATION' });
    expect(db.matching(/UPDATE service_requests/)).toHaveLength(0);
  });

  it('terminal job cannot be rescheduled', async () => {
    const db = new FakeDb();
    db.onRows(/FROM jobs j JOIN provider_profiles/, [{ ...JOB_ROW, state: 'RATED' }]);
    const svc = new SchedulingService(db as never, redisStub as never, { create: jest.fn() } as never);
    await expect(svc.reschedule('job-1', 'cust-1', { scheduled_at: '2026-11-21T10:00:00Z' }))
      .rejects.toMatchObject({ status: 409, code: 'JOB_TERMINAL' });
  });
});

describe('scheduling — recurring jobs', () => {
  it('advanceNextRun: weekly lands on the next matching weekday; monthly on the same day next month', () => {
    const wed = new Date(2026, 10, 18, 10, 0, 0); // Wed 18 Nov 2026
    const nextMon = advanceNextRun(wed, 'weekly', 1);
    expect(nextMon.getDay()).toBe(1);
    expect(nextMon.getDate() - wed.getDate()).toBe(5);
    expect(nextMon.getHours()).toBe(10);
    const mid = new Date(2026, 10, 15, 9, 30, 0);
    const nextMonth = advanceNextRun(mid, 'monthly', null, 15);
    expect(nextMonth.getMonth()).toBe(11);
    expect(nextMonth.getDate()).toBe(15);
  });

  it('skip-next advances next_run_at by exactly one period', async () => {
    const db = new FakeDb();
    db.onRows(/FROM recurring_jobs WHERE id/, [{ id: 'rj-1', customer_id: 'cust-1', status: 'active', frequency: 'weekly', day_of_week: 1, next_run_at: '2026-11-23T10:00:00Z' }]);
    db.onRows(/UPDATE recurring_jobs SET next_run_at/, [{ id: 'rj-1', next_run_at: '2026-11-30T10:00:00Z', skipped_count: 1 }]);
    const svc = new SchedulingService(db as never, redisStub as never, { create: jest.fn() } as never);
    const out = await svc.skipNext('rj-1', 'cust-1');
    expect(out.next_run_at).toBe('2026-11-30T10:00:00Z');
    const upd = db.matching(/UPDATE recurring_jobs SET next_run_at/);
    expect(upd[0].params[1]).toBe('2026-11-30T10:00:00.000Z');
  });

  it('generateDueInstances creates exactly one request per due job', async () => {
    const db = new FakeDb();
    let calls = 0;
    const dueRow = {
      id: 'rj-1', customer_id: 'cust-1', category_id: 'cat-1', specs: {}, fulfillment: 'PROVIDER_COMES',
      lat: '30.1798', lng: '66.975', address_id: null, customer_offer: '2500',
      frequency: 'weekly', day_of_week: 1, day_of_month: null, next_run_at: '2026-11-20T10:00:00Z',
    };
    db.on(/FROM recurring_jobs r WHERE r.status='active'/, () => ({ rows: calls++ === 0 ? [dueRow] : [] }));
    db.onRows(/UPDATE recurring_jobs SET last_generated_at/, [{ id: 'rj-1' }]);
    const create = jest.fn(async (_customerId: string, _dto: unknown, _key?: string) => ({ id: 'req-new' }));
    const svc = new SchedulingService(db as never, redisStub as never, { create } as never);
    const first = await svc.generateDueInstances(new Date('2026-11-20T10:00:01Z'));
    expect(first.generated).toBe(1);
    expect(first.instances[0]).toMatchObject({ recurring_job_id: 'rj-1', request_id: 'req-new' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][2]).toBe('recurring:rj-1:2026-11-20T10:00:00.000Z');
    expect(create.mock.calls[0][1]).toMatchObject({ scheduled_at: '2026-11-20T10:00:00.000Z', fulfillment: 'PROVIDER_COMES' });
    const second = await svc.generateDueInstances(new Date('2026-11-20T10:00:02Z'));
    expect(second.generated).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('createRecurring validates frequency/day fields', async () => {
    const db = new FakeDb();
    const svc = new SchedulingService(db as never, redisStub as never, { create: jest.fn() } as never);
    const base = { fulfillment: 'PROVIDER_COMES', lat: 30.1798, lng: 66.975, starts_at: '2027-06-07T10:00:00Z' };
    await expect(svc.createRecurring('cust-1', { ...base, frequency: 'daily' } as never))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_FREQUENCY' });
    await expect(svc.createRecurring('cust-1', { ...base, frequency: 'weekly' } as never))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_DAY_OF_WEEK' });
    await expect(svc.createRecurring('cust-1', { ...base, frequency: 'monthly' } as never))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_DAY_OF_MONTH' });
  });
});

describe('contract gaps — listJobs, suspend, waitlist, form schema', () => {
  it('listJobs returns the {items, next_cursor} envelope', async () => {
    const db = new FakeDb();
    db.onRows(/FROM provider_profiles WHERE user_id/, [{ id: 'prof-1' }]);
    let calls = 0;
    const jobRows = [
      { id: 'job-3', request_id: 'r3', agreed_price: '2000', final_price: null, state: 'ACCEPTED', payment_method: 'cash', payment_status: 'unpaid', customer_id: 'cust-1', provider_id: 'prof-1', scheduled_at: null, created_at: '2026-11-17T10:00:00Z' },
      { id: 'job-2', request_id: 'r2', agreed_price: '1500', final_price: '1500', state: 'PAYMENT_SETTLED', payment_method: 'cash', payment_status: 'settled', customer_id: 'cust-1', provider_id: 'prof-1', scheduled_at: null, created_at: '2026-11-16T10:00:00Z' },
      { id: 'job-1', request_id: 'r1', agreed_price: '1000', final_price: '1000', state: 'RATED', payment_method: 'cash', payment_status: 'settled', customer_id: 'cust-1', provider_id: 'prof-1', scheduled_at: null, created_at: '2026-11-15T10:00:00Z' },
    ];
    db.on(/FROM jobs j LEFT JOIN service_requests/, () => ({ rows: calls++ === 0 ? jobRows : jobRows.slice(2) }));
    const svc = new JobsQueryService(db as never, redisStub as never);
    const page1 = await svc.listJobs('cust-1', 'customer', undefined, undefined, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].id).toBe('job-3');
    expect(page1.next_cursor).toBe('job-2');
    const page2 = await svc.listJobs('cust-1', 'customer', undefined, 'job-2', 2);
    expect(page2.items).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
  });

  it('suspend flips user status and writes an audit row', async () => {
    const db = new FakeDb();
    db.onRows(/FROM users WHERE id/, [{ id: 'u-1', phone: '+923001234567', status: 'active' }]);
    db.onRows(/UPDATE users SET status/, [{ id: 'u-1', phone: '+923001234567', status: 'suspended' }]);
    const svc = new AdminService(db as never, noRealtime as never, {} as never);
    const out = await svc.suspendUser('admin-1', 'u-1', true);
    expect(out.status).toBe('suspended');
    const audits = db.matching(/INSERT INTO audit_logs/);
    expect(audits).toHaveLength(1);
    expect(audits[0].params[1]).toBe('user.suspend');
  });

  it('waitlist join is idempotent per user + category + cell', async () => {
    const db = new FakeDb();
    const catalogStub = { categoryLookup: () => ({ byId: async () => ({ id: 'cat-1' }), bySlug: async () => ({ id: 'cat-1' }) }) };
    let selects = 0;
    db.on(/FROM waitlist WHERE user_id/, () => ({
      rows: selects++ === 0 ? [] : [{ id: 'wl-1', category_id: 'cat-1', lat: '30.18', lng: '66.975', status: 'waiting', created_at: '2026-11-17T10:00:00Z' }],
    }));
    db.onRows(/INSERT INTO waitlist/, [{ id: 'wl-1', category_id: 'cat-1', lat: '30.18', lng: '66.975', status: 'waiting', created_at: '2026-11-17T10:00:00Z' }]);
    const svc = new RequestsService(db as never, redisStub as never, noRealtime as never, catalogStub as never);
    const first = await svc.joinWaitlist('cust-1', { category_slug: 'book-binding', lat: 30.1798, lng: 66.975 });
    const second = await svc.joinWaitlist('cust-1', { category_slug: 'book-binding', lat: 30.1799, lng: 66.9751 });
    expect(first.id).toBe('wl-1');
    expect(second.id).toBe('wl-1');
    expect(db.matching(/INSERT INTO waitlist/)).toHaveLength(1); // same ~110m cell, no duplicate
    expect(first.lat).toBe(30.18); // cell-rounded coordinate echoed back
  });

  it('form-schema validation accepts a real schema and rejects stubs', () => {
    expect(() => validateFormSchema({ type: 'object', properties: { books: { type: 'integer' }, size: { type: 'string', enum: ['A4', 'A5'] } }, required: ['books'] })).not.toThrow();
    expect(() => validateFormSchema({ type: 'array', properties: {} })).toThrow();
    expect(() => validateFormSchema({ type: 'object' })).toThrow();
    expect(() => validateFormSchema({ type: 'object', properties: { books: {} } })).toThrow();
    expect(() => validateFormSchema({ type: 'object', properties: { size: { type: 'string', enum: 'A4' } } })).toThrow();
  });
});
