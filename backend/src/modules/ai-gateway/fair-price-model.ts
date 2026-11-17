// Learned fair-price model (pure — unit-tested).
//
// Replaces/augments the existing percentile statistics
// (src/common/utils/fair-range.ts) with a small OLS regression trained on
// completed-job prices: price ~ intercept + per-unit coefficient, where
// the unit is the numeric spec of the job (e.g. number of books for
// book-binding, rooms for electrician work). A city offset is folded in
// by training one model per (category, city) bucket — the service groups
// samples that way before calling train().
//
// FALLBACK RULE (honest small-data behaviour): the model is used only
// when n >= MIN_SAMPLES_FOR_MODEL (8), the quantity varies across
// samples, and R² >= 0.30. Otherwise the caller MUST use the percentile
// range from fairRangeFromPrices() — a thin sample must never produce a
// confident-looking model price.

import { fairRangeFromPrices, FairRange } from '../../common/utils/fair-range';

export const MIN_SAMPLES_FOR_MODEL = 8;
export const MIN_MODEL_R2 = 0.3;

export interface PriceSample { price: number; quantity: number | null }
export interface FairPriceModel {
  intercept: number;
  perUnit: number;
  residualStd: number;
  rSquared: number;
  sampleSize: number;
}
export interface FairPriceEstimate {
  min: number; typical: number; max: number; sampleSize: number;
  source: 'model' | 'percentile';
  /** Present only when source is 'model'. */
  rSquared?: number;
  /** Present only when source is 'model'. */
  model?: { intercept: number; perUnit: number };
  hidden: boolean;
}

export function trainFairPriceModel(samples: PriceSample[]): FairPriceModel | null {
  const pts = samples.filter((s) => Number.isFinite(s.price) && s.price > 0 && s.quantity != null && Number.isFinite(s.quantity));
  if (pts.length < MIN_SAMPLES_FOR_MODEL) return null;
  const n = pts.length;
  const meanQ = pts.reduce((a, p) => a + p.quantity!, 0) / n;
  const meanP = pts.reduce((a, p) => a + p.price, 0) / n;
  const varQ = pts.reduce((a, p) => a + (p.quantity! - meanQ) ** 2, 0);
  if (varQ === 0) return null; // quantity never varies — no signal to learn
  const cov = pts.reduce((a, p) => a + (p.quantity! - meanQ) * (p.price - meanP), 0);
  const perUnit = cov / varQ;
  const intercept = meanP - perUnit * meanQ;
  const ssTot = pts.reduce((a, p) => a + (p.price - meanP) ** 2, 0);
  const ssRes = pts.reduce((a, p) => a + (p.price - (intercept + perUnit * p.quantity!)) ** 2, 0);
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  if (rSquared < MIN_MODEL_R2) return null;
  return { intercept, perUnit, residualStd: Math.sqrt(ssRes / Math.max(n - 2, 1)), rSquared, sampleSize: n };
}

function clampRound(v: number): number { return Math.max(0, Math.round(v)); }

/** Estimate a fair range for a requested quantity. Falls back to
 *  percentiles whenever the model cannot be trained (thin / flat / noisy
 *  data) — the percentile path is the existing, reviewed behaviour. */
export function estimateFairPrice(samples: PriceSample[], quantity: number | null): FairPriceEstimate {
  const prices = samples.map((s) => s.price);
  const percentile: FairRange = fairRangeFromPrices(prices);
  const model = trainFairPriceModel(samples);
  if (!model || quantity == null) {
    return { min: percentile.min, typical: percentile.typical, max: percentile.max, sampleSize: percentile.sampleSize, source: 'percentile', hidden: percentile.hidden };
  }
  const typical = clampRound(model.intercept + model.perUnit * quantity);
  const band = Math.round(1.28 * model.residualStd); // ~p10/p90 under normality
  return {
    min: clampRound(typical - band), typical, max: clampRound(typical + band),
    sampleSize: model.sampleSize, source: 'model',
    rSquared: Math.round(model.rSquared * 100) / 100,
    model: { intercept: Math.round(model.intercept), perUnit: Math.round(model.perUnit * 100) / 100 },
    hidden: model.sampleSize < 5,
  };
}
