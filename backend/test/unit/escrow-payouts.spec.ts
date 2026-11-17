// Escrow release + provider payouts — unit tests (Phase 3, item 8).
// Runs against an in-memory FakeDb that interprets exactly the SQL the
// EscrowService emits (no live Postgres here) — same pattern as
// test/unit/payments.spec.ts. Live-DB behaviour (including the 0008
// deferred ledger-balance trigger) is covered by
// test/integration/escrow-payouts.spec.ts against nearservice_p3_escrow.
import { randomUUID } from 'crypto';
import { EscrowService } from '../../src/modules/escrow/escrow.service';
import { autoReleaseAt, isAutoReleaseDue, payoutBreakdown, validateEscrowConfig } from '../../src/modules/escrow/escrow-calc';
import { DatabaseService } from '../../src/database/database.service';
import { RedisService } from '../../src/database/redis.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { ApiError } from '../../src/common/errors/api-error';

/* ------------------------------------------------------------------ */
/* FakeDb: minimal in-memory interpreter for the SQL EscrowService emits */
/* ------------------------------------------------------------------ */
type Row = Record<string, any>;

class FakeDb {
  users: Row[] = [];
  provider_profiles: Row[] = [];
  wallet_accounts: Row[] = [];
  ledger_entries: Row[] = [];
  jobs: Row[] = [];
  escrow_holds: Row[] = [];
  disputes: Row[] = [];
  payouts: Row[] = [];
  payments: Row[] = [];
  job_events: Row[] = [];
  feature_flags: Record<string, Row> = {};
  private ledgerSeq = 0;

  async withTransaction<T>(fn: (c: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }

  seedUser(phone: string): string {
    const id = randomUUID();
    this.users.push({ id, phone });
    return id;
  }
  seedProvider(userId: string): string {
    const id = randomUUID();
    this.provider_profiles.push({ id, user_id: userId });
    return id;
  }
  seedJob(customerId: string, providerId: string, finalPricePkr: number, commissionRate = 0.1): string {
    const id = randomUUID();
    this.jobs.push({
      id, customer_id: customerId, provider_id: providerId,
      agreed_price: finalPricePkr, final_price: finalPricePkr,
      commission_rate: commissionRate, commission_amount: null,
      state: 'COMPLETED', payment_status: 'unpaid',
      // Batch 2 (§6a): unconfirmed until the customer confirms (or the
      // customer release / auto-confirm sweep stamps it).
      completion_confirmed_at: null, completion_confirmed_by: null,
    });
    return id;
  }
  fundWallet(userId: string, balancePaisa: number): string {
    let w = this.wallet_accounts.find((x) => x.user_id === userId);
    if (!w) {
      w = { id: randomUUID(), user_id: userId, balance_paisa: 0, escrow_held_paisa: 0, currency: 'PKR' };
      this.wallet_accounts.push(w);
    }
    w.balance_paisa = balancePaisa;
    return w.id;
  }
  walletOf(userId: string): Row | undefined {
    return this.wallet_accounts.find((x) => x.user_id === userId);
  }
  /** Net D-C per txn_id over ledger_entries (must be 0 for every txn). */
  ledgerDiff(txnId: string): number {
    return this.ledger_entries
      .filter((e) => e.txn_id === txnId)
      .reduce((s, e) => s + (e.direction === 'D' ? e.amount_paisa : -e.amount_paisa), 0);
  }

  async query(text: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    const p = params as any[];
    const has = (s: string) => text.includes(s);

    if (has('SELECT config FROM feature_flags WHERE key=$1')) {
      const row = this.feature_flags[p[0]];
      return { rows: row ? [{ config: row.config }] : [] };
    }
    if (has('INSERT INTO feature_flags')) {
      this.feature_flags[p[0]] = { key: p[0], config: JSON.parse(p[1]) };
      return { rows: [] };
    }
    if (has('INSERT INTO wallet_accounts')) {
      if (this.wallet_accounts.some((w) => w.user_id === p[0])) return { rows: [] };
      const row = { id: randomUUID(), user_id: p[0], balance_paisa: 0, escrow_held_paisa: 0, currency: 'PKR' };
      this.wallet_accounts.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (has('SELECT id FROM wallet_accounts WHERE user_id=$1')) {
      const w = this.wallet_accounts.find((x) => x.user_id === p[0]);
      return { rows: w ? [{ id: w.id }] : [] };
    }
    if (has('SELECT balance_paisa FROM wallet_accounts WHERE id=$1 FOR UPDATE')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      return { rows: w ? [{ balance_paisa: String(w.balance_paisa) }] : [] };
    }
    if (has('UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      if (w) w.balance_paisa -= p[1];
      return { rows: [] };
    }
    if (has('UPDATE wallet_accounts SET balance_paisa = balance_paisa + $2')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      if (w) w.balance_paisa += p[1];
      return { rows: [] };
    }
    if (has('UPDATE wallet_accounts SET escrow_held_paisa = escrow_held_paisa + $2')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      if (w) w.escrow_held_paisa += p[1];
      return { rows: [] };
    }
    if (has('UPDATE wallet_accounts SET escrow_held_paisa = escrow_held_paisa - $2')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      if (w) w.escrow_held_paisa -= p[1];
      return { rows: [] };
    }
    if (has('SELECT j.*, p.user_id AS provider_user_id FROM jobs')) {
      const job = this.jobs.find((j) => j.id === p[0]);
      if (!job) return { rows: [] };
      const prof = this.provider_profiles.find((x) => x.id === job.provider_id);
      return { rows: [{ ...job, provider_user_id: prof?.user_id ?? null }] };
    }
    if (has('SELECT * FROM escrow_holds WHERE job_id=$1 FOR UPDATE')) {
      const h = this.escrow_holds.find((x) => x.job_id === p[0]);
      return { rows: h ? [{ ...h }] : [] };
    }
    if (has('SELECT * FROM escrow_holds WHERE id=$1 FOR UPDATE')) {
      const h = this.escrow_holds.find((x) => x.id === p[0]);
      return { rows: h ? [{ ...h }] : [] };
    }
    if (has("SELECT * FROM escrow_holds WHERE status='held' AND auto_release_at <=")) {
      const rows = this.escrow_holds
        .filter((x) => x.status === 'held' && new Date(x.auto_release_at).getTime() <= new Date(p[0]).getTime())
        .sort((a, b) => new Date(a.auto_release_at).getTime() - new Date(b.auto_release_at).getTime());
      return { rows: rows.map((r) => ({ ...r })) };
    }
    if (has('SELECT * FROM escrow_holds WHERE id=$1')) {
      const h = this.escrow_holds.find((x) => x.id === p[0]);
      return { rows: h ? [{ ...h }] : [] };
    }
    if (has('SELECT * FROM escrow_holds WHERE customer_id=$1 OR provider_user_id=$1')) {
      return { rows: this.escrow_holds.filter((x) => x.customer_id === p[0] || x.provider_user_id === p[0]).map((r) => ({ ...r })) };
    }
    if (has('SELECT * FROM escrow_holds WHERE status=$1')) {
      return { rows: this.escrow_holds.filter((x) => x.status === p[0]).map((r) => ({ ...r })) };
    }
    if (has('SELECT * FROM escrow_holds ORDER BY created_at DESC')) {
      return { rows: this.escrow_holds.map((r) => ({ ...r })) };
    }
    if (has('INSERT INTO escrow_holds')) {
      const row: Row = {
        id: randomUUID(), job_id: p[0], customer_id: p[1], provider_id: p[2], provider_user_id: p[3],
        amount_paisa: p[4], commission_paisa: p[5], status: 'held',
        held_at: new Date().toISOString(), auto_release_at: p[6],
        released_at: null, released_by: null, release_txn_id: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      this.escrow_holds.push(row);
      return { rows: [{ ...row }] };
    }
    if (has("UPDATE escrow_holds SET status='released'")) {
      const h = this.escrow_holds.find((x) => x.id === p[0]);
      if (h) {
        h.status = 'released'; h.released_at = p[1]; h.released_by = p[2]; h.release_txn_id = p[3]; h.updated_at = new Date().toISOString();
      }
      return { rows: h ? [{ ...h }] : [] };
    }
    if (has("SELECT COUNT(*) AS cnt FROM disputes WHERE job_id=$1 AND status='open'")) {
      const cnt = this.disputes.filter((d) => d.job_id === p[0] && d.status === 'open').length;
      return { rows: [{ cnt: String(cnt) }] };
    }
    if (has('INSERT INTO ledger_entries')) {
      const row: Row = {
        id: ++this.ledgerSeq, txn_id: p[0], wallet_id: p[1], account_code: p[2],
        direction: p[3], amount_paisa: p[4], job_id: p[5] ?? null, memo: p[6] ?? '',
        created_at: new Date().toISOString(),
      };
      this.ledger_entries.push(row);
      return { rows: [] };
    }
    if (has("UPDATE jobs SET payment_status='escrow_held'")) {
      const j = this.jobs.find((x) => x.id === p[0]);
      if (j) j.payment_status = 'escrow_held';
      return { rows: [] };
    }
    if (has("UPDATE jobs SET state='PAYMENT_SETTLED'")) {
      const j = this.jobs.find((x) => x.id === p[0]);
      if (j) { j.state = 'PAYMENT_SETTLED'; j.payment_status = 'settled'; j.commission_amount = p[1]; }
      return { rows: [] };
    }
    // Batch 2 (§6a): customer escrow release stamps the completion
    // confirmation (COALESCE — a prior confirmation is kept).
    if (has('UPDATE jobs SET completion_confirmed_at=COALESCE')) {
      const j = this.jobs.find((x) => x.id === p[0]);
      if (j && j.state === 'COMPLETED') {
        j.completion_confirmed_at = j.completion_confirmed_at ?? new Date().toISOString();
        j.completion_confirmed_by = j.completion_confirmed_by ?? p[1];
      }
      return { rows: [] };
    }
    // Batch 2 (§6a): admin/auto release gate — is the job confirmed yet?
    if (has('SELECT completion_confirmed_at FROM jobs WHERE id=$1')) {
      const j = this.jobs.find((x) => x.id === p[0]);
      return { rows: [{ completion_confirmed_at: j?.completion_confirmed_at ?? null }] };
    }
    if (has('INSERT INTO job_events')) {
      this.job_events.push({ job_id: p[0], from_state: p[1], to_state: p[2], actor_user_id: p[3], actor_role: p[4], payload: p[5] });
      return { rows: [] };
    }
    if (has('INSERT INTO payments')) {
      const row: Row = {
        id: randomUUID(), job_id: p[0], payer_id: p[1], method: 'escrow',
        provider_name: 'wallet', amount: p[2], status: 'confirmed', created_at: new Date().toISOString(),
      };
      this.payments.push(row);
      return { rows: [{ ...row }] };
    }
    if (has('SELECT id FROM provider_profiles WHERE user_id=$1')) {
      const prof = this.provider_profiles.find((x) => x.user_id === p[0]);
      return { rows: prof ? [{ id: prof.id }] : [] };
    }
    if (has('INSERT INTO payouts')) {
      const row: Row = {
        id: randomUUID(), wallet_id: p[0], job_id: p[1], escrow_hold_id: p[2],
        amount: p[3], amount_paisa: p[4], fee: p[5], fee_paisa: p[6],
        tax: JSON.parse(p[7]), tax_paisa: p[8], net_paisa: p[9],
        destination: p[10], destination_phone: p[11], provider_method: p[12],
        kind: p[13], status: p[14], scheduled_for: p[15],
        executed_at: null, provider_ref: null, approved_by: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      this.payouts.push(row);
      return { rows: [{ ...row }] };
    }
    if (has('SELECT * FROM payouts WHERE id=$1 FOR UPDATE')) {
      const r = this.payouts.find((x) => x.id === p[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    if (has("SELECT * FROM payouts WHERE status='approved' AND kind='scheduled'")) {
      const rows = this.payouts
        .filter((x) => x.status === 'approved' && x.kind === 'scheduled' && x.scheduled_for && new Date(x.scheduled_for).getTime() <= new Date(p[0]).getTime())
        .sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());
      return { rows: rows.map((r) => ({ ...r })) };
    }
    if (has("UPDATE payouts SET status='approved'")) {
      const r = this.payouts.find((x) => x.id === p[0]);
      if (r) { r.status = 'approved'; r.approved_by = p[1]; }
      return { rows: r ? [{ ...r }] : [] };
    }
    if (has("UPDATE payouts SET status='executed'")) {
      const r = this.payouts.find((x) => x.id === p[0]);
      if (r) { r.status = 'executed'; r.approved_by = p[1]; r.executed_at = p[2]; r.provider_ref = p[3]; }
      return { rows: r ? [{ ...r }] : [] };
    }
    if (has("UPDATE payouts SET status='rejected'")) {
      const r = this.payouts.find((x) => x.id === p[0]);
      if (r && ['requested', 'scheduled', 'approved'].includes(r.status)) {
        r.status = 'rejected'; r.approved_by = p[1];
        return { rows: [{ ...r }] };
      }
      return { rows: [] };
    }
    if (has("UPDATE payouts SET status='failed'")) {
      const r = this.payouts.find((x) => x.id === p[0]);
      if (r) r.status = 'failed';
      return { rows: [] };
    }
    if (has('SELECT * FROM payouts WHERE id=$1')) {
      const r = this.payouts.find((x) => x.id === p[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    if (has('SELECT * FROM payouts WHERE status=$1')) {
      return { rows: this.payouts.filter((x) => x.status === p[0]).map((r) => ({ ...r })) };
    }
    if (has('SELECT * FROM payouts ORDER BY created_at DESC')) {
      return { rows: this.payouts.map((r) => ({ ...r })) };
    }
    throw new Error(`FakeDb: unhandled SQL: ${text.slice(0, 160)}`);
  }
}

/* ------------------------------------------------------------------ */

function makeService(db: FakeDb): EscrowService {
  return new EscrowService(
    db as unknown as DatabaseService,
    new RedisService(),
    new RealtimeService(),
  );
}

function setupJob(db: FakeDb, finalPricePkr = 6000, customerBalancePaisa = 1_000_000) {
  const customerId = db.seedUser('+923001111111');
  const providerUserId = db.seedUser('+923002222222');
  const providerId = db.seedProvider(providerUserId);
  const jobId = db.seedJob(customerId, providerId, finalPricePkr);
  db.fundWallet(customerId, customerBalancePaisa);
  return { customerId, providerUserId, providerId, jobId };
}

function expectApiError(p: Promise<unknown>, code: string, status: number) {
  return expect(p).rejects.toMatchObject({ code, status } as Partial<ApiError>);
}

describe('escrow-calc (pure)', () => {
  it('payoutBreakdown: fee + tax + net sum to gross', () => {
    const b = payoutBreakdown(100_000, 0, 0.02, 0.1);
    expect(b.fee_paisa).toBe(2000);
    expect(b.tax_paisa).toBe(9800); // 10% of (100000 - 2000)
    expect(b.net_paisa).toBe(88_200);
    expect(b.fee_paisa + b.tax_paisa + b.net_paisa).toBe(100_000);
  });
  it('payoutBreakdown: zero fee/tax passes the gross through', () => {
    expect(payoutBreakdown(50_000, 0, 0, 0)).toEqual({ fee_paisa: 0, tax_paisa: 0, net_paisa: 50_000 });
  });
  it('payoutBreakdown: flat fee adds on top of the rate fee', () => {
    expect(payoutBreakdown(100_000, 500, 0.01, 0)).toEqual({ fee_paisa: 1500, tax_paisa: 0, net_paisa: 98_500 });
  });
  it('autoReleaseAt adds the admin-set hours', () => {
    const held = new Date('2026-11-17T00:00:00.000Z');
    expect(autoReleaseAt(held, 48).toISOString()).toBe('2026-11-19T00:00:00.000Z');
  });
  it('isAutoReleaseDue: due only when held, past deadline, no open dispute', () => {
    const now = new Date('2026-11-19T00:00:01.000Z');
    expect(isAutoReleaseDue('held', '2026-11-19T00:00:00.000Z', now, false)).toBe(true);
    expect(isAutoReleaseDue('held', '2026-11-19T00:00:00.000Z', now, true)).toBe(false);
    expect(isAutoReleaseDue('held', '2026-11-20T00:00:00.000Z', now, false)).toBe(false);
    expect(isAutoReleaseDue('released', '2026-11-19T00:00:00.000Z', now, false)).toBe(false);
  });
  it('validateEscrowConfig rejects out-of-band values', () => {
    expect(() => validateEscrowConfig({ auto_release_hours: 0 })).toThrow(RangeError);
    expect(() => validateEscrowConfig({ auto_release_hours: 721 })).toThrow(RangeError);
    expect(() => validateEscrowConfig({ payout_fee_rate: 0.6 })).toThrow(RangeError);
    expect(() => validateEscrowConfig({ payout_tax_rate: -0.01 })).toThrow(RangeError);
    expect(() => validateEscrowConfig({ auto_release_hours: 72 })).not.toThrow();
  });
});

describe('escrow holds', () => {
  it('createHold: debits customer, parks funds in escrow_held, ledger balanced', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const { customerId, jobId } = setupJob(db, 6000);
    const hold = await svc.createHold(jobId, customerId);
    expect(hold.status).toBe('held');
    expect(hold.amount_paisa).toBe(600_000);
    expect(hold.commission_paisa).toBe(60_000); // 10% of PKR 6,000
    expect(hold.amount_pkr).toBe(6000);
    const wallet = db.walletOf(customerId)!;
    expect(wallet.balance_paisa).toBe(400_000);
    expect(wallet.escrow_held_paisa).toBe(600_000);
    const txnIds = [...new Set(db.ledger_entries.map((e) => e.txn_id))];
    expect(txnIds).toHaveLength(1);
    expect(db.ledgerDiff(txnIds[0])).toBe(0); // D wallet 600k = C escrow_held 600k
    const job = db.jobs.find((j) => j.id === jobId)!;
    expect(job.payment_status).toBe('escrow_held');
  });

  it('createHold: below the high-value threshold is 422', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const { customerId, jobId } = setupJob(db, 4000); // PKR 4,000 < PKR 5,000 default
    await expectApiError(svc.createHold(jobId, customerId), 'ESCROW_BELOW_THRESHOLD', 422);
    expect(db.escrow_holds).toHaveLength(0);
    expect(db.ledger_entries).toHaveLength(0);
  });

  it('createHold: insufficient wallet balance is 409 and writes nothing', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const { customerId, jobId } = setupJob(db, 6000, 100_000);
    await expectApiError(svc.createHold(jobId, customerId), 'INSUFFICIENT_WALLET_BALANCE', 409);
    expect(db.escrow_holds).toHaveLength(0);
    expect(db.ledger_entries).toHaveLength(0);
  });

  it('createHold: a second hold on the same job is 409', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const { customerId, jobId } = setupJob(db, 6000);
    await svc.createHold(jobId, customerId);
    await expectApiError(svc.createHold(jobId, customerId), 'ESCROW_ALREADY_HELD', 409);
  });

  it('release on customer confirmation: provider gets amount - commission, ledger balanced, job settled', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const { customerId, providerUserId, jobId } = setupJob(db, 6000);
    const hold = await svc.createHold(jobId, customerId);
    const released = await svc.releaseHold(hold.id, customerId);
    expect(released.status).toBe('released');
    expect(released.release_txn_id).toBeTruthy();
    const custWallet = db.walletOf(customerId)!;
    expect(custWallet.balance_paisa).toBe(400_000); // unchanged by release
    expect(custWallet.escrow_held_paisa).toBe(0);
    const provWallet = db.walletOf(providerUserId)!;
    expect(provWallet.balance_paisa).toBe(540_000); // 600k - 10% commission
    // Release txn balanced: D escrow_held 600k = C wallet 540k + C commission_rev 60k.
    expect(db.ledgerDiff(released.release_txn_id!)).toBe(0);
    const legs = db.ledger_entries.filter((e) => e.txn_id === released.release_txn_id);
    expect(legs).toHaveLength(3);
    expect(legs.filter((e) => e.direction === 'D').reduce((s, e) => s + e.amount_paisa, 0)).toBe(600_000);
    expect(legs.filter((e) => e.direction === 'C').reduce((s, e) => s + e.amount_paisa, 0)).toBe(600_000);
    const job = db.jobs.find((j) => j.id === jobId)!;
    expect(job.state).toBe('PAYMENT_SETTLED');
    expect(job.payment_status).toBe('settled');
    expect(job.commission_amount).toBe(600); // PKR
    expect(db.payments).toHaveLength(1);
    expect(db.payments[0].method).toBe('escrow');
  });

  it('release: only the customer can confirm (provider is 403), second release is 409', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const { customerId, providerUserId, jobId } = setupJob(db, 6000);
    const hold = await svc.createHold(jobId, customerId);
    await expectApiError(svc.releaseHold(hold.id, providerUserId), 'FORBIDDEN', 403);
    await svc.releaseHold(hold.id, customerId);
    await expectApiError(svc.releaseHold(hold.id, customerId), 'ESCROW_NOT_HELD', 409);
  });

  it('release blocked when a dispute is open; hold stays held and no money moves', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const { customerId, jobId } = setupJob(db, 6000);
    const hold = await svc.createHold(jobId, customerId);
    db.disputes.push({ id: randomUUID(), job_id: jobId, status: 'open' });
    await expectApiError(svc.releaseHold(hold.id, customerId), 'ESCROW_DISPUTE_OPEN', 409);
    const stored = db.escrow_holds.find((h) => h.id === hold.id)!;
    expect(stored.status).toBe('held');
    expect(db.walletOf(customerId)!.escrow_held_paisa).toBe(600_000);
    expect(db.ledger_entries).toHaveLength(2); // hold legs only
  });

  it('auto-release after the admin-set hours with no dispute releases to the provider', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const { customerId, providerUserId, jobId } = setupJob(db, 6000);
    const hold = await svc.createHold(jobId, customerId);
    // Move the deadline into the past (hold was created with now + 48h).
    db.escrow_holds.find((h) => h.id === hold.id)!.auto_release_at =
      new Date(Date.now() - 60_000).toISOString();
    // Batch 2 (§6a): auto-release waits for completion confirmation.
    db.jobs.find((j) => j.id === jobId)!.completion_confirmed_at = new Date().toISOString();
    const out = await svc.releaseDueHolds();
    expect(out.released).toEqual([hold.id]);
    expect(out.skipped_dispute).toEqual([]);
    expect(out.skipped_unconfirmed).toEqual([]);
    expect(db.walletOf(providerUserId)!.balance_paisa).toBe(540_000);
    expect(db.escrow_holds.find((h) => h.id === hold.id)!.status).toBe('released');
    // Idempotent: a second sweep releases nothing twice.
    const again = await svc.releaseDueHolds();
    expect(again.released).toEqual([]);
  });

  it('Batch 2 (§6a): auto-release skips an unconfirmed hold; admin release is 409 until confirmed', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const { customerId, providerUserId, jobId } = setupJob(db, 6000);
    const hold = await svc.createHold(jobId, customerId);
    db.escrow_holds.find((h) => h.id === hold.id)!.auto_release_at =
      new Date(Date.now() - 60_000).toISOString();
    const out = await svc.releaseDueHolds();
    expect(out.released).toEqual([]);
    expect(out.skipped_unconfirmed).toEqual([hold.id]);
    expect(db.escrow_holds.find((h) => h.id === hold.id)!.status).toBe('held');
    expect(db.walletOf(providerUserId)).toBeUndefined();
    await expectApiError(svc.releaseHoldAsAdmin(hold.id, 'admin-1'), 'COMPLETION_NOT_CONFIRMED', 409);
    // Once the customer confirms, the sweep releases it.
    db.jobs.find((j) => j.id === jobId)!.completion_confirmed_at = new Date().toISOString();
    const out2 = await svc.releaseDueHolds();
    expect(out2.released).toEqual([hold.id]);
    expect(db.walletOf(providerUserId)!.balance_paisa).toBe(540_000);
  });

  it('auto-release is blocked when a dispute is open (hold skipped, funds stay parked)', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const { customerId, providerUserId, jobId } = setupJob(db, 6000);
    const hold = await svc.createHold(jobId, customerId);
    db.escrow_holds.find((h) => h.id === hold.id)!.auto_release_at =
      new Date(Date.now() - 60_000).toISOString();
    db.disputes.push({ id: randomUUID(), job_id: jobId, status: 'open' });
    const out = await svc.releaseDueHolds();
    expect(out.released).toEqual([]);
    expect(out.skipped_dispute).toEqual([hold.id]);
    expect(db.escrow_holds.find((h) => h.id === hold.id)!.status).toBe('held');
    expect(db.walletOf(providerUserId)).toBeUndefined();
    expect(db.walletOf(customerId)!.escrow_held_paisa).toBe(600_000);
  });

  it('auto-release does nothing before the deadline', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const { customerId, providerUserId, jobId } = setupJob(db, 6000);
    const hold = await svc.createHold(jobId, customerId);
    const out = await svc.releaseDueHolds();
    expect(out.released).toEqual([]);
    expect(out.skipped_dispute).toEqual([]);
    expect(db.escrow_holds.find((h) => h.id === hold.id)!.status).toBe('held');
    expect(db.walletOf(providerUserId)).toBeUndefined();
  });

  it('admin can change the auto-release hours; the next hold uses them', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const cfg = await svc.updateConfig('admin-1', { auto_release_hours: 72 });
    expect(cfg.auto_release_hours).toBe(72);
    const { customerId, jobId } = setupJob(db, 6000);
    const before = Date.now();
    const hold = await svc.createHold(jobId, customerId);
    const deadline = new Date(hold.auto_release_at).getTime();
    expect(deadline - before).toBeGreaterThanOrEqual(71 * 3600 * 1000);
    expect(deadline - before).toBeLessThanOrEqual(73 * 3600 * 1000);
    await expectApiError(svc.updateConfig('admin-1', { auto_release_hours: 0 }), 'INVALID_ESCROW_CONFIG', 422);
  });
});

describe('provider payouts', () => {
  /** Provider with PKR 5,400 spendable (as after a PKR 6,000 escrow release). */
  function setupProvider(db: FakeDb, balancePaisa = 540_000) {
    const providerUserId = db.seedUser('+923003333333');
    db.seedProvider(providerUserId);
    db.fundWallet(providerUserId, balancePaisa);
    return providerUserId;
  }

  it('instant payout: request is only recorded (no money moves) until finance approves', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const providerUserId = setupProvider(db);
    const payout = await svc.requestPayout(providerUserId, {
      amount_pkr: 1000, method: 'jazzcash', destination_phone: '+923001234567', kind: 'instant',
    });
    expect(payout.status).toBe('requested');
    expect(payout.kind).toBe('instant');
    expect(payout.amount_paisa).toBe(100_000);
    expect(payout.sandbox).toBe(true);
    expect(db.walletOf(providerUserId)!.balance_paisa).toBe(540_000); // untouched
    expect(db.ledger_entries).toHaveLength(0);
    const approved = await svc.approvePayout(payout.id, 'finance-1');
    expect(approved.status).toBe('executed');
    expect(approved.approved_by).toBe('finance-1');
    expect(approved.provider_ref).toMatch(/^JC-PAYOUT-SANDBOX-/); // sandbox mock reference
    expect(db.walletOf(providerUserId)!.balance_paisa).toBe(440_000);
    // Ledger balanced: D wallet 100k = C payout_out 100k (no fee/tax configured).
    const txnIds = [...new Set(db.ledger_entries.map((e) => e.txn_id))];
    expect(txnIds).toHaveLength(1);
    expect(db.ledgerDiff(txnIds[0])).toBe(0);
  });

  it('payout fee + tax: configured rates split gross into fee / tax / net, ledger balanced', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    await svc.updateConfig('admin-1', { payout_fee_rate: 0.02, payout_tax_rate: 0.1 });
    const providerUserId = setupProvider(db);
    const payout = await svc.requestPayout(providerUserId, {
      amount_pkr: 1000, method: 'easypaisa', destination_phone: '+923001234567', kind: 'instant',
    });
    expect(payout.fee_paisa).toBe(2000);
    expect(payout.tax_paisa).toBe(9800);
    expect(payout.net_paisa).toBe(88_200);
    const executed = await svc.approvePayout(payout.id, 'finance-1');
    expect(executed.status).toBe('executed');
    expect(executed.provider_ref).toMatch(/^EP-PAYOUT-SANDBOX-/);
    expect(db.walletOf(providerUserId)!.balance_paisa).toBe(440_000); // gross debited
    const legs = db.ledger_entries;
    expect(legs).toHaveLength(4); // D wallet + C payout_out + C fee_rev + C tax_payable
    expect(db.ledgerDiff(legs[0].txn_id)).toBe(0);
    const byAccount = Object.fromEntries(legs.map((e) => [`${e.direction}:${e.account_code}`, e.amount_paisa]));
    expect(byAccount['D:wallet']).toBe(100_000);
    expect(byAccount['C:payout_out']).toBe(88_200);
    expect(byAccount['C:payout_fee_rev']).toBe(2000);
    expect(byAccount['C:payout_tax_payable']).toBe(9800);
  });

  it('scheduled payout: approve only marks approved; run-due executes after scheduled_for', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const providerUserId = setupProvider(db);
    const future = new Date(Date.now() + 3600_000).toISOString();
    const payout = await svc.requestPayout(providerUserId, {
      amount_pkr: 1000, method: 'jazzcash', destination_phone: '+923001234567',
      kind: 'scheduled', scheduled_for: future,
    });
    expect(payout.status).toBe('scheduled');
    const approved = await svc.approvePayout(payout.id, 'finance-1');
    expect(approved.status).toBe('approved');
    expect(db.walletOf(providerUserId)!.balance_paisa).toBe(540_000); // still untouched
    // Not due yet: sweep does nothing.
    expect(await svc.executeDuePayouts(new Date())).toEqual(
      expect.objectContaining({ executed: [], failed: [] }),
    );
    // Past scheduled_for: sweep executes (sandbox) and debits gross.
    const done = await svc.executeDuePayouts(new Date(Date.now() + 2 * 3600_000));
    expect(done.executed).toEqual([payout.id]);
    expect(db.walletOf(providerUserId)!.balance_paisa).toBe(440_000);
    expect(db.payouts.find((x) => x.id === payout.id)!.status).toBe('executed');
  });

  it('scheduled payout needs a future scheduled_for (422 otherwise)', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const providerUserId = setupProvider(db);
    await expectApiError(
      svc.requestPayout(providerUserId, { amount_pkr: 1000, method: 'jazzcash', destination_phone: '+923001234567', kind: 'scheduled' }),
      'PAYOUT_SCHEDULE_MISSING', 422,
    );
    await expectApiError(
      svc.requestPayout(providerUserId, { amount_pkr: 1000, method: 'jazzcash', destination_phone: '+923001234567', kind: 'scheduled', scheduled_for: new Date(Date.now() - 1000).toISOString() }),
      'PAYOUT_SCHEDULE_PAST', 422,
    );
    await expectApiError(
      svc.requestPayout(providerUserId, { amount_pkr: 1000, method: 'jazzcash', destination_phone: '+923001234567', kind: 'instant', scheduled_for: new Date(Date.now() + 3600_000).toISOString() }),
      'PAYOUT_SCHEDULE_UNEXPECTED', 422,
    );
  });

  it('payout: insufficient balance is 409; non-provider is 403; reject moves no money', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    const providerUserId = setupProvider(db, 50_000);
    await expectApiError(
      svc.requestPayout(providerUserId, { amount_pkr: 1000, method: 'jazzcash', destination_phone: '+923001234567', kind: 'instant' }),
      'INSUFFICIENT_WALLET_BALANCE', 409,
    );
    const customerId = db.seedUser('+923004444444');
    db.fundWallet(customerId, 1_000_000);
    await expectApiError(
      svc.requestPayout(customerId, { amount_pkr: 1000, method: 'jazzcash', destination_phone: '+923001234567', kind: 'instant' }),
      'FORBIDDEN', 403,
    );
    const rich = setupProvider(db, 540_000);
    const payout = await svc.requestPayout(rich, {
      amount_pkr: 1000, method: 'jazzcash', destination_phone: '+923001234567', kind: 'instant',
    });
    const rejected = await svc.rejectPayout(payout.id, 'finance-1', 'missing verification');
    expect(rejected.status).toBe('rejected');
    expect(db.walletOf(rich)!.balance_paisa).toBe(540_000);
    expect(db.ledger_entries).toHaveLength(0);
    await expectApiError(svc.approvePayout(payout.id, 'finance-1'), 'PAYOUT_NOT_APPROVABLE', 409);
  });

  it('config defaults are 48h / PKR 5,000 / zero fee and tax', async () => {
    const db = new FakeDb();
    const svc = makeService(db);
    expect(await svc.getConfig()).toEqual({
      auto_release_hours: 48,
      min_amount_paisa: 500_000,
      payout_fee_flat_paisa: 0,
      payout_fee_rate: 0,
      payout_tax_rate: 0,
    });
  });
});
