import { fairRangeFromPrices, offerWarning, FAIR_RANGE_MIN_SAMPLE } from '../../src/common/utils/fair-range';
describe('fair-range percentiles (PRD p.7)', () => {
  it('returns p10/p50/p90 and hides when sample < 5', () => {
    const r = fairRangeFromPrices([2200, 2400, 2500, 2600, 2700, 3000, 2800, 2300]);
    expect(r.min).toBeLessThan(r.typical); expect(r.typical).toBeLessThan(r.max);
    expect(r.hidden).toBe(false); expect(r.sampleSize).toBe(8);
    const small = fairRangeFromPrices([2400, 2600]);
    expect(small.hidden).toBe(true);
    expect(FAIR_RANGE_MIN_SAMPLE).toBe(5);
  });
  it('warns below range and far above range', () => {
    const range = { min: 2200, typical: 2600, max: 3000, sampleSize: 42, hidden: false };
    expect(offerWarning(1500, range)).toBe('below_range');
    expect(offerWarning(2400, range)).toBe('within_range');
    expect(offerWarning(5000, range)).toBe('above_range');
    expect(offerWarning(null, range)).toBeNull();
  });
});
