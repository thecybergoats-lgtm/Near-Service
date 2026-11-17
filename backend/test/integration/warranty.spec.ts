// Warranty Product — integration tests (Phase 4, item 4).
// REAL Postgres 16 + PostGIS 3 and REAL Redis. Run with:
//   DATABASE_URL=postgresql://root@/nearservice_p4_warranty?host=/var/run/postgresql
//   REDIS_URL=redis://localhost:6379
//   NODE_ENV=test npx jest --runInBand test/integration/warranty.spec.ts
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0009 + 0019 (the only migrations this piece
// depends on — other Phase 4 workers' 0016–0018 are intentionally NOT
// applied here, so their state can never break this piece's tests).
// Only ever point it at the dedicated test DB nearservice_p4_warranty.
// Skipped entirely when DATABASE_URL or REDIS_URL is not set.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { DatabaseService } from '../../src/database/database.service';
import { RedisService } from '../../src/database/redis.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { WarrantyService } from '../../src/modules/warranty/warranty.service';

jest.setTimeout(60000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
let phoneSeq = 0;
const PHONE = (n: string) => `+92301${RUN}${n}${phoneSeq++}`;
const CATEGORY_ID = '00000000-0000-4000-8000-0000b0000001'; // Book Binding
const MIGRATIONS = [
  '0001_init.sql', '0002_requests_jobs.sql', '0003_money_trust.sql',
  '0004_seed.sql', '0005_phase2_payments.sql', '0006_phase2_ops.sql',
  '0007_revoke_refresh_families.sql', '0008_ledger_balance_guard.sql',
  '0009_stage3_fixes.sql', '0019_warranty.sql',
];

maybeDescribe('warranty product (real DB + Redis)', () => {
  let dbSvc: DatabaseService;
  let redis: RedisService;
  let warranty: WarrantyService;
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
    warranty = new WarrantyService(dbSvc, redis, new RealtimeService());
    adminId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Warranty Finance Admin','ur') RETURNING id`,
      [`+92309${RUN}99`],
    )).rows[0].id as string;
  });

  afterAll(async () => {
    if (redis) await redis.onModuleDestroy();
    if (dbSvc) await dbSvc.onModuleDestroy();
    if (admin) await admin.end();
  });

  async function makeUser(phone: string): Promise<string> {
    return (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Warranty Test','ur') RETURNING id`,
      [phone],
    )).rows[0].id as string;
  }

  async function makeProvider(phone: string, tier: number): Promise<{ userId: string; providerId: string }> {
    const userId = await makeUser(phone);
    const providerId = (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, tier, base_point)
       VALUES ($1,'individual','Warranty Provider',$2, ST_SetSRID(ST_MakePoint(66.9750,30.1798),4326)::geography) RETURNING id`,
      [userId, tier],
    )).rows[0].id as string;
    return { userId, providerId };
  }

  /** A job in the given state, with a funded customer wallet. */
  async function makeJob(finalPricePkr: number, tier: number, state = 'IN_PROGRESS', customerBalancePaisa = 1_000_000) {
    const customerId = await makeUser(PHONE('1'));
    const { userId: providerUserId, providerId } = await makeProvider(PHONE('2'), tier);
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
       VALUES ($1,$2,$3,$4,$5,$5,0.1,$6,'unpaid') RETURNING id`,
      [requestId, offerId, customerId, providerId, finalPricePkr, state],
    )).rows[0].id as string;
    await admin.query(`INSERT INTO wallet_accounts (user_id, balance_paisa) VALUES ($1,$2)`, [customerId, customerBalancePaisa]);
    return { customerId, providerUserId, providerId, jobId };
  }

  /** Opt in at booking, then complete the job at `completedAt`. */
  async function makeWarrantiedJob(finalPricePkr: number, tier: number, completedAt: Date, settle = false) {
    const j = await makeJob(finalPricePkr, tier, 'IN_PROGRESS');
    const w = await warranty.optIn(j.jobId, j.customerId);
    await admin.query(
      `UPDATE jobs SET state=$2, completed_at=$3, payment_status=$4 WHERE id=$1`,
      [j.jobId, settle ? 'PAYMENT_SETTLED' : 'COMPLETED', completedAt.toISOString(), settle ? 'settled' : 'unpaid'],
    );
    return { ...j, warranty: w };
  }

  async function walletOf(userId: string) {
    const row = (await admin.query(
      `SELECT balance_paisa, escrow_held_paisa FROM wallet_accounts WHERE user_id=$1`, [userId],
    )).rows[0] as { balance_paisa: string; escrow_held_paisa: string };
    return { balance_paisa: Number(row.balance_paisa), escrow_held_paisa: Number(row.escrow_held_paisa) };
  }

  async function ledgerDiffs(): Promise<{ txn_id: string; diff: number }[]> {
    const rows = (await admin.query(
      `SELECT txn_id, SUM(CASE WHEN direction='D' THEN amount_paisa ELSE -amount_paisa END)::bigint AS diff
         FROM ledger_entries GROUP BY txn_id HAVING SUM(CASE WHEN direction='D' THEN amount_paisa ELSE -amount_paisa END) <> 0`,
    )).rows;
    return rows as unknown as { txn_id: string; diff: number }[];
  }

  it('0019 applied: warranty tables, fee config, rules v1, jobs columns', async () => {
    const tables = (await admin.query(
      `SELECT to_regclass('public.job_warranties') AS w, to_regclass('public.warranty_claims') AS c,
              to_regclass('public.warranty_claim_events') AS e, to_regclass('public.warranty_rules') AS r`,
    )).rows[0];
    expect(tables.w).toBe('job_warranties');
    expect(tables.c).toBe('warranty_claims');
    expect(tables.e).toBe('warranty_claim_events');
    expect(tables.r).toBe('warranty_rules');
    const flags = (await admin.query(
      `SELECT key, config FROM feature_flags WHERE key LIKE 'warranty%' ORDER BY key`,
    )).rows;
    expect(flags.map((r: { key: string }) => r.key)).toEqual([
      'warranty_claim_days', 'warranty_fee_flat_paisa', 'warranty_fee_max_paisa',
      'warranty_fee_min_paisa', 'warranty_fee_rate',
    ]);
    const rules = await warranty.getRules();
    expect(rules.version).toBe(1);
    expect(rules.is_current).toBe(true);
    expect(rules.body_md).toMatch(/7 days/);
    const cols = (await admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='jobs'
        AND column_name IN ('warranty_opted_in','warranty_fee_paisa')`,
    )).rows;
    expect(cols).toHaveLength(2);
  });

  it('quote + config: 5% default, min/max caps enforced via admin config', async () => {
    const q = await warranty.quoteFee(6000);
    expect(q.fee_paisa).toBe(30_000); // PKR 300
    expect(q.fee_rate).toBe(0.05);
    expect(q.claim_window_days).toBe(7);
    expect((await warranty.quoteFee(500)).fee_paisa).toBe(5_000); // min PKR 50
    expect((await warranty.quoteFee(50_000)).fee_paisa).toBe(50_000); // max PKR 500
    const updated = await warranty.updateConfig(adminId, { fee_rate: 0.5, fee_min_paisa: 10_000, fee_max_paisa: 20_000 });
    expect(updated.fee_rate).toBe(0.5);
    expect((await warranty.quoteFee(10_000)).fee_paisa).toBe(20_000); // 50% capped at PKR 200
    await warranty.updateConfig(adminId, { fee_rate: 0.05, fee_min_paisa: 5_000, fee_max_paisa: 50_000 });
    await expect(warranty.updateConfig(adminId, { fee_rate: 0.6 })).rejects.toMatchObject({ code: 'INVALID_WARRANTY_CONFIG', status: 422 });
    await expect(warranty.updateConfig(adminId, { fee_min_paisa: 60_000 })).rejects.toMatchObject({ code: 'INVALID_WARRANTY_CONFIG', status: 422 });
  });

  it('opt-in: Tier 3 allowed with the priced fee; tiers 0-2 rejected 422', async () => {
    const ok = await makeJob(6000, 3);
    const w = await warranty.optIn(ok.jobId, ok.customerId);
    expect(w.status).toBe('pending_payment');
    expect(w.fee_paisa).toBe(30_000);
    const badge = await warranty.providerBadge(ok.providerId);
    expect(badge.warranty_eligible).toBe(true);
    expect(badge.badge).toBe('WARRANTY_7_DAY');
    expect(badge.tier_name).toBe('Trusted Pro');
    await expect(warranty.optIn(ok.jobId, ok.customerId)).rejects.toMatchObject({ code: 'WARRANTY_ALREADY_OPTED_IN', status: 409 });
    for (const tier of [0, 1, 2]) {
      const j = await makeJob(6000, tier);
      await expect(warranty.optIn(j.jobId, j.customerId)).rejects.toMatchObject({ code: 'WARRANTY_TIER_NOT_ELIGIBLE', status: 422 });
      const b = await warranty.providerBadge(j.providerId);
      expect(b.warranty_eligible).toBe(false);
      expect(b.badge).toBeNull();
    }
  });

  it('fee collection: balanced ledger, wallet debited, 7-day window from completion', async () => {
    const completedAt = new Date(Date.now() - 2 * 24 * 3600_000);
    const j = await makeWarrantiedJob(6000, 3, completedAt);
    // Too early: job is COMPLETED here, so this succeeds — check the
    // too-early path on a fresh IN_PROGRESS job instead.
    const early = await makeJob(6000, 3, 'IN_PROGRESS');
    await warranty.optIn(early.jobId, early.customerId);
    await expect(warranty.collectFee(early.jobId, early.customerId)).rejects.toMatchObject({ code: 'WARRANTY_FEE_TOO_EARLY', status: 409 });

    const active = await warranty.collectFee(j.jobId, j.customerId);
    expect(active.status).toBe('active');
    expect(active.fee_txn_id).toBeTruthy();
    expect(new Date(active.coverage_starts_at as string).getTime()).toBe(completedAt.getTime());
    expect(new Date(active.coverage_ends_at as string).getTime()).toBe(completedAt.getTime() + 7 * 24 * 3600_000);
    expect((await walletOf(j.customerId)).balance_paisa).toBe(1_000_000 - 30_000);
    expect(await ledgerDiffs()).toEqual([]);
    const legs = (await admin.query(
      `SELECT account_code, direction, amount_paisa FROM ledger_entries WHERE txn_id=$1 ORDER BY direction, account_code`,
      [active.fee_txn_id],
    )).rows.map((r: { account_code: string; direction: string; amount_paisa: string }) => ({
      account_code: r.account_code, direction: r.direction, amount: Number(r.amount_paisa),
    }));
    expect(legs).toEqual([
      { account_code: 'warranty_fee_rev', direction: 'C', amount: 30_000 },
      { account_code: 'wallet', direction: 'D', amount: 30_000 },
    ]);
    // Second collection is rejected.
    await expect(warranty.collectFee(j.jobId, j.customerId)).rejects.toMatchObject({ code: 'WARRANTY_FEE_STATE', status: 409 });
    // Receipt shows the fee, the window and no claim yet.
    const receipt = await warranty.getReceipt(j.jobId, j.customerId);
    expect(receipt.warranty_fee_pkr).toBe(300);
    expect(receipt.total_charged_pkr).toBe(6300);
    expect(receipt.claim).toBeNull();
  });

  it('claim window: filed inside 7 days; exactly at the deadline is in time; day 8 is rejected', async () => {
    // Day-8 job: completed 8 days ago.
    const late = await makeWarrantiedJob(6000, 3, new Date(Date.now() - 8 * 24 * 3600_000));
    await warranty.collectFee(late.jobId, late.customerId);
    await expect(warranty.fileClaim(late.jobId, late.customerId, { reason: 'poor_work', description: 'Work fell apart' }))
      .rejects.toMatchObject({ code: 'WARRANTY_CLAIM_WINDOW_CLOSED', status: 422 });

    // Boundary job: completed exactly 7 days ago — file at the deadline instant.
    const edge = await makeWarrantiedJob(6000, 3, new Date(Date.now() - 7 * 24 * 3600_000));
    const active = await warranty.collectFee(edge.jobId, edge.customerId);
    const deadline = new Date(active.coverage_ends_at as string);
    const claim = await warranty.fileClaim(edge.jobId, edge.customerId, { reason: 'poor_work', description: 'Edge of window' }, deadline);
    expect(claim.status).toBe('filed');
    // One second past the deadline is late (fresh job, same shape).
    const past = await makeWarrantiedJob(6000, 3, new Date(Date.now() - 7 * 24 * 3600_000 - 1000));
    await warranty.collectFee(past.jobId, past.customerId);
    await expect(warranty.fileClaim(past.jobId, past.customerId, { reason: 'poor_work', description: 'Too late' }))
      .rejects.toMatchObject({ code: 'WARRANTY_CLAIM_WINDOW_CLOSED', status: 422 });
  });

  it('rework-then-close flow: filed -> under_review -> rework_offered -> rework_done -> closed', async () => {
    const j = await makeWarrantiedJob(6000, 3, new Date(Date.now() - 24 * 3600_000));
    await warranty.collectFee(j.jobId, j.customerId);
    const claim = await warranty.fileClaim(j.jobId, j.customerId, { reason: 'incomplete', description: 'Half the work missing' });
    // A second open claim is rejected.
    await expect(warranty.fileClaim(j.jobId, j.customerId, { reason: 'other', description: 'Again' }))
      .rejects.toMatchObject({ code: 'WARRANTY_CLAIM_ALREADY_OPEN', status: 409 });
    // Refund straight from filed is illegal — and the attempt is logged.
    await expect(warranty.approveRefund(claim.id, adminId, 'skip rework')).rejects.toMatchObject({ code: 'ILLEGAL_CLAIM_TRANSITION', status: 409 });
    const illegal = (await admin.query(
      `SELECT illegal FROM warranty_claim_events WHERE claim_id=$1 AND to_status='refunded'`,
      [claim.id],
    )).rows;
    expect(illegal).toHaveLength(1);
    expect(illegal[0].illegal).toBe(true);

    const reviewed = await warranty.reviewClaim(claim.id, adminId);
    expect(reviewed.status).toBe('under_review');
    const offered = await warranty.offerRework(claim.id, j.providerUserId, 'provider', 'Will return tomorrow to fix it');
    expect(offered.status).toBe('rework_offered');
    expect(offered.rework_note).toMatch(/tomorrow/);
    const done = await warranty.reportReworkDone(claim.id, j.customerId, 'customer', 'Fixed properly now');
    expect(done.status).toBe('rework_done');
    const closed = await warranty.closeClaim(claim.id, j.customerId, 'customer');
    expect(closed.status).toBe('closed');
    expect(closed.resolved_at).toBeTruthy();
    const events = (await warranty.getClaim(claim.id, j.customerId)).events;
    expect(events.map((e) => String(e.to_status))).toEqual(
      ['filed', 'refunded', 'under_review', 'rework_offered', 'rework_done', 'closed'],
    );
    // Terminal: no further transition (this illegal attempt is logged too).
    await expect(warranty.reviewClaim(claim.id, adminId)).rejects.toMatchObject({ code: 'ILLEGAL_CLAIM_TRANSITION', status: 409 });
    expect(await ledgerDiffs()).toEqual([]);
  });

  it('rework-then-refund flow: refund = full price + fee, ledger balanced, provider debited only when settled', async () => {
    const j = await makeWarrantiedJob(6000, 3, new Date(Date.now() - 24 * 3600_000), true); // settled
    await warranty.collectFee(j.jobId, j.customerId);
    // Provider was "paid" the settled job: fund their wallet with the price.
    await admin.query(`INSERT INTO wallet_accounts (user_id, balance_paisa) VALUES ($1, 600000)`, [j.providerUserId]);
    const claim = await warranty.fileClaim(j.jobId, j.customerId, { reason: 'poor_work', description: 'Still broken' });
    await warranty.reviewClaim(claim.id, adminId);
    await warranty.offerRework(claim.id, adminId, 'admin', 'Rework offered by support');
    const failed = await warranty.reportReworkFailed(claim.id, j.customerId, 'customer', 'Provider refused to return');
    expect(failed.status).toBe('rework_failed');
    const refunded = await warranty.approveRefund(claim.id, adminId, 'Rework refused — full refund per published rules');
    expect(refunded.status).toBe('refunded');
    expect(refunded.refund_amount_paisa).toBe(630_000); // PKR 6,000 price + PKR 300 fee
    expect(refunded.refund_txn_id).toBeTruthy();
    // Customer: paid 30,000 fee, got 630,000 back.
    expect((await walletOf(j.customerId)).balance_paisa).toBe(1_000_000 - 30_000 + 630_000);
    // Provider: debited the job price only (the fee was never theirs).
    expect((await walletOf(j.providerUserId)).balance_paisa).toBe(0);
    expect(await ledgerDiffs()).toEqual([]);
    const legs = (await admin.query(
      `SELECT account_code, direction, amount_paisa FROM ledger_entries WHERE txn_id=$1 ORDER BY direction, account_code, amount_paisa`,
      [refunded.refund_txn_id],
    )).rows.map((r: { account_code: string; direction: string; amount_paisa: string }) => ({
      account_code: r.account_code, direction: r.direction, amount: Number(r.amount_paisa),
    }));
    expect(legs).toEqual([
      { account_code: 'wallet', direction: 'C', amount: 30_000 },
      { account_code: 'wallet', direction: 'C', amount: 600_000 },
      { account_code: 'warranty_fee_rev', direction: 'D', amount: 30_000 },
      { account_code: 'warranty_refund_expense', direction: 'D', amount: 600_000 },
    ]);
    const pay = (await admin.query(
      `SELECT amount, status FROM payments WHERE job_id=$1 AND status='refunded'`, [j.jobId],
    )).rows;
    expect(pay).toHaveLength(1);
    expect(Number(pay[0].amount)).toBe(6300);
    const w = (await admin.query(`SELECT status FROM job_warranties WHERE job_id=$1`, [j.jobId])).rows[0];
    expect(w.status).toBe('refunded');
    const receipt = await warranty.getReceipt(j.jobId, j.customerId);
    expect((receipt.claim as { status: string }).status).toBe('refunded');
    // Admin decision was audited.
    const audit = (await admin.query(
      `SELECT action FROM audit_logs WHERE entity='warranty_claims' AND entity_id=$1 ORDER BY id DESC LIMIT 1`,
      [claim.id],
    )).rows;
    expect(audit[0].action).toBe('warranty.claim.refund');
  });

  it('admin reject: claim rejected with a reason, warranty goes back to active', async () => {
    const j = await makeWarrantiedJob(6000, 3, new Date(Date.now() - 24 * 3600_000));
    await warranty.collectFee(j.jobId, j.customerId);
    const claim = await warranty.fileClaim(j.jobId, j.customerId, { reason: 'other', description: 'Not a workmanship fault' });
    await expect(warranty.rejectClaim(claim.id, adminId, '')).rejects.toMatchObject({ status: 400 });
    const rejected = await warranty.rejectClaim(claim.id, adminId, 'Damage was caused by the customer after completion');
    expect(rejected.status).toBe('rejected');
    expect(rejected.decision_reason).toMatch(/customer after completion/);
    const w = (await admin.query(`SELECT status FROM job_warranties WHERE job_id=$1`, [j.jobId])).rows[0];
    expect(w.status).toBe('active');
    expect(await ledgerDiffs()).toEqual([]);
  });

  it('rules: admin publishes a new version; expiry sweep closes old warranties', async () => {
    const v2 = await warranty.updateRules(adminId, 'Warranty Rules v2', '# Rules v2\n\nFee is 5%.');
    expect(v2.version).toBe(2);
    expect((await warranty.getRules()).version).toBe(2);
    const old = (await admin.query(`SELECT is_current FROM warranty_rules WHERE version=1`)).rows[0];
    expect(old.is_current).toBe(false);

    const j = await makeWarrantiedJob(6000, 3, new Date(Date.now() - 8 * 24 * 3600_000));
    await warranty.collectFee(j.jobId, j.customerId);
    const out = await warranty.expireWarranties();
    expect(out.expired).toContain(j.warranty.id);
    const w = (await admin.query(`SELECT status FROM job_warranties WHERE id=$1`, [j.warranty.id])).rows[0];
    expect(w.status).toBe('expired');
  });
});
