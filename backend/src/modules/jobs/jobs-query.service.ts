import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { Errors } from '../../common/errors/api-error';
import { toJob } from '../offers/offers.service';

// ---- Live-tracking pure helpers (shared with RealtimeGateway) ----

export interface LocationPoint { lat: number; lng: number; at: Date | string; }

/** Haversine distance in km between two WGS-84 points. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** ETA in whole minutes at an urban 30 km/h assumption, minimum 1 minute. */
export function etaMinutesForDistance(distanceKm: number, speedKmh = 30): number {
  return Math.max(1, Math.round((distanceKm / speedKmh) * 60));
}

/** Implied speed km/h between two timestamped points; null when it cannot
 *  be computed (no previous point). A zero/negative time delta with real
 *  movement is treated as infinite speed (teleport). */
export function impliedSpeedKmh(prev: LocationPoint, curr: LocationPoint): number | null {
  const dtSeconds = (new Date(curr.at).getTime() - new Date(prev.at).getTime()) / 1000;
  const distanceKm = haversineKm(prev, curr);
  if (dtSeconds <= 0) return distanceKm > 0.0001 ? Number.POSITIVE_INFINITY : 0;
  return (distanceKm / dtSeconds) * 3600;
}

export const TRACKING_STATES = ['PROVIDER_EN_ROUTE', 'ITEM_PICKED_UP'];
export const MAX_LOCATION_SPEED_KMH = 200;

/** Decide whether a provider.location point is accepted. Pure + unit-tested:
 *  - job must be en route (PROVIDER_EN_ROUTE / ITEM_PICKED_UP); once ARRIVED
 *    or later, tracking stops and points are rejected;
 *  - lat/lng must be in range;
 *  - a point implying >200 km/h from the last stored point is a teleport:
 *    rejected, and the caller must flag it in fraud_signals (never emitted). */
export function evaluateLocationPoint(opts: {
  state: string;
  prev: LocationPoint | null;
  curr: LocationPoint;
  jobLat: number;
  jobLng: number;
}): { ok: boolean; error?: string; speed_kmh: number | null; distance_km: number; eta_minutes: number } {
  const distance_km = haversineKm(opts.curr, { lat: opts.jobLat, lng: opts.jobLng });
  const eta_minutes = etaMinutesForDistance(distance_km);
  if (!TRACKING_STATES.includes(opts.state)) return { ok: false, error: 'NOT_EN_ROUTE', speed_kmh: null, distance_km, eta_minutes };
  if (opts.curr.lat < -90 || opts.curr.lat > 90 || opts.curr.lng < -180 || opts.curr.lng > 180) {
    return { ok: false, error: 'INVALID_LOCATION', speed_kmh: null, distance_km, eta_minutes };
  }
  const speed_kmh = opts.prev ? impliedSpeedKmh(opts.prev, opts.curr) : null;
  if (speed_kmh != null && speed_kmh > MAX_LOCATION_SPEED_KMH) {
    return { ok: false, error: 'IMPLAUSIBLE_SPEED', speed_kmh, distance_km, eta_minutes };
  }
  return { ok: true, speed_kmh, distance_km, eta_minutes };
}

function toJobExtended(row: Record<string, unknown>) {
  return {
    ...toJob(row),
    customer_id: row.customer_id,
    provider_id: row.provider_id,
    // Batch 2 (§6a): when the customer confirmed completion (null until
    // then — or until the auto-confirm sweep confirms it).
    completion_confirmed_at: row.completion_confirmed_at ?? null,
    completion_confirmed_by: row.completion_confirmed_by ?? null,
    scheduled_at: row.scheduled_at ?? null,
    created_at: row.created_at,
  };
}

const TRAIL_RETENTION_HOURS = 48;

@Injectable()
export class JobsQueryService {
  constructor(private db: DatabaseService, private redis: RedisService) {}

  private async providerIdFor(userId: string): Promise<string | null> {
    const row = (await this.db.query<{ id: string }>(`SELECT id FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
    return row?.id ?? null;
  }

  /** Job history for the caller (OpenAPI listJobs). Role defaults to the
   *  caller's active profile: provider when they have one, else customer.
   *  Cursor pagination: pass next_cursor (a job id) to continue. */
  async listJobs(userId: string, role?: string, state?: string, cursor?: string, limit = 20) {
    const lim = Math.min(Math.max(limit || 20, 1), 100);
    let side = role;
    if (!side) side = (await this.providerIdFor(userId)) ? 'provider' : 'customer';
    if (side !== 'customer' && side !== 'provider') throw Errors.unprocessable('INVALID_ROLE', "role must be 'customer' or 'provider'");
    const providerId = side === 'provider' ? await this.providerIdFor(userId) : null;
    if (side === 'provider' && !providerId) throw Errors.forbidden('No provider profile for this account');
    // FIX 7 latent bug: the old query always bound 5 params but the
    // customer branch never referenced $2 (providerId) — Postgres cannot
    // infer the type of an unused parameter and fails with 42P18. One
    // $1 placeholder now holds whichever side id applies.
    const whoCol = side === 'customer' ? 'j.customer_id' : 'j.provider_id';
    const whoId = side === 'customer' ? userId : providerId;
    const params: unknown[] = [whoId, state ?? null, cursor ?? null, lim + 1];
    const rows = (await this.db.query(
      `SELECT j.*, r.scheduled_at FROM jobs j LEFT JOIN service_requests r ON r.id=j.request_id
       WHERE ${whoCol}=$1
         AND ($2::varchar IS NULL OR j.state=$2::varchar)
         AND ($3::text IS NULL OR (j.created_at, j.id) < (SELECT created_at, id FROM jobs WHERE id=$3::uuid))
       ORDER BY j.created_at DESC, j.id DESC LIMIT $4`,
      params)).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return { items: page.map(toJobExtended), next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }

  /** Job details (OpenAPI getJob). Customer or provider of that job only. */
  async getJob(jobId: string, userId: string) {
    const row = (await this.db.query(
      `SELECT j.*, r.scheduled_at, p.user_id AS provider_user_id FROM jobs j
        LEFT JOIN service_requests r ON r.id=j.request_id
        JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1`, [jobId])).rows[0];
    if (!row) throw Errors.notFound('Job');
    if (row.customer_id !== userId && row.provider_user_id !== userId) throw Errors.forbidden('Not a party to this job');
    return toJobExtended(row);
  }

  /** Live tracking for a job (parties only). Latest point comes from Redis
   *  (key provider:loc:{jobId}, 48h TTL) with a DB fallback; the trail is the
   *  last 20 points inside the 48h dispute window. RETENTION RULE: points
   *  older than 48h are evidence, not live state — they are never served here
   *  and must be purged by a nightly job (not in this repo). */
  async getTracking(jobId: string, userId: string) {
    const job = (await this.db.query(
      `SELECT j.state, j.customer_id, p.user_id AS provider_user_id,
              ST_Y(r.location::geometry) AS lat, ST_X(r.location::geometry) AS lng
       FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id
       JOIN service_requests r ON r.id=j.request_id WHERE j.id=$1`, [jobId])).rows[0] as unknown as
      { state: string; customer_id: string; provider_user_id: string; lat: string; lng: string } | undefined;
    if (!job) throw Errors.notFound('Job');
    if (job.customer_id !== userId && job.provider_user_id !== userId) throw Errors.forbidden('Not a party to this job');
    const jobLat = Number(job.lat);
    const jobLng = Number(job.lng);
    let latest: { lat: number; lng: number; updated_at: string } | null = null;
    const cached = await this.redis.get(`provider:loc:${jobId}`);
    if (cached) {
      try {
        const p = JSON.parse(cached) as { lat: number; lng: number; at: string };
        latest = { lat: p.lat, lng: p.lng, updated_at: p.at };
      } catch { latest = null; }
    }
    const trailRows = (await this.db.query<{ lat: string; lng: string; at: string }>(
      `SELECT ST_Y(point::geometry)::text AS lat, ST_X(point::geometry)::text AS lng, created_at AS at
       FROM provider_locations WHERE job_id=$1 AND created_at >= now() - interval '${TRAIL_RETENTION_HOURS} hours'
       ORDER BY created_at DESC LIMIT 20`, [jobId])).rows;
    const trail = trailRows.map((r) => ({ lat: Number(r.lat), lng: Number(r.lng), at: r.at })).reverse();
    if (!latest && trail.length) {
      const last = trail[trail.length - 1];
      latest = { lat: last.lat, lng: last.lng, updated_at: last.at };
    }
    const distance_km = latest ? Number(haversineKm(latest, { lat: jobLat, lng: jobLng }).toFixed(3)) : null;
    const eta_minutes = distance_km != null ? etaMinutesForDistance(distance_km) : null;
    return { job_id: jobId, state: job.state, provider: latest, distance_km, eta_minutes, trail };
  }
}
