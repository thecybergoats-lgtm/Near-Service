import { bayesianRating, rankScore, etaMinutes, RANKING_WEIGHTS } from '../../src/common/utils/ranking';
describe('ranking formula (PRD p.6)', () => {
  it('weights sum to 1.0', () => {
    const s = Object.values(RANKING_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(s).toBeCloseTo(1, 10);
  });
  it('Bayesian rating: a single 5-star job cannot outrank an established 4.7', () => {
    const rookie = bayesianRating(5, 1);
    const veteran = bayesianRating(4.7, 200);
    expect(rookie).toBeLessThan(veteran);
    expect(rookie).toBeCloseTo((3.8 * 10 + 5) / 11, 5);
    expect(bayesianRating(0, 0)).toBe(3.8); // prior with no jobs
  });
  it('nearer + better-rated + online provider scores higher', () => {
    const base = { maxRadiusKm: 5, ratingAvg: 4.5, jobsCompleted: 100, responseSecondsAvg: 120, completionRate: 0.97, tier: 2, startingPricePkr: 2000, fairTypicalPkr: 2500, isOnline: true, isOpenNow: true, cancellations: 0, noShows: 0, upheldDisputes: 0 };
    const near = rankScore({ ...base, distanceKm: 0.5 });
    const far = rankScore({ ...base, distanceKm: 4.5 });
    expect(near).toBeGreaterThan(far);
    const penalised = rankScore({ ...base, distanceKm: 0.5, noShows: 5, upheldDisputes: 3 });
    expect(penalised).toBeLessThan(near);
    expect(near).toBeGreaterThanOrEqual(0); expect(near).toBeLessThanOrEqual(1);
  });
  it('ETA scales with distance', () => {
    expect(etaMinutes(0)).toBe(5);
    expect(etaMinutes(10)).toBe(24);
  });
});
