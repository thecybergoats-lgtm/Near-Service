// Integration tests (Stage 2, FIX 8) — REAL Postgres 16 + PostGIS 3 and
// REAL Redis. Run with:
//   DATABASE_URL=postgres://nearservice_test:<pw>@127.0.0.1:5432/nearservice_fix8_test REDIS_URL=redis://localhost:6379 \
//   NODE_ENV=test npm test -- ledger-balance
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0008. Only ever point it at a dedicated test DB.
// Skipped entirely when DATABASE_URL or REDIS_URL is not set.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { DatabaseService } from '../../src/database/database.service';
import { RedisService } from '../../src/database/redis.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { JobsService } from '../../src/modules/jobs/jobs.service';
import { ReconciliationService } from '../../src/modules/payments/reconciliation.service';

jest.setTimeout(30000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
const PHONE = (n: string) => `+92301${RUN}${n}`;
// Seeded by 0004_seed.sql.
const CATEGORY_ID = '00000000-0000-4000-8000-0000b0000001'; // Book Binding

maybeDescribe('ledger balance guard + reconciliation (real DB + Redis)', () => {
  let dbSvc: DatabaseService;
  let redis: RedisService;
  let jobs: JobsService;
  let recon: ReconciliationService;
  let admin: Client;

  beforeAll(async () => {
    // Fresh schema, then apply every migration in order (same as npm run migrate).
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
    jobs = new JobsService(dbSvc, redis, new RealtimeService());
    recon = new ReconciliationService(dbSvc);
  });

  afterAll(async () => {
    await redis.onModuleDestroy();
    await dbSvc.onModuleDestroy();
    await admin.end();
  });

  async function makeWalletUser(phone: string): Promise<{ userId: string; walletId: string }> {
    const userId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Ledger Test','ur') RETURNING id`,
      [phone],
    )).rows[0].id as string;
    const walletId = (await admin.query(
      `INSERT INTO wallet_accounts (user_id) VALUES ($1) RETURNING id`,
      [userId],
    )).rows[0].id as string;
    return { userId, walletId };
  }

  it('FIX 8a(1): an unbalanced insert fails at COMMIT and writes nothing', async () => {
    const { walletId } = await makeWalletUser(PHONE('01'));
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

  it('FIX 8a(2): a balanced insert commits fine', async () => {
    const { walletId } = await makeWalletUser(PHONE('02'));
    const txnId = crypto.randomUUID();
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, memo)
         VALUES ($1,$2,'wallet','D',5000,'balanced D')`,
        [txnId, walletId],
      );
      await c.query(
        `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, memo)
         VALUES ($1,$2,'commission_rev','C',5000,'balanced C')`,
        [txnId, walletId],
      );
      await c.query('COMMIT');
      // A real writer always moves the balance with the legs; keep this
      // wallet consistent so the later reconciliation run stays clean.
      await admin.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - 5000 WHERE id=$1`, [walletId]);
      const rows = (await admin.query(
        `SELECT COUNT(*)::int AS cnt FROM ledger_entries WHERE txn_id=$1`, [txnId],
      )).rows[0].cnt as number;
      expect(rows).toBe(2);
    } finally {
      await c.end();
    }
  });

  it('FIX 8a(3): UPDATE and DELETE on ledger_entries are rejected', async () => {
    const { walletId } = await makeWalletUser(PHONE('03'));
    const txnId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, memo) VALUES
       ($1,$2,'wallet','D',1000,'append-only D'), ($1,$2,'commission_rev','C',1000,'append-only C')`,
      [txnId, walletId],
    );
    // Keep this wallet consistent (see the balanced-insert test above).
    await admin.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa - 1000 WHERE id=$1`, [walletId]);
    await expect(admin.query(
      `UPDATE ledger_entries SET memo='tampered' WHERE txn_id=$1`, [txnId],
    )).rejects.toThrow(/append-only/);
    await expect(admin.query(
      `DELETE FROM ledger_entries WHERE txn_id=$1`, [txnId],
    )).rejects.toThrow(/append-only/);
    const rows = (await admin.query(
      `SELECT COUNT(*)::int AS cnt FROM ledger_entries WHERE txn_id=$1`, [txnId],
    )).rows[0].cnt as number;
    expect(rows).toBe(2);
  });

  it('FIX 8b: golden cash-job flow settles balanced; reconciliation is clean + idempotent', async () => {
    // Minimal COMPLETED cash job, PKR 1000 at the 10% commission rate.
    const customerId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Cash Customer','ur') RETURNING id`,
      [PHONE('04')],
    )).rows[0].id as string;
    const providerUserId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Cash Provider','ur') RETURNING id`,
      [PHONE('05')],
    )).rows[0].id as string;
    const providerId = (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, base_point)
       VALUES ($1,'INDIVIDUAL','Cash Provider', ST_SetSRID(ST_MakePoint(66.9,30.2),4326)::geography) RETURNING id`,
      [providerUserId],
    )).rows[0].id as string;
    const requestId = (await admin.query(
      `INSERT INTO service_requests (customer_id, category_id, fulfillment, location)
       VALUES ($1,$2,'in_person', ST_SetSRID(ST_MakePoint(66.9,30.2),4326)::geography) RETURNING id`,
      [customerId, CATEGORY_ID],
    )).rows[0].id as string;
    const offerId = (await admin.query(
      `INSERT INTO offers (request_id, provider_id, offered_by, price, expires_at)
       VALUES ($1,$2,'provider',1000, now() + interval '1 hour') RETURNING id`,
      [requestId, providerId],
    )).rows[0].id as string;
    const jobId = (await admin.query(
      `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price, commission_rate, state, payment_method, payment_status)
       VALUES ($1,$2,$3,$4,1000,1000,0.1,'COMPLETED','cash','unpaid') RETURNING id`,
      [requestId, offerId, customerId, providerId],
    )).rows[0].id as string;

    // Both sides confirm cash payment via the real service (2nd settles).
    await jobs.confirmPayment(jobId, customerId);
    const settled = await jobs.confirmPayment(jobId, providerUserId);
    expect(settled.state).toBe('PAYMENT_SETTLED');
    expect(settled.payment_status).toBe('settled');

    // 10% commission on PKR 1000 = PKR 100 = 10000 paisa, debited from the
    // provider's wallet (balance may go negative — PRD p.18).
    const wallet = (await admin.query(
      `SELECT balance_paisa FROM wallet_accounts WHERE user_id=$1`, [providerUserId],
    )).rows[0];
    expect(Number(wallet.balance_paisa)).toBe(-10000);
    const legs = (await admin.query(
      `SELECT account_code, direction, amount_paisa FROM ledger_entries WHERE job_id=$1 ORDER BY id`,
      [jobId],
    )).rows;
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ account_code: 'wallet', direction: 'D', amount_paisa: '10000' });
    expect(legs[1]).toMatchObject({ account_code: 'commission_rev', direction: 'C', amount_paisa: '10000' });

    // Reconciliation: zero mismatches across the whole ledger.
    const first = await recon.run('manual');
    expect(first.status).toBe('clean');
    expect(first.txn_mismatches).toBe(0);
    expect(first.wallet_mismatches).toBe(0);
    expect(first.mismatches).toEqual([]);
    expect(first.txn_checked).toBeGreaterThanOrEqual(1);
    expect(first.wallet_checked).toBeGreaterThanOrEqual(1);

    // Re-run: idempotent — no fraud_signals appear, second report is clean.
    const second = await recon.run('manual');
    expect(second.status).toBe('clean');
    expect(second.txn_mismatches).toBe(0);
    expect(second.wallet_mismatches).toBe(0);
    const signals = (await admin.query(
      `SELECT COUNT(*)::int AS cnt FROM fraud_signals WHERE signal IN ('ledger_unbalanced','wallet_balance_mismatch')`,
    )).rows[0].cnt as number;
    expect(signals).toBe(0);
    const reports = (await admin.query(
      `SELECT COUNT(*)::int AS cnt FROM reconciliation_reports`,
    )).rows[0].cnt as number;
    expect(reports).toBe(2);
    expect((await recon.latest())?.id).toBe(second.id);
  });
});
