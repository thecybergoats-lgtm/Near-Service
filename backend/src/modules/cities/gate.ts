// Go/no-go gate — pure evaluation (Phase 4, item 3: multi-city ops).
// A city opens only when supply density passes the go/no-go gate (PRD).
// The four metrics are computed from live tables by CitiesService
// (computeMetrics); this file decides pass/fail from numbers alone, so
// it is unit-testable with no database.

export interface GateThresholds {
  minProviders: number;
  minSupplyDensityPer100k: number;
  minFillRate: number;
  maxTimeToFirstOfferSeconds: number;
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  minProviders: 10,
  minSupplyDensityPer100k: 0.8,
  minFillRate: 0.5,
  maxTimeToFirstOfferSeconds: 900,
};

export interface GateMetrics {
  /** Providers with a base point inside the city's default radius. */
  providerCount: number;
  /** Providers per 100,000 residents; null when the city has no
   *  population estimate (a missing denominator cannot pass). */
  supplyDensityPer100k: number | null;
  /** Share of non-cancelled requests in the last 30 days (inside the
   *  city radius) that got at least one offer; null when there were no
   *  requests at all — no demand signal yet, so the gate cannot pass. */
  fillRate: number | null;
  /** Mean seconds from request creation to first offer, same window;
   *  null when no request ever got an offer. */
  timeToFirstOfferSeconds: number | null;
}

export type GateMetricKey =
  | 'provider_count'
  | 'supply_density'
  | 'fill_rate'
  | 'time_to_first_offer';

export interface GateMetricResult {
  value: number | null;
  threshold: number;
  passed: boolean;
  /** Why it failed, when it did — 'below_threshold' | 'above_threshold' | 'no_data'. */
  reason: string | null;
}

export interface GateEvaluation {
  passed: boolean;
  results: Record<GateMetricKey, GateMetricResult>;
}

/** A null metric is a FAIL, not a skip: a city with no requests has no
 *  evidence of fill rate or offer speed, and a city with no population
 *  estimate has no density denominator. The gate must not open a city
 *  on missing data. */
export function evaluateGate(metrics: GateMetrics, thresholds: GateThresholds): GateEvaluation {
  const results: Record<GateMetricKey, GateMetricResult> = {
    provider_count: {
      value: metrics.providerCount,
      threshold: thresholds.minProviders,
      passed: metrics.providerCount >= thresholds.minProviders,
      reason: metrics.providerCount >= thresholds.minProviders ? null : 'below_threshold',
    },
    supply_density: {
      value: metrics.supplyDensityPer100k,
      threshold: thresholds.minSupplyDensityPer100k,
      passed: metrics.supplyDensityPer100k != null && metrics.supplyDensityPer100k >= thresholds.minSupplyDensityPer100k,
      reason:
        metrics.supplyDensityPer100k == null
          ? 'no_data'
          : metrics.supplyDensityPer100k >= thresholds.minSupplyDensityPer100k
            ? null
            : 'below_threshold',
    },
    fill_rate: {
      value: metrics.fillRate,
      threshold: thresholds.minFillRate,
      passed: metrics.fillRate != null && metrics.fillRate >= thresholds.minFillRate,
      reason:
        metrics.fillRate == null
          ? 'no_data'
          : metrics.fillRate >= thresholds.minFillRate
            ? null
            : 'below_threshold',
    },
    time_to_first_offer: {
      value: metrics.timeToFirstOfferSeconds,
      threshold: thresholds.maxTimeToFirstOfferSeconds,
      passed: metrics.timeToFirstOfferSeconds != null && metrics.timeToFirstOfferSeconds <= thresholds.maxTimeToFirstOfferSeconds,
      reason:
        metrics.timeToFirstOfferSeconds == null
          ? 'no_data'
          : metrics.timeToFirstOfferSeconds <= thresholds.maxTimeToFirstOfferSeconds
            ? null
            : 'above_threshold',
    },
  };
  return { passed: Object.values(results).every((r) => r.passed), results };
}

// ---- City status lifecycle ----------------------------------------------
// planned -> in_preparation -> gate_review -> live -> paused -> gate_review
// (a paused city re-enters gate_review and must pass the gate again to
// go live). Going live is the only transition that needs a gate check;
// the service enforces that separately (latest evaluation must pass).

export type CityStatus = 'planned' | 'in_preparation' | 'gate_review' | 'live' | 'paused';

export const CITY_STATUSES: CityStatus[] = ['planned', 'in_preparation', 'gate_review', 'live', 'paused'];

const CITY_TRANSITIONS: Record<CityStatus, CityStatus[]> = {
  planned: ['in_preparation'],
  in_preparation: ['gate_review', 'planned'],
  gate_review: ['live', 'in_preparation'],
  live: ['paused'],
  paused: ['gate_review'],
};

export function isLegalCityTransition(from: CityStatus, to: CityStatus): boolean {
  return (CITY_TRANSITIONS[from] ?? []).includes(to);
}

export function legalCityTransitions(from: CityStatus): CityStatus[] {
  return [...(CITY_TRANSITIONS[from] ?? [])];
}
