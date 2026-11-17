// Search load-test harness (Phase 4, item 1d).
//
// Boots ONLY the SearchModule (in-process, real Postgres + Redis) and
// fires N concurrent gateway searches, then reports measured latency
// percentiles — no invented numbers.
//
// HONESTY: this runs on ONE VM against ONE Postgres instance. There is
// no search cluster, no second machine and no 50,000-user load rig here.
// The Phase 1 target is 5,000 concurrent users and the Phase 4 target is
// 50,000; this harness runs at whatever concurrency the VM supports and
// reports exactly what it measured. 50,000 concurrent users is the
// Phase 4 load-test TARGET, documented in docs/phase4-search.md — it is
// NOT claimed as measured here.
//
// Usage (from backend/, after `npm run build`):
//   DATABASE_URL=postgresql://root@/nearservice_p4_search?host=/var/run/postgresql \
//   REDIS_URL=redis://localhost:6379 \
//   SEARCH_PROVIDER=scaled \
//   node dist/scripts/search-load-test.js [--concurrency 5000] [--warmup 50]
// DESTRUCTIVE to the target database: it drops the public schema and
// re-applies db/0001–0004 + 0016. The script REFUSES to run unless the
// database name contains 'test', 'load' or 'scratch'.
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { SearchModule } from '../modules/search/search.module';
import { SearchGatewayService } from '../modules/search/search-gateway.service';
import { SearchCacheService } from '../modules/search/search-cache.service';

const MIGRATIONS = [
  '0001_init.sql', '0002_requests_jobs.sql', '0003_money_trust.sql',
  '0004_seed.sql', '0016_search_scaleout.sql',
];

// Realistic query mix: seeded categories + Roman Urdu aliases + a typo.
const QUERIES = [
  'book binding', 'ac repair', 'electrician', 'plumber', 'mobile repair',
  'bijli wala', 'jild saazi', 'ac gas', 'electrican', 'nalka band',
  'AC theek karwana', 'kitab jild',
];
const LAT = 30.1798;
const LNG = 66.975;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number.parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main(): Promise<number> {
  const concurrency = arg('--concurrency', 5000);
  const warmup = arg('--warmup', 50);
  const dbUrl = process.env.DATABASE_URL ?? '';
  const dbName = (() => {
    // Unix-socket URLs (postgresql://root@/db?host=/var/run/postgresql)
    // have an empty host, which WHATWG URL rejects — parse by hand.
    const noQuery = dbUrl.split('?')[0];
    const m = /\/([^/]+)$/.exec(noQuery);
    return m ? m[1] : '';
  })();
  if (!dbUrl) {
    console.error('DATABASE_URL is required.');
    return 2;
  }
  if (!/test|load|scratch/i.test(dbName)) {
    console.error(
      `REFUSING to run: database '${dbName}' does not look like a scratch DB ` +
      `(name must contain 'test', 'load' or 'scratch' — this harness drops the public schema).`,
    );
    return 2;
  }
  const provider = process.env.SEARCH_PROVIDER ?? 'scaled';
  console.log(`search load test: concurrency=${concurrency} warmup=${warmup} provider=${provider} db=${dbName}`);

  const admin = new Client({ connectionString: dbUrl });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const dbDir = path.resolve(__dirname, '../../../db');
  for (const file of MIGRATIONS) {
    await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
  }

  const mod = await Test.createTestingModule({ imports: [SearchModule] }).compile();
  const gateway = mod.get(SearchGatewayService);
  const cache = mod.get(SearchCacheService);
  console.log(`active provider: ${gateway.activeProviderName()}`);
  await cache.invalidateAll('load-test-setup');

  const runOne = async (i: number): Promise<number> => {
    const q = QUERIES[i % QUERIES.length];
    const t0 = Date.now();
    await gateway.search({ q, lat: LAT, lng: LNG });
    return Date.now() - t0;
  };

  for (let i = 0; i < warmup; i++) await runOne(i);
  console.log(`warmup done (${warmup} searches)`);

  const latencies: number[] = [];
  let errors = 0;
  const wallStart = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      runOne(i).then((ms) => { latencies.push(ms); }).catch((e) => {
        errors += 1;
        if (errors <= 5) console.error(`search ${i} failed: ${(e as Error).message}`);
      }),
    ),
  );
  const wallMs = Date.now() - wallStart;
  latencies.sort((a, b) => a - b);
  const ok = latencies.length;
  const mean = ok ? latencies.reduce((a, b) => a + b, 0) / ok : 0;
  const cacheHits = Number(
    (await admin.query(`SELECT COUNT(*)::int AS n FROM search_query_events WHERE cache_hit`)).rows[0].n,
  );
  const totalEvents = Number(
    (await admin.query(`SELECT COUNT(*)::int AS n FROM search_query_events`)).rows[0].n,
  );

  const report = {
    target: 'Phase 1: 5000 concurrent users (Phase 4 target 50000 — NOT measured here)',
    provider: gateway.activeProviderName(),
    concurrency,
    completed: ok,
    errors,
    error_rate: ok + errors ? errors / (ok + errors) : 0,
    wall_ms: wallMs,
    throughput_req_per_s: ok ? +(ok / (wallMs / 1000)).toFixed(1) : 0,
    latency_ms: {
      mean: +mean.toFixed(1),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] ?? 0,
    },
    cache_hit_rate_events: totalEvents ? +(cacheHits / totalEvents).toFixed(3) : 0,
    note: 'Single VM, single Postgres instance, in-process gateway. No cluster, no second machine.',
  };
  console.log(JSON.stringify(report, null, 2));
  await mod.close();
  await admin.end();
  return errors / Math.max(1, ok + errors) > 0.01 ? 1 : 0;
}

main()
  .then((code) => { process.exit(code); })
  .catch((e) => { console.error(e); process.exit(2); });
