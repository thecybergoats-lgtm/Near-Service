// Env validation tests (FIX 5). parseEnv is pure — each case passes an
// explicit env record, so tests never depend on the ambient process.env.
import { parseEnv } from '../../src/config/env';

const PROD_BASE: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  CNIC_PEPPER: 'c'.repeat(32),
  OTP_HASH_SECRET: 'd'.repeat(32),
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
};

describe('env validation (FIX 5)', () => {
  it('production with all valid secrets parses; OTP_DEV_MODE defaults to false', () => {
    const env = parseEnv(PROD_BASE);
    expect(env.isProduction).toBe(true);
    expect(env.otpDevMode).toBe(false);
    expect(env.jwtAccessSecret).toBe('a'.repeat(32));
  });

  it.each([
    ['JWT_ACCESS_SECRET'],
    ['JWT_REFRESH_SECRET'],
    ['CNIC_PEPPER'],
    ['OTP_HASH_SECRET'],
    ['FIELD_ENCRYPTION_KEY'],
    ['DATABASE_URL'],
    ['REDIS_URL'],
  ])('production refuses to start when %s is missing', (key) => {
    const { [key]: _dropped, ...rest } = PROD_BASE;
    void _dropped;
    expect(() => parseEnv(rest)).toThrow(new RegExp(`${key} is REQUIRED`));
  });

  it('production refuses a short JWT secret', () => {
    expect(() => parseEnv({ ...PROD_BASE, JWT_ACCESS_SECRET: 'too-short' })).toThrow(/at least 32 characters/);
  });

  it('production refuses a secret containing "change-me"', () => {
    expect(() => parseEnv({ ...PROD_BASE, JWT_ACCESS_SECRET: `change-me-${'x'.repeat(32)}` })).toThrow(
      /must not contain "change-me"/,
    );
  });

  it('production refuses identical access and refresh secrets', () => {
    expect(() => parseEnv({ ...PROD_BASE, JWT_REFRESH_SECRET: PROD_BASE.JWT_ACCESS_SECRET })).toThrow(
      /must differ from JWT_ACCESS_SECRET/,
    );
  });

  it('production refuses a FIELD_ENCRYPTION_KEY that is not 32 bytes', () => {
    expect(() =>
      parseEnv({ ...PROD_BASE, FIELD_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/exactly 32 bytes/);
  });

  it('development allows missing secrets (dev defaults) and OTP_DEV_MODE defaults to false', () => {
    const env = parseEnv({ NODE_ENV: 'development' });
    expect(env.isProduction).toBe(false);
    expect(env.otpDevMode).toBe(false);
    expect(env.jwtAccessSecret.length).toBeGreaterThanOrEqual(32);
    expect(env.jwtAccessSecret).not.toBe(env.jwtRefreshSecret);
  });

  it('OTP_DEV_MODE=true parses as true outside production', () => {
    expect(parseEnv({ NODE_ENV: 'development', OTP_DEV_MODE: 'true' }).otpDevMode).toBe(true);
  });
});
