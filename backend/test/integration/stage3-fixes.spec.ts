// Stage 3 integration tests (FIXES 11-15) — REAL Postgres 16 + PostGIS 3
// and REAL Redis. Run with:
//   DATABASE_URL=<redacted>
//   REDIS_URL=redis://localhost:6379 NODE_ENV=test npm test -- stage3-fixes
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0009. Only ever point it at a dedicated test DB.
// Skipped entirely when DATABASE_URL or REDIS_URL is not set.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { createValidationPipe } from '../../src/common/validation/validation-pipe';
import { RedisService } from '../../src/database/redis.service';
import { WalletService } from '../../src/modules/payments/wallet.service';
import { AdminService } from '../../src/modules/admin/admin.service';
import { TrustService } from '../../src/modules/trust/trust.service';
import { hashOtp } from '../../src/common/utils/otp';

jest.setTimeout(60000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
// Valid PK mobile: +92 + 10 digits. prefix (3 digits, 30x) + RUN (6) + d (1).
const PHONE = (prefix: string, d: string) => `+92${prefix}${RUN}${d}`;
const CATEGORY_ID = '00000000-0000-4000-8000-0000b0000001'; // Book Binding (seeded)
const OTP_CODE = '123456';
let disputePhoneSeq = 0; // distinct 31x phones for makeDisputedJob

async function bootApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

maybeDescribe('Stage 3 fixes (real DB + Redis)', () => {
  let app: INestApplication;
  let admin: Client;
  let redis: RedisService;
  let rawRedis: Redis;
  let wallet: WalletService;
  let adminSvc: AdminService;
  let trust: TrustService;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    const files = fs.readdirSync(dbDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    redis = new RedisService();
    rawRedis = new Redis(process.env.REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    const keys = [...(await rawRedis.keys('rl:*')), ...(await rawRedis.keys('otp:rl:*')), ...(await rawRedis.keys('idem:*'))];
    if (keys.length) await rawRedis.del(...keys);
    app = await bootApp();
    wallet = app.get(WalletService);
    adminSvc = app.get(AdminService);
    trust = app.get(TrustService);
  });

  afterAll(async () => {
    await app.close();
    await redis.onModuleDestroy();
    rawRedis.disconnect();
    await admin.end();
  });

  async function login(phone: string): Promise<string> {
    await redis.set(`otp:${phone}`, hashOtp(OTP_CODE), 300);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .send({ phone, code: OTP_CODE, device_fingerprint: `stage3-${phone.slice(-4)}` });
    expect(res.status).toBe(200);
    return res.body.access_token as string;
  }

  async function makeUser(phone: string): Promise<string> {
    const r = await admin.query(`INSERT INTO users (phone, full_name, language) VALUES ($1,'Stage3','ur') RETURNING id`, [phone]);
    return r.rows[0].id as string;
  }

  async function makeProvider(userId: string): Promise<string> {
    const r = await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, tier, base_point)
       VALUES ($1,'INDIVIDUAL','Stage3 Provider',1, ST_SetSRID(ST_MakePoint(66.975,30.1798),4326)::geography) RETURNING id`,
      [userId],
    );
    return r.rows[0].id as string;
  }

  async function makeJob(customerId: string, providerId: string, finalPrice: number, state: string, paymentStatus = 'unpaid'): Promise<string> {
    const req = await admin.query(
      `INSERT INTO service_requests (customer_id, category_id, fulfillment, location, status)
       VALUES ($1,$2,'VISIT_SHOP', ST_SetSRID(ST_MakePoint(66.975,30.1798),4326)::geography, 'ACCEPTED') RETURNING id`,
      [customerId, CATEGORY_ID],
    );
    const offer = await admin.query(
      `INSERT INTO offers (request_id, provider_id, offered_by, price, status, expires_at)
       VALUES ($1,$2,'provider',$3,'accepted', now() + interval '1 hour') RETURNING id`,
      [req.rows[0].id, providerId, finalPrice],
    );
    const job = await admin.query(
      `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price, commission_rate, state, payment_status)
       VALUES ($1,$2,$3,$4,$5,$5,0.10,$6,$7) RETURNING id`,
      [req.rows[0].id, offer.rows[0].id, customerId, providerId, finalPrice, state, paymentStatus],
    );
    return job.rows[0].id as string;
  }

  async function fundWallet(userId: string, paisa: number): Promise<void> {
    await admin.query(
      `INSERT INTO wallet_accounts (user_id, balance_paisa) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET balance_paisa=$2`,
      [userId, paisa],
    );
  }

  it('FIX 13: GET /health is 200 and GET /ready is 200 when Postgres + Redis are up', async () => {
    const health = await request(app.getHttpServer()).get('/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    const ready = await request(app.getHttpServer()).get('/api/v1/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.dependencies).toEqual({ postgres: 'up', redis: 'up' });
  });

  it('FIX 13: GET /ready is 503 with Redis unreachable (dead REDIS_URL)', async () => {
    const saved = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://localhost:6399';
    let deadApp: INestApplication | null = null;
    try {
      deadApp = await bootApp();
      const res = await request(deadApp.getHttpServer()).get('/api/v1/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.dependencies.postgres).toBe('up');
      expect(res.body.dependencies.redis).toBe('down');
      const health = await request(deadApp.getHttpServer()).get('/api/v1/health');
      expect(health.status).toBe(200);
    } finally {
      if (deadApp) await deadApp.close();
      process.env.REDIS_URL = saved;
    }
  });

  it('FIX 14(a): two parallel redemptions of the same promo for the same user -> exactly one success', async () => {
    const customerId = await makeUser(PHONE('301','1'));
    const providerUserId = await makeUser(PHONE('301','2'));
    const providerId = await makeProvider(providerUserId);
    await fundWallet(customerId, 500000); // PKR 5,000
    const promoId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO promos (id, code, kind, value, per_user_limit, is_active) VALUES ($1,'RACE1','percent',10,1,true)`,
      [promoId],
    );
    const jobA = await makeJob(customerId, providerId, 1000, 'COMPLETED');
    const jobB = await makeJob(customerId, providerId, 1000, 'COMPLETED');
    const [a, b] = await Promise.allSettled([
      wallet.payWithWallet(jobA, customerId, 'RACE1', undefined, 'race-a'),
      wallet.payWithWallet(jobB, customerId, 'RACE1', undefined, 'race-b'),
    ]);
    const ok = [a, b].filter((r) => r.status === 'fulfilled');
    const failed = [a, b].filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // The loser fails either at validation (it validated after the winner
    // committed: PROMO_INVALID wrapping PROMO_PER_USER_LIMIT) or at the
    // in-txn re-check (PROMO_PER_USER_LIMIT) — both mean "already
    // redeemed". What must never happen is two successes.
    const reason = (failed[0] as PromiseRejectedResult).reason;
    const codeText = `${reason?.code ?? ''} ${reason?.message ?? ''}`;
    expect(codeText).toMatch(/PROMO_PER_USER_LIMIT/);
    const count = await admin.query(`SELECT COUNT(*) AS cnt FROM promo_redemptions WHERE promo_id=$1 AND user_id=$2`, [promoId, customerId]);
    expect(Number(count.rows[0].cnt)).toBe(1);
  });

  it('FIX 14(a) mechanism: the FOR UPDATE promo-row lock is what serialises concurrent redemptions', async () => {
    // Mirrors the in-txn promo block in WalletService.payWithWalletInner:
    // lock the promo row, re-count, insert. The interleaving is driven
    // explicitly so the result is deterministic, not timing luck.
    // WITH the lock: B's FOR UPDATE blocks until A commits, then B's
    // re-count sees 1 and it rolls back -> exactly one redemption.
    // WITHOUT the lock (control): both count 0 before either inserts,
    // because the (promo_id, user_id, job_id) PK cannot stop different
    // jobs -> two redemptions. The lock, not the PK, closes the race.
    const customerId = await makeUser(PHONE('301', '3'));
    const providerUserId = await makeUser(PHONE('301', '4'));
    const providerId = await makeProvider(providerUserId);
    // job_id is a real FK — use real jobs (state is irrelevant here; the
    // redemption insert is what is being serialised).
    const jobA = await makeJob(customerId, providerId, 1000, 'COMPLETED');
    const jobB = await makeJob(customerId, providerId, 1000, 'COMPLETED');
    const lockedPromo = crypto.randomUUID();
    const unlockedPromo = crypto.randomUUID();
    for (const id of [lockedPromo, unlockedPromo]) {
      await admin.query(`INSERT INTO promos (id, code, kind, value, per_user_limit, is_active) VALUES ($1,$2,'percent',10,1,true)`, [id, `RACE-${id.slice(0, 8)}`]);
    }
    const openTx = async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      await c.query('BEGIN');
      return c;
    };
    const countUses = async (c: Client, promoId: string) =>
      Number((await c.query(`SELECT COUNT(*) AS cnt FROM promo_redemptions WHERE promo_id=$1 AND user_id=$2`, [promoId, customerId])).rows[0].cnt);
    const insertRedemption = async (c: Client, promoId: string, jobId: string) =>
      c.query(`INSERT INTO promo_redemptions (promo_id, user_id, job_id) VALUES ($1,$2,$3)`, [promoId, customerId, jobId]);

    // WITH lock.
    const a = await openTx();
    const b = await openTx();
    await a.query(`SELECT per_user_limit FROM promos WHERE id=$1 FOR UPDATE`, [lockedPromo]); // A holds the lock first
    const lockB = b.query(`SELECT per_user_limit FROM promos WHERE id=$1 FOR UPDATE`, [lockedPromo]); // not awaited: blocks on A
    expect(await countUses(a, lockedPromo)).toBe(0);
    await insertRedemption(a, lockedPromo, jobA);
    await a.query('COMMIT');
    await a.end();
    await lockB; // unblocks now that A committed
    expect(await countUses(b, lockedPromo)).toBe(1);
    await b.query('ROLLBACK');
    await b.end();
    const lockedCount = await admin.query(`SELECT COUNT(*) AS cnt FROM promo_redemptions WHERE promo_id=$1`, [lockedPromo]);
    expect(Number(lockedCount.rows[0].cnt)).toBe(1);

    // WITHOUT lock (control).
    const c1 = await openTx();
    const c2 = await openTx();
    expect(await countUses(c1, unlockedPromo)).toBe(0);
    expect(await countUses(c2, unlockedPromo)).toBe(0);
    await insertRedemption(c1, unlockedPromo, jobA);
    await insertRedemption(c2, unlockedPromo, jobB);
    await c1.query('COMMIT');
    await c2.query('COMMIT');
    await c1.end();
    await c2.end();
    const unlockedCount = await admin.query(`SELECT COUNT(*) AS cnt FROM promo_redemptions WHERE promo_id=$1`, [unlockedPromo]);
    expect(Number(unlockedCount.rows[0].cnt)).toBe(2);
  });

  async function makeDisputedJob(finalPrice: number): Promise<{ jobId: string; disputeId: string; customerId: string; adminId: string }> {
    const customerId = await makeUser(PHONE('31' + String(disputePhoneSeq++), '1'));
    const providerUserId = await makeUser(PHONE('31' + String(disputePhoneSeq++), '1'));
    const providerId = await makeProvider(providerUserId);
    const jobId = await makeJob(customerId, providerId, finalPrice, 'DISPUTED', 'settled');
    const dispute = await admin.query(
      `INSERT INTO disputes (job_id, opened_by, reason_code, status) VALUES ($1,$2,'not_as_described','open') RETURNING id`,
      [jobId, customerId],
    );
    const adminId = await makeUser(PHONE('31' + String(disputePhoneSeq++), '1'));
    return { jobId, disputeId: dispute.rows[0].id as string, customerId, adminId };
  }

  it('FIX 14(b): a full refund writes a payments row (refunded) matching the ledger', async () => {
    const { jobId, disputeId, adminId } = await makeDisputedJob(1000);
    await adminSvc.resolveDispute(adminId, disputeId, { outcome: 'refund' });
    const pay = await admin.query(`SELECT * FROM payments WHERE job_id=$1 AND status='refunded'`, [jobId]);
    expect(pay.rows).toHaveLength(1);
    expect(Number(pay.rows[0].amount)).toBe(1000);
    const legs = await admin.query(
      `SELECT SUM(CASE WHEN direction='D' THEN amount_paisa ELSE 0 END)::int AS d,
              SUM(CASE WHEN direction='C' THEN amount_paisa ELSE 0 END)::int AS c
       FROM ledger_entries WHERE job_id=$1 AND memo LIKE 'Dispute refund%'`,
      [jobId],
    );
    expect(Number(legs.rows[0].d)).toBeGreaterThan(0);
    expect(Number(legs.rows[0].d)).toBe(Number(legs.rows[0].c));
    expect(Number(pay.rows[0].amount) * 100).toBe(Number(legs.rows[0].d) / 2); // customer credit + provider debit legs
    const job = await admin.query(`SELECT state FROM jobs WHERE id=$1`, [jobId]);
    expect(job.rows[0].state).toBe('REFUNDED');
  });

  it('FIX 14(b): a partial refund writes a payments row (partially_refunded) with the partial amount', async () => {
    const { jobId, disputeId, adminId } = await makeDisputedJob(1000);
    await adminSvc.resolveDispute(adminId, disputeId, { outcome: 'partial_refund', amount_pkr: 400 });
    const pay = await admin.query(`SELECT * FROM payments WHERE job_id=$1 AND status='partially_refunded'`, [jobId]);
    expect(pay.rows).toHaveLength(1);
    expect(Number(pay.rows[0].amount)).toBe(400);
    const job = await admin.query(`SELECT state FROM jobs WHERE id=$1`, [jobId]);
    expect(job.rows[0].state).toBe('PAYMENT_SETTLED');
  });

  it('FIX 14(c): dispute photo evidence uses the signed-URL upload flow; foreign keys are rejected', async () => {
    const customerId = await makeUser(PHONE('302','1'));
    const providerUserId = await makeUser(PHONE('302','2'));
    const providerId = await makeProvider(providerUserId);
    const jobId = await makeJob(customerId, providerId, 500, 'DISPUTED', 'unpaid');
    const dispute = await admin.query(
      `INSERT INTO disputes (job_id, opened_by, reason_code, status) VALUES ($1,$2,'not_as_described','open') RETURNING id`,
      [jobId, customerId],
    );
    const disputeId = dispute.rows[0].id as string;
    const up = await trust.requestEvidenceUpload(disputeId, customerId);
    expect(up.storage_key.startsWith(`disputes/${disputeId}/evidence-`)).toBe(true);
    expect(up.upload_url).toContain(encodeURIComponent(up.storage_key));
    // Upload the bytes to the local dev receiver (same flow as documents).
    const uploadPath = new URL(up.upload_url).pathname;
    const put = await request(app.getHttpServer()).post(uploadPath).send(Buffer.from('fake-photo-bytes'));
    expect(put.status).toBe(200);
    expect(put.body.storage_key).toBe(up.storage_key);
    const row = await trust.addEvidence(disputeId, customerId, { kind: 'photo', storage_key: up.storage_key });
    expect(row.storage_key).toBe(up.storage_key);
    const got = await trust.getDispute(disputeId, customerId);
    expect(got.evidence).toHaveLength(1);
    expect(got.evidence[0].storage_key).toBe(up.storage_key);
    // A hand-typed / foreign key is rejected.
    await expect(
      trust.addEvidence(disputeId, customerId, { kind: 'photo', storage_key: 'disputes/someone-else/evidence-x.bin' }),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE_KEY' });
    await expect(
      trust.addEvidence(disputeId, customerId, { kind: 'photo' }),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE_KEY' });
  });

  it('FIX 14(d): GET /chats is served by the messaging module', async () => {
    const customerPhone = PHONE('303','1');
    const customerId = await makeUser(customerPhone);
    const providerUserId = await makeUser(PHONE('303','2'));
    const providerId = await makeProvider(providerUserId);
    const jobId = await makeJob(customerId, providerId, 500, 'ACCEPTED');
    const reqRow = await admin.query(`SELECT request_id FROM jobs WHERE id=$1`, [jobId]);
    await admin.query(
      `INSERT INTO chats (job_id, request_id, customer_id, provider_id) VALUES ($1,$2,$3,$4)`,
      [jobId, reqRow.rows[0].request_id, customerId, providerId],
    );
    const token = await login(customerPhone);
    const res = await request(app.getHttpServer())
      .get('/api/v1/chats')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].job_id).toBe(jobId);
    expect(res.body.next_cursor).toBeNull();
    const filtered = await request(app.getHttpServer())
      .get(`/api/v1/chats?job_id=${jobId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(1);
  });
});
