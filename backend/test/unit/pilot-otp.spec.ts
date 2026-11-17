// Temporary pilot login tests (remove before public launch).
// A fixed code works ONLY for the single allowlisted owner phone; every
// other phone still gets a random OTP, and the pilot code is useless
// without a prior requestOtp (it is not a backdoor in verify). The pilot
// code value here is test-only. The real path is Firebase phone auth /
// SMS gateway (PRD p.4).
import { AuthService } from '../../src/modules/auth/auth.service';
import { RedisService } from '../../src/database/redis.service';
import { parseEnv } from '../../src/config/env';

const PILOT_PHONE = '+923333079204';
const PILOT_CODE = '482917';
const OTHER_PHONE = '+923001234567';

jest.mock('../../src/config/env', () => {
  const actual = jest.requireActual('../../src/config/env');
  // Values are inlined here (not read from the outer consts): jest.mock
  // factories are hoisted above the const declarations, so referencing
  // them would throw "Cannot access before initialization".
  return {
    ...actual,
    env: { ...actual.env, pilotLoginPhone: '+923333079204', pilotLoginCode: '482917' },
  };
});

function makeService() {
  delete process.env.REDIS_URL;
  const redis = new RedisService();
  const userRow = { id: 'user-1', phone: PILOT_PHONE, full_name: 'Test', language: 'ur', status: 'active' };
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

describe('temporary pilot login', () => {
  it('pilot phone: requestOtp then verifyOtp with the pilot code returns tokens', async () => {
    const { svc } = makeService();
    const req = await svc.requestOtp(PILOT_PHONE);
    expect(req.expires_in_seconds).toBeGreaterThan(0);
    const out = await svc.verifyOtp(PILOT_PHONE, PILOT_CODE);
    expect(out.access_token).toBeTruthy();
    expect(out.refresh_token).toBeTruthy();
  });

  it('pilot phone: a wrong code fails with OTP_INVALID', async () => {
    const { svc } = makeService();
    await svc.requestOtp(PILOT_PHONE);
    await expect(svc.verifyOtp(PILOT_PHONE, '000000')).rejects.toMatchObject({
      status: 400,
      code: 'OTP_INVALID',
    });
  });

  it('pilot code does NOT work for any other phone', async () => {
    const { svc } = makeService();
    await svc.requestOtp(OTHER_PHONE);
    await expect(svc.verifyOtp(OTHER_PHONE, PILOT_CODE)).rejects.toMatchObject({
      status: 400,
      code: 'OTP_INVALID',
    });
  });

  it('pilot code is useless without a prior request (no backdoor in verify)', async () => {
    const { svc } = makeService();
    await expect(svc.verifyOtp(PILOT_PHONE, PILOT_CODE)).rejects.toMatchObject({
      status: 400,
      code: 'OTP_EXPIRED',
    });
  });

  it('env validation: phone and code must be set together, code exactly 6 digits', () => {
    expect(() => parseEnv({ NODE_ENV: 'test', PILOT_LOGIN_PHONE: PILOT_PHONE })).toThrow(
      'must be set together',
    );
    expect(() => parseEnv({ NODE_ENV: 'test', PILOT_LOGIN_CODE: '12345' })).toThrow(
      'must be set together',
    );
    expect(() =>
      parseEnv({ NODE_ENV: 'test', PILOT_LOGIN_PHONE: PILOT_PHONE, PILOT_LOGIN_CODE: '12345' }),
    ).toThrow('exactly 6 digits');
    expect(() =>
      parseEnv({ NODE_ENV: 'test', PILOT_LOGIN_PHONE: '+442071234567', PILOT_LOGIN_CODE: '123456' }),
    ).toThrow('Pakistani mobile number');
    const env = parseEnv({
      NODE_ENV: 'test',
      PILOT_LOGIN_PHONE: PILOT_PHONE,
      PILOT_LOGIN_CODE: PILOT_CODE,
    });
    expect(env.pilotLoginPhone).toBe(PILOT_PHONE);
    expect(env.pilotLoginCode).toBe(PILOT_CODE);
    expect(parseEnv({ NODE_ENV: 'test' }).pilotLoginPhone).toBeNull();
  });
});
