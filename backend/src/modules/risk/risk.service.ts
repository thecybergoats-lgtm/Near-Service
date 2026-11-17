import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import { pageFromRows, offsetPage } from '../../common/utils/pagination';
import {
  DEFAULT_RISK_THRESHOLDS,
  DEFAULT_RISK_WEIGHTS,
  RISK_SIGNALS,
  RiskSignal,
  RiskThresholds,
  isRiskBlocked,
  isRiskSignal,
  levelForScore,
  rankingPenaltyForScore,
  scoreFromCounts,
} from '../../common/utils/risk-scoring';

export interface RiskSettings extends RiskThresholds {
  weights: Record<RiskSignal, number>;
}
/** Signals whose counts come from risk_events only. Every other signal has
 *  a derived source in existing tables (see loadCounts); event rows for a
 *  derived signal are IGNORED at recompute time so one occurrence is never
 *  counted twice (e.g. a teleport already in fraud_signals). */
const EVENT_ONLY_SIGNALS: RiskSignal[] = ['no_show', 'sim_change', 'mock_location', 'report', 'ledger_anomaly'];

const DEFAULT_SETTINGS: RiskSettings = {
  weights: { ...DEFAULT_RISK_WEIGHTS },
  ...DEFAULT_RISK_THRESHOLDS,
};

function toScoreRow(row: Record<string, unknown>) {
  return {
    user_id: String(row.user_id),
    score: Number(row.score),
    level: String(row.level ?? 'low'),
    breakdown: (row.breakdown ?? {}) as Record<string, unknown>,
    hold_until: row.hold_until ? String(row.hold_until) : null,
    updated_at: row.updated_at ? String(row.updated_at) : null,
  };
}

@Injectable()
export class RiskService {
  constructor(private db: DatabaseService) {}

  private async audit(actorId: string | null, action: string, entity: string, entityId: string | null, before: unknown, after: unknown) {
    await this.db.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
      [actorId, action, entity, entityId, JSON.stringify(before ?? null), JSON.stringify(after ?? null)],
    );
  }

  private async requireUser(userId: string) {
    const row = (await this.db.query(`SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
    if (!row) throw Errors.notFound('User');
    return row;
  }

  // ---- Settings (risk_settings table, migration 0011) ----

  async getSettings(): Promise<RiskSettings> {
    const rows = (await this.db.query<{ key: string; value: unknown }>(`SELECT key, value FROM risk_settings`)).rows;
    const out: RiskSettings = {
      weights: { ...DEFAULT_RISK_WEIGHTS },
      review_threshold: DEFAULT_RISK_THRESHOLDS.review_threshold,
      block_threshold: DEFAULT_RISK_THRESHOLDS.block_threshold,
      hold_hours: DEFAULT_RISK_THRESHOLDS.hold_hours,
      window_days: DEFAULT_RISK_THRESHOLDS.window_days,
      velocity_max_requests_per_hour: DEFAULT_RISK_THRESHOLDS.velocity_max_requests_per_hour,
    };
    for (const r of rows) {
      if (r.key === 'weights' && r.value && typeof r.value === 'object') {
        for (const [k, v] of Object.entries(r.value as Record<string, unknown>)) {
          if (isRiskSignal(k) && typeof v === 'number' && Number.isFinite(v)) out.weights[k] = v;
        }
      } else if (r.key in out && typeof r.value === 'number' && Number.isFinite(r.value)) {
        (out as unknown as Record<string, number>)[r.key] = r.value;
      }
    }
    return out;
  }

  /** Validate + persist a partial settings patch. Thresholds must satisfy
   *  0 <= review < block <= 100; weights are per-signal 0..50. Every change
   *  is audited (action risk.settings.update, before/after = full settings).
   *  Changes apply to the NEXT recompute, never retroactively. */
  async updateSettings(adminId: string, patch: Partial<RiskSettings>): Promise<RiskSettings> {
    const before = await this.getSettings();
    const next: RiskSettings = {
      weights: { ...before.weights, ...(patch.weights ?? {}) },
      review_threshold: patch.review_threshold ?? before.review_threshold,
      block_threshold: patch.block_threshold ?? before.block_threshold,
      hold_hours: patch.hold_hours ?? before.hold_hours,
      window_days: patch.window_days ?? before.window_days,
      velocity_max_requests_per_hour: patch.velocity_max_requests_per_hour ?? before.velocity_max_requests_per_hour,
    };
    const bad = (msg: string) => Errors.unprocessable('INVALID_RISK_SETTINGS', msg);
    for (const [k, v] of Object.entries(next.weights)) {
      if (!isRiskSignal(k) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 50) throw bad(`weights.${k} must be a number 0..50`);
    }
    for (const k of ['review_threshold', 'block_threshold'] as const) {
      if (!Number.isInteger(next[k]) || next[k] < 0 || next[k] > 100) throw bad(`${k} must be an integer 0..100`);
    }
    if (next.review_threshold >= next.block_threshold) throw bad('review_threshold must be below block_threshold');
    if (!Number.isInteger(next.hold_hours) || next.hold_hours < 0 || next.hold_hours > 720) throw bad('hold_hours must be an integer 0..720');
    if (!Number.isInteger(next.window_days) || next.window_days < 1 || next.window_days > 365) throw bad('window_days must be an integer 1..365');
    if (!Number.isInteger(next.velocity_max_requests_per_hour) || next.velocity_max_requests_per_hour < 1 || next.velocity_max_requests_per_hour > 1000) {
      throw bad('velocity_max_requests_per_hour must be an integer 1..1000');
    }
    const upsert = async (key: string, value: unknown) => {
      await this.db.query(
        `INSERT INTO risk_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [key, JSON.stringify(value), adminId],
      );
    };
    if (patch.weights) await upsert('weights', next.weights);
    if (patch.review_threshold !== undefined) await upsert('review_threshold', next.review_threshold);
    if (patch.block_threshold !== undefined) await upsert('block_threshold', next.block_threshold);
    if (patch.hold_hours !== undefined) await upsert('hold_hours', next.hold_hours);
    if (patch.window_days !== undefined) await upsert('window_days', next.window_days);
    if (patch.velocity_max_requests_per_hour !== undefined) await upsert('velocity_max_requests_per_hour', next.velocity_max_requests_per_hour);
    await this.audit(adminId, 'risk.settings.update', 'risk_settings', null, before, next);
    return next;
  }

  // ---- Scores ----

  /** Stored score, or a zero score when the user was never scored. Never
   *  recomputes — callers that need fresh numbers call recomputeScore. */
  async getScore(userId: string) {
    await this.requireUser(userId);
    const row = (await this.db.query(`SELECT * FROM risk_scores WHERE user_id=$1`, [userId])).rows[0] as Record<string, unknown> | undefined;
    const settings = await this.getSettings();
    if (!row) {
      return { user_id: userId, score: 0, level: 'low', breakdown: {}, hold_until: null, updated_at: null,
        review_threshold: settings.review_threshold, block_threshold: settings.block_threshold };
    }
    return { ...toScoreRow(row), review_threshold: settings.review_threshold, block_threshold: settings.block_threshold };
  }

  /** Gather every signal count for a user inside the configured window.
   *  Derived sources (existing tables) are authoritative; risk_events rows
   *  are counted only for EVENT_ONLY_SIGNALS. */
  private async loadCounts(userId: string, settings: RiskSettings): Promise<Partial<Record<RiskSignal, number>>> {
    const windowDays = settings.window_days;
    const canc = (await this.db.query<{ provider_cancellations: string; customer_cancellations: string }>(
      `SELECT
         (SELECT COUNT(*)::int FROM jobs WHERE provider_id IN (SELECT id FROM provider_profiles WHERE user_id=$1)
            AND state='CANCELLED_BY_PROVIDER' AND created_at >= now() - ($2::int || ' days')::interval) AS provider_cancellations,
         (SELECT COUNT(*)::int FROM jobs WHERE customer_id=$1 AND state='CANCELLED_BY_CUSTOMER'
            AND created_at >= now() - ($2::int || ' days')::interval) AS customer_cancellations`,
      [userId, windowDays])).rows[0];
    const upheld = (await this.db.query<{ n: string }>(
      // Upheld = the customer got money back (refund / partial_refund /
      // compensation), so the fault lies with the PROVIDER only. The
      // customer is the wronged party and is never scored for it.
      `SELECT COUNT(*)::int AS n FROM disputes d JOIN jobs j ON j.id=d.job_id JOIN provider_profiles p ON p.id=j.provider_id
        WHERE d.status='resolved' AND d.resolution->>'outcome' IN ('refund','partial_refund','compensation')
          AND p.user_id=$1 AND d.updated_at >= now() - ($2::int || ' days')::interval`,
      [userId, windowDays])).rows[0];
    const teleport = (await this.db.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM fraud_signals WHERE user_id=$1 AND signal='teleport_location'
         AND created_at >= now() - ($2::int || ' days')::interval`,
      [userId, windowDays])).rows[0];
    const devices = (await this.db.query<{ n: string }>(
      `SELECT COUNT(DISTINCT device_fingerprint)::int AS n FROM user_devices WHERE user_id=$1
         AND COALESCE(last_seen_at, created_at) >= now() - ($2::int || ' days')::interval`,
      [userId, windowDays])).rows[0];
    const duplicates = (await this.db.query<{ n: string }>(
      `SELECT COUNT(DISTINCT ud2.user_id)::int AS n FROM user_devices ud1
         JOIN user_devices ud2 ON ud2.device_fingerprint = ud1.device_fingerprint AND ud2.user_id <> $1
        WHERE ud1.user_id=$1`,
      [userId])).rows[0];
    const payoutReuse = (await this.db.query<{ n: string }>(
      `SELECT COUNT(DISTINCT p2.user_id)::int AS n FROM provider_profiles p1
         JOIN provider_profiles p2 ON p2.payout_account_encrypted = p1.payout_account_encrypted AND p2.user_id <> $1
        WHERE p1.user_id=$1 AND p1.payout_account_encrypted IS NOT NULL`,
      [userId])).rows[0];
    const velocity = (await this.db.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM service_requests WHERE customer_id=$1 AND created_at >= now() - interval '1 hour'`,
      [userId])).rows[0];
    const events = (await this.db.query<{ signal: string; n: string }>(
      `SELECT signal, COUNT(*)::int AS n FROM risk_events WHERE user_id=$1
         AND created_at >= now() - ($2::int || ' days')::interval GROUP BY signal`,
      [userId, windowDays])).rows;

    const counts: Partial<Record<RiskSignal, number>> = {
      cancellation: Number(canc?.provider_cancellations ?? 0) + Number(canc?.customer_cancellations ?? 0),
      upheld_dispute: Number(upheld?.n ?? 0),
      teleport: Number(teleport?.n ?? 0),
      device_change: Math.max(0, Number(devices?.n ?? 0) - 1),
      duplicate_account: Number(duplicates?.n ?? 0),
      payout_account_reuse: Number(payoutReuse?.n ?? 0),
      velocity: Number(velocity?.n ?? 0) > settings.velocity_max_requests_per_hour ? 1 : 0,
    };
    for (const e of events) {
      if (isRiskSignal(e.signal) && EVENT_ONLY_SIGNALS.includes(e.signal)) counts[e.signal] = Number(e.n);
    }
    return counts;
  }

  /** Recompute a user's score from current signals + settings, persist it
   *  to risk_scores, and audit the change (action risk.score.update) when
   *  the score or level moved. A critical score sets hold_until =
   *  now + hold_hours; dropping below the block threshold clears the hold.
   *  The engine never suspends an account itself — the hold is a flag for
   *  admin review (PATCH /admin/users/:id/suspend stays the human action). */
  async recomputeScore(userId: string, actorId?: string | null) {
    await this.requireUser(userId);
    const settings = await this.getSettings();
    const counts = await this.loadCounts(userId, settings);
    const { score, level, breakdown } = scoreFromCounts(counts, settings.weights, settings);
    const old = (await this.db.query(`SELECT * FROM risk_scores WHERE user_id=$1`, [userId])).rows[0] as Record<string, unknown> | undefined;
    const holdUntil = level === 'critical'
      ? new Date(Date.now() + settings.hold_hours * 3600 * 1000).toISOString()
      : null;
    const row = (await this.db.query(
      `INSERT INTO risk_scores (user_id, score, level, breakdown, hold_until, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (user_id) DO UPDATE SET score=EXCLUDED.score, level=EXCLUDED.level,
         breakdown=EXCLUDED.breakdown, hold_until=EXCLUDED.hold_until, updated_at=now()
       RETURNING *`,
      [userId, score, level, JSON.stringify(breakdown), holdUntil])).rows[0] as Record<string, unknown>;
    const changed = !old || Number(old.score) !== score || String(old.level) !== level;
    if (changed && (old || score > 0)) {
      const before = old ? toScoreRow(old) : { user_id: userId, score: 0, level: 'low', breakdown: {}, hold_until: null };
      await this.audit(actorId ?? null, 'risk.score.update', 'risk_scores', userId, before, toScoreRow(row));
    }
    return { ...toScoreRow(row), review_threshold: settings.review_threshold, block_threshold: settings.block_threshold };
  }

  /** Record one signal occurrence (manual / operator-reported signals such
   *  as no-show, SIM change, mock location). The event is stored, then the
   *  score is recomputed so the new event is reflected immediately. */
  async recordEvent(actorId: string, dto: { user_id: string; signal: RiskSignal; job_id?: string | null; detail?: Record<string, unknown> | null }) {
    await this.requireUser(dto.user_id);
    if (dto.job_id) {
      const job = (await this.db.query(`SELECT id FROM jobs WHERE id=$1`, [dto.job_id])).rows[0];
      if (!job) throw Errors.notFound('Job');
    }
    const settings = await this.getSettings();
    const event = (await this.db.query(
      `INSERT INTO risk_events (user_id, job_id, signal, score_delta, detail, source)
       VALUES ($1,$2,$3,$4,$5,'manual') RETURNING *`,
      [dto.user_id, dto.job_id ?? null, dto.signal, settings.weights[dto.signal], dto.detail ? JSON.stringify(dto.detail) : null])).rows[0];
    const score = await this.recomputeScore(dto.user_id, actorId);
    return { event, score };
  }

  /** A user's risk events, newest first. Cursor is an event id. */
  async listEvents(userId: string, opts: { signal?: string; cursor?: string; limit?: number }) {
    await this.requireUser(userId);
    if (opts.signal && !isRiskSignal(opts.signal)) throw Errors.unprocessable('INVALID_SIGNAL', `signal must be one of: ${RISK_SIGNALS.join(', ')}`);
    const lim = Math.min(Math.max(opts.limit || 20, 1), 100);
    const rows = (await this.db.query(
      `SELECT * FROM risk_events WHERE user_id=$1
         AND ($2::varchar IS NULL OR signal=$2::varchar)
         AND ($3::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM risk_events WHERE id=$3::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [userId, opts.signal ?? null, opts.cursor ?? null, lim + 1])).rows;
    return pageFromRows(rows, lim);
  }

  /** Admin fraud-review queue: scored users at/above the review threshold,
   *  highest score first. Offset-cursor page (the queue is small and
   *  score-ordered, so no stable id key exists — same pattern as
   *  ProvidersService.nearby via offsetPage). */
  async listReviewQueue(opts: { cursor?: string; limit?: number }) {
    const settings = await this.getSettings();
    const lim = Math.min(Math.max(opts.limit || 20, 1), 100);
    const rows = (await this.db.query(
      `SELECT rs.*, u.phone, u.full_name, u.status FROM risk_scores rs JOIN users u ON u.id=rs.user_id
        WHERE rs.score >= $1 AND u.deleted_at IS NULL ORDER BY rs.score DESC, rs.user_id ASC LIMIT 200`,
      [settings.review_threshold])).rows;
    const page = offsetPage(rows, opts.cursor, lim);
    return { ...page, review_threshold: settings.review_threshold, block_threshold: settings.block_threshold };
  }

  // ---- Ranking hook (read-only; the integrator wires it in) ----

  /** Ranking penalty for one user from the STORED score — cheap enough to
   *  call per provider inside ProvidersService.nearby(). It deliberately
   *  does NOT recompute: recomputeScore is the explicit refresh path.
   *  Unknown / never-scored users get penalty 0. See risk.module.ts for
   *  the exact integration point (ProvidersService.nearby, rankScore call). */
  async rankingPenaltyForUser(userId: string) {
    const settings = await this.getSettings();
    const row = (await this.db.query(`SELECT score, level FROM risk_scores WHERE user_id=$1`, [userId])).rows[0] as
      { score: string; level: string } | undefined;
    const score = row ? Number(row.score) : 0;
    const level = row ? String(row.level) : levelForScore(score, settings);
    return {
      user_id: userId,
      score,
      level,
      penalty: rankingPenaltyForScore(score, settings),
      blocked: isRiskBlocked(score, settings),
      review_threshold: settings.review_threshold,
      block_threshold: settings.block_threshold,
    };
  }

  /** Job-level risk: the higher of the two parties' stored scores, plus 10
   *  for an open dispute on the job and 5 per teleport signal on the job
   *  (capped at +20). Used by admin fraud review; the per-party scores
   *  stay the source of truth, the job number is a roll-up only. */
  async scoreJob(jobId: string) {
    const job = (await this.db.query(
      `SELECT j.id, j.customer_id, p.user_id AS provider_user_id FROM jobs j
         JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1`,
      [jobId])).rows[0] as { id: string; customer_id: string; provider_user_id: string } | undefined;
    if (!job) throw Errors.notFound('Job');
    const settings = await this.getSettings();
    const readStored = async (userId: string) => {
      const r = (await this.db.query(`SELECT score FROM risk_scores WHERE user_id=$1`, [userId])).rows[0] as { score: string } | undefined;
      return r ? Number(r.score) : 0;
    };
    const customerScore = await readStored(job.customer_id);
    const providerScore = await readStored(job.provider_user_id);
    const openDisputes = (await this.db.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM disputes WHERE job_id=$1 AND status='open'`, [jobId])).rows[0];
    const teleports = (await this.db.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM fraud_signals WHERE job_id=$1 AND signal='teleport_location'`, [jobId])).rows[0];
    const openDispute = Number(openDisputes?.n ?? 0) > 0;
    const teleportCount = Number(teleports?.n ?? 0);
    const score = Math.min(100, Math.max(customerScore, providerScore) + (openDispute ? 10 : 0) + Math.min(20, teleportCount * 5));
    return {
      job_id: jobId,
      score,
      level: levelForScore(score, settings),
      customer_id: job.customer_id,
      customer_score: customerScore,
      provider_id: job.provider_user_id,
      provider_score: providerScore,
      open_dispute: openDispute,
      teleport_events: teleportCount,
      review_threshold: settings.review_threshold,
      block_threshold: settings.block_threshold,
    };
  }
}
