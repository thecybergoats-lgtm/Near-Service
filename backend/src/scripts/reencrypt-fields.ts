// One-off migration for FIX 4: re-encrypts legacy base64 "encrypted" values
// (cnic_encrypted, payout_account_encrypted) into real AES-256-GCM values
// ("v1:" + base64(iv|tag|ciphertext)).
// SAFE TO RUN TWICE: rows already in the v1:/v2: format are skipped, and
// values in an unknown format are logged and left untouched (never corrupted).
// Usage: DATABASE_URL=... npm run reencrypt:fields
// (FIELD_ENCRYPTION_KEY must be set — in production the app refuses to start
// without it; in dev the dev default from src/config/env.ts applies.)
import { Client } from 'pg';
import { encryptField, isFieldEncrypted, isLegacyBase64 } from '../common/crypto/field-encryption';

export interface ReencryptResult { upgraded: number; alreadyEncrypted: number; unknownSkipped: number }

/** Re-encrypts legacy rows on an already-connected client. Exported for
 *  tests; the CLI entry point below is the only production use. */
export async function reencryptFields(client: Client): Promise<ReencryptResult> {
  const { rows } = await client.query<{ id: string; cnic_encrypted: string | null; payout_account_encrypted: string | null }>(
    `SELECT id, cnic_encrypted, payout_account_encrypted FROM provider_profiles`,
  );
  let upgraded = 0;
  let alreadyEncrypted = 0;
  let unknownSkipped = 0;
  for (const row of rows) {
    for (const col of ['cnic_encrypted', 'payout_account_encrypted'] as const) {
      const value = row[col];
      if (!value) continue;
      if (isFieldEncrypted(value)) { alreadyEncrypted += 1; continue; }
      if (!isLegacyBase64(value)) {
        // eslint-disable-next-line no-console
        console.warn(`reencrypt: provider ${row.id} ${col} has an unknown format — left untouched`);
        unknownSkipped += 1;
        continue;
      }
      const plaintext = Buffer.from(value, 'base64').toString('utf8');
      await client.query(`UPDATE provider_profiles SET ${col}=$2 WHERE id=$1`, [row.id, encryptField(plaintext)]);
      upgraded += 1;
    }
  }
  return { upgraded, alreadyEncrypted, unknownSkipped };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = new Client({ connectionString: url });
  await client.connect();
  const r = await reencryptFields(client);
  await client.end();
  // eslint-disable-next-line no-console
  console.log(`reencrypt-fields: upgraded=${r.upgraded} already-encrypted=${r.alreadyEncrypted} unknown-format-skipped=${r.unknownSkipped} (safe to re-run)`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
