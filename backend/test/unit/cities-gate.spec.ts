// Multi-city ops — unit tests for the pure gate + lifecycle (Phase 4, item 3).
// No database: evaluateGate / isLegalCityTransition are pure functions.
import {
  evaluateGate,
  isLegalCityTransition,
  legalCityTransitions,
  DEFAULT_GATE_THRESHOLDS,
  GateMetrics,
} from '../../src/modules/cities/gate';

const PASSING: GateMetrics = {
  providerCount: 12,
  supplyDensityPer100k: 1.0,
  fillRate: 0.667,
  timeToFirstOfferSeconds: 240,
};
const FAILING_KARACHI_SEED: GateMetrics = {
  providerCount: 3,
  supplyDensityPer100k: 0.019,
  fillRate: null,
  timeToFirstOfferSeconds: null,
};

describe('evaluateGate', () => {
  it('passes when every metric meets its threshold', () => {
    const out = evaluateGate(PASSING, DEFAULT_GATE_THRESHOLDS);
    expect(out.passed).toBe(true);
    expect(out.results.provider_count.passed).toBe(true);
    expect(out.results.supply_density.passed).toBe(true);
    expect(out.results.fill_rate.passed).toBe(true);
    expect(out.results.time_to_first_offer.passed).toBe(true);
  });

  it('fails at the boundary: one provider short of the target', () => {
    const out = evaluateGate({ ...PASSING, providerCount: 9 }, DEFAULT_GATE_THRESHOLDS);
    expect(out.passed).toBe(false);
    expect(out.results.provider_count).toMatchObject({ value: 9, threshold: 10, passed: false, reason: 'below_threshold' });
    expect(out.results.fill_rate.passed).toBe(true);
  });

  it('fails when fill rate is below the threshold', () => {
    const out = evaluateGate({ ...PASSING, fillRate: 0.4 }, DEFAULT_GATE_THRESHOLDS);
    expect(out.passed).toBe(false);
    expect(out.results.fill_rate.reason).toBe('below_threshold');
  });

  it('fails when time to first offer exceeds the threshold', () => {
    const out = evaluateGate({ ...PASSING, timeToFirstOfferSeconds: 901 }, DEFAULT_GATE_THRESHOLDS);
    expect(out.passed).toBe(false);
    expect(out.results.time_to_first_offer.reason).toBe('above_threshold');
  });

  it('fails on missing data: null fill rate / time-to-first-offer is a fail, not a skip', () => {
    const out = evaluateGate(FAILING_KARACHI_SEED, DEFAULT_GATE_THRESHOLDS);
    expect(out.passed).toBe(false);
    expect(out.results.provider_count.passed).toBe(false);
    expect(out.results.supply_density).toMatchObject({ value: 0.019, passed: false, reason: 'below_threshold' });
    expect(out.results.fill_rate).toMatchObject({ value: null, passed: false, reason: 'no_data' });
    expect(out.results.time_to_first_offer).toMatchObject({ value: null, passed: false, reason: 'no_data' });
  });

  it('fails when the population estimate is missing (density has no denominator)', () => {
    const out = evaluateGate({ ...PASSING, supplyDensityPer100k: null }, DEFAULT_GATE_THRESHOLDS);
    expect(out.passed).toBe(false);
    expect(out.results.supply_density.reason).toBe('no_data');
  });

  it('honours a per-city threshold override', () => {
    const strict = { ...DEFAULT_GATE_THRESHOLDS, minProviders: 20 };
    expect(evaluateGate(PASSING, strict).passed).toBe(false);
    const lax = { ...DEFAULT_GATE_THRESHOLDS, minProviders: 5, minFillRate: 0.1, minSupplyDensityPer100k: 0.01 };
    expect(evaluateGate({ ...FAILING_KARACHI_SEED, fillRate: 0.5, timeToFirstOfferSeconds: 100 }, lax).passed).toBe(false);
    // 3 providers still < 5 — the override alone does not fake a pass.
    expect(evaluateGate({ ...PASSING, providerCount: 6 }, lax).passed).toBe(true);
  });
});

describe('city status lifecycle', () => {
  it('allows the launch path planned -> in_preparation -> gate_review -> live', () => {
    expect(isLegalCityTransition('planned', 'in_preparation')).toBe(true);
    expect(isLegalCityTransition('in_preparation', 'gate_review')).toBe(true);
    expect(isLegalCityTransition('gate_review', 'live')).toBe(true);
  });

  it('allows live -> paused -> gate_review (re-entry must pass the gate again)', () => {
    expect(isLegalCityTransition('live', 'paused')).toBe(true);
    expect(isLegalCityTransition('paused', 'gate_review')).toBe(true);
  });

  it('rejects skips and backwards jumps', () => {
    expect(isLegalCityTransition('planned', 'live')).toBe(false);
    expect(isLegalCityTransition('planned', 'gate_review')).toBe(false);
    expect(isLegalCityTransition('in_preparation', 'live')).toBe(false);
    expect(isLegalCityTransition('live', 'gate_review')).toBe(false);
    expect(isLegalCityTransition('live', 'planned')).toBe(false);
    expect(isLegalCityTransition('paused', 'live')).toBe(false);
    expect(isLegalCityTransition('gate_review', 'paused')).toBe(false);
  });

  it('lists the legal next states', () => {
    expect(legalCityTransitions('gate_review')).toEqual(['live', 'in_preparation']);
    expect(legalCityTransitions('live')).toEqual(['paused']);
  });
});
