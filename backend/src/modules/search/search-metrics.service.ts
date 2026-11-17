// Search metrics + the dedicated-tier gate (Phase 4, item 1b).
//
// What is measured (tables from db/0016_search_scaleout.sql):
//   * every served search -> one row in search_query_events
//     (query, provider, cache_hit, latency_ms, result_count)
//   * every result click -> one row in search_click_events
//     (target_type 'category' | 'provider', target_id)
// From those two tables the service derives, over a window:
//   p50 / p95 latency, zero-result rate, cache-hit rate,
//   click-through rate (clicks / queries in the window).
//
// THE GATE — the decision the PRD defers to Phase 4 ("a dedicated search
// tier only if measured latency or relevance demands it"): evaluateGate()
// compares the live window against admin-configurable thresholds
// (search_gate_config, seeded in 0016) and returns either
// 'stay_in_process' or 'switch_on_dedicated_tier', with a reason per
// breached condition. The gate NEVER switches anything by itself — it is
// a recommendation an admin acts on (by setting SEARCH_SERVICE_URL /
// SEARCH_PROVIDER). A switch with no data behind it would be a guess;
// the gate says so explicitly when the sample is below min_queries.
//
// CTR honesty: until a click-reporting call exists (POST /search/click
// is NOT part of this item — see docs/phase4-search.md), clicks stay 0
// and the gate treats CTR as "no data" rather than 0%, so an unmeasured
// CTR can never trigger the tier.
//
// Recording never breaks search: recordQuery/recordClick swallow their
// own errors (logged) and return null on failure.
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { SearchProviderName } from './search.types';

export interface SearchWindowStats {
  window_hours: number;
  queries: number;
  zero_result_queries: number;
  zero_result_rate: number;
  cache_hits: number;
  cache_hit_rate: number;
  clicks: number;
  /** clicks / queries in the window. Null when no clicks have ever been
   *  recorded — "no data", not 0%. */
  click_through_rate: number | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  /** Queries in the window, scaled to a full day, for the volume rule. */
  queries_per_day: number;
}

export interface GateThresholds {
  /** Switch on when p95 latency exceeds this (ms). */
  p95_latency_ms: number;
  /** Switch on when the zero-result rate exceeds this (0–1). */
  zero_result_rate: number;
  /** Switch on when CTR falls below this (0–1) — only when clicks exist. */
  ctr_floor: number;
  /** Switch on when volume exceeds this many queries/day. */
  queries_per_day: number;
  /** Below this many queries in the window the gate abstains. */
  min_queries_for_gate: number;
  /** Window (hours) the gate evaluates over. */
  window_hours: number;
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  p95_latency_ms: 500,
  zero_result_rate: 0.25,
  ctr_floor: 0.05,
  queries_per_day: 10000,
  min_queries_for_gate: 100,
  window_hours: 24,
};

export type GateDecision = 'stay_in_process' | 'switch_on_dedicated_tier';

export interface GateEvaluation {
  decision: GateDecision;
  reasons: string[];
  breached: string[];
  stats: SearchWindowStats;
  thresholds: GateThresholds;
  evaluated_at: string;
}

/** Pure gate rule — unit-tested without a database. */
export function evaluateGateDecision(stats: SearchWindowStats, t: GateThresholds): { decision: GateDecision; reasons: string[]; breached: string[] } {
  const reasons: string[] = [];
  const breached: string[] = [];
  if (stats.queries < t.min_queries_for_gate) {
    return {
      decision: 'stay_in_process',
      reasons: [`insufficient data: ${stats.queries} queries in the last ${stats.window_hours}h (need ${t.min_queries_for_gate} before the gate can judge)`],
      breached,
    };
  }
  if (stats.latency_p95_ms != null && stats.latency_p95_ms > t.p95_latency_ms) {
    breached.push('p95_latency');
    reasons.push(`p95 latency ${stats.latency_p95_ms}ms exceeds ${t.p95_latency_ms}ms`);
  }
  if (stats.zero_result_rate > t.zero_result_rate) {
    breached.push('zero_result_rate');
    reasons.push(`zero-result rate ${(stats.zero_result_rate * 100).toFixed(1)}% exceeds ${(t.zero_result_rate * 100).toFixed(1)}%`);
  }
  if (stats.click_through_rate != null && stats.click_through_rate < t.ctr_floor) {
    breached.push('click_through_rate');
    reasons.push(`click-through rate ${(stats.click_through_rate * 100).toFixed(1)}% is below ${(t.ctr_floor * 100).toFixed(1)}%`);
  }
  if (stats.queries_per_day > t.queries_per_day) {
    breached.push('query_volume');
    reasons.push(`volume ${Math.round(stats.queries_per_day)} queries/day exceeds ${t.queries_per_day}/day`);
  }
  if (breached.length === 0) {
    reasons.push('all metrics within thresholds — the in-process tier is sufficient');
  }
  return { decision: breached.length ? 'switch_on_dedicated_tier' : 'stay_in_process', reasons, breached };
}

const THRESHOLD_KEYS: Record<keyof GateThresholds, string> = {
  p95_latency_ms: 'p95_latency_ms_threshold',
  zero_result_rate: 'zero_result_rate_threshold',
  ctr_floor: 'ctr_floor',
  queries_per_day: 'queries_per_day_threshold',
  min_queries_for_gate: 'min_queries_for_gate',
  window_hours: 'window_hours',
};

@Injectable()
export class SearchMetricsService {
  private readonly logger = new Logger(SearchMetricsService.name);
  constructor(private db: DatabaseService) {}

  /** Record one served search. Returns the event id (for click
   *  correlation) or null when recording failed. Never throws. */
  async recordQuery(input: {
    query: string;
    provider: SearchProviderName;
    cacheHit: boolean;
    latencyMs: number;
    resultCount: number;
  }): Promise<string | null> {
    try {
      const row = (await this.db.query<{ id: string }>(
        `INSERT INTO search_query_events (query, provider, cache_hit, latency_ms, result_count)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.query.slice(0, 100), input.provider, input.cacheHit, Math.max(0, Math.round(input.latencyMs)), Math.max(0, input.resultCount)],
      )).rows[0];
      return row?.id ?? null;
    } catch (e) {
      this.logger.warn(`search metrics record failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Record a click on a search result. Never throws. */
  async recordClick(input: { queryEventId?: string | null; targetType: 'category' | 'provider'; targetId?: string }): Promise<boolean> {
    try {
      await this.db.query(
        `INSERT INTO search_click_events (query_event_id, target_type, target_id) VALUES ($1, $2, $3)`,
        [input.queryEventId ?? null, input.targetType, input.targetId ?? null],
      );
      return true;
    } catch (e) {
      this.logger.warn(`search click record failed: ${(e as Error).message}`);
      return false;
    }
  }

  async windowStats(windowHours: number): Promise<SearchWindowStats> {
    const hours = Math.min(Math.max(Math.round(windowHours) || 24, 1), 24 * 30);
    const row = (await this.db.query(
      `SELECT COUNT(*)::int AS queries,
              COUNT(*) FILTER (WHERE result_count = 0)::int AS zero_result_queries,
              COUNT(*) FILTER (WHERE cache_hit)::int AS cache_hits,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::int AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95
       FROM search_query_events
       WHERE created_at >= now() - ($1 || ' hours')::interval`,
      [hours],
    )).rows[0];
    const clicks = (await this.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM search_click_events WHERE created_at >= now() - ($1 || ' hours')::interval`,
      [hours],
    )).rows[0]?.n ?? 0;
    const queries = row?.queries ?? 0;
    return {
      window_hours: hours,
      queries,
      zero_result_queries: row?.zero_result_queries ?? 0,
      zero_result_rate: queries ? (row?.zero_result_queries ?? 0) / queries : 0,
      cache_hits: row?.cache_hits ?? 0,
      cache_hit_rate: queries ? (row?.cache_hits ?? 0) / queries : 0,
      clicks,
      // No clicks recorded at all in the window = no CTR data, not 0%.
      click_through_rate: clicks > 0 && queries > 0 ? clicks / queries : null,
      latency_p50_ms: row?.p50 ?? null,
      latency_p95_ms: row?.p95 ?? null,
      queries_per_day: queries * (24 / hours),
    };
  }

  async thresholds(): Promise<GateThresholds> {
    const out: GateThresholds = { ...DEFAULT_GATE_THRESHOLDS };
    try {
      const rows = (await this.db.query<{ key: string; value: { value: number } }>(
        `SELECT key, value FROM search_gate_config`,
      )).rows;
      for (const r of rows) {
        const entry = Object.entries(THRESHOLD_KEYS).find(([, k]) => k === r.key);
        if (entry && typeof r.value?.value === 'number') {
          (out as unknown as Record<string, number>)[entry[0]] = r.value.value;
        }
      }
    } catch (e) {
      this.logger.warn(`search gate thresholds read failed, using defaults: ${(e as Error).message}`);
    }
    return out;
  }

  /** Validate + persist threshold changes. Throws on invalid values. */
  async updateThresholds(patch: Partial<GateThresholds>): Promise<GateThresholds> {
    const merged = { ...(await this.thresholds()), ...patch };
    if (!(merged.p95_latency_ms > 0)) throw new Error('p95_latency_ms must be > 0');
    if (!(merged.zero_result_rate >= 0 && merged.zero_result_rate <= 1)) throw new Error('zero_result_rate must be between 0 and 1');
    if (!(merged.ctr_floor >= 0 && merged.ctr_floor <= 1)) throw new Error('ctr_floor must be between 0 and 1');
    if (!(merged.queries_per_day > 0)) throw new Error('queries_per_day must be > 0');
    if (!(merged.min_queries_for_gate >= 0)) throw new Error('min_queries_for_gate must be >= 0');
    if (!(merged.window_hours >= 1 && merged.window_hours <= 24 * 30)) throw new Error('window_hours must be between 1 and 720');
    for (const [field, key] of Object.entries(THRESHOLD_KEYS) as [keyof GateThresholds, string][]) {
      if (patch[field] !== undefined) {
        await this.db.query(
          `INSERT INTO search_gate_config (key, value, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [key, JSON.stringify({ value: patch[field] })],
        );
      }
    }
    return this.thresholds();
  }

  async evaluateGate(): Promise<GateEvaluation> {
    const t = await this.thresholds();
    const stats = await this.windowStats(t.window_hours);
    const { decision, reasons, breached } = evaluateGateDecision(stats, t);
    return { decision, reasons, breached, stats, thresholds: t, evaluated_at: new Date().toISOString() };
  }

  /** Admin view data: live window + gate + daily rollup rows. */
  async metricsView(windowHours = 24, days = 14): Promise<{ window: SearchWindowStats; gate: GateEvaluation; daily: Record<string, unknown>[] }> {
    const gate = await this.evaluateGate();
    const window = gate.stats;
    void windowHours;
    const daily = (await this.db.query(
      `SELECT day, provider, queries, zero_result_queries, cache_hits, clicks, latency_p50_ms, latency_p95_ms
       FROM search_metrics_daily WHERE day >= CURRENT_DATE - ($1::int - 1) ORDER BY day DESC, provider`,
      [Math.min(Math.max(days, 1), 90)],
    )).rows;
    return { window, gate, daily };
  }

  /** Roll one day's raw events into search_metrics_daily (idempotent).
   *  Run by an admin / ops job, not on the search path. */
  async rollupDaily(day: string): Promise<void> {
    await this.db.query(
      `INSERT INTO search_metrics_daily
         (day, provider, queries, zero_result_queries, cache_hits, clicks, latency_p50_ms, latency_p95_ms)
       SELECT $1::date, provider, COUNT(*)::int,
              COUNT(*) FILTER (WHERE result_count = 0)::int,
              COUNT(*) FILTER (WHERE cache_hit)::int,
              0,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::int,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int
       FROM search_query_events
       WHERE created_at >= $1::date AND created_at < $1::date + INTERVAL '1 day'
       GROUP BY provider
       ON CONFLICT (day, provider) DO UPDATE SET
         queries = EXCLUDED.queries, zero_result_queries = EXCLUDED.zero_result_queries,
         cache_hits = EXCLUDED.cache_hits,
         latency_p50_ms = EXCLUDED.latency_p50_ms, latency_p95_ms = EXCLUDED.latency_p95_ms`,
      [day],
    );
    // 'all' row: totals across providers + the day's clicks.
    await this.db.query(
      `INSERT INTO search_metrics_daily
         (day, provider, queries, zero_result_queries, cache_hits, clicks, latency_p50_ms, latency_p95_ms)
       SELECT $1::date, 'all', COUNT(*)::int,
              COUNT(*) FILTER (WHERE result_count = 0)::int,
              COUNT(*) FILTER (WHERE cache_hit)::int,
              (SELECT COUNT(*)::int FROM search_click_events
                WHERE created_at >= $1::date AND created_at < $1::date + INTERVAL '1 day'),
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::int,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int
       FROM search_query_events
       WHERE created_at >= $1::date AND created_at < $1::date + INTERVAL '1 day'
       ON CONFLICT (day, provider) DO UPDATE SET
         queries = EXCLUDED.queries, zero_result_queries = EXCLUDED.zero_result_queries,
         cache_hits = EXCLUDED.cache_hits, clicks = EXCLUDED.clicks,
         latency_p50_ms = EXCLUDED.latency_p50_ms, latency_p95_ms = EXCLUDED.latency_p95_ms`,
      [day],
    );
  }
}
