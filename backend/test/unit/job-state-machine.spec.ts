import { isLegalTransition, legalNextStates } from '../../src/common/utils/job-state-machine';
describe('job state machine (PRD p.8)', () => {
  it('allows the happy path', () => {
    const path = ['DRAFT','BROADCASTING','OFFERS_RECEIVED','ACCEPTED','PROVIDER_EN_ROUTE','ARRIVED','IN_PROGRESS','COMPLETED','PAYMENT_SETTLED','RATED'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(isLegalTransition(path[i], path[i + 1])).toBe(true);
  });
  it('allows the price-adjustment loop and pickup flow', () => {
    expect(isLegalTransition('IN_PROGRESS','PRICE_ADJUSTMENT_PENDING')).toBe(true);
    expect(isLegalTransition('PRICE_ADJUSTMENT_PENDING','IN_PROGRESS')).toBe(true);
    expect(isLegalTransition('ACCEPTED','ITEM_PICKED_UP')).toBe(true);
    expect(isLegalTransition('ITEM_PICKED_UP','IN_PROGRESS')).toBe(true);
  });
  it('rejects illegal transitions', () => {
    expect(isLegalTransition('DRAFT','COMPLETED')).toBe(false);
    expect(isLegalTransition('RATED','IN_PROGRESS')).toBe(false);
    expect(isLegalTransition('COMPLETED','ACCEPTED')).toBe(false);
    expect(isLegalTransition('PAYMENT_SETTLED','IN_PROGRESS')).toBe(false);
    expect(isLegalTransition('CANCELLED_BY_CUSTOMER','ACCEPTED')).toBe(false);
  });
  it('terminal states have no outgoing transitions', () => {
    expect(legalNextStates('RATED')).toEqual([]);
    expect(legalNextStates('REFUNDED')).toEqual([]);
  });
});
