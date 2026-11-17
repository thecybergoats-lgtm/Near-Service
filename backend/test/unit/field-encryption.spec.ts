import { randomBytes } from 'crypto';
import {
  encryptField,
  decryptField,
  isFieldEncrypted,
  isLegacyBase64,
  encryptFieldWithKey,
  decryptFieldWithKey,
} from '../../src/common/crypto/field-encryption';
import { parseEnv } from '../../src/config/env';

const PLAINTEXT = '6110112345671'; // a CNIC (13 digits, no dashes)

describe('field encryption (FIX 4: AES-256-GCM, not base64)', () => {
  it('round-trips', () => {
    expect(decryptField(encryptField(PLAINTEXT))).toBe(PLAINTEXT);
    expect(decryptField(encryptField('JazzCash 03001234567'))).toBe('JazzCash 03001234567');
  });

  it('two encryptions of the same value differ (fresh random IV)', () => {
    const a = encryptField(PLAINTEXT);
    const b = encryptField(PLAINTEXT);
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe(PLAINTEXT);
    expect(decryptField(b)).toBe(PLAINTEXT);
  });

  it('tampering with the ciphertext throws (auth tag verification)', () => {
    const enc = encryptField(PLAINTEXT);
    const [, payload] = enc.split(':');
    const buf = Buffer.from(payload, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a bit in the ciphertext
    const tampered = `v1:${buf.toString('base64')}`;
    expect(() => decryptField(tampered)).toThrow();
  });

  it('tampering with the version prefix throws', () => {
    const enc = encryptField(PLAINTEXT);
    expect(() => decryptField(enc.replace(/^v1:/, 'v9:'))).toThrow(/Unknown field-encryption key version/);
    expect(() => decryptField(PLAINTEXT)).toThrow(/missing version prefix/);
  });

  it('legacy base64 values are detected, encrypted values are not', () => {
    const legacy = Buffer.from(PLAINTEXT).toString('base64');
    expect(isLegacyBase64(legacy)).toBe(true);
    expect(isFieldEncrypted(legacy)).toBe(false);
    const enc = encryptField(PLAINTEXT);
    expect(isFieldEncrypted(enc)).toBe(true);
    expect(isLegacyBase64(enc)).toBe(false);
    expect(isLegacyBase64(null)).toBe(false);
  });

  it('no *_encrypted value is plain base64 of a readable string (DB-shape check)', () => {
    // What a DB check does: take the stored value, strip the version
    // prefix, base64-decode it, and require the bytes NOT to be readable
    // text. The old format failed this by construction.
    for (const value of ['6110112345671', 'JazzCash 03001234567', 'PK12ABCD0000000000000001']) {
      const stored = encryptField(value);
      expect(stored.startsWith('v1:')).toBe(true);
      const decoded = Buffer.from(stored.slice(3), 'base64').toString('utf8');
      // IV + auth tag + ciphertext are random bytes: the decoded payload
      // must not be the plaintext and must contain non-printable bytes.
      expect(decoded).not.toContain(value);
      expect(/[^\x20-\x7E]/.test(decoded)).toBe(true);
    }
  });

  it('encryptFieldWithKey enforces a 32-byte key', () => {
    const key = randomBytes(32);
    expect(decryptFieldWithKey(encryptFieldWithKey(PLAINTEXT, key), key)).toBe(PLAINTEXT);
    expect(() => decryptFieldWithKey(encryptFieldWithKey(PLAINTEXT, key), randomBytes(32))).toThrow();
    expect(() => encryptFieldWithKey(PLAINTEXT, randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe('FIELD_ENCRYPTION_KEY validation (FIX 5)', () => {
  const prodBase = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    CNIC_PEPPER: 'c'.repeat(32),
    OTP_HASH_SECRET: 'd'.repeat(32),
    FIELD_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  };
  it('production refuses to start without FIELD_ENCRYPTION_KEY', () => {
    const { FIELD_ENCRYPTION_KEY, ...rest } = prodBase;
    void FIELD_ENCRYPTION_KEY;
    expect(() => parseEnv(rest)).toThrow(/FIELD_ENCRYPTION_KEY is REQUIRED/);
  });
  it('production refuses a wrong-length FIELD_ENCRYPTION_KEY', () => {
    expect(() =>
      parseEnv({ ...prodBase, FIELD_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/exactly 32 bytes/);
  });
  it('production accepts a valid 32-byte base64 FIELD_ENCRYPTION_KEY', () => {
    expect(() => parseEnv(prodBase)).not.toThrow();
  });
});
