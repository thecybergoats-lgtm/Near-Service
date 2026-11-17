// Provider ranking — PRD p.6. Weights are admin-configurable (feature_flags /
// commission config); defaults below. All component scores are 0..1.
export const RANKING_WEIGHTS = { w1: 0.3, w2: 0.22, w3: 0.13, w4: 0.13, w5: 0.1, w6: 0.07, w7: 0.05 };
export const BAYESIAN_PRIOR_RATING = 3.8;
export const BAYESIAN_PRIOR_JOBS = 10;

export function bayesianRating(ratingAvg: number, jobsCompleted: number, prior = BAYESIAN_PRIOR_RATING, priorJobs = BAYESIAN_PRIOR_JOBS): number {
  const n = Math.max(0, jobsCompleted);
  return (prior * priorJobs + ratingAvg * n) / (priorJobs + n);
}
export interface RankingInput {
  distanceKm: number; maxRadiusKm: number;
  ratingAvg: number; jobsCompleted: number;
  responseSecondsAvg: number | null;
  completionRate: number | null; // 0..1
  tier: number; // 0..3
  startingPricePkr: number | null; fairTypicalPkr: number | null;
  isOnline: boolean; isOpenNow: boolean;
  cancellations: number; noShows: number; upheldDisputes: number;
  weights?: Partial<typeof RANKING_WEIGHTS>;
}
export function rankScore(input: RankingInput): number {
  const w = { ...RANKING_WEIGHTS, ...(input.weights ?? {}) };
  const proximity = Math.max(0, 1 - input.distanceKm / Math.max(1, input.maxRadiusKm));
  const rating = bayesianRating(input.ratingAvg, input.jobsCompleted) / 5;
  const response = input.responseSecondsAvg == null ? 0.5 : Math.max(0, 1 - Math.min(input.responseSecondsAvg, 1800) / 1800);
  const completion = input.completionRate ?? 0.8;
  const tier = Math.min(3, Math.max(0, input.tier)) / 3;
  let price = 0.5;
  if (input.startingPricePkr != null && input.fairTypicalPkr != null && input.fairTypicalPkr > 0) {
    const ratio = input.startingPricePkr / input.fairTypicalPkr;
    price = ratio <= 1 ? 1 - ratio * 0.3 : Math.max(0, 1 - (ratio - 1) * 1.5);
  }
  const availability = input.isOnline && input.isOpenNow ? 1 : input.isOnline ? 0.6 : 0;
  const penalties = Math.min(0.5, input.cancellations * 0.02 + input.noShows * 0.05 + input.upheldDisputes * 0.08);
  return Math.max(0, w.w1 * proximity + w.w2 * rating + w.w3 * response + w.w4 * completion + w.w5 * tier + w.w6 * price + w.w7 * availability - penalties);
}
export function etaMinutes(distanceKm: number, avgSpeedKmh = 25): number {
  return Math.max(5, Math.round((distanceKm / avgSpeedKmh) * 60));
}
