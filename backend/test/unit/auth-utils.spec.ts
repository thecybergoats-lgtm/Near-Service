import { generateOtpCode, normalizePhone, isValidPkPhone } from '../../src/common/utils/otp';
import { isContactSharing } from '../../src/common/utils/contact-sharing';
import { cnicHmac, isValidCnic } from '../../src/common/utils/cnic';
describe('OTP helpers', () => {
  it('generates a 6-digit code', () => { expect(generateOtpCode()).toMatch(/^\d{6}$/); });
  it('normalises 03xx numbers to +92', () => {
    expect(normalizePhone('03001234567')).toBe('+923001234567');
    expect(normalizePhone('+923001234567')).toBe('+923001234567');
    expect(normalizePhone('923001234567')).toBe('+923001234567');
  });
  it('validates PK phone format', () => { expect(isValidPkPhone('+923001234567')).toBe(true); expect(isValidPkPhone('03001234567')).toBe(false); });
});
describe('contact-sharing flag', () => {
  it('flags phone numbers, whatsapp mentions and emails', () => {
    expect(isContactSharing('call me 03001234567')).toBe(true);
    expect(isContactSharing('mera whatsapp 03211234567')).toBe(true);
    expect(isContactSharing('email me at a@b.com')).toBe(true);
    expect(isContactSharing('kitab kab milegi?')).toBe(false);
    expect(isContactSharing(null)).toBe(false);
  });
});
describe('CNIC HMAC (v1.1: cnic_hmac, never a plain hash)', () => {
  it('is a 64-hex HMAC, pepper-dependent, and validates format', () => {
    const h1 = cnicHmac('61101-1234567-1', 'pepper-a');
    const h2 = cnicHmac('6110112345671', 'pepper-a');
    expect(h1).toBe(h2); // formatting-insensitive
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(cnicHmac('61101-1234567-1', 'pepper-b')).not.toBe(h1);
    expect(isValidCnic('61101-1234567-1')).toBe(true);
    expect(isValidCnic('123')).toBe(false);
  });
});
