// Field-level encryption for sensitive columns (Stage 1, FIX 4).
// Replaces the old `Buffer.from(x).toString('base64')` "placeholder" — base64
// is encoding, NOT encryption, and must never be used for CNIC / payout data.
//
// Format: "v1:" + base64(iv | authTag | ciphertext), AES-256-GCM with a fresh
// random 12-byte IV per value, so two encryptions of the same plaintext
// always differ and any tampering fails authentication.
// Key rotation: the version prefix selects the key — 'v1' =
// FIELD_ENCRYPTION_KEY, 'v2' = FIELD_ENCRYPTION_KEY_V2. Encrypt always uses
// the CURRENT_VERSION; decrypt uses the version in the prefix, so old rows
// stay readable after a rotation. The key itself comes from the single env
// module (src/config/env.ts): in production the app refuses to start if the
// key is missing or is not base64 of exactly 32 bytes.
import * as crypto from 'crypto';
import { fieldEncryptionKey } from '../../config/env';

export type FieldKeyVersion = 'v1' | 'v2';
export const CURRENT_FIELD_KEY_VERSION: FieldKeyVersion = 'v1';
const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptField(plaintext: string, version: FieldKeyVersion = CURRENT_FIELD_KEY_VERSION): string {
  const key = fieldEncryptionKey(version);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version}:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

export function decryptField(value: string): string {
  const m = /^(v\d+):(.+)$/.exec(value);
  if (!m) throw new Error('Not a field-encrypted value (missing version prefix)');
  const version = m[1];
  if (version !== 'v1' && version !== 'v2') throw new Error(`Unknown field-encryption key version: ${version}`);
  const key = fieldEncryptionKey(version as FieldKeyVersion);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length <= IV_LEN + TAG_LEN) throw new Error('Field-encrypted value is too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // Throws on any tampering (bad tag) or wrong key — never returns garbage.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** True when the value is already in the versioned encrypted format. */
export function isFieldEncrypted(value: string | null | undefined): boolean {
  return !!value && /^(v1|v2):/.test(value);
}

/** True when the value looks like the OLD legacy format: plain base64 of the
 *  raw plaintext (the pre-FIX-4 "encryption"). Used by the re-encryption
 *  script to find rows that still need upgrading. */
export function isLegacyBase64(value: string | null | undefined): boolean {
  if (!value || isFieldEncrypted(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length > 0 && decoded.toString('base64') === value.replace(/\s/g, '');
  } catch {
    return false;
  }
}

/** Dev-only helpers for tests: encrypt/decrypt with an explicit key instead
 *  of env (same AES-256-GCM format as encryptField/decryptField). */
export function encryptFieldWithKey(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('Field-encryption key must be 32 bytes');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
}

export function decryptFieldWithKey(value: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('Field-encryption key must be 32 bytes');
  const m = /^(v\d+):(.+)$/.exec(value);
  if (!m) throw new Error('Not a field-encrypted value (missing version prefix)');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length <= IV_LEN + TAG_LEN) throw new Error('Field-encrypted value is too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_LEN));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
}

export function currentFieldKeyVersion(): FieldKeyVersion {
  return CURRENT_FIELD_KEY_VERSION;
}
