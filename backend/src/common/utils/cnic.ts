import * as crypto from 'crypto';
import { env } from '../../config/env';
// v1.1: CNIC duplicate detection uses HMAC-SHA256 keyed with CNIC_PEPPER.
// CNIC_PEPPER comes from the secrets manager in production — never
// hardcoded, never logged, never stored in the DB. A plain hash of a
// 13-digit CNIC is trivially reversible by brute force, so plain hashes
// are never used. The plaintext CNIC itself is stored only field-level
// encrypted (cnic_encrypted); the HMAC is for duplicate detection.
// The pepper comes from the single env module (FIX 5): required in
// production, dev-only default otherwise. An explicit pepper argument
// still wins (unit tests), but it must never be a production pepper.
export function cnicHmac(cnicDigits: string, pepper?: string): string {
  const p = pepper ?? env.cnicPepper;
  return crypto.createHmac('sha256', p).update(cnicDigits.replace(/\D/g, '')).digest('hex');
}
export function isValidCnic(cnic: string): boolean {
  return /^\d{5}-\d{7}-\d$/.test(cnic) || /^\d{13}$/.test(cnic);
}
