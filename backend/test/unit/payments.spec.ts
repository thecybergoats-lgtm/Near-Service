// Payments unit tests — wallet ledger, top-up, wallet-paid settlement,
// promo abuse limits, referrals. Runs against an in-memory FakeDb that
// interprets exactly the SQL the services emit (no live Postgres here).
import { randomUUID } from 'crypto';
import { WalletService } from '../../src/modules/payments/wallet.service';
import { PromotionsService } from '../../src/modules/payments/promotions.service';
import { ApiError } from '../../src/common/errors/api-error';

/* ------------------------------------------------------------------ */
/* FakeDb: minimal in-memory interpreter for the SQL our services emit */
/* ------------------------------------------------------------------ */
type Row = Record<string, any>;

class FakeDb {
  users: Row[] = [];
  wallet_accounts: Row[] = [];
  ledger_entries: Row[] = [];
  payments: Row[] = [];
  jobs: Row[] = [];
  provider_profiles: Row[] = [];
  promos: Row[] = [];
  promo_redemptions: Row[] = [];
  referrals: Row[] = [];
  job_events: Row[] = [];
  private ledgerSeq = 0;

  async withTransaction<T>(fn: (c: FakeDb) => Promise<T>): Promise<T> {
    return fn(this); // no real txn in memory; services still get atomicity via throws
  }

  async query(text: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    const p = params as any[];
    const has = (s: string) => text.includes(s);

    if (has('INSERT INTO wallet_accounts')) {
      if (this.wallet_accounts.some((w) => w.user_id === p[0])) return { rows: [] };
      const row = { id: randomUUID(), user_id: p[0], balance_paisa: 0, escrow_held_paisa: 0, currency: 'PKR' };
      this.wallet_accounts.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (has('SELECT id FROM wallet_accounts')) {
      const w = this.wallet_accounts.find((x) => x.user_id === p[0]);
      return { rows: w ? [{ id: w.id }] : [] };
    }
    if (has('SELECT balance_paisa, escrow_held_paisa, currency FROM wallet_accounts')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      return { rows: w ? [{ balance_paisa: String(w.balance_paisa), escrow_held_paisa: String(w.escrow_held_paisa), currency: 'PKR' }] : [] };
    }
    if (has('SELECT balance_paisa FROM wallet_accounts')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      return { rows: w ? [{ balance_paisa: String(w.balance_paisa) }] : [] };
    }
    if (has('UPDATE wallet_accounts SET balance_paisa = balance_paisa + $2')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      if (w) w.balance_paisa += p[1];
      return { rows: [] };
    }
    if (has('UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      if (w) w.balance_paisa -= p[1];
      return { rows: [] };
    }
    if (has('SELECT COALESCE(SUM(amount),0) AS total FROM payments')) {
      const total = this.payments.filter((x) => x.payer_id === p[0] && x.method === 'wallet' && x.status === 'confirmed')
        .reduce((s, x) => s + Number(x.amount), 0);
      return { rows: [{ total: String(total) }] };
    }
    if (has("FROM jobs WHERE customer_id=$1 AND state='COMPLETED'")) {
      const total = this.jobs.filter((j) => j.customer_id === p[0] && j.state === 'COMPLETED' && j.payment_status === 'unpaid')
        .reduce((s, j) => s + Number(j.final_price), 0);
      return { rows: [{ total: String(total) }] };
    }
    if (has('SUM(j.final_price - j.commission_amount)')) {
      const profIds = new Set(this.provider_profiles.filter((x) => x.user_id === p[0]).map((x) => x.id));
      const total = this.jobs.filter((j) => profIds.has(j.provider_id) && j.payment_status === 'settled')
        .reduce((s, j) => s + (Number(j.final_price) - Number(j.commission_amount ?? 0)), 0);
      return { rows: [{ total: String(total) }] };
    }
    if (has('SUM(j.final_price)')) {
      const profIds = new Set(this.provider_profiles.filter((x) => x.user_id === p[0]).map((x) => x.id));
      const total = this.jobs.filter((j) => profIds.has(j.provider_id) && j.state === 'COMPLETED' && j.payment_status === 'unpaid')
        .reduce((s, j) => s + Number(j.final_price), 0);
      return { rows: [{ total: String(total) }] };
    }
    if (has('FROM ledger_entries')) {
      let rows = this.ledger_entries.filter((e) => e.wallet_id === p[0]);
      if (p.length === 3) rows = rows.filter((e) => e.id < Number(p[1]));
      rows = [...rows].sort((a, b) => b.id - a.id).slice(0, Number(p[p.length - 1]));
      return { rows: rows.map((e) => ({ ...e })) };
    }
    if (has('INSERT INTO ledger_entries')) {
      const row: Row = { id: ++this.ledgerSeq, txn_id: p[0], wallet_id: p[1], account_code: p[2], direction: p[3], amount_paisa: p[4] };
      if (p.length === 7) { row.job_id = p[5]; row.memo = p[6]; } else { row.job_id = null; row.memo = p[5]; }
      row.created_at = new Date().toISOString();
      this.ledger_entries.push(row);
      return { rows: [] };
    }
    if (has('SELECT * FROM payments WHERE id=$1 FOR UPDATE')) {
      const row = this.payments.find((x) => x.id === p[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (has('INSERT INTO payments')) {
      const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), updated_at: null };
      if (has("'gateway'")) {
        Object.assign(row, { job_id: null, payer_id: p[0], method: 'gateway', provider_name: p[1], provider_ref: p[2], amount: p[3], status: 'initiated', idempotency_key: p[4] });
      } else {
        Object.assign(row, { job_id: p[0], payer_id: p[1], method: 'wallet', provider_name: 'wallet', provider_ref: null, amount: p[2], status: 'confirmed', idempotency_key: null });
      }
      this.payments.push(row);
      return { rows: [{ ...row }] };
    }
    if (has("UPDATE payments SET status='confirmed'")) {
      const row = this.payments.find((x) => x.id === p[0]);
      if (row) { row.status = 'confirmed'; row.updated_at = new Date().toISOString(); }
      return { rows: row ? [{ ...row }] : [] };
    }
    if (has('SELECT j.*, p.user_id AS provider_user_id FROM jobs')) {
      const job = this.jobs.find((j) => j.id === p[0]);
      if (!job) return { rows: [] };
      const prof = this.provider_profiles.find((x) => x.id === job.provider_id);
      return { rows: [{ ...job, provider_user_id: prof?.user_id }] };
    }
    if (has('SELECT * FROM jobs WHERE id=$1')) {
      const job = this.jobs.find((j) => j.id === p[0]);
      return { rows: job ? [{ ...job }] : [] };
    }
    if (has('SELECT * FROM promos WHERE code=$1')) {
      const row = this.promos.find((x) => x.code === p[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (has('SELECT per_user_limit FROM promos WHERE id=$1')) {
      const row = this.promos.find((x) => x.id === p[0]);
      return { rows: row ? [{ per_user_limit: row.per_user_limit }] : [] };
    }
    if (has('FROM promo_redemptions WHERE promo_id=$1 AND user_id=$2')) {
      const n = this.promo_redemptions.filter((r) => r.promo_id === p[0] && r.user_id === p[1]).length;
      return { rows: [{ cnt: String(n) }] };
    }
    if (has('FROM promo_redemptions WHERE promo_id=$1 AND device_fingerprint=$2')) {
      const n = this.promo_redemptions.filter((r) => r.promo_id === p[0] && r.device_fingerprint === p[1]).length;
      return { rows: [{ cnt: String(n) }] };
    }
    if (has('FROM promo_redemptions WHERE promo_id=$1')) {
      const n = this.promo_redemptions.filter((r) => r.promo_id === p[0]).length;
      return { rows: [{ cnt: String(n) }] };
    }
    if (has('INSERT INTO promo_redemptions')) {
      this.promo_redemptions.push({ promo_id: p[0], user_id: p[1], job_id: p[2], device_fingerprint: p[3] });
      return { rows: [] };
    }
    if (has("FROM jobs WHERE customer_id=$1 AND payment_status='settled'")) {
      const n = this.jobs.filter((j) => j.customer_id === p[0] && j.payment_status === 'settled').length;
      return { rows: [{ cnt: String(n) }] };
    }
    if (has("UPDATE jobs SET state='PAYMENT_SETTLED'")) {
      const job = this.jobs.find((j) => j.id === p[0]);
      if (job) { job.state = 'PAYMENT_SETTLED'; job.payment_status = 'settled'; job.payment_method = 'wallet'; job.commission_amount = p[1]; }
      return { rows: [] };
    }
    if (has('INSERT INTO job_events')) {
      this.job_events.push({ job_id: p[0], from_state: 'COMPLETED', to_state: 'PAYMENT_SETTLED', actor_user_id: p[1], actor_role: 'customer', payload: p[2] });
      return { rows: [] };
    }
    if (has("SELECT * FROM referrals WHERE referred_id=$1 AND status='pending'")) {
      const row = this.referrals.find((r) => r.referred_id === p[0] && r.status === 'pending');
      return { rows: row ? [{ ...row }] : [] };
    }
    if (has('SELECT status, credit_paisa FROM referrals WHERE referrer_id=$1')) {
      return { rows: this.referrals.filter((r) => r.referrer_id === p[0]).map((r) => ({ status: r.status, credit_paisa: String(r.credit_paisa) })) };
    }
    if (has('SELECT id FROM users WHERE UPPER(LEFT')) {
      const u = this.users.find((x) => String(x.id).replace(/-/g, '').slice(0, 8).toUpperCase() === p[0]);
      return { rows: u ? [{ id: u.id }] : [] };
    }
    if (has('INSERT INTO referrals')) {
      if (this.referrals.some((r) => r.referred_id === p[1])) return { rows: [] };
      const row = { id: randomUUID(), referrer_id: p[0], referred_id: p[1], credit_paisa: 0, status: 'pending' };
      this.referrals.push(row);
      return { rows: [{ ...row }] };
    }
    if (has("UPDATE referrals SET status='credited'")) {
      const row = this.referrals.find((r) => r.id === p[0]);
      if (row) { row.status = 'credited'; row.credit_paisa = p[1]; }
      return { rows: [] };
    }
    throw new Error(`FakeDb: unhandled SQL: ${text}`);
  }
}

class FakeRedis {
  private store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async set(k: string, v: string) { this.store.set(k, v); }
  async del(k: string) { this.store.delete(k); }
  async setNx(k: string, v: string) { if (this.store.has(k)) return false; this.store.set(k, v); return true; }
}
const fakeRealtime = { emitToRoom: () => undefined, emitToUser: () => undefined };

/* ------------------------------------------------------------------ */
/* World builders                                                      */
/* ------------------------------------------------------------------ */
const CUSTOMER = 'c0010001-4000-8000-000000000001';
const PROVIDER_USER = '9a010001-4000-8000-000000000001';
const PROVIDER_PROFILE = 'prof-0001-4000-8000-000000000001';
const REFERRER = 'beef0001-4000-8000-000000000001';

function makeWorld() {
  const db = new FakeDb();
  db.users.push({ id: CUSTOMER }, { id: PROVIDER_USER }, { id: REFERRER });
  db.provider_profiles.push({ id: PROVIDER_PROFILE, user_id: PROVIDER_USER, tier: 0 });
  const promos = new PromotionsService(db as any);
  const wallet = new WalletService(db as any, new FakeRedis() as any, fakeRealtime as any, promos);
  return { db, promos, wallet };
}

function seedJob(db: FakeDb, id: string, customerId: string, finalPricePkr: number, state = 'COMPLETED') {
  const job = {
    id, request_id: randomUUID(), offer_id: randomUUID(), customer_id: customerId,
    provider_id: PROVIDER_PROFILE, agreed_price: finalPricePkr, final_price: finalPricePkr,
    commission_rate: 0.1, commission_amount: null, state, payment_method: 'cash', payment_status: 'unpaid',
    // Batch 2 (§6a): seeded jobs are already customer-confirmed, so the
    // wallet-payment tests exercise settlement, not the confirm gate.
    completion_confirmed_at: new Date().toISOString(), completion_confirmed_by: customerId,
  };
  db.jobs.push(job);
  return job;
}

function seedPromo(db: FakeDb, partial: Record<string, any>) {
  const promo = {
    id: randomUUID(), code: 'PROMO1', kind: 'percent', value: 10, max_uses: null,
    per_user_limit: 1, per_device_limit: 1, category_id: null, city_id: null,
    first_job_only: false, valid_from: new Date(Date.now() - 86400000).toISOString(),
    valid_to: null, is_active: true, ...partial,
  };
  db.promos.push(promo);
  return promo;
}

/** Assert every txn_id in the ledger is balanced (sum D == sum C). */
function expectLedgerBalanced(db: FakeDb) {
  const byTxn = new Map<string, { d: number; c: number }>();
  for (const e of db.ledger_entries) {
    const t = byTxn.get(e.txn_id) ?? { d: 0, c: 0 };
    if (e.direction === 'D') t.d += e.amount_paisa; else t.c += e.amount_paisa;
    byTxn.set(e.txn_id, t);
  }
  expect(byTxn.size).toBeGreaterThan(0);
  for (const [txn, sums] of byTxn) {
    expect(sums.d).toBe(sums.c);
  }
}

async function topUp(wallet: WalletService, userId: string, pkr: number) {
  const init = await wallet.initiateTopup(userId, 'jazzcash', pkr, '+923001234567');
  expect(init.sandbox).toBe(true);
  expect(init.reference).toMatch(/^JC-SANDBOX-[0-9A-F]{8}$/);
  const confirmed = await wallet.confirmTopup(userId, init.payment_id);
  expect(confirmed.status).toBe('confirmed');
  return confirmed;
}

async function expectApiError(p: Promise<unknown>, status: number, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    expect((e as ApiError).code).toBe(code);
    return;
  }
  throw new Error(`expected ApiError ${status} ${code}, but the call succeeded`);
}

/* ------------------------------------------------------------------ */
/* Wallet ledger                                                       */
/* ------------------------------------------------------------------ */
describe('wallet ledger (top-up → pay)', () => {
  it('top-up +10000 paisa credits the wallet with a balanced ledger', async () => {
    const { db, wallet } = makeWorld();
    const out = await topUp(wallet, CUSTOMER, 100); // PKR 100 = 10000 paisa
    expect(out.wallet.balance_paisa).toBe(10000);
    expect(out.wallet.balance_pkr).toBe(100);
    expect(out.wallet.currency).toBe('PKR');
    expectLedgerBalanced(db);
    const txns = await wallet.listTransactions(CUSTOMER);
    expect(txns.items).toHaveLength(2);
    expect(txns.items.map((i) => i.account_code).sort()).toEqual(['cash_in', 'wallet']);
  });

  it('pay-wallet settles a PKR 1000 job: customer −100000, provider +90000, ledger balanced', async () => {
    const { db, wallet } = makeWorld();
    await topUp(wallet, CUSTOMER, 2000);
    seedJob(db, 'job-0001', CUSTOMER, 1000);
    const res = await wallet.payWithWallet('job-0001', CUSTOMER);
    expect(res.job.state).toBe('PAYMENT_SETTLED');
    expect(res.commission_paisa).toBe(10000);
    const cust = await wallet.getWalletView(CUSTOMER);
    const prov = await wallet.getWalletView(PROVIDER_USER);
    expect(cust.balance_paisa).toBe(100000); // 200000 − 100000
    expect(prov.balance_paisa).toBe(90000); // 100000 − 10% commission
    expect(cust.profile_views.customer.spent_pkr).toBe(1000);
    expect(prov.profile_views.provider.earnings_pkr).toBe(900);
    expect(prov.profile_views.provider.commission_owed_pkr).toBe(0);
    expectLedgerBalanced(db);
    const job = db.jobs.find((j) => j.id === 'job-0001');
    expect(job?.payment_status).toBe('settled');
    expect(job?.payment_method).toBe('wallet');
    const payment = db.payments.find((x) => x.job_id === 'job-0001');
    expect(payment?.method).toBe('wallet');
    expect(payment?.status).toBe('confirmed');
    expect(db.job_events.some((e) => e.job_id === 'job-0001' && e.to_state === 'PAYMENT_SETTLED')).toBe(true);
  });

  it('rejects wallet payment with 409 INSUFFICIENT_WALLET_BALANCE and moves no money', async () => {
    const { db, wallet } = makeWorld();
    seedJob(db, 'job-0001', CUSTOMER, 1000);
    await expectApiError(wallet.payWithWallet('job-0001', CUSTOMER), 409, 'INSUFFICIENT_WALLET_BALANCE');
    expect(db.ledger_entries).toHaveLength(0);
    expect(db.jobs[0].state).toBe('COMPLETED');
  });

  it('rejects wallet payment from a non-COMPLETED job and from a non-customer', async () => {
    const { db, wallet } = makeWorld();
    await topUp(wallet, CUSTOMER, 2000);
    seedJob(db, 'job-0001', CUSTOMER, 1000, 'IN_PROGRESS');
    await expectApiError(wallet.payWithWallet('job-0001', CUSTOMER), 409, 'NOT_COMPLETED');
    seedJob(db, 'job-0002', CUSTOMER, 1000);
    await expectApiError(wallet.payWithWallet('job-0002', PROVIDER_USER), 403, 'FORBIDDEN');
  });

  it('Batch 2 §6a: wallet payment is blocked until the customer confirms completion', async () => {
    const { db, wallet } = makeWorld();
    await topUp(wallet, CUSTOMER, 2000);
    const job = seedJob(db, 'job-0001', CUSTOMER, 1000);
    (job as { completion_confirmed_at: string | null; completion_confirmed_by: string | null }).completion_confirmed_at = null;
    (job as { completion_confirmed_at: string | null; completion_confirmed_by: string | null }).completion_confirmed_by = null;
    await expectApiError(wallet.payWithWallet('job-0001', CUSTOMER), 409, 'COMPLETION_NOT_CONFIRMED');
    // No payment moved: only the 2 top-up legs exist.
    expect(db.ledger_entries).toHaveLength(2);
    expect(db.ledger_entries.every((e) => e.job_id === null)).toBe(true);
    expect(db.jobs[0].state).toBe('COMPLETED');
    job.completion_confirmed_at = new Date().toISOString();
    job.completion_confirmed_by = CUSTOMER;
    const res = await wallet.payWithWallet('job-0001', CUSTOMER);
    expect(res.job.state).toBe('PAYMENT_SETTLED');
  });

  it('FIRSTJOB10: 10% discount absorbed by the platform, provider still gets full price − commission', async () => {
    const { db, wallet } = makeWorld();
    seedPromo(db, { code: 'FIRSTJOB10', kind: 'percent', value: 10, first_job_only: true });
    await topUp(wallet, CUSTOMER, 2000);
    seedJob(db, 'job-0001', CUSTOMER, 1000);
    const res = await wallet.payWithWallet('job-0001', CUSTOMER, 'FIRSTJOB10');
    expect(res.discount_paisa).toBe(10000);
    const cust = await wallet.getWalletView(CUSTOMER);
    const prov = await wallet.getWalletView(PROVIDER_USER);
    expect(cust.balance_paisa).toBe(110000); // 200000 − 90000 paid
    expect(prov.balance_paisa).toBe(90000); // full 100000 − 10000 commission
    expect(db.promo_redemptions).toHaveLength(1);
    expectLedgerBalanced(db); // D 90000 + D promo_expense 10000 = C 90000 + C commission 10000
  });

  it('paginates wallet transactions with a cursor', async () => {
    const { wallet } = makeWorld();
    await topUp(wallet, CUSTOMER, 2000); // 2 ledger rows: D cash_in / C wallet
    const page1 = await wallet.listTransactions(CUSTOMER, undefined, 1);
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await wallet.listTransactions(CUSTOMER, page1.next_cursor ?? undefined, 10);
    expect(page2.items).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
  });

  it('lists the four payment methods with sandbox flags', () => {
    const { wallet } = makeWorld();
    expect(wallet.getPaymentMethods()).toEqual([
      { id: 'cash', label: 'Cash on completion', sandbox: false },
      { id: 'wallet', label: 'Near Service wallet', sandbox: false },
      { id: 'jazzcash', label: 'JazzCash', sandbox: true },
      { id: 'easypaisa', label: 'Easypaisa', sandbox: true },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Promo abuse limits                                                  */
/* ------------------------------------------------------------------ */
describe('promo validation (abuse limits, side-effect free)', () => {
  it('rejects an unknown code and an expired code', async () => {
    const { promos } = makeWorld();
    const missing = await promos.validatePromo({ code: 'NOPE', userId: CUSTOMER });
    expect(missing.valid).toBe(false);
    expect(missing.reason).toBe('PROMO_NOT_FOUND');
    const { db, promos: p2 } = makeWorld();
    seedPromo(db, { code: 'OLD', valid_to: new Date(Date.now() - 1000).toISOString() });
    const expired = await p2.validatePromo({ code: 'OLD', userId: CUSTOMER });
    expect(expired.valid).toBe(false);
    expect(expired.reason).toBe('PROMO_EXPIRED');
  });

  it('enforces per-user and per-device limits', async () => {
    const { db, promos } = makeWorld();
    const promo = seedPromo(db, { code: 'ONCE', per_user_limit: 1, per_device_limit: 1 });
    const ok = await promos.validatePromo({ code: 'ONCE', userId: CUSTOMER, deviceFingerprint: 'dev-1', amountPkr: 1000 });
    expect(ok.valid).toBe(true);
    expect(ok.discount_paisa).toBe(10000);
    // Simulate a redemption, then the same user / same device are blocked.
    db.promo_redemptions.push({ promo_id: promo.id, user_id: CUSTOMER, job_id: 'job-x', device_fingerprint: 'dev-1' });
    const byUser = await promos.validatePromo({ code: 'ONCE', userId: CUSTOMER, deviceFingerprint: 'dev-2', amountPkr: 1000 });
    expect(byUser.valid).toBe(false);
    expect(byUser.reason).toBe('PROMO_PER_USER_LIMIT');
    const byDevice = await promos.validatePromo({ code: 'ONCE', userId: 'other-user', deviceFingerprint: 'dev-1', amountPkr: 1000 });
    expect(byDevice.valid).toBe(false);
    expect(byDevice.reason).toBe('PROMO_PER_DEVICE_LIMIT');
  });

  it('enforces first-job-only: a user with a settled job cannot use FIRSTJOB10', async () => {
    const { db, promos } = makeWorld();
    seedPromo(db, { code: 'FIRSTJOB10', first_job_only: true });
    seedJob(db, 'job-old', CUSTOMER, 500);
    db.jobs[0].state = 'PAYMENT_SETTLED';
    db.jobs[0].payment_status = 'settled';
    const v = await promos.validatePromo({ code: 'FIRSTJOB10', userId: CUSTOMER, amountPkr: 1000 });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('PROMO_FIRST_JOB_ONLY');
  });

  it('validation is side-effect free: no redemption rows are created', async () => {
    const { db, promos } = makeWorld();
    seedPromo(db, { code: 'FIRSTJOB10', first_job_only: true });
    await promos.validatePromo({ code: 'FIRSTJOB10', userId: CUSTOMER, amountPkr: 1000 });
    await promos.validatePromo({ code: 'FIRSTJOB10', userId: CUSTOMER, amountPkr: 1000 });
    await promos.validatePromo({ code: 'NOPE', userId: CUSTOMER });
    expect(db.promo_redemptions).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Referrals                                                           */
/* ------------------------------------------------------------------ */
describe('referrals', () => {
  it('credits the referrer PKR 200 on the referred user first paid job only', async () => {
    const { db, wallet, promos } = makeWorld();
    db.referrals.push({ id: randomUUID(), referrer_id: REFERRER, referred_id: CUSTOMER, credit_paisa: 0, status: 'pending' });
    await topUp(wallet, CUSTOMER, 2000);
    seedJob(db, 'job-0001', CUSTOMER, 1000);
    await wallet.payWithWallet('job-0001', CUSTOMER);
    const refWallet = await wallet.getWalletView(REFERRER);
    expect(refWallet.balance_paisa).toBe(20000);
    expect(db.referrals[0].status).toBe('credited');
    expect(db.referrals[0].credit_paisa).toBe(20000);
    expectLedgerBalanced(db);
    // Second paid job: no second credit.
    await topUp(wallet, CUSTOMER, 2000);
    seedJob(db, 'job-0002', CUSTOMER, 1000);
    await wallet.payWithWallet('job-0002', CUSTOMER);
    const refWallet2 = await wallet.getWalletView(REFERRER);
    expect(refWallet2.balance_paisa).toBe(20000);
    const info = await promos.getReferralInfo(REFERRER);
    expect(info).toEqual({ code: 'NS-BEEF0001', referred_count: 1, credit_paisa: 20000, pending_count: 0 });
  });

  it('claim links a referrer by code, rejects self-referral and duplicates', async () => {
    const { db, promos } = makeWorld();
    const info = await promos.claimReferral(CUSTOMER, 'NS-BEEF0001');
    expect(info.code).toBe('NS-C0010001');
    expect(info.referred_count).toBe(0);
    await expectApiError(promos.claimReferral(CUSTOMER, 'NS-BEEF0001'), 409, 'ALREADY_REFERRED');
    await expectApiError(promos.claimReferral(REFERRER, 'NS-BEEF0001'), 400, 'SELF_REFERRAL');
    await expectApiError(promos.claimReferral(CUSTOMER, 'NS-XXXXXXX'), 400, 'INVALID_REFERRAL_CODE');
    expect(db.referrals).toHaveLength(1);
  });
});
