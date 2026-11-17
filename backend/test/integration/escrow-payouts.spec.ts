// Escrow release + provider payouts — integration tests (Phase 3, item 8).
// REAL Postgres 16 + PostGIS 3 and REAL Redis. Run with:
//   DATABASE_URL=postgresql://escrow_test@localhost:5432/nearservice_p3_escrow
//   PGPASSFILE=$HOME/.pgpass REDIS_URL=redis://localhost:6379
//   NODE_ENV=test npx jest --runInBand test/integration/escrow-payouts.spec.ts
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0009 + 0015 (the only migrations this piece
// depends on — other Phase 3 workers' 0010–0014 are intentionally NOT
// applied here, so their state can never break this piece's tests).
// Only ever point it at the dedicated test DB nearservice_p3_escrow.
// Skipped entirely when DATABASE_URL or REDIS_URL is not set.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { DatabaseService } from '../../src/database/database.service';
import { RedisService } from '../../src/database/redis.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { EscrowService } from '../../src/modules/escrow/escrow.service';

jest.setTimeout(60000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
let phoneSeq = 0;
const PHONE = (n: string) => `+92301${RUN}${n}${phoneSeq++}`;
// Seeded by 0004_seed.sql.
const CATEGORY_ID = '00000000-0000-4000-8000-0000b0000001'; // Book Binding
// Only the migrations this piece depends on (0001–0009 + 0015 + 0023).
// 0023 is Batch 2: escrow release is gated on jobs.completion_confirmed_at
// (customer release implies confirmation; admin/auto release requires it),
// so the escrow tests need those columns even though this spec applies a
// subset of migrations.
const MIGRATIONS = [
  '0001_init.sql', '0002_requests_jobs.sql', '0003_money_trust.sql',
  '0004_seed.sql', '0005_phase2_payments.sql', '0006_phase2_ops.sql',
  '0007_revoke_refresh_families.sql', '0008_ledger_balance_guard.sql',
  '0009_stage3_fixes.sql', '0015_escrow_payouts.sql',
  '0023_batch2_trust_safety.sql',
];

maybeDescribe('escrow release + provider payouts (real DB + Redis)', () => {
  let dbSvc: DatabaseService;
  let redis: RedisService;
  let escrow: EscrowService;
  let admin: Client;
  let adminId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    for (const file of MIGRATIONS) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    redis = new RedisService();
    dbSvc = new DatabaseService();
    escrow = new EscrowService(dbSvc, redis, new RealtimeService());
    adminId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Escrow Finance Admin','ur') RETURNING id`,
      [`+92309${RUN}99`],
    )).rows[0].id as string;
  });

  afterAll(async () => {
    // Guarded: beforeAll may throw before these are assigned (e.g. a
    // migration fails) — a crashing afterAll would mask the real error.
    if (redis) await redis.onModuleDestroy();
    if (dbSvc) await dbSvc.onModuleDestroy();
    if (admin) await admin.end();
  });

  async function makeUser(phone: string): Promise<string> {
    return (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Escrow Test','ur') RETURNING id`,
      [phone],
    )).rows[0].id as string;
  }

  async function makeProvider(phone: string): Promise<{ userId: string; providerId: string }> {
    const userId = await makeUser(phone);
    const providerId = (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, base_point)
       VALUES ($1,'individual','Escrow Provider', ST_SetSRID(ST_MakePoint(66.9750,30.1798),4326)::geography) RETURNING id`,
      [userId],
    )).rows[0].id as string;
    return { userId, providerId };
  }

  /** A COMPLETED job at the given final price, with a funded customer wallet. */
  async function makeCompletedJob(finalPricePkr: number, customerBalancePaisa: number) {
    const customerId = await makeUser(PHONE('1'));
    const { userId: providerUserId, providerId } = await makeProvider(PHONE('2'));
    const requestId = (await admin.query(
      `INSERT INTO service_requests (customer_id, category_id, fulfillment, location, status)
       VALUES ($1,$2,'onsite', ST_SetSRID(ST_MakePoint(66.9750,30.1798),4326)::geography, 'ACCEPTED') RETURNING id`,
      [customerId, CATEGORY_ID],
    )).rows[0].id as string;
    const offerId = (await admin.query(
      `INSERT INTO offers (request_id, provider_id, offered_by, round, price, expires_at)
       VALUES ($1,$2,'provider',1,$3, now() + interval '1 day') RETURNING id`,
      [requestId, providerId, finalPricePkr],
    )).rows[0].id as string;
    const jobId = (await admin.query(
      `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price, commission_rate, state, payment_status)
       VALUES ($1,$2,$3,$4,$5,$5,0.1,'COMPLETED','unpaid') RETURNING id`,
      [requestId, offerId, customerId, providerId, finalPricePkr],
    )).rows[0].id as string;
    await admin.query(
      `INSERT INTO wallet_accounts (user_id, balance_paisa) VALUES ($1,$2)`,
      [customerId, customerBalancePaisa],
    );
    return { customerId, providerUserId, providerId, jobId };
  }

  async function walletOf(userId: string) {
    const row = (await admin.query(
      `SELECT balance_paisa, escrow_held_paisa FROM wallet_accounts WHERE user_id=$1`, [userId],
    )).rows[0] as { balance_paisa: string; escrow_held_paisa: string };
    // pg returns bigint columns as strings — coerce for numeric asserts.
    return { balance_paisa: Number(row.balance_paisa), escrow_held_paisa: Number(row.escrow_held_paisa) };
  }

  /** SUM(D) - SUM(C) per txn_id over ledger_entries — must be 0 everywhere. */
  async function ledgerDiffs(): Promise<{ txn_id: string; diff: number }[]> {
    const rows = (await admin.query(
      `SELECT txn_id, SUM(CASE WHEN direction='D' THEN amount_paisa ELSE -amount_paisa END)::bigint AS diff
         FROM ledger_entries GROUP BY txn_id HAVING SUM(CASE WHEN direction='D' THEN amount_paisa ELSE -amount_paisa END) <> 0`,
    )).rows;
    return rows as unknown as { txn_id: string; diff: number }[];
  }

  it('0015 applied: escrow_holds exists, payouts extended, escrow config seeded', async () => {
    const tables = (await admin.query(
      `SELECT to_regclass('public.escrow_holds') AS holds, to_regclass('public.payouts') AS payouts`,
    )).rows[0];
    expect(tables.holds).toBe('escrow_holds');
    expect(tables.payouts).toBe('payouts');
    const cols = (await admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='payouts'
        AND column_name IN ('amount_paisa','fee_paisa','tax_paisa','net_paisa','kind','provider_method','scheduled_for','provider_ref')`,
    )).rows;
    expect(cols).toHaveLength(8);
    const flags = (await admin.query(
      `SELECT key, config FROM feature_flags WHERE key LIKE 'escrow%' OR key LIKE 'payout%' ORDER BY key`,
    )).rows;
    expect(flags.map((r: { key: string }) => r.key)).toEqual([
      'escrow_auto_release_hours', 'escrow_min_amount_paisa',
      'payout_fee_flat_paisa', 'payout_fee_rate', 'payout_tax_rate',
    ]);
    expect((flags[0] as { config: { value_hours: number } }).config.value_hours).toBe(48);
  });

  it('golden flow: hold -> customer release -> provider paid, ledger balanced, job settled', async () => {
    const { customerId, providerUserId, jobId } = await makeCompletedJob(6000, 1_000_000);
    const hold = await escrow.createHold(jobId, customerId);
    expect(hold.status).toBe('held');
    expect(hold.amount_paisa).toBe(600_000);
    let w = await walletOf(customerId);
    expect(w.balance_paisa).toBe(400_000);
    expect(w.escrow_held_paisa).toBe(600_000);
    expect(await ledgerDiffs()).toEqual([]);

    const released = await escrow.releaseHold(hold.id, customerId);
    expect(released.status).toBe('released');
    expect(released.release_txn_id).toBeTruthy();
    w = await walletOf(customerId);
    expect(w.balance_paisa).toBe(400_000);
    expect(w.escrow_held_paisa).toBe(0);
    const pw = await walletOf(providerUserId);
    expect(pw.balance_paisa).toBe(540_000); // PKR 6,000 - 10% commission
    const job = (await admin.query(`SELECT state, payment_status, commission_amount FROM jobs WHERE id=$1`, [jobId])).rows[0];
    expect(job.state).toBe('PAYMENT_SETTLED');
    expect(job.payment_status).toBe('settled');
    expect(Number(job.commission_amount)).toBe(600);
    expect(await ledgerDiffs()).toEqual([]);
    // Release legs: D escrow_held 600k = C wallet 540k + C commission_rev 60k.
    const legs = (await admin.query(
      `SELECT account_code, direction, amount_paisa FROM ledger_entries WHERE txn_id=$1 ORDER BY direction, account_code`,
      [released.release_txn_id],
    )).rows.map((r: { account_code: string; direction: string; amount_paisa: string }) => ({
      account_code: r.account_code, direction: r.direction, amount: Number(r.amount_paisa),
    }));
    // ORDER BY direction, account_code: 'C' before 'D', and
    // 'commission_rev' before 'wallet' alphabetically.
    expect(legs).toEqual([
      { account_code: 'commission_rev', direction: 'C', amount: 60_000 },
      { account_code: 'wallet', direction: 'C', amount: 540_000 },
      { account_code: 'escrow_held', direction: 'D', amount: 600_000 },
    ]);
  });

  it('auto-release: due hold with no dispute releases; disputed hold is skipped', async () => {
    const a = await makeCompletedJob(6000, 1_000_000);
    const b = await makeCompletedJob(6000, 1_000_000);
    const holdA = await escrow.createHold(a.jobId, a.customerId);
    const holdB = await escrow.createHold(b.jobId, b.customerId);
    await admin.query(`UPDATE escrow_holds SET auto_release_at = now() - interval '1 hour' WHERE id IN ($1,$2)`, [holdA.id, holdB.id]);
    // Batch 2 (§6a): auto-release waits for completion confirmation.
    // Job A is confirmed (so it releases); job B is not — but its open
    // dispute is checked first, so it is reported as skipped_dispute.
    await admin.query(`UPDATE jobs SET completion_confirmed_at=now(), completion_confirmed_by=$2 WHERE id=$1`, [a.jobId, a.customerId]);
    await admin.query(
      `INSERT INTO disputes (job_id, opened_by, reason_code, status) VALUES ($1,$2,'not_done','open')`,
      [b.jobId, b.customerId],
    );
    const out = await escrow.releaseDueHolds();
    expect(out.released).toContain(holdA.id);
    expect(out.skipped_dispute).toContain(holdB.id);
    expect(out.skipped_unconfirmed ?? []).not.toContain(holdA.id);
    expect((await walletOf(a.providerUserId)).balance_paisa).toBe(540_000);
    const holdBRow = (await admin.query(`SELECT status FROM escrow_holds WHERE id=$1`, [holdB.id])).rows[0];
    expect(holdBRow.status).toBe('held');
    expect((await walletOf(b.customerId)).escrow_held_paisa).toBe(600_000);
    // Manual release of the disputed hold is also blocked.
    await expect(escrow.releaseHold(holdB.id, b.customerId)).rejects.toMatchObject({ code: 'ESCROW_DISPUTE_OPEN', status: 409 });
    expect(await ledgerDiffs()).toEqual([]);
  });

  it('payouts: instant executes on finance approval (sandbox), fee/tax split, ledger balanced', async () => {
    await escrow.updateConfig(adminId, { payout_fee_rate: 0.02, payout_tax_rate: 0.1 });
    const { userId: providerUserId } = await makeProvider(PHONE('3'));
    await admin.query(`INSERT INTO wallet_accounts (user_id, balance_paisa) VALUES ($1, 540000)`, [providerUserId]);
    const payout = await escrow.requestPayout(providerUserId, {
      amount_pkr: 1000, method: 'jazzcash', destination_phone: '+923001234567', kind: 'instant',
    });
    expect(payout.status).toBe('requested');
    expect(payout.fee_paisa).toBe(2000);
    expect(payout.tax_paisa).toBe(9800);
    expect(payout.net_paisa).toBe(88_200);
    expect(payout.sandbox).toBe(true);
    expect((await walletOf(providerUserId)).balance_paisa).toBe(540_000); // untouched until approval
    const executed = await escrow.approvePayout(payout.id, adminId);
    expect(executed.status).toBe('executed');
    expect(executed.provider_ref).toMatch(/^JC-PAYOUT-SANDBOX-/);
    expect((await walletOf(providerUserId)).balance_paisa).toBe(440_000);
    expect(await ledgerDiffs()).toEqual([]);
    await escrow.updateConfig(adminId, { payout_fee_rate: 0, payout_tax_rate: 0 });
  });

  it('payouts: scheduled executes only via run-due after scheduled_for; reject moves no money', async () => {
    const { userId: providerUserId } = await makeProvider(PHONE('4'));
    await admin.query(`INSERT INTO wallet_accounts (user_id, balance_paisa) VALUES ($1, 540000)`, [providerUserId]);
    const future = new Date(Date.now() + 3600_000).toISOString();
    const payout = await escrow.requestPayout(providerUserId, {
      amount_pkr: 1000, method: 'easypaisa', destination_phone: '+923001234567',
      kind: 'scheduled', scheduled_for: future,
    });
    expect(payout.status).toBe('scheduled');
    await escrow.approvePayout(payout.id, adminId);
    expect((await escrow.executeDuePayouts(new Date())).executed).not.toContain(payout.id);
    expect((await walletOf(providerUserId)).balance_paisa).toBe(540_000);
    const done = await escrow.executeDuePayouts(new Date(Date.now() + 2 * 3600_000));
    expect(done.executed).toContain(payout.id);
    expect((await walletOf(providerUserId)).balance_paisa).toBe(440_000);
    expect(await ledgerDiffs()).toEqual([]);

    const doomed = await escrow.requestPayout(providerUserId, {
      amount_pkr: 500, method: 'jazzcash', destination_phone: '+923001234567', kind: 'instant',
    });
    const rejected = await escrow.rejectPayout(doomed.id, adminId, 'verification pending');
    expect(rejected.status).toBe('rejected');
    expect((await walletOf(providerUserId)).balance_paisa).toBe(440_000);
  });

  it('0008 guard: a one-legged ledger insert fails at COMMIT and writes nothing', async () => {
    const { userId: providerUserId } = await makeProvider(PHONE('5'));
    const walletId = (await admin.query(
      `INSERT INTO wallet_accounts (user_id, balance_paisa) VALUES ($1, 100000) RETURNING id`,
      [providerUserId],
    )).rows[0].id as string;
    const txnId = crypto.randomUUID();
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, memo)
         VALUES ($1,$2,'wallet','D',10000,'one leg only')`,
        [txnId, walletId],
      );
      await expect(c.query('COMMIT')).rejects.toThrow(/unbalanced/);
      const rows = (await admin.query(
        `SELECT COUNT(*)::int AS cnt FROM ledger_entries WHERE txn_id=$1`, [txnId],
      )).rows[0].cnt as number;
      expect(rows).toBe(0);
    } finally {
      await c.end();
    }
  });
});
