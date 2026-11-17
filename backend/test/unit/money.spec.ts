import { pkrToPaisa, paisaToPkr, commissionPaisa, isValidPkrAmount } from '../../src/common/utils/money';
describe('money (paisa <-> PKR)', () => {
  it('converts PKR to paisa and back', () => {
    expect(pkrToPaisa(2400)).toBe(240000);
    expect(pkrToPaisa(2550.5)).toBe(255050);
    expect(paisaToPkr(240000)).toBe(2400);
  });
  it('computes 10% commission in paisa', () => {
    expect(commissionPaisa(255000, 0.1)).toBe(25500); // PKR 2,550 job
    expect(commissionPaisa(100, 0.1)).toBe(10);
  });
  it('validates PKR amounts', () => {
    expect(isValidPkrAmount(2400)).toBe(true);
    expect(isValidPkrAmount(0)).toBe(false);
    expect(isValidPkrAmount(-5)).toBe(false);
    expect(isValidPkrAmount(10.005)).toBe(false); // sub-paisa precision
  });
});
