// FIX 15(b) (Stage 3) — log redaction: JWTs, OTP codes, secret-bearing
// key=value pairs and CNIC numbers must never survive into a log line.
// Phone numbers, user ids and request ids are NOT secrets and are kept.
import { redactSecrets } from '../../src/common/utils/log-redaction';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('redactSecrets', () => {
  it('removes a JWT and an OTP code from a sample log line', () => {
    // NOTE: the phone +923001234567 itself ends in 123456, so the OTP
    // code in this line is 654321 to keep the assertions meaningful.
    const line = `[DEV OTP] phone=+923001234567 code=654321 jwt=${JWT} — DEV MODE ONLY`;
    const out = redactSecrets(line);
    expect(out).not.toContain('654321');
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).toContain('[REDACTED_JWT]');
    expect(out).toContain('[REDACTED_OTP]');
    expect(out).toContain('+923001234567'); // phone is kept
  });
  it('redacts secret key=value pairs and CNIC numbers', () => {
    const line = `login failed password=hunter2 cnic=35202-1234567-1 payout_account=PK36ABPA0000001234567890 otp=987654`;
    const out = redactSecrets(line);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('35202-1234567-1');
    expect(out).not.toContain('PK36ABPA0000001234567890');
    expect(out).not.toContain('987654');
    expect(out).toContain('password=[REDACTED]');
    expect(out).toContain('cnic=[REDACTED]');
  });
  it('redacts a bare CNIC number with no key', () => {
    expect(redactSecrets('user CNIC 3520212345671 on file')).toBe('user CNIC [REDACTED_CNIC] on file');
    expect(redactSecrets('user CNIC 35202-1234567-1 on file')).toBe('user CNIC [REDACTED_CNIC] on file');
  });
  it('leaves ordinary log lines untouched', () => {
    const line = 'Near Service API listening on :3000 (base /api/v1).';
    expect(redactSecrets(line)).toBe(line);
  });
  it('is idempotent', () => {
    const line = `code=123456 token=${JWT}`;
    expect(redactSecrets(redactSecrets(line))).toBe(redactSecrets(line));
  });
});
