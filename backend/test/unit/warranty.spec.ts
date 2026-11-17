// Warranty Product — unit tests (Phase 4, item 4).
// Pure calc/state-machine tests run with no I/O; the module-wiring test
// compiles WarrantyModule standalone (DatabaseModule is @Global and its
// services are lazy — no live Postgres/Redis needed). Live-DB behaviour
// (ledger balance, claim window, refund) is covered by
// test/integration/warranty.spec.ts against nearservice_p4_warranty.
import { Test } from '@nestjs/testing';
import { DatabaseModule } from '../../src/database/database.module';
import { WarrantyModule } from '../../src/modules/warranty/warranty.module';
import { WarrantyService } from '../../src/modules/warranty/warranty.service';
import {
  CLAIM_TRANSITIONS,
  DEFAULT_WARRANTY_CONFIG,
  computeWarrantyFee,
  coverageEndsAt,
  isLegalClaimTransition,
  isWithinClaimWindow,
  legalNextClaimStates,
  validateWarrantyConfig,
} from '../../src/modules/warranty/warranty-calc';

describe('warranty fee pricing (pure)', () => {
  it('5% of the job price by default', () => {
    expect(computeWarrantyFee(600_000, DEFAULT_WARRANTY_CONFIG)).toBe(30_000); // PKR 6,000 -> PKR 300
    expect(computeWarrantyFee(100_000, DEFAULT_WARRANTY_CONFIG)).toBe(5_000); // PKR 1,000 -> PKR 50
  });

  it('minimum fee applies on small jobs', () => {
    // 5% of PKR 500 is PKR 25 — below the PKR 50 minimum.
    expect(computeWarrantyFee(50_000, DEFAULT_WARRANTY_CONFIG)).toBe(5_000);
  });

  it('maximum fee caps large jobs', () => {
    // 5% of PKR 50,000 is PKR 2,500 — capped at PKR 500.
    expect(computeWarrantyFee(5_000_000, DEFAULT_WARRANTY_CONFIG)).toBe(50_000);
  });

  it('flat fee is added before the caps', () => {
    const cfg = { ...DEFAULT_WARRANTY_CONFIG, fee_flat_paisa: 10_000, fee_rate: 0 };
    expect(computeWarrantyFee(100_000, cfg)).toBe(10_000);
    // Flat fee alone above the max is still capped.
    expect(computeWarrantyFee(100_000, { ...cfg, fee_flat_paisa: 99_000 })).toBe(50_000);
  });

  it('zero or negative price yields no fee', () => {
    expect(computeWarrantyFee(0, DEFAULT_WARRANTY_CONFIG)).toBe(0);
    expect(computeWarrantyFee(-100, DEFAULT_WARRANTY_CONFIG)).toBe(0);
  });

  it('admin config validation rejects bad values', () => {
    expect(() => validateWarrantyConfig({ fee_rate: 0.6 })).toThrow(RangeError);
    expect(() => validateWarrantyConfig({ fee_rate: -0.01 })).toThrow(RangeError);
    expect(() => validateWarrantyConfig({ fee_min_paisa: 1.5 })).toThrow(RangeError);
    expect(() => validateWarrantyConfig({ fee_min_paisa: 60_000, fee_max_paisa: 50_000 })).toThrow(RangeError);
    expect(() => validateWarrantyConfig({ claim_window_days: 0 })).toThrow(RangeError);
    expect(() => validateWarrantyConfig({ claim_window_days: 31 })).toThrow(RangeError);
    expect(() => validateWarrantyConfig({ fee_rate: 0.1, fee_min_paisa: 1_000, fee_max_paisa: 100_000, claim_window_days: 7 })).not.toThrow();
  });
});

describe('warranty claim window (pure)', () => {
  it('coverage ends exactly 7 days after completion', () => {
    const completed = new Date('2026-11-10T10:00:00.000Z');
    expect(coverageEndsAt(completed).toISOString()).toBe('2026-11-17T10:00:00.000Z');
  });

  it('a claim filed exactly at the deadline is in time; one second later is late', () => {
    const ends = new Date('2026-11-17T10:00:00.000Z');
    expect(isWithinClaimWindow(new Date('2026-11-17T10:00:00.000Z'), ends)).toBe(true);
    expect(isWithinClaimWindow(new Date('2026-11-17T10:00:00.001Z'), ends)).toBe(false);
  });

  it('day 8 after completion is outside the window', () => {
    const completed = new Date('2026-11-10T10:00:00.000Z');
    const ends = coverageEndsAt(completed);
    expect(isWithinClaimWindow(new Date('2026-11-18T10:00:00.000Z'), ends)).toBe(false);
  });
});

describe('warranty claim state machine (pure)', () => {
  it('the happy path is rework first, then close', () => {
    expect(isLegalClaimTransition('filed', 'under_review')).toBe(true);
    expect(isLegalClaimTransition('under_review', 'rework_offered')).toBe(true);
    expect(isLegalClaimTransition('rework_offered', 'rework_done')).toBe(true);
    expect(isLegalClaimTransition('rework_done', 'closed')).toBe(true);
  });

  it('refund requires a failed/refused rework first', () => {
    expect(isLegalClaimTransition('rework_failed', 'refunded')).toBe(true);
    expect(isLegalClaimTransition('filed', 'refunded')).toBe(false);
    expect(isLegalClaimTransition('under_review', 'refunded')).toBe(false);
    expect(isLegalClaimTransition('rework_offered', 'refunded')).toBe(false);
    expect(isLegalClaimTransition('rework_done', 'refunded')).toBe(false);
  });

  it('rejection is only possible before rework is offered', () => {
    expect(isLegalClaimTransition('filed', 'rejected')).toBe(true);
    expect(isLegalClaimTransition('under_review', 'rejected')).toBe(true);
    expect(isLegalClaimTransition('rework_offered', 'rejected')).toBe(false);
  });

  it('terminal states have no outgoing transitions', () => {
    for (const terminal of ['refunded', 'rejected', 'closed'] as const) {
      expect(legalNextClaimStates(terminal)).toEqual([]);
      expect(CLAIM_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('rework_failed is the only route to a refund', () => {
    expect(legalNextClaimStates('rework_failed')).toEqual(['refunded']);
    expect(legalNextClaimStates('rework_offered')).toEqual(['rework_done', 'rework_failed']);
  });
});

describe('WarrantyModule standalone wiring (no live DB)', () => {
  it('compiles with WarrantyModule alone (+ @Global DatabaseModule) and resolves the service', async () => {
    const mod = await Test.createTestingModule({ imports: [DatabaseModule, WarrantyModule] }).compile();
    const svc = mod.get(WarrantyService);
    expect(svc).toBeDefined();
    expect(typeof svc.optIn).toBe('function');
    expect(typeof svc.collectFee).toBe('function');
    expect(typeof svc.fileClaim).toBe('function');
    expect(typeof svc.approveRefund).toBe('function');
    expect(typeof svc.getRules).toBe('function');
    expect(typeof svc.providerBadge).toBe('function');
    await mod.close();
  });
});
