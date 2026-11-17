// Integration tests — risk engine (Phase 3, item 2) against REAL Postgres 16
// + PostGIS 3. Run with (passwordless peer auth over the local socket; no
// password in the URL, no PGPASSFILE needed):
//   DATABASE_URL=postgresql://root@/nearservice_p3_risk?host=/var/run/postgresql \
//   NODE_ENV=test npm test -- risk-engine --runInBand
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0011. Only ever point it at the dedicated
// nearservice_p3_risk database — never a shared test DB.
// Skipped entirely when DATABASE_URL is not set.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { DatabaseService } from '../../src/database/database.service';
import { RiskService } from '../../src/modules/risk/risk.service';

jest.setTimeout(60000);

const hasDb = !!process.env.DATABASE_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
const PHONE = (n: string) => `+92301${RUN}${n}`;
const CATEGORY_ID = '00000000-0000-4000-8000-0000b0000001'; // Book Binding (seeded by 0004)

maybeDescribe('risk engine (real DB)', () => {
  let dbSvc: DatabaseService;
  let risk: RiskService;
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    const files = fs.readdirSync(dbDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(files).toContain('0011_risk_engine.sql');
    for (const file of files) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    dbSvc = new DatabaseService();
    risk = new RiskService(dbSvc);
  });

  afterAll(async () => {
    await dbSvc.onModuleDestroy();
    await admin.end();
  });

  async function makeUser(phone: string): Promise<string> {
    return (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Risk Test','ur') RETURNING id`,
      [phone],
    )).rows[0].id as string;
  }
  async function makeProvider(userId: string, payoutAccount: string | null = null): Promise<string> {
    return (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, base_point, payout_account_encrypted)
       VALUES ($1,'INDIVIDUAL','Risk Provider', ST_SetSRID(ST_MakePoint(66.9,30.2),4326)::geography, $2) RETURNING id`,
      [userId, payoutAccount],
    )).rows[0].id as string;
  }
  async function makeJob(customerId: string, providerId: string, state: string): Promise<string> {
    const requestId = (await admin.query(
      `INSERT INTO service_requests (customer_id, category_id, fulfillment, location)
       VALUES ($1,$2,'PROVIDER_COMES', ST_SetSRID(ST_MakePoint(66.9,30.2),4326)::geography) RETURNING id`,
      [customerId, CATEGORY_ID],
    )).rows[0].id as string;
    const offerId = (await admin.query(
      `INSERT INTO offers (request_id, provider_id, offered_by, price, expires_at)
       VALUES ($1,$2,'provider',1000, now() + interval '1 hour') RETURNING id`,
      [requestId, providerId],
    )).rows[0].id as string;
    return (await admin.query(
      `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price, commission_rate, state, payment_method, payment_status)
       VALUES ($1,$2,$3,$4,1000,1000,0.1,$5,'cash','unpaid') RETURNING id`,
      [requestId, offerId, customerId, providerId, state],
    )).rows[0].id as string;
  }

  it('migration 0011 seeds risk_settings and extends risk_scores', async () => {
    const settings = await admin.query(`SELECT key, value FROM risk_settings ORDER BY key`);
    const keys = settings.rows.map((r) => r.key as string);
    expect(keys).toEqual(['block_threshold', 'hold_hours', 'review_threshold', 'velocity_max_requests_per_hour', 'weights', 'window_days']);
    const weights = settings.rows.find((r) => r.key === 'weights')?.value as Record<string, number>;
    expect(weights.no_show).toBe(12);
    expect(weights.upheld_dispute).toBe(20);
    const cols = await admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='risk_scores' ORDER BY column_name`);
    expect(cols.rows.map((r) => r.column_name)).toContain('level');
    expect(cols.rows.map((r) => r.column_name)).toContain('breakdown');
    const tables = await admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('risk_events','risk_settings')`);
    expect(tables.rows).toHaveLength(2);
  });

  it('recomputeScore aggregates every derived signal + a recorded event, sets critical + hold, and audits', async () => {
    const customerId = await makeUser(PHONE('11'));
    const providerUserId = await makeUser(PHONE('12'));
    const providerId = await makeProvider(providerUserId, 'acct-shared-1');
    const otherUserId = await makeUser(PHONE('13'));
    const otherProviderUserId = await makeUser(PHONE('14'));
    await makeProvider(otherProviderUserId, 'acct-shared-1'); // payout-account reuse (+15)

    // 1 provider cancellation (+5) and 1 customer cancellation (counts
    // toward the CUSTOMER, not the provider).
    await makeJob(customerId, providerId, 'CANCELLED_BY_PROVIDER');
    await makeJob(customerId, providerId, 'CANCELLED_BY_CUSTOMER');
    // 1 upheld dispute: resolved with a refund outcome (+20). Real resolves
    // set updated_at=now() (AdminService.resolveDispute); the column has no
    // default, so the test must set it too or the window filter excludes it.
    const disputedJobId = await makeJob(customerId, providerId, 'DISPUTED');
    await admin.query(
      `INSERT INTO disputes (job_id, opened_by, status, resolution, updated_at) VALUES ($1,$2,'resolved',$3,now())`,
      [disputedJobId, customerId, JSON.stringify({ outcome: 'refund', amount_pkr: 1000 })],
    );
    // 1 teleport fraud signal (+15).
    await admin.query(
      `INSERT INTO fraud_signals (user_id, job_id, signal, detail) VALUES ($1,$2,'teleport_location',$3)`,
      [providerUserId, disputedJobId, JSON.stringify({ speed_kmh: 900 })],
    );
    // 2 devices for the provider -> 1 extra device (+8); the other user
    // shares one fingerprint -> duplicate account (+18).
    await admin.query(
      `INSERT INTO user_devices (user_id, device_fingerprint, platform, last_seen_at) VALUES
       ($1,'fp-a','android',now()), ($1,'fp-b','android',now()), ($2,'fp-a','android',now())`,
      [providerUserId, otherUserId],
    );
    // Recorded event: no-show (+12). recordEvent recomputes immediately.
    const recorded = await risk.recordEvent(providerUserId, { user_id: providerUserId, signal: 'no_show', job_id: disputedJobId });
    expect(recorded.event.signal).toBe('no_show');
    expect(Number(recorded.event.score_delta)).toBe(12);
    // 5 + 20 + 15 + 8 + 18 + 15 + 12 = 93 -> critical, hold set.
    expect(recorded.score.score).toBe(93);
    expect(recorded.score.level).toBe('critical');
    expect(recorded.score.hold_until).not.toBeNull();
    expect(recorded.score.breakdown.cancellation).toMatchObject({ count: 1, points: 5 });
    expect(recorded.score.breakdown.upheld_dispute).toMatchObject({ count: 1, points: 20 });
    expect(recorded.score.breakdown.teleport).toMatchObject({ count: 1, points: 15 });
    expect(recorded.score.breakdown.device_change).toMatchObject({ count: 1, points: 8 });
    expect(recorded.score.breakdown.duplicate_account).toMatchObject({ count: 1, points: 18 });
    expect(recorded.score.breakdown.payout_account_reuse).toMatchObject({ count: 1, points: 15 });
    expect(recorded.score.breakdown.no_show).toMatchObject({ count: 1, points: 12 });

    // The stored row matches, and exactly one audit row was written.
    const stored = await risk.getScore(providerUserId);
    expect(stored.score).toBe(93);
    const audits = (await admin.query(
      `SELECT action, before, after FROM audit_logs WHERE entity='risk_scores' AND entity_id=$1 ORDER BY id`,
      [providerUserId],
    )).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('risk.score.update');
    expect(Number((audits[0].after as { score: number }).score)).toBe(93);

    // Recompute with nothing changed: no second audit row.
    await risk.recomputeScore(providerUserId, providerUserId);
    const audits2 = (await admin.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_logs WHERE entity='risk_scores' AND entity_id=$1`,
      [providerUserId],
    )).rows[0].cnt as number;
    expect(audits2).toBe(1);

    // Ranking penalty: (93-60)/40 * 0.5 = 0.4125, and blocked at >= 85.
    const penalty = await risk.rankingPenaltyForUser(providerUserId);
    expect(penalty).toMatchObject({ score: 93, level: 'critical', blocked: true });
    expect(penalty.penalty).toBeCloseTo(0.4125, 10);

    // The customer scores 15: 1 customer cancellation (5) + velocity
    // (12 requests in the last hour > 10 limit -> 10). No hold, low.
    for (let i = 0; i < 12; i++) {
      await admin.query(
        `INSERT INTO service_requests (customer_id, category_id, fulfillment, location)
         VALUES ($1,$2,'PROVIDER_COMES', ST_SetSRID(ST_MakePoint(66.9,30.2),4326)::geography)`,
        [customerId, CATEGORY_ID],
      );
    }
    const customerScore = await risk.recomputeScore(customerId, providerUserId);
    expect(customerScore.score).toBe(15);
    expect(customerScore.level).toBe('low');
    expect(customerScore.hold_until).toBeNull();

    // Review queue lists the critical provider, not the low customer.
    const queue = await risk.listReviewQueue({});
    expect(queue.items.map((r) => String((r as Record<string, unknown>).user_id))).toContain(providerUserId);
    expect(queue.items.map((r) => String((r as Record<string, unknown>).user_id))).not.toContain(customerId);

    // Job roll-up: max(93 provider, 15 customer) + 10 open dispute = 103 -> 100.
    await admin.query(
      `INSERT INTO disputes (job_id, opened_by, status) VALUES ($1,$2,'open')`,
      [disputedJobId, customerId],
    );
    const jobScore = await risk.scoreJob(disputedJobId);
    expect(jobScore).toMatchObject({ score: 100, level: 'critical', provider_score: 93, customer_score: 15, open_dispute: true });

    // Events list shows the recorded no-show.
    const events = await risk.listEvents(providerUserId, {});
    expect(events.items.map((e) => (e as Record<string, unknown>).signal)).toContain('no_show');
  });

  it('settings update persists, is audited, and moves the review queue', async () => {
    // updated_by has a FK to users(id): the acting admin must be real.
    const adminId = await makeUser(PHONE('16'));
    const before = await risk.getSettings();
    expect(before.review_threshold).toBe(60);
    const updated = await risk.updateSettings(adminId, { review_threshold: 50, block_threshold: 80 });
    expect(updated.review_threshold).toBe(50);
    expect(updated.block_threshold).toBe(80);
    const stored = (await admin.query(`SELECT value FROM risk_settings WHERE key='review_threshold'`)).rows[0].value as number;
    expect(stored).toBe(50);
    const audits = (await admin.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_logs WHERE action='risk.settings.update'`,
    )).rows[0].cnt as number;
    expect(audits).toBe(1);
    await expect(risk.updateSettings(adminId, { review_threshold: 80, block_threshold: 80 }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_RISK_SETTINGS' });
    // Restore defaults so other workers' runs are unaffected.
    await risk.updateSettings(adminId, { review_threshold: 60, block_threshold: 85 });
    expect((await risk.getSettings()).review_threshold).toBe(60);
  });

  it('getScore returns zero for a never-scored user; recordEvent 404s for unknown ids', async () => {
    const freshId = await makeUser(PHONE('15'));
    expect(await risk.getScore(freshId)).toMatchObject({ score: 0, level: 'low' });
    await expect(risk.recordEvent(freshId, { user_id: '00000000-0000-4000-8000-000000000000', signal: 'no_show' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(risk.recomputeScore('00000000-0000-4000-8000-000000000000'))
      .rejects.toMatchObject({ status: 404 });
  });
});
