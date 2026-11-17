// Phase 2 unit tests: live tracking (speed sanity, ETA, trail) + job reads.
import { JobsQueryService, haversineKm, etaMinutesForDistance, evaluateLocationPoint } from '../../src/modules/jobs/jobs-query.service';

type Handler = (text: string, params: unknown[]) => { rows: Record<string, unknown>[] } | undefined;
class FakeDb {
  queries: { text: string; params: unknown[] }[] = [];
  private handlers: { re: RegExp; fn: Handler }[] = [];
  on(re: RegExp, fn: Handler) { this.handlers.push({ re, fn }); return this; }
  onRows(re: RegExp, rows: Record<string, unknown>[]) { return this.on(re, () => ({ rows })); }
  async query(text: string, params: unknown[] = []) {
    this.queries.push({ text, params });
    for (const h of this.handlers) {
      if (h.re.test(text)) {
        const out = h.fn(text, params);
        if (out) return out;
      }
    }
    return { rows: [] as Record<string, unknown>[] };
  }
  async withTransaction<T>(fn: (c: unknown) => Promise<T>): Promise<T> { return fn(this as unknown); }
}
const redisStub = (cached: string | null) => ({ get: async () => cached, set: async () => undefined });

describe('tracking maths', () => {
  it('haversine: two Quetta points ~1.9 km apart', () => {
    const d = haversineKm({ lat: 30.1798, lng: 66.975 }, { lat: 30.195, lng: 66.985 });
    expect(d).toBeGreaterThan(1.5);
    expect(d).toBeLessThan(2.2);
    expect(haversineKm({ lat: 30.1798, lng: 66.975 }, { lat: 30.1798, lng: 66.975 })).toBe(0);
  });

  it('ETA: 15 km at 30 km/h is 30 min; tiny distances floor at 1 min', () => {
    expect(etaMinutesForDistance(15)).toBe(30);
    expect(etaMinutesForDistance(0.1)).toBe(1);
    expect(etaMinutesForDistance(0)).toBe(1);
    expect(etaMinutesForDistance(2.5)).toBe(5);
  });

  it('teleport: 100 km in 60 s is rejected as implausible speed', () => {
    const verdict = evaluateLocationPoint({
      state: 'PROVIDER_EN_ROUTE',
      prev: { lat: 30.1798, lng: 66.975, at: '2026-11-17T10:00:00Z' },
      curr: { lat: 31.0, lng: 67.5, at: '2026-11-17T10:01:00Z' },
      jobLat: 30.195, jobLng: 66.985,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toBe('IMPLAUSIBLE_SPEED');
    expect(verdict.speed_kmh).toBeGreaterThan(200);
  });

  it('normal movement is accepted with distance + ETA to the job', () => {
    const verdict = evaluateLocationPoint({
      state: 'PROVIDER_EN_ROUTE',
      prev: { lat: 30.1798, lng: 66.975, at: '2026-11-17T10:00:00Z' },
      curr: { lat: 30.185, lng: 66.98, at: '2026-11-17T10:05:00Z' },
      jobLat: 30.195, jobLng: 66.985,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.speed_kmh).toBeLessThan(200);
    expect(verdict.distance_km).toBeGreaterThan(0);
    expect(verdict.eta_minutes).toBeGreaterThanOrEqual(1);
    // ETA is distance / 30 km/h, min 1
    expect(verdict.eta_minutes).toBe(etaMinutesForDistance(verdict.distance_km));
  });

  it('tracking is rejected once the job is ARRIVED or later', () => {
    for (const state of ['ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'PAYMENT_SETTLED']) {
      const verdict = evaluateLocationPoint({
        state, prev: null,
        curr: { lat: 30.185, lng: 66.98, at: '2026-11-17T10:05:00Z' },
        jobLat: 30.195, jobLng: 66.985,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.error).toBe('NOT_EN_ROUTE');
    }
    const enRoute = evaluateLocationPoint({
      state: 'ITEM_PICKED_UP', prev: null,
      curr: { lat: 30.185, lng: 66.98, at: '2026-11-17T10:05:00Z' },
      jobLat: 30.195, jobLng: 66.985,
    });
    expect(enRoute.ok).toBe(true);
  });

  it('out-of-range coordinates are rejected', () => {
    const verdict = evaluateLocationPoint({
      state: 'PROVIDER_EN_ROUTE', prev: null,
      curr: { lat: 100, lng: 66.98, at: '2026-11-17T10:05:00Z' },
      jobLat: 30.195, jobLng: 66.985,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toBe('INVALID_LOCATION');
  });
});

describe('getTracking', () => {
  const JOB_ROW = { state: 'PROVIDER_EN_ROUTE', customer_id: 'cust-1', provider_user_id: 'prov-1', lat: '30.195', lng: '66.985' };
  // As the real query returns them: created_at DESC (service reverses to chronological).
  const TRAIL = [
    { lat: '30.19', lng: '66.983', at: '2026-11-17T10:05:00Z' },
    { lat: '30.185', lng: '66.98', at: '2026-11-17T10:03:00Z' },
    { lat: '30.18', lng: '66.976', at: '2026-11-17T10:00:00Z' },
  ];
  function trackingDb(trail: Record<string, unknown>[] = TRAIL) {
    const db = new FakeDb();
    db.onRows(/FROM jobs j JOIN provider_profiles/, [JOB_ROW]);
    db.onRows(/FROM provider_locations WHERE job_id/, trail);
    return db;
  }

  it('returns latest point, distance, ETA and the last-20 trail', async () => {
    const svc = new JobsQueryService(trackingDb() as never, redisStub(null) as never);
    const out = await svc.getTracking('job-1', 'cust-1');
    expect(out.job_id).toBe('job-1');
    expect(out.state).toBe('PROVIDER_EN_ROUTE');
    expect(out.provider).toMatchObject({ lat: 30.19, lng: 66.983 });
    expect(out.distance_km).toBeGreaterThan(0);
    expect(out.eta_minutes).toBe(etaMinutesForDistance(out.distance_km as number));
    expect(out.trail).toHaveLength(3);
    expect(out.trail[0].at).toBe('2026-11-17T10:00:00Z'); // chronological
    expect(out.trail[2].at).toBe('2026-11-17T10:05:00Z');
  });

  it('prefers the Redis latest point over the DB trail', async () => {
    const cached = JSON.stringify({ lat: 30.192, lng: 66.984, at: '2026-11-17T10:06:00Z' });
    const svc = new JobsQueryService(trackingDb() as never, redisStub(cached) as never);
    const out = await svc.getTracking('job-1', 'prov-1');
    expect(out.provider).toMatchObject({ lat: 30.192, lng: 66.984, updated_at: '2026-11-17T10:06:00Z' });
  });

  it('no points yet -> provider null, no distance/ETA, empty trail', async () => {
    const svc = new JobsQueryService(trackingDb([]) as never, redisStub(null) as never);
    const out = await svc.getTracking('job-1', 'cust-1');
    expect(out.provider).toBeNull();
    expect(out.distance_km).toBeNull();
    expect(out.eta_minutes).toBeNull();
    expect(out.trail).toEqual([]);
  });

  it('non-party gets 403', async () => {
    const svc = new JobsQueryService(trackingDb() as never, redisStub(null) as never);
    await expect(svc.getTracking('job-1', 'someone-else')).rejects.toMatchObject({ status: 403 });
  });
});

describe('getJob', () => {
  const ROW = {
    id: 'job-1', request_id: 'req-1', agreed_price: '2000', final_price: null, state: 'ACCEPTED',
    payment_method: 'cash', payment_status: 'unpaid', customer_id: 'cust-1', provider_id: 'prof-1',
    provider_user_id: 'prov-1', scheduled_at: '2026-11-20T10:00:00Z', created_at: '2026-11-17T10:00:00Z',
  };
  it('party reads the job; stranger gets 403; missing job 404', async () => {
    const db = new FakeDb();
    db.on(/FROM jobs j/, (_t, p) => ({ rows: p[0] === 'job-1' ? [ROW] : [] }));
    const svc = new JobsQueryService(db as never, redisStub(null) as never);
    const job = await svc.getJob('job-1', 'prov-1');
    expect(job.id).toBe('job-1');
    expect(job.scheduled_at).toBe('2026-11-20T10:00:00Z');
    await expect(svc.getJob('job-1', 'someone-else')).rejects.toMatchObject({ status: 403 });
    await expect(svc.getJob('job-missing', 'cust-1')).rejects.toMatchObject({ status: 404 });
  });
});
