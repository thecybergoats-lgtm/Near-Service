// OTP brute-force protection tests (FIX 3).
// Uses the real RedisService with its in-memory fallback (no REDIS_URL) so
// jest fake timers control the 15-minute lock window, and a stub DB — the
// failure/lock paths never touch the database. The real-DB + real-Redis
// behaviour is covered by test/integration/auth-refresh-reuse.spec.ts.
import * as fs from 'fs';
import * as path from 'path';
import { AuthService } from '../../src/modules/auth/auth.service';
import { RedisService } from '../../src/database/redis.service';
import { hashOtp } from '../../src/common/utils/otp';
import { ApiError } from '../../src/common/errors/api-error';

const PHONE = '+923001234567';
const CODE = '123456';

/** Await a promise that must reject with an ApiError; returns the error. */
async function expectApiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected promise to reject with an ApiError');
}

function makeService() {
  delete process.env.REDIS_URL;
  const redis = new RedisService();
  const userRow = { id: 'user-1', phone: PHONE, full_name: 'Test', language: 'ur', status: 'active' };
  const client = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM users WHERE phone')) return { rows: [] };
      if (sql.startsWith('INSERT INTO users')) return { rows: [userRow] };
      if (sql.startsWith('INSERT INTO wallet_accounts')) return { rows: [{ id: 'wallet-1' }] };
      return { rows: [] };
    }),
  };
  const db: any = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM user_roles')) return { rows: [{ name: 'customer' }] };
      return { rows: [] };
    }),
    withTransaction: jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(client)),
  };
  return { svc: new AuthService(db, redis), redis };
}

async function seedOtp(redis: RedisService, code = CODE) {
  await redis.set(`otp:${PHONE}`, hashOtp(code), 300);
}

describe('OTP lockout (FIX 3)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('locks after 5 wrong codes; the correct code still fails; works again after the window', async () => {
    const { svc, redis } = makeService();
    await seedOtp(redis);
    for (let i = 0; i < 4; i += 1) {
      await expect(svc.verifyOtp(PHONE, '000000')).rejects.toMatchObject({ status: 400, code: 'OTP_INVALID' });
    }
    // 5th wrong code trips the lock.
    await expect(svc.verifyOtp(PHONE, '000000')).rejects.toMatchObject({ status: 429, code: 'OTP_LOCKED' });
    const lockedErr = await expectApiError(svc.verifyOtp(PHONE, CODE));
    expect(lockedErr).toBeInstanceOf(ApiError);
    expect(lockedErr.status).toBe(429);
    expect(lockedErr.code).toBe('OTP_LOCKED');
    expect(lockedErr.retryAfterSeconds).toBeGreaterThan(0);
    expect(lockedErr.retryAfterSeconds).toBeLessThanOrEqual(900);

    // Fake clock: 15 minutes + 1 second pass; the lock is gone.
    jest.advanceTimersByTime(901_000);
    await seedOtp(redis);
    const out = await svc.verifyOtp(PHONE, CODE);
    expect(out.access_token).toBeTruthy();
    expect(out.refresh_token).toBeTruthy();
  });

  it('a successful verify resets the failure counters', async () => {
    const { svc, redis } = makeService();
    await seedOtp(redis);
    for (let i = 0; i < 3; i += 1) {
      await expect(svc.verifyOtp(PHONE, '000000')).rejects.toMatchObject({ status: 400, code: 'OTP_INVALID' });
    }
    const ok = await svc.verifyOtp(PHONE, CODE);
    expect(ok.refresh_token).toBeTruthy();
    // Counters were reset: 4 more wrong codes must NOT lock, the 5th must.
    await seedOtp(redis);
    for (let i = 0; i < 4; i += 1) {
      await expect(svc.verifyOtp(PHONE, '000000')).rejects.toMatchObject({ status: 400, code: 'OTP_INVALID' });
    }
    await expect(svc.verifyOtp(PHONE, '000000')).rejects.toMatchObject({ status: 429, code: 'OTP_LOCKED' });
  });

  it('generateOtpCode never uses Math.random (source check)', () => {
    // Match an actual CALL (Math.random followed by "("); the file's header
    // comment mentions the name without calling it, which is fine.
    const src = fs.readFileSync(path.join(__dirname, '../../src/common/utils/otp.ts'), 'utf8');
    expect(src).not.toMatch(/Math\.random\s*\(/);
    expect(src).toContain('crypto.randomInt');
  });

  it('OTP hash is a keyed HMAC-SHA256 (64 hex), secret-dependent', () => {
    const h1 = hashOtp('123456', 'secret-a');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOtp('123456', 'secret-b')).not.toBe(h1);
    expect(hashOtp('654321', 'secret-a')).not.toBe(h1);
  });
});
