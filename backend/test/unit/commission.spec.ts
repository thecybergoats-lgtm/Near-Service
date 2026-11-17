import {
  clampCommissionRate,
  commissionRuleSpecificity,
  getCommissionBlockThresholdPaisa,
  isCommissionBlocked,
  isCommissionRateInBand,
  pickCommissionRule,
  resolveCommissionRateFromRules,
  CommissionRuleRow,
} from '../../src/common/utils/commission';
import { referralCodeFor } from '../../src/common/utils/referral';

const day = (s: string) => s;
function rule(partial: Partial<CommissionRuleRow> & { rate: number }): CommissionRuleRow {
  return { category_id: null, city_id: null, tier: null, valid_from: day('2026-01-01'), valid_to: null, is_promo: false, ...partial };
}

describe('commission engine', () => {
  it('most specific rule beats global (category+city+tier > category+city > category > global)', () => {
    const rules = [
      rule({ rate: 0.1 }), // global
      rule({ rate: 0.12, category_id: 'cat-1' }),
      rule({ rate: 0.08, category_id: 'cat-1', city_id: 'city-1' }),
      rule({ rate: 0.15, category_id: 'cat-1', city_id: 'city-1', tier: 1 }),
    ];
    const scope = { categoryId: 'cat-1', cityId: 'city-1', tier: 1 };
    expect(pickCommissionRule(rules, scope)?.rate).toBe(0.15);
    expect(pickCommissionRule(rules, { categoryId: 'cat-1', cityId: 'city-1' })?.rate).toBe(0.08);
    expect(pickCommissionRule(rules, { categoryId: 'cat-1' })?.rate).toBe(0.12);
    expect(pickCommissionRule(rules, {})?.rate).toBe(0.1);
    // city+tier beats bare category
    expect(pickCommissionRule(
      [rule({ rate: 0.12, category_id: 'cat-1' }), rule({ rate: 0.07, city_id: 'city-1', tier: 1 })],
      { categoryId: 'cat-1', cityId: 'city-1', tier: 1 },
    )?.rate).toBe(0.07);
    // category+tier beats city+tier
    expect(pickCommissionRule(
      [rule({ rate: 0.06, city_id: 'city-1', tier: 1 }), rule({ rate: 0.09, category_id: 'cat-1', tier: 1 })],
      { categoryId: 'cat-1', cityId: 'city-1', tier: 1 },
    )?.rate).toBe(0.09);
  });

  it('specificity weights follow the required order', () => {
    expect(commissionRuleSpecificity(rule({ rate: 0.1, category_id: 'c', city_id: 'x', tier: 1 }))).toBe(9);
    expect(commissionRuleSpecificity(rule({ rate: 0.1, category_id: 'c', city_id: 'x' }))).toBe(7);
    expect(commissionRuleSpecificity(rule({ rate: 0.1, category_id: 'c', tier: 1 }))).toBe(6);
    expect(commissionRuleSpecificity(rule({ rate: 0.1, city_id: 'x', tier: 1 }))).toBe(5);
    expect(commissionRuleSpecificity(rule({ rate: 0.1, category_id: 'c' }))).toBe(4);
    expect(commissionRuleSpecificity(rule({ rate: 0.1, city_id: 'x' }))).toBe(3);
    expect(commissionRuleSpecificity(rule({ rate: 0.1, tier: 1 }))).toBe(2);
    expect(commissionRuleSpecificity(rule({ rate: 0.1 }))).toBe(0);
  });

  it('ignores expired and not-yet-started rules', () => {
    const on = new Date('2026-11-17');
    const rules = [
      rule({ rate: 0.15, valid_to: '2026-11-01' }), // expired
      rule({ rate: 0.14, valid_from: '2026-12-01' }), // not started
      rule({ rate: 0.1 }),
    ];
    expect(pickCommissionRule(rules, {}, on)?.rate).toBe(0.1);
  });

  it('clamps rates to the 0.05–0.15 band', () => {
    expect(clampCommissionRate(0.03)).toBe(0.05);
    expect(clampCommissionRate(0.2)).toBe(0.15);
    expect(clampCommissionRate(0.1)).toBe(0.1);
    expect(isCommissionRateInBand(0.04)).toBe(false);
    expect(isCommissionRateInBand(0.16)).toBe(false);
    expect(isCommissionRateInBand(0.05)).toBe(true);
    expect(isCommissionRateInBand(0.15)).toBe(true);
    // A stored rule outside the band is clamped on resolve, never applied raw.
    expect(resolveCommissionRateFromRules([rule({ rate: 0.99 })], {})).toBe(0.15);
    expect(resolveCommissionRateFromRules([rule({ rate: 0.01 })], {})).toBe(0.05);
  });

  it('falls back to the default rate when no rule matches', () => {
    expect(resolveCommissionRateFromRules([], {}, 0.1)).toBe(0.1);
    expect(resolveCommissionRateFromRules([rule({ rate: 0.12, category_id: 'other' })], { categoryId: 'cat-1' }, 0.1)).toBe(0.1);
  });

  it('reads the block threshold from feature_flags, defaulting to -500000 paisa', async () => {
    const withFlag = { query: async () => ({ rows: [{ config: { value_paisa: -250000 } }] }) };
    expect(await getCommissionBlockThresholdPaisa(withFlag)).toBe(-250000);
    const missing = { query: async () => ({ rows: [] }) };
    expect(await getCommissionBlockThresholdPaisa(missing)).toBe(-500000);
    const malformed = { query: async () => ({ rows: [{ config: {} }] }) };
    expect(await getCommissionBlockThresholdPaisa(malformed)).toBe(-500000);
  });

  it('blocks a provider only when the wallet is below the threshold', () => {
    expect(isCommissionBlocked(-500001, -500000)).toBe(true);
    expect(isCommissionBlocked(-500000, -500000)).toBe(false); // at threshold: not blocked
    expect(isCommissionBlocked(0, -500000)).toBe(false);
    expect(isCommissionBlocked(1000, -500000)).toBe(false);
  });

  it('derives referral codes as NS- + first 8 hex chars of the user id', () => {
    expect(referralCodeFor('40000000-0001-4000-8000-000000000001')).toBe('NS-40000000');
    expect(referralCodeFor('abcdef12-0000-4000-8000-000000000000')).toBe('NS-ABCDEF12');
  });
});
