// Seed runner: applies db/0004_seed.sql (idempotent — uses ON CONFLICT).
// Usage: DATABASE_URL=... npm run seed   (run after `npm run migrate`).
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = fs.readFileSync(path.resolve(__dirname, '../../../db/0004_seed.sql'), 'utf8');
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(sql);
  await client.end();
  console.log('seed applied (db/0004_seed.sql)');
}
main().catch((e) => { console.error(e); process.exit(1); });
