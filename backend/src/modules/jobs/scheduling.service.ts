import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { Errors } from '../../common/errors/api-error';
import { TERMINAL_STATES } from '../../common/utils/job-state-machine';
import { resolveCategoryId } from '../../common/utils/category-resolve';
import { withIdempotency } from '../../common/utils/idempotency';
import { RequestsService } from '../requests/requests.service';

export type RecurringFrequency = 'weekly' | 'monthly';

/** Next run strictly after `from`, preserving the time of day.
 *  Weekly: the next date whose Postgres day-of-week (0=Sunday..6=Saturday)
 *  equals dayOfWeek. Monthly: the same day-of-month next month
 *  (dayOfMonth is capped at 28 at validation, so it always exists). */
export function advanceNextRun(from: Date, frequency: RecurringFrequency, dayOfWeek?: number | null, dayOfMonth?: number | null): Date {
  const base = new Date(from.getTime());
  if (frequency === 'weekly') {
    const dow = dayOfWeek ?? base.getDay();
    const d = new Date(base.getTime());
    d.setDate(d.getDate() + 1);
    while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
    return d;
  }
  const dom = dayOfMonth ?? base.getDate();
  const candidate = new Date(base.getFullYear(), base.getMonth(), dom, base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds());
  if (candidate <= base) candidate.setMonth(candidate.getMonth() + 1);
  return candidate;
}

export interface RecurringJobInput {
  category_id?: string; category_slug?: string; description?: string;
  specs?: Record<string, unknown>; fulfillment: string;
  lat: number; lng: number; address_id?: string; customer_offer?: number;
  frequency: RecurringFrequency; day_of_week?: number; day_of_month?: number;
  starts_at: string; ends_at?: string;
}

@Injectable()
export class SchedulingService {
  constructor(private db: DatabaseService, private redis: RedisService, private requests: RequestsService) {}

  private categoryLookup() {
    return {
      byId: async (id: string) => (await this.db.query<{ id: string }>(`SELECT id FROM categories WHERE id=$1 AND is_active`, [id])).rows[0] ?? null,
      bySlug: async (slug: string) => (await this.db.query<{ id: string }>(`SELECT id FROM categories WHERE slug=$1 AND is_active`, [slug])).rows[0] ?? null,
    };
  }

  private validateRecurrence(frequency: string, dayOfWeek?: number, dayOfMonth?: number) {
    if (frequency !== 'weekly' && frequency !== 'monthly') {
      throw Errors.unprocessable('INVALID_FREQUENCY', "frequency must be 'weekly' or 'monthly'");
    }
    if (frequency === 'weekly' && (dayOfWeek == null || dayOfWeek < 0 || dayOfWeek > 6 || !Number.isInteger(dayOfWeek))) {
      // Recurring day_of_week is Postgres DOW (0=Sunday) — NOT the
      // availability weekday (0=Monday). Both mappings + conversions live
      // in ONE place: src/common/utils/availability.ts.
      throw Errors.unprocessable('INVALID_DAY_OF_WEEK', 'weekly recurrence needs day_of_week 0..6 (Postgres DOW: 0=Sunday)');
    }
    if (frequency === 'monthly' && (dayOfMonth == null || dayOfMonth < 1 || dayOfMonth > 28 || !Number.isInteger(dayOfMonth))) {
      throw Errors.unprocessable('INVALID_DAY_OF_MONTH', 'monthly recurrence needs day_of_month 1..28');
    }
  }

  /** Reschedule a job (job party only, job not terminal). The accepted price
   *  is kept: only the linked request's scheduled_at changes, plus a
   *  job_events row and job.reminder notifications for both parties. If the
   *  scope changed, the date is NOT moved — 409 with guidance to renegotiate
   *  the price first via POST /jobs/:id/adjustments. */
  async reschedule(jobId: string, userId: string, dto: { scheduled_at: string; reason?: string; scope_changed?: boolean }, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'job-reschedule', idempotencyKey, async () => this.rescheduleInner(jobId, userId, dto));
  }
  private async rescheduleInner(jobId: string, userId: string, dto: { scheduled_at: string; reason?: string; scope_changed?: boolean }) {
    const job = (await this.db.query(
      `SELECT j.id, j.state, j.customer_id, j.agreed_price, j.final_price, p.user_id AS provider_user_id,
              r.id AS request_id, r.scheduled_at AS current_scheduled_at
       FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id
       JOIN service_requests r ON r.id=j.request_id WHERE j.id=$1`, [jobId])).rows[0] as unknown as
      Record<string, unknown> | undefined;
    if (!job) throw Errors.notFound('Job');
    const role = userId === job.customer_id ? 'customer' : userId === job.provider_user_id ? 'provider' : null;
    if (!role) throw Errors.forbidden('Only the job parties can reschedule');
    if ((TERMINAL_STATES as string[]).includes(String(job.state))) {
      throw Errors.conflict('JOB_TERMINAL', `Job is ${job.state} and cannot be rescheduled`);
    }
    if (dto.scope_changed) {
      throw Errors.conflict(
        'SCOPE_CHANGED_REQUIRES_RENEGOTIATION',
        'The scope changed, so the price must be renegotiated before the date moves. Use POST /jobs/:id/adjustments first, then reschedule.',
        { guidance: 'POST /jobs/:id/adjustments' },
      );
    }
    const scheduledAt = new Date(dto.scheduled_at);
    if (Number.isNaN(scheduledAt.getTime())) throw Errors.unprocessable('INVALID_SCHEDULED_AT', 'scheduled_at must be an ISO date-time');
    await this.db.query(`UPDATE service_requests SET scheduled_at=$2, updated_at=now() WHERE id=$1`, [job.request_id, scheduledAt.toISOString()]);
    await this.db.query(
      `INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload) VALUES ($1,$2,$2,$3,$4,$5)`,
      [jobId, job.state, userId, role, JSON.stringify({ event: 'rescheduled', scheduled_at: scheduledAt.toISOString(), previous_scheduled_at: job.current_scheduled_at, reason: dto.reason ?? null })]);
    for (const partyId of [job.customer_id, job.provider_user_id]) {
      await this.db.query(`INSERT INTO notifications (user_id, channel, template_key, payload, status) VALUES ($1,'push','job.reminder',$2,'queued')`,
        [partyId, JSON.stringify({ job_id: jobId, scheduled_at: scheduledAt.toISOString() })]);
    }
    return {
      job_id: jobId, state: job.state, scheduled_at: scheduledAt.toISOString(),
      previous_scheduled_at: job.current_scheduled_at ?? null,
      agreed_price: Number(job.agreed_price), final_price: job.final_price != null ? Number(job.final_price) : null,
    };
  }

  async createRecurring(customerId: string, dto: RecurringJobInput) {
    this.validateRecurrence(dto.frequency, dto.day_of_week, dto.day_of_month);
    const categoryId = await resolveCategoryId(this.categoryLookup(), { category_id: dto.category_id, category_slug: dto.category_slug });
    if (!['VISIT_SHOP', 'PROVIDER_COMES', 'PICKUP_DELIVERY'].includes(dto.fulfillment)) {
      throw Errors.unprocessable('INVALID_FULFILLMENT', 'fulfillment must be VISIT_SHOP, PROVIDER_COMES or PICKUP_DELIVERY');
    }
    if (typeof dto.lat !== 'number' || dto.lat < -90 || dto.lat > 90 || typeof dto.lng !== 'number' || dto.lng < -180 || dto.lng > 180) {
      throw Errors.unprocessable('INVALID_LOCATION', 'lat must be -90..90 and lng -180..180');
    }
    const startsAt = new Date(dto.starts_at);
    if (Number.isNaN(startsAt.getTime())) throw Errors.unprocessable('INVALID_STARTS_AT', 'starts_at must be an ISO date-time');
    const endsAt = dto.ends_at ? new Date(dto.ends_at) : null;
    if (endsAt && Number.isNaN(endsAt.getTime())) throw Errors.unprocessable('INVALID_ENDS_AT', 'ends_at must be an ISO date-time');
    if (endsAt && endsAt <= startsAt) throw Errors.unprocessable('INVALID_ENDS_AT', 'ends_at must be after starts_at');
    // First run: starts_at when it is in the future, otherwise advance forward
    // from starts_at until the run is ahead of now.
    const now = new Date();
    let nextRun = startsAt;
    let guard = 0;
    while (nextRun <= now && guard++ < 1200) nextRun = advanceNextRun(nextRun, dto.frequency, dto.day_of_week, dto.day_of_month);
    const row = (await this.db.query(
      `INSERT INTO recurring_jobs (customer_id, category_id, specs, fulfillment, location, address_id, customer_offer,
         frequency, day_of_week, day_of_month, starts_at, ends_at, status, next_run_at)
       VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,$7,$8,$9,$10,$11,$12,$13,'active',$14) RETURNING *`,
      [customerId, categoryId, JSON.stringify(dto.specs ?? {}), dto.fulfillment, dto.lat, dto.lng,
       dto.address_id ?? null, dto.customer_offer ?? null, dto.frequency,
       dto.frequency === 'weekly' ? dto.day_of_week : null,
       dto.frequency === 'monthly' ? dto.day_of_month : null,
       startsAt.toISOString(), endsAt?.toISOString() ?? null, nextRun.toISOString()])).rows[0];
    return row;
  }

  async listRecurring(customerId: string, cursor?: string, limit = 20) {
    const lim = Math.min(Math.max(limit || 20, 1), 100);
    const rows = (await this.db.query(
      `SELECT * FROM recurring_jobs WHERE customer_id=$1
         AND ($2::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM recurring_jobs WHERE id=$2::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [customerId, cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return { items: page, next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }

  async patchRecurring(id: string, customerId: string, status: string) {
    if (!['active', 'paused', 'cancelled'].includes(status)) {
      throw Errors.unprocessable('INVALID_STATUS', "status must be 'active', 'paused' or 'cancelled'");
    }
    const row = (await this.db.query(`SELECT * FROM recurring_jobs WHERE id=$1 AND customer_id=$2`, [id, customerId])).rows[0];
    if (!row) throw Errors.notFound('Recurring job');
    if (row.status === 'cancelled' && status !== 'cancelled') {
      throw Errors.conflict('RECURRING_CANCELLED', 'A cancelled recurring job cannot be resumed');
    }
    return (await this.db.query(
      `UPDATE recurring_jobs SET status=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, status])).rows[0];
  }

  /** Skip the next run: advance next_run_at by exactly one period and log
   *  the skip (skipped_count / last_skipped_at). No request is created. */
  async skipNext(id: string, customerId: string) {
    const row = (await this.db.query(`SELECT * FROM recurring_jobs WHERE id=$1 AND customer_id=$2`, [id, customerId])).rows[0];
    if (!row) throw Errors.notFound('Recurring job');
    if (row.status !== 'active') throw Errors.conflict('RECURRING_NOT_ACTIVE', `Cannot skip the next run of a ${row.status} recurring job`);
    const nextRun = advanceNextRun(new Date(row.next_run_at), row.frequency as RecurringFrequency, row.day_of_week, row.day_of_month);
    return (await this.db.query(
      `UPDATE recurring_jobs SET next_run_at=$2, skipped_count=skipped_count+1, last_skipped_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
      [id, nextRun.toISOString()])).rows[0];
  }

  /** Generate one service request per due recurring job. Reuses the existing
   *  request creation path (RequestsService.create) — no duplicated SQL — so
   *  the generated request is broadcast to providers exactly like a manual
   *  one. Idempotency key `recurring:<id>:<next_run_at>` makes a retried run
   *  return the same request instead of duplicating it. A real cron/scheduler
   *  must call POST /admin/recurring-jobs/run-due — there is no cron infra in
   *  this repo. */
  async generateDueInstances(now: Date = new Date()) {
    const due = (await this.db.query(
      `SELECT r.*, ST_Y(r.location::geometry) AS lat, ST_X(r.location::geometry) AS lng
       FROM recurring_jobs r WHERE r.status='active' AND r.next_run_at <= $1
         AND (r.ends_at IS NULL OR r.next_run_at <= r.ends_at) ORDER BY r.next_run_at ASC`,
      [now.toISOString()])).rows;
    const instances: { recurring_job_id: string; request_id: string; scheduled_at: string }[] = [];
    for (const r of due) {
      const runAt = new Date(r.next_run_at);
      const request = await this.requests.create(String(r.customer_id), {
        category_id: String(r.category_id),
        description: (r.specs as Record<string, unknown>)?.description as string | undefined ?? 'Recurring job',
        specs: (r.specs ?? {}) as Record<string, unknown>,
        fulfillment: r.fulfillment,
        lat: Number(r.lat), lng: Number(r.lng),
        address_id: r.address_id ?? undefined,
        scheduled_at: runAt.toISOString(),
        customer_offer: r.customer_offer != null ? Number(r.customer_offer) : undefined,
      } as never, `recurring:${r.id}:${runAt.toISOString()}`);
      const nextRun = advanceNextRun(runAt, r.frequency as RecurringFrequency, r.day_of_week, r.day_of_month);
      const advanced = (await this.db.query(
        `UPDATE recurring_jobs SET last_generated_at=now(), next_run_at=$2, updated_at=now()
         WHERE id=$1 AND next_run_at=$3 RETURNING id`,
        [r.id, nextRun.toISOString(), runAt.toISOString()])).rows[0];
      if (!advanced) continue; // another runner already advanced this job
      instances.push({ recurring_job_id: String(r.id), request_id: String((request as Record<string, unknown>).id), scheduled_at: runAt.toISOString() });
    }
    return { generated: instances.length, instances };
  }
}
