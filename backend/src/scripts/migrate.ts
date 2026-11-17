// Migration runner: applies db/*.sql in numeric order, tracking applied
// files in schema_migrations. Usage: DATABASE_URL=... npm run migrate
// (or: psql "$DATABASE_URL" -f db/0001_init.sql ... — see db/README.md).
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const dbDir = path.resolve(__dirname, '../../../db');
  const files = fs.readdirSync(dbDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const file of files) {
    const done = await client.query(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [file]);
    if (done.rowCount) { console.log(`skip ${file}`); continue; }
    const sql = fs.readFileSync(path.join(dbDir, file), 'utf8');
    console.log(`applying ${file} ...`);
    await client.query(sql);
    await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
    console.log(`applied ${file}`);
  }
  await client.end();
  console.log('migrations complete');
}
main().catch((e) => { console.error(e); process.exit(1); });
