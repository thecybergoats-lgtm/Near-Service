// Integration tests (Stage 1, FIX 2 + FIX 3 + FIX 4) — REAL Postgres 16 +
// PostGIS 3 and REAL Redis. Run with:
//   DATABASE_URL=postgres://.../nearservice_stage1_test REDIS_URL=redis://localhost:6379 \
//   NODE_ENV=test OTP_DEV_MODE=false \
//   JWT_ACCESS_SECRET=<32+ chars> JWT_REFRESH_SECRET=<32+ chars, different> \
//   CNIC_PEPPER=<32+ chars> OTP_HASH_SECRET=<32+ chars> \
//   FIELD_ENCRYPTION_KEY=<base64 of 32 bytes> npm test -- auth-refresh-reuse
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0007. Only ever point it at a dedicated test DB.
// Skipped entirely when DATABASE_URL or REDIS_URL is not set.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { AuthService } from '../../src/modules/auth/auth.service';
import { DatabaseService } from '../../src/database/database.service';
import { RedisService } from '../../src/database/redis.service';
import { hashOtp } from '../../src/common/utils/otp';
import { decryptField } from '../../src/common/crypto/field-encryption';
import { cnicHmac } from '../../src/common/utils/cnic';
import { reencryptFields } from '../../src/scripts/reencrypt-fields';
import { ApiError } from '../../src/common/errors/api-error';

jest.setTimeout(30000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

// Unique phones per run: Redis keys (otp:*, otp:rl:*, otp:locked:*) live up
// to an hour, so a second full-suite run must not trip on the first run's
// leftover counters/locks. The service does not validate phone format
// (Stage 2 scope), so any distinct +92… string works here.
const RUN = String(crypto.randomInt(100000, 999999));
const PHONE = (n: string) => `+92300${RUN}${n}`;

/** Await a promise that must reject with an ApiError; returns the error. */
async function expectApiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected promise to reject with an ApiError');
}

maybeDescribe('auth refresh reuse + OTP lockout (real DB + Redis)', () => {
  let svc: AuthService;
  let redis: RedisService;
  let dbSvc: DatabaseService;
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
    svc = new AuthService(dbSvc, redis);
  });

  afterAll(async () => {
    await redis.onModuleDestroy();
    await dbSvc.onModuleDestroy();
    await admin.end();
  });

  async function loginWithSeededOtp(phone: string, code = '123456') {
    await redis.set(`otp:${phone}`, hashOtp(code), 300);
    return svc.verifyOtp(phone, code);
  }

  it('FIX 2: replaying the ORIGINAL refresh token revokes the whole family', async () => {
    const phone = PHONE('01');
    const login = await loginWithSeededOtp(phone);
    expect(login.refresh_token).toBeTruthy();
    const first = await svc.refresh(login.refresh_token);
    expect(first.refresh_token).toBeTruthy();
    expect(first.refresh_token).not.toBe(login.refresh_token);
    // Replay the ORIGINAL token: must be 401 REFRESH_REUSE_DETECTED.
    const replayErr = await expectApiError(svc.refresh(login.refresh_token));
    expect(replayErr).toBeInstanceOf(ApiError);
    expect(replayErr.status).toBe(401);
    expect(replayErr.code).toBe('REFRESH_REUSE_DETECTED');
    // The family is revoked: even the NEW token from refresh #1 is rejected.
    const newTokenErr = await expectApiError(svc.refresh(first.refresh_token));
    expect(newTokenErr).toBeInstanceOf(ApiError);
    expect(newTokenErr.status).toBe(401);
  });

  it('FIX 3: 5 wrong OTP codes lock verify on real Redis; correct code still fails', async () => {
    const phone = PHONE('02');
    await redis.set(`otp:${phone}`, hashOtp('123456'), 300);
    for (let i = 0; i < 4; i += 1) {
      await expect(svc.verifyOtp(phone, '000000')).rejects.toMatchObject({ status: 400, code: 'OTP_INVALID' });
    }
    await expect(svc.verifyOtp(phone, '000000')).rejects.toMatchObject({ status: 429, code: 'OTP_LOCKED' });
    const locked = await expectApiError(svc.verifyOtp(phone, '123456'));
    expect(locked.status).toBe(429);
    expect(locked.code).toBe('OTP_LOCKED');
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);
    expect(locked.retryAfterSeconds).toBeLessThanOrEqual(900);
    const ttl = await redis.ttl(`otp:locked:${phone}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it('FIX 3(d): 10 parallel OTP requests count exactly 10 (atomic INCR+EXPIRE)', async () => {
    const phone = PHONE('03');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => svc.requestOtp(phone)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const limited = results.filter(
      (r) => r.status === 'rejected' && (r.reason as ApiError).status === 429,
    ).length;
    expect(ok).toBe(5); // OTP_MAX_ATTEMPTS_PER_PHONE_PER_HOUR default is 5
    expect(limited).toBe(5);
    expect(await redis.get(`otp:rl:${phone}`)).toBe('10');
  });

  it('FIX 4: reencrypt-fields upgrades legacy base64 rows and is idempotent', async () => {
    const cnic = '6110112345671';
    const payout = 'JazzCash 03001234567';
    const userId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Reencrypt Test','ur') RETURNING id`,
      [PHONE('04')],
    )).rows[0].id as string;
    const legacyCnic = Buffer.from(cnic).toString('base64');
    const legacyPayout = Buffer.from(payout).toString('base64');
    const profileId = (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, cnic_encrypted, cnic_hmac, base_point, payout_method, payout_account_encrypted)
       VALUES ($1,'INDIVIDUAL','Reencrypt Test',$2,$3, ST_SetSRID(ST_MakePoint(66.9,30.2),4326)::geography,'jazzcash',$4) RETURNING id`,
      [userId, legacyCnic, cnicHmac(cnic), legacyPayout],
    )).rows[0].id as string;

    const first = await reencryptFields(admin);
    expect(first.upgraded).toBe(2);
    const row = (await admin.query<{ cnic_encrypted: string; payout_account_encrypted: string }>(
      `SELECT cnic_encrypted, payout_account_encrypted FROM provider_profiles WHERE id=$1`, [profileId],
    )).rows[0];
    expect(row.cnic_encrypted.startsWith('v1:')).toBe(true);
    expect(row.payout_account_encrypted.startsWith('v1:')).toBe(true);
    expect(decryptField(row.cnic_encrypted)).toBe(cnic);
    expect(decryptField(row.payout_account_encrypted)).toBe(payout);

    const second = await reencryptFields(admin);
    expect(second.upgraded).toBe(0);
    expect(second.alreadyEncrypted).toBe(2);
  });
});
