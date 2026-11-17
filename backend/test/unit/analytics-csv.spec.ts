// Analytics warehouse — unit tests (Phase 4, item 2). Pure CSV / funnel
// helpers + standalone Nest module wiring (AnalyticsModule only, with a
// stub DatabaseService — NOT the full AppModule). No live database needed.
import { Test } from '@nestjs/testing';
import { ANALYTICS_CSV_DISCLAIMER, csvEscape, funnelRates, toCsv, toCsvExport } from '../../src/modules/analytics/analytics-csv';
import { AnalyticsModule } from '../../src/modules/analytics/analytics.module';
import { AnalyticsController } from '../../src/modules/analytics/analytics.controller';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import { DatabaseModule } from '../../src/database/database.module';
import { DatabaseService } from '../../src/database/database.service';

describe('csvEscape / toCsv', () => {
  it('plain values pass through; null/undefined become empty', () => {
    expect(csvEscape('Quetta')).toBe('Quetta');
    expect(csvEscape(1500)).toBe('1500');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });
  it('commas, quotes and newlines are RFC 4180 quoted', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });
  it('toCsv uses the given column order and CRLF lines', () => {
    const out = toCsv([{ b: 2, a: 'x,y' }, { b: 3, a: 'z' }], ['a', 'b']);
    expect(out).toBe('a,b\r\n"x,y",2\r\nz,3\r\n');
  });
  it('toCsv with no rows still emits the header', () => {
    expect(toCsv([], ['city', 'revenue_pkr'])).toBe('city,revenue_pkr\r\n');
  });
  it('export CSV starts with the legal-review disclaimer, not a data row', () => {
    const out = toCsvExport([{ city: 'Quetta', revenue_pkr: 1500 }], ['city', 'revenue_pkr']);
    expect(out.startsWith('# SUBJECT TO LEGAL REVIEW')).toBe(true);
    expect(out).toContain('FBR, PRA, SRB');
    expect(out).toContain('city,revenue_pkr\r\nQuetta,1500\r\n');
    expect(ANALYTICS_CSV_DISCLAIMER).toContain('SUBJECT TO LEGAL REVIEW');
  });
});

describe('funnelRates', () => {
  it('computes offer / fill / completion / rating rates from stage counts', () => {
    const f = funnelRates({ requests: 10, withOffers: 8, accepted: 5, completed: 4, rated: 3 });
    expect(f.offerRate).toBeCloseTo(0.8);
    expect(f.fillRate).toBeCloseTo(0.5);
    expect(f.completionRate).toBeCloseTo(0.8);
    expect(f.ratingRate).toBeCloseTo(0.75);
  });
  it('zero denominators give 0, not NaN', () => {
    const f = funnelRates({ requests: 0, withOffers: 0, accepted: 0, completed: 0, rated: 0 });
    expect(f.offerRate).toBe(0);
    expect(f.fillRate).toBe(0);
    expect(f.completionRate).toBe(0);
    expect(f.ratingRate).toBe(0);
  });
});

describe('AnalyticsModule standalone wiring', () => {
  // Minimal stub: every query returns empty rows; the ETL run-row insert
  // returns an id so runEtl can build its report.
  const stubClient = {
    query: async (sql: string) => {
      if (sql.includes('RETURNING id')) return { rows: [{ id: '00000000-0000-4000-8000-000000000001' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const stubDb = {
    query: stubClient.query,
    withTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(stubClient),
  };

  let controller: AnalyticsController;
  let service: AnalyticsService;

  beforeAll(async () => {
    // DatabaseService is @Global via DatabaseModule in the real app, so
    // the standalone test imports DatabaseModule and overrides its
    // DatabaseService with the stub.
    const mod = await Test.createTestingModule({ imports: [DatabaseModule, AnalyticsModule] })
      .overrideProvider(DatabaseService)
      .useValue(stubDb)
      .compile();
    controller = mod.get(AnalyticsController);
    service = mod.get(AnalyticsService);
  });

  it('compiles standalone with only AnalyticsModule imported', () => {
    expect(controller).toBeDefined();
    expect(service).toBeDefined();
  });

  it('funnel on an empty warehouse returns zeros and a null median', async () => {
    const f = await controller.funnel({});
    expect(f.requests).toBe(0);
    expect(f.fillRate).toBe(0);
    expect(f.medianTimeToFirstOfferSeconds).toBeNull();
  });

  it('revenue and supply-demand return empty lists on an empty warehouse', async () => {
    expect(await controller.revenue({ group_by: 'city' })).toEqual([]);
    const sd = await controller.supplyDemand({});
    expect(sd.demandByHour).toEqual([]);
    expect(sd.supplyByCity).toEqual([]);
  });

  it('ETL run against the stub completes and reports a reconciliation object', async () => {
    const run = await controller.runEtl();
    expect(run.status).toBe('completed');
    expect(run.reconciliation.requests).toEqual({ operational: 0, warehouse: 0, match: true });
    expect(run.reconciliation.providers.match).toBe(true);
  });

  it('latest status returns null when no run has happened', async () => {
    // The stub has no etl_runs rows, so latestRun() finds nothing.
    expect(await controller.status()).toBeNull();
  });

  it('CSV export returns the disclaimer + header even with no rows', async () => {
    const csv = await controller.exportCsv('fact_requests');
    expect(csv.startsWith('# SUBJECT TO LEGAL REVIEW')).toBe(true);
    expect(csv).toContain('request_id,request_date');
  });

  it('CSV export rejects unknown tables', async () => {
    await expect(controller.exportCsv('users')).rejects.toThrow('unknown export table');
  });
});
