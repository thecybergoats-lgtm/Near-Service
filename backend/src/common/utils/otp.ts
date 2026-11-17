// OTP helpers (Stage 1, FIX 3).
// - Codes use crypto.randomInt (CSPRNG). Math.random is NEVER used here
//   (enforced by a CI grep step).
// - Stored OTPs are HMAC-SHA256(code, OTP_HASH_SECRET) hex — a keyed hash,
//   not bcrypt (bcrypt truncates at 72 bytes and is slow for this use).
//   The secret comes from the single env module; without it the app refuses
//   to start in production.
// - Dev mode ONLY: codes are logged to the console (labelled) and never sent
//   by SMS. Production must use Firebase phone auth / SMS gateway.
import * as crypto from 'crypto';
import { env } from '../../config/env';

export function generateOtpCode(): string {
  // crypto.randomInt is cryptographically secure; 100000..999999 inclusive.
  return String(crypto.randomInt(100000, 1000000));
}

export function normalizePhone(raw: string): string {
  let p = raw.replace(/[\s-]/g, '');
  if (p.startsWith('03')) p = '+92' + p.slice(1);
  if (p.startsWith('92') && !p.startsWith('+')) p = '+' + p;
  return p;
}

export function isValidPkPhone(phone: string): boolean {
  return /^\+92 3\d{2} \d{7}$/.test(phone.replace(/(\+923\d{2})(\d{7})/, '$1 $2')) || /^\+923\d{9}$/.test(phone);
}

/** Keyed hash of an OTP code for Redis storage. Returns 64 lowercase hex
 *  chars. The secret defaults to env.otpHashSecret; an explicit secret wins
 *  (unit tests). */
export function hashOtp(code: string, secret?: string): string {
  const s = secret ?? env.otpHashSecret;
  return crypto.createHmac('sha256', s).update(code).digest('hex');
}

/** Constant-time comparison of two hex hashes. Returns false (never throws)
 *  when lengths differ — e.g. a legacy bcrypt hash in Redis. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
