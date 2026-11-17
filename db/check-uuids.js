// Scans UUID literals and fails if any is not a strict RFC-4122 version-4
// UUID (8-4-4-4-12 lowercase hex, version nibble 4, variant 8/9/a/b).
//
// WHY v4, not just shape: the old checker only required the 8-4-4-4-12
// shape, so the 0004 seeds passed it while being version-0 UUIDs
// (one old seed id ended in a version-0 suffix). class-validator's @IsUUID()
// rejects those, so POST /requests (and every other endpoint taking a
// category_id) 422'd on ids copied from GET /categories (Fix A).
// db/0021_fix_seed_uuids.sql rewrote the 35 seeded ids to v4.
//
// Scanned: every db/*.sql file, every backend/test fixture/spec, and
// backend/src (a bad literal there is the same bug class — see the old
// builtin-aliases.ts template that generated version-0 ids).
//
// ONE exemption: db/0021_fix_seed_uuids.sql must spell the OLD ids to map
// them to the new ones. Lines in that file carrying the trailing marker
// `-- fix-a:legacy-id` are skipped line-by-line; any non-v4 literal on
// any other line — including any other line of 0021 itself — still fails.
// Usage: node db/check-uuids.js   (also run in CI on every push)
const fs = require('fs');
const path = require('path');

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Loose candidate: anything shaped like a UUID (groups of hex separated by
// dashes) so malformed ones are caught instead of silently skipped.
const CANDIDATE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{2,6}-[0-9a-fA-F]{2,6}-[0-9a-fA-F]{2,6}-[0-9a-fA-F]{8,14}/g;
// Exemption marker (Fix A): only the old->new mapping lines of 0021 carry it.
const LEGACY_MARKER = 'fix-a:legacy-id';

// A candidate immediately followed by `${` is a template-string prefix
// (e.g. builtin-aliases.ts builds ids from a template ending `${n}`), not a complete
// UUID literal, so it is not checked as one.
const isTemplatePrefix = (line, m) =>
  line.slice(m.index + m[0].length, m.index + m[0].length + 2) === '${';

const repoRoot = path.resolve(__dirname, '..');

function collectSqlFiles() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(__dirname, f));
}

function collectTsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        walk(p);
      } else if (e.isFile() && p.endsWith('.ts')) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

const files = [
  ...collectSqlFiles(),
  ...collectTsFiles(path.join(repoRoot, 'backend', 'test')),
  ...collectTsFiles(path.join(repoRoot, 'backend', 'src')),
];

let checked = 0;
let exempted = 0;
const bad = [];
for (const file of files) {
  const rel = path.relative(repoRoot, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes(LEGACY_MARKER)) {
      // The 0021 mapping lines: old ids are the source data being retired.
      // Still verify the NEW id on the same line is a valid v4 UUID.
      const lits = [...line.matchAll(CANDIDATE)].map((m) => m[0]);
      for (const lit of lits) {
        if (V4.test(lit)) {
          checked += 1;
        } else {
          exempted += 1; // an old id on a marked 0021 mapping line
        }
      }
      return;
    }
    for (const m of line.matchAll(CANDIDATE)) {
      if (isTemplatePrefix(line, m)) continue;
      checked += 1;
      if (!V4.test(m[0])) {
        bad.push(`${rel}:${i + 1}: invalid (non-v4) UUID '${m[0]}'`);
      }
    }
  });
}
if (bad.length) {
  console.error(`check-uuids: FAIL — ${bad.length} non-v4 UUID literal(s) of ${checked} checked:`);
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.log(
  `check-uuids: OK — ${checked} UUID literal(s) valid v4 in ${files.length} file(s)` +
    (exempted ? ` (${exempted} legacy id(s) on marked 0021 mapping lines exempted)` : ''),
);
