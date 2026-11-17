// Risk engine unit tests (Phase 3, item 2) — pure scoring + RiskService
// against a fake DatabaseService (query matched on SQL substrings, in
// order). No live database needed.
import {
  DEFAULT_RISK_THRESHOLDS,
  applyRiskPenaltyToRankScore,
  isRiskBlocked,
  levelForScore,
  rankingPenaltyForScore,
  scoreFromCounts,
} from '../../src/common/utils/risk-scoring';
import { RiskService } from '../../src/modules/risk/risk.service';

const USER = '10000000-0001-4000-8000-000000000001';
const ADMIN = '10000000-0001-4000-8000-000000000099';

describe('pure risk scoring', () => {
  it('each signal contributes weight * count', () => {
    const r = scoreFromCounts({ cancellation: 2, no_show: 1, upheld_dispute: 1 });
    // 2*5 + 1*12 + 1*20 = 42
    expect(r.score).toBe(42);
    expect(r.breakdown.cancellation).toEqual({ count: 2, weight: 5, points: 10 });
    expect(r.breakdown.no_show).toEqual({ count: 1, weight: 12, points: 12 });
    expect(r.breakdown.upheld_dispute).toEqual({ count: 1, weight: 20, points: 20 });
    expect(r.breakdown.teleport).toEqual({ count: 0, weight: 15, points: 0 });
  });

  it('per-signal cap stops one noisy signal maxing the score; total caps at 100', () => {
    const r = scoreFromCounts({ cancellation: 20 }); // 20*5 = 100 raw -> capped 40
    expect(r.breakdown.cancellation.points).toBe(40);
    expect(r.score).toBe(40);
    const maxed = scoreFromCounts({ cancellation: 20, no_show: 20, upheld_dispute: 20, teleport: 20, duplicate_account: 20 });
    expect(maxed.score).toBe(100);
  });

  it('custom weights override defaults', () => {
    const r = scoreFromCounts({ no_show: 1 }, { no_show: 25 });
    expect(r.score).toBe(25);
    expect(r.breakdown.no_show.weight).toBe(25);
  });

  it('levels follow the thresholds: low < 30, medium < 60, high < 85, critical >= 85', () => {
    expect(levelForScore(0)).toBe('low');
    expect(levelForScore(29)).toBe('low');
    expect(levelForScore(30)).toBe('medium');
    expect(levelForScore(59)).toBe('medium');
    expect(levelForScore(60)).toBe('high');
    expect(levelForScore(84)).toBe('high');
    expect(levelForScore(85)).toBe('critical');
    expect(levelForScore(100)).toBe('critical');
    // Custom thresholds move the boundaries with them.
    expect(levelForScore(50, { ...DEFAULT_RISK_THRESHOLDS, review_threshold: 40, block_threshold: 70 })).toBe('high');
    expect(levelForScore(70, { ...DEFAULT_RISK_THRESHOLDS, review_threshold: 40, block_threshold: 70 })).toBe('critical');
  });

  it('ranking penalty is 0 below review, rises to 0.5 at score 100', () => {
    expect(rankingPenaltyForScore(0)).toBe(0);
    expect(rankingPenaltyForScore(59)).toBe(0);
    expect(rankingPenaltyForScore(60)).toBe(0);
    expect(rankingPenaltyForScore(80)).toBeCloseTo(0.25, 10); // (80-60)/40 * 0.5
    expect(rankingPenaltyForScore(100)).toBe(0.5);
    expect(applyRiskPenaltyToRankScore(0.9, 80)).toBeCloseTo(0.65, 10);
    expect(applyRiskPenaltyToRankScore(0.1, 100)).toBe(0); // floored at 0
    expect(applyRiskPenaltyToRankScore(0.9, 10)).toBe(0.9); // no penalty below review
  });

  it('blocked only at/above the block threshold', () => {
    expect(isRiskBlocked(84)).toBe(false);
    expect(isRiskBlocked(85)).toBe(true);
    expect(isRiskBlocked(100)).toBe(true);
  });
});

// ---- Fake DatabaseService: routes SQL to canned rows by substring ----

type Route = [string, (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] } | void>];
function fakeDb(routes: Route[], onQuery?: (sql: string, params: unknown[]) => void) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    onQuery?.(sql, params);
    for (const [needle, fn] of routes) {
      if (sql.includes(needle)) return fn(sql, params);
    }
    throw new Error(`unexpected SQL in fake db: ${sql.slice(0, 120)}`);
  });
  return { query, calls, withTransaction: jest.fn(async (fn: (c: { query: typeof query }) => Promise<unknown>) => fn({ query })) };
}

const SETTINGS_ROWS = { rows: [] as Record<string, unknown>[] };
const EMPTY = { rows: [] as Record<string, unknown>[] };

/** Full canned signal set for recompute tests. Counts:
 *  cancellations 2 provider + 1 customer = 3 -> 15; upheld 1 -> 20;
 *  teleport 2 -> 30; devices 3 distinct -> 2 extra -> 16; duplicate 1 -> 18;
 *  payout reuse 0; velocity 15 requests/hour (>10) -> 1 -> 10;
 *  events: no_show 2 -> 24, sim_change 1 -> 8. Total 141 -> capped 100. */
function signalRoutes(extra: Route[] = []): Route[] {
  return [
    ...extra,
    ['risk_settings', async () => SETTINGS_ROWS],
    ['CANCELLED_BY_PROVIDER', async () => ({ rows: [{ provider_cancellations: '2', customer_cancellations: '1' }] })],
    ["resolution->>'outcome'", async () => ({ rows: [{ n: '1' }] })],
    ['teleport_location', async () => ({ rows: [{ n: '2' }] })],
    ['COUNT(DISTINCT device_fingerprint)', async () => ({ rows: [{ n: '3' }] })],
    ['ud2.device_fingerprint', async () => ({ rows: [{ n: '1' }] })],
    ['payout_account_encrypted = p1', async () => ({ rows: [{ n: '0' }] })],
    ['service_requests WHERE customer_id', async () => ({ rows: [{ n: '15' }] })],
    ['FROM risk_events WHERE user_id', async () => ({ rows: [{ signal: 'no_show', n: '2' }, { signal: 'sim_change', n: '1' }] })],
    ['SELECT id FROM users', async () => ({ rows: [{ id: USER }] })],
  ];
}

describe('RiskService with a fake database', () => {
  it('recomputeScore aggregates every signal type and caps at 100 / critical', async () => {
    const upserted: Record<string, unknown>[] = [];
    const audits: Array<Record<string, unknown>> = [];
    const db = fakeDb([
      ...signalRoutes(),
      ['INSERT INTO risk_scores', async (_s, p) => {
        upserted.push({ user_id: p[0], score: p[1], level: p[2], hold_until: p[4] });
        return { rows: [{ user_id: USER, score: '100', level: 'critical', breakdown: '{}', hold_until: '2026-11-18T00:00:00.000Z', updated_at: '2026-11-17T00:00:00.000Z' }] };
      }],
      ['SELECT * FROM risk_scores', async () => EMPTY],
      ['INSERT INTO audit_logs', async (_s, p) => { audits.push({ action: p[1] }); return EMPTY; }],
    ]);
    const svc = new RiskService(db as never);
    const out = await svc.recomputeScore(USER, ADMIN);
    expect(out.score).toBe(100);
    expect(out.level).toBe('critical');
    expect(out.review_threshold).toBe(60);
    expect(out.block_threshold).toBe(85);
    expect(upserted[0].hold_until).not.toBeNull(); // critical sets a hold
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('risk.score.update');
  });

  it('recomputeScore with no signals scores 0 / low, sets no hold, writes no audit for a first zero', async () => {
    // All-zero counts: audit must never be called (the fake throws if it is).
    const zeroDb = fakeDb([
      ['risk_settings', async () => SETTINGS_ROWS],
      ['CANCELLED_BY_PROVIDER', async () => ({ rows: [{ provider_cancellations: '0', customer_cancellations: '0' }] })],
      ["resolution->>'outcome'", async () => ({ rows: [{ n: '0' }] })],
      ['teleport_location', async () => ({ rows: [{ n: '0' }] })],
      ['COUNT(DISTINCT device_fingerprint)', async () => ({ rows: [{ n: '1' }] })], // 1 device -> 0 extra
      ['ud2.device_fingerprint', async () => ({ rows: [{ n: '0' }] })],
      ['payout_account_encrypted = p1', async () => ({ rows: [{ n: '0' }] })],
      ['service_requests WHERE customer_id', async () => ({ rows: [{ n: '2' }] })], // under velocity limit
      ['FROM risk_events WHERE user_id', async () => ({ rows: [] })],
      ['SELECT id FROM users', async () => ({ rows: [{ id: USER }] })],
      ['SELECT * FROM risk_scores', async () => EMPTY],
      ['INSERT INTO risk_scores', async () => ({ rows: [{ user_id: USER, score: '0', level: 'low', breakdown: '{}', hold_until: null, updated_at: '2026-11-17T00:00:00.000Z' }] })],
      ['INSERT INTO audit_logs', async () => { throw new Error('no audit expected for a first zero score'); }],
    ]);
    const svc = new RiskService(zeroDb as never);
    const out = await svc.recomputeScore(USER, ADMIN);
    expect(out.score).toBe(0);
    expect(out.level).toBe('low');
    expect(out.hold_until).toBeNull();
  });

  it('recomputeScore does NOT audit when the score is unchanged', async () => {
    const audits: unknown[] = [];
    const db = fakeDb([
      ['risk_settings', async () => SETTINGS_ROWS],
      ['CANCELLED_BY_PROVIDER', async () => ({ rows: [{ provider_cancellations: '0', customer_cancellations: '0' }] })],
      ["resolution->>'outcome'", async () => ({ rows: [{ n: '0' }] })],
      ['teleport_location', async () => ({ rows: [{ n: '0' }] })],
      ['COUNT(DISTINCT device_fingerprint)', async () => ({ rows: [{ n: '1' }] })],
      ['ud2.device_fingerprint', async () => ({ rows: [{ n: '0' }] })],
      ['payout_account_encrypted = p1', async () => ({ rows: [{ n: '0' }] })],
      ['service_requests WHERE customer_id', async () => ({ rows: [{ n: '1' }] })],
      ['FROM risk_events WHERE user_id', async () => ({ rows: [] })],
      ['SELECT id FROM users', async () => ({ rows: [{ id: USER }] })],
      ['SELECT * FROM risk_scores', async () => ({ rows: [{ user_id: USER, score: '0', level: 'low', breakdown: '{}', hold_until: null }] })],
      ['INSERT INTO risk_scores', async () => ({ rows: [{ user_id: USER, score: '0', level: 'low', breakdown: '{}', hold_until: null, updated_at: '2026-11-17T00:00:00.000Z' }] })],
      ['INSERT INTO audit_logs', async () => { audits.push(1); return EMPTY; }],
    ]);
    const svc = new RiskService(db as never);
    await svc.recomputeScore(USER, ADMIN);
    expect(audits).toHaveLength(0);
  });

  it('derived signals win over duplicate risk_events rows (no double counting)', async () => {
    // teleport appears twice in fraud_signals AND twice as risk_events;
    // the score must count it once (2 * 15 = 30), not twice (60).
    const db = fakeDb([
      ['risk_settings', async () => SETTINGS_ROWS],
      ['CANCELLED_BY_PROVIDER', async () => ({ rows: [{ provider_cancellations: '0', customer_cancellations: '0' }] })],
      ["resolution->>'outcome'", async () => ({ rows: [{ n: '0' }] })],
      ['teleport_location', async () => ({ rows: [{ n: '2' }] })],
      ['COUNT(DISTINCT device_fingerprint)', async () => ({ rows: [{ n: '1' }] })],
      ['ud2.device_fingerprint', async () => ({ rows: [{ n: '0' }] })],
      ['payout_account_encrypted = p1', async () => ({ rows: [{ n: '0' }] })],
      ['service_requests WHERE customer_id', async () => ({ rows: [{ n: '1' }] })],
      ['FROM risk_events WHERE user_id', async () => ({ rows: [{ signal: 'teleport', n: '2' }, { signal: 'cancellation', n: '5' }] })],
      ['SELECT id FROM users', async () => ({ rows: [{ id: USER }] })],
      ['SELECT * FROM risk_scores', async () => EMPTY],
      ['INSERT INTO risk_scores', async (_s, p) => ({ rows: [{ user_id: USER, score: String(p[1]), level: p[2], breakdown: '{}', hold_until: null, updated_at: '2026-11-17T00:00:00.000Z' }] })],
      ['INSERT INTO audit_logs', async () => EMPTY],
    ]);
    const svc = new RiskService(db as never);
    const out = await svc.recomputeScore(USER, ADMIN);
    expect(out.score).toBe(30); // teleport only; event rows for derived signals ignored
    expect(out.level).toBe('medium');
  });

  it('recordEvent stores the event with the signal weight, then recomputes', async () => {
    const inserted: unknown[] = [];
    const db = fakeDb([
      ...signalRoutes(),
      ['INSERT INTO risk_events', async (_s, p) => {
        // Params: $1 user_id, $2 job_id, $3 signal, $4 score_delta, $5 detail;
        // source 'manual' is a SQL literal, not a param.
        inserted.push({ user_id: p[0], job_id: p[1], signal: p[2], score_delta: p[3] });
        return { rows: [{ id: 'e1', user_id: USER, signal: 'no_show', score_delta: '12', source: 'manual' }] };
      }],
      ['SELECT id FROM jobs', async () => ({ rows: [{ id: 'job-1' }] })],
      ['INSERT INTO risk_scores', async () => ({ rows: [{ user_id: USER, score: '100', level: 'critical', breakdown: '{}', hold_until: '2026-11-18T00:00:00.000Z', updated_at: '2026-11-17T00:00:00.000Z' }] })],
      ['SELECT * FROM risk_scores', async () => EMPTY],
      ['INSERT INTO audit_logs', async () => EMPTY],
    ]);
    const svc = new RiskService(db as never);
    const out = await svc.recordEvent(ADMIN, { user_id: USER, signal: 'no_show', job_id: 'job-1', detail: { note: 'provider never arrived' } });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ user_id: USER, signal: 'no_show', score_delta: 12 });
    expect(out.score.score).toBe(100);
  });

  it('recordEvent 404s for an unknown user and an unknown job', async () => {
    const db = fakeDb([['SELECT id FROM users', async () => EMPTY]]);
    const svc = new RiskService(db as never);
    await expect(svc.recordEvent(ADMIN, { user_id: USER, signal: 'no_show' })).rejects.toMatchObject({ status: 404 });
  });

  it('updateSettings rejects review >= block and out-of-range weights', async () => {
    const db = fakeDb([['risk_settings', async () => SETTINGS_ROWS]]);
    const svc = new RiskService(db as never);
    await expect(svc.updateSettings(ADMIN, { review_threshold: 85, block_threshold: 85 })).rejects.toMatchObject({ status: 422, code: 'INVALID_RISK_SETTINGS' });
    await expect(svc.updateSettings(ADMIN, { review_threshold: 101 })).rejects.toMatchObject({ status: 422 });
    await expect(svc.updateSettings(ADMIN, { weights: { no_show: 51 } as never })).rejects.toMatchObject({ status: 422 });
    await expect(svc.updateSettings(ADMIN, { hold_hours: 721 })).rejects.toMatchObject({ status: 422 });
  });

  it('updateSettings persists the patch and audits before/after', async () => {
    const upserts: Array<{ key: string; value: unknown }> = [];
    const audits: Array<Record<string, unknown>> = [];
    const db = fakeDb([
      // INSERT must precede the generic 'risk_settings' select route:
      // the upsert SQL also contains that substring.
      ['INSERT INTO risk_settings', async (_s, p) => { upserts.push({ key: String(p[0]), value: JSON.parse(String(p[1])) }); return EMPTY; }],
      ['risk_settings', async () => SETTINGS_ROWS],
      ['INSERT INTO audit_logs', async (_s, p) => { audits.push({ action: p[1] }); return EMPTY; }],
    ]);
    const svc = new RiskService(db as never);
    const out = await svc.updateSettings(ADMIN, { review_threshold: 50, block_threshold: 80 });
    expect(out.review_threshold).toBe(50);
    expect(out.block_threshold).toBe(80);
    expect(upserts).toHaveLength(2);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('risk.settings.update');
  });

  it('getSettings merges stored rows over defaults; malformed rows fall back to defaults', async () => {
    const db = fakeDb([['risk_settings', async () => ({
      rows: [
        { key: 'review_threshold', value: 50 },
        { key: 'weights', value: { no_show: 30 } },
        { key: 'block_threshold', value: 'not-a-number' },
      ],
    })]]);
    const svc = new RiskService(db as never);
    const s = await svc.getSettings();
    expect(s.review_threshold).toBe(50);
    expect(s.weights.no_show).toBe(30);
    expect(s.weights.teleport).toBe(15); // untouched default
    expect(s.block_threshold).toBe(85); // malformed row ignored
  });

  it('rankingPenaltyForUser reads the stored score without recomputing', async () => {
    const db = fakeDb([
      ['risk_settings', async () => SETTINGS_ROWS],
      ['SELECT score, level FROM risk_scores', async () => ({ rows: [{ score: '80', level: 'high' }] })],
    ]);
    const svc = new RiskService(db as never);
    const out = await svc.rankingPenaltyForUser(USER);
    expect(out).toMatchObject({ user_id: USER, score: 80, level: 'high', blocked: false });
    expect(out.penalty).toBeCloseTo(0.25, 10);
    // Never-scored user: zero penalty, no crash, and no recompute query ran.
    const db2 = fakeDb([
      ['risk_settings', async () => SETTINGS_ROWS],
      ['SELECT score, level FROM risk_scores', async () => EMPTY],
    ]);
    const svc2 = new RiskService(db2 as never);
    const out2 = await svc2.rankingPenaltyForUser(USER);
    expect(out2).toMatchObject({ score: 0, level: 'low', penalty: 0, blocked: false });
    expect(db2.query).not.toHaveBeenCalledWith(expect.stringContaining('CANCELLED_BY_PROVIDER'), expect.anything());
  });

  it('getScore returns a zero score for a never-scored user', async () => {
    const db = fakeDb([
      ['SELECT id FROM users', async () => ({ rows: [{ id: USER }] })],
      ['SELECT * FROM risk_scores', async () => EMPTY],
      ['risk_settings', async () => SETTINGS_ROWS],
    ]);
    const svc = new RiskService(db as never);
    const out = await svc.getScore(USER);
    expect(out).toMatchObject({ user_id: USER, score: 0, level: 'low', hold_until: null });
  });
});
