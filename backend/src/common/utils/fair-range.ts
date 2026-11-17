// Fair-price range — PRD p.7: percentile statistics over accepted/completed
// job prices for (category, city, spec set). Hidden client-side when the
// sample is too small (sample_size < MIN_SAMPLE).
export const FAIR_RANGE_MIN_SAMPLE = 5;
export interface FairRange { min: number; typical: number; max: number; sampleSize: number; hidden: boolean }
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
export function fairRangeFromPrices(pricesPkr: number[]): FairRange {
  const sorted = [...pricesPkr].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const sampleSize = sorted.length;
  if (sampleSize === 0) return { min: 0, typical: 0, max: 0, sampleSize, hidden: true };
  const min = Math.round(percentile(sorted, 10));
  const typical = Math.round(percentile(sorted, 50));
  const max = Math.round(percentile(sorted, 90));
  return { min, typical, max, sampleSize, hidden: sampleSize < FAIR_RANGE_MIN_SAMPLE };
}
export function offerWarning(customerOfferPkr: number | null, range: FairRange): 'below_range' | 'above_range' | 'within_range' | null {
  if (customerOfferPkr == null || range.hidden) return null;
  if (customerOfferPkr < range.min) return 'below_range';
  if (customerOfferPkr > range.max * 1.25) return 'above_range';
  return 'within_range';
}
