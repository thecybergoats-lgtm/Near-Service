// Subscriptions + Teams integration tests (Phase 3) — REAL Postgres 16 +
// PostGIS 3. Run with (own test DB — never a shared test DB):
//   PGPASSFILE=~/.pgpass DATABASE_URL=postgres://p3subs@127.0.0.1:5432/nearservice_p3_subs \
//   NODE_ENV=test npm test -- subscriptions-teams --runInBand
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0009 + 0012 only (0010/0011/0013–0015 belong to
// other Phase 3 workers and are still in flight — this file must not depend
// on them). Skipped entirely when DATABASE_URL is not set.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { DatabaseService } from '../../src/database/database.service';
import { SubscriptionsService } from '../../src/modules/subscriptions/subscriptions.service';
import { TeamsService } from '../../src/modules/teams/teams.service';
import { ApiError } from '../../src/common/errors/api-error';

jest.setTimeout(60000);

const hasDb = !!process.env.DATABASE_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
const PHONE = (n: string) => `+92302${RUN}${n}`;
// Seeded by 0004_seed.sql.
const CATEGORY_ID = '00000000-0000-4000-8000-0000b0000001'; // Book Binding

async function expectApiError(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { return e as ApiError; }
  throw new Error('expected promise to reject with an ApiError');
}

maybeDescribe('subscriptions + teams (real Postgres)', () => {
  let dbSvc: DatabaseService;
  let subs: SubscriptionsService;
  let teams: TeamsService;
  let admin: Client;
  let ownerId: string;
  let worker1Id: string;
  let worker2Id: string;
  let customerId: string;
  let providerId: string;
  let jobId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    const files = ['0001_init.sql', '0002_requests_jobs.sql', '0003_money_trust.sql', '0004_seed.sql',
      '0005_phase2_payments.sql', '0006_phase2_ops.sql', '0007_revoke_refresh_families.sql',
      '0008_ledger_balance_guard.sql', '0009_stage3_fixes.sql', '0012_subscriptions_teams.sql'];
    for (const file of files) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    dbSvc = new DatabaseService();
    subs = new SubscriptionsService(dbSvc);
    teams = new TeamsService(dbSvc);

    ownerId = crypto.randomUUID();
    worker1Id = crypto.randomUUID();
    worker2Id = crypto.randomUUID();
    customerId = crypto.randomUUID();
    for (const [id, phone] of [[ownerId, PHONE('1')], [worker1Id, PHONE('2')], [worker2Id, PHONE('3')], [customerId, PHONE('4')]] as const) {
      await admin.query(`INSERT INTO users (id, phone, full_name) VALUES ($1,$2,$3)`, [id, phone, `User ${phone}`]);
    }
    providerId = (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, base_point)
       VALUES ($1,'INDIVIDUAL','Ali Repair Shop', ST_SetSRID(ST_MakePoint(67.0,30.18),4326)::geography) RETURNING id`,
      [ownerId],
    )).rows[0].id;
    await admin.query(`INSERT INTO wallet_accounts (user_id, balance_paisa) VALUES ($1, 500000)`, [ownerId]); // PKR 5,000
    const requestId = (await admin.query(
      `INSERT INTO service_requests (customer_id, category_id, fulfillment, location, status)
       VALUES ($1,$2,'VISIT_SHOP', ST_SetSRID(ST_MakePoint(67.0,30.18),4326)::geography,'ACCEPTED') RETURNING id`,
      [customerId, CATEGORY_ID],
    )).rows[0].id;
    const offerId = (await admin.query(
      `INSERT INTO offers (request_id, provider_id, offered_by, price, status, expires_at)
       VALUES ($1,$2,'provider',2000,'accepted', now() + interval '1 hour') RETURNING id`,
      [requestId, providerId],
    )).rows[0].id;
    jobId = (await admin.query(
      `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price,
                         commission_rate, commission_amount, state, payment_method, payment_status)
       VALUES ($1,$2,$3,$4,2000,2000,0.10,200,'ACCEPTED','cash','unpaid') RETURNING id`,
      [requestId, offerId, customerId, providerId],
    )).rows[0].id;
  });

  afterAll(async () => {
    if (dbSvc) await dbSvc.onModuleDestroy();
    if (admin) await admin.end();
  });

  it('migration 0012 seeded the three plans and created the team tables', async () => {
    const plans = await admin.query(`SELECT code, price_pkr, commission_multiplier, max_staff_accounts, featured FROM subscription_plans ORDER BY price_pkr`);
    expect(plans.rows.map((r) => r.code)).toEqual(['free', 'pro', 'business']);
    expect(Number(plans.rows.find((r) => r.code === 'business')!.commission_multiplier)).toBeCloseTo(0.6);
    expect(Number(plans.rows.find((r) => r.code === 'business')!.max_staff_accounts)).toBe(5);
    const tables = await admin.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('teams','team_members','team_job_assignments','subscriptions')`);
    expect(tables.rows).toHaveLength(4);
  });

  it('Business subscribe charges PKR 2,499 from the wallet with balanced ledger rows', async () => {
    const mine = await subs.subscribe(ownerId, 'business');
    expect(mine.plan_code).toBe('business');
    expect(mine.status).toBe('active');
    expect(mine.placement).toEqual({ sponsored: true, label: 'Sponsored' });
    const wallet = await admin.query(`SELECT balance_paisa FROM wallet_accounts WHERE user_id=$1`, [ownerId]);
    expect(Number(wallet.rows[0].balance_paisa)).toBe(500000 - 249900);
    const ledger = await admin.query(
      `SELECT account_code, direction, SUM(amount_paisa) AS total FROM ledger_entries GROUP BY account_code, direction ORDER BY 1,2`);
    const debits = ledger.rows.filter((r) => r.direction === 'D').reduce((s, r) => s + Number(r.total), 0);
    const credits = ledger.rows.filter((r) => r.direction === 'C').reduce((s, r) => s + Number(r.total), 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(249900);
    const profile = await admin.query(`SELECT subscription_plan FROM provider_profiles WHERE id=$1`, [providerId]);
    expect(profile.rows[0].subscription_plan).toBe('business');
  });

  it('effective commission rate follows the Business plan (0.10 -> 0.06)', async () => {
    expect(await subs.effectiveCommissionRate(ownerId, 0.1)).toBeCloseTo(0.06);
    expect(await subs.isProviderFeatured(providerId)).toEqual({ sponsored: true, label: 'Sponsored' });
  });

  it('team invite/accept/assign + worker visibility on the real DB', async () => {
    const team = await teams.createTeam(ownerId, 'Ali Repair Shop');
    await teams.inviteMember(team.id, ownerId, worker1Id, 'worker');
    await teams.inviteMember(team.id, ownerId, worker2Id, 'worker');
    await teams.acceptInvite(team.id, worker1Id);
    await teams.acceptInvite(team.id, worker2Id);
    await teams.assignJob(team.id, ownerId, jobId, worker1Id);

    const w1Jobs = await teams.listTeamJobs(team.id, worker1Id);
    expect(w1Jobs.items.map((j: any) => j.id)).toEqual([jobId]);
    const w2Jobs = await teams.listTeamJobs(team.id, worker2Id);
    expect(w2Jobs.items).toHaveLength(0);
    const err = await expectApiError(teams.getTeamJob(team.id, worker2Id, jobId));
    expect(err.status).toBe(403);
    expect((await teams.getTeamJob(team.id, worker1Id, jobId)).id).toBe(jobId);
    const ownerJobs = await teams.listTeamJobs(team.id, ownerId);
    expect(ownerJobs.items.map((j: any) => j.id)).toEqual([jobId]);
  });

  it('central earnings split settled jobs per worker once the job settles', async () => {
    const team = (await admin.query(`SELECT id FROM teams WHERE provider_id=$1`, [providerId])).rows[0];
    await admin.query(`UPDATE jobs SET state='PAYMENT_SETTLED', payment_status='settled', commission_amount=120 WHERE id=$1`, [jobId]);
    const e = await teams.getTeamEarnings(team.id, ownerId);
    expect(e.gross_pkr).toBe(2000);
    expect(e.commission_pkr).toBe(120);
    expect(e.net_earnings_pkr).toBe(1880);
    expect(e.by_worker).toHaveLength(1);
    expect(e.by_worker[0].worker_user_id).toBe(worker1Id);
    expect(e.by_worker[0].net_earnings_pkr).toBe(1880);
    expect(e.unassigned.jobs_settled).toBe(0);
  });

  it('a Free-plan owner cannot invite staff (TEAM_SEAT_LIMIT)', async () => {
    const freeOwner = crypto.randomUUID();
    await admin.query(`INSERT INTO users (id, phone) VALUES ($1,$2)`, [freeOwner, PHONE('5')]);
    await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, base_point)
       VALUES ($1,'INDIVIDUAL','Free Shop', ST_SetSRID(ST_MakePoint(67.0,30.18),4326)::geography)`,
      [freeOwner],
    );
    const team = await teams.createTeam(freeOwner, 'Free Shop');
    const err = await expectApiError(teams.inviteMember(team.id, freeOwner, worker1Id, 'worker'));
    expect(err.status).toBe(409);
    expect(err.code).toBe('TEAM_SEAT_LIMIT');
  });
});
