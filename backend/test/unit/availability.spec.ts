// FIX 11 (Stage 3) — isOpenNow + weekday conversions.
// Clock is pinned with explicit Dates: Karachi is UTC+5, so Karachi
// Tue 2026-11-17 10:00 == UTC 05:00. Availability weekday 0=Monday.
import {
  isOpenNow,
  karachiDayParts,
  postgresDowToAvailabilityWeekday,
  availabilityWeekdayToPostgresDow,
  recurringDowToAvailabilityWeekday,
  availabilityWeekdayToRecurringDow,
  AvailabilitySlot,
} from '../../src/common/utils/availability';

const slot = (weekday: number, opens: string | null, closes: string | null, is_day_off = false): AvailabilitySlot =>
  ({ weekday, opens, closes, is_day_off });
/** Karachi Tue 2026-11-17 HH:MM as a Date (UTC = Karachi - 5h). */
const tue = (hh: number, mm = 0) => new Date(Date.UTC(2026, 10, 17, hh - 5, mm));
/** Karachi Mon 2026-11-16 HH:MM. */
const mon = (hh: number, mm = 0) => new Date(Date.UTC(2026, 10, 16, hh - 5, mm));

describe('weekday conversions (single source of truth)', () => {
  it('Postgres DOW (0=Sunday) -> availability weekday (0=Monday)', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(postgresDowToAvailabilityWeekday)).toEqual([6, 0, 1, 2, 3, 4, 5]);
  });
  it('availability weekday (0=Monday) -> Postgres DOW (0=Sunday)', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(availabilityWeekdayToPostgresDow)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
  it('recurring day_of_week uses the same Sunday-based numbering as Postgres DOW', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(recurringDowToAvailabilityWeekday)).toEqual([6, 0, 1, 2, 3, 4, 5]);
    expect([0, 1, 2, 3, 4, 5, 6].map(availabilityWeekdayToRecurringDow)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
  it('round-trips both ways', () => {
    for (let d = 0; d < 7; d++) {
      expect(availabilityWeekdayToPostgresDow(postgresDowToAvailabilityWeekday(d))).toBe(d);
      expect(postgresDowToAvailabilityWeekday(availabilityWeekdayToPostgresDow(d))).toBe(d);
    }
  });
  it('karachiDayParts: Tue 2026-11-17 10:00 PKT is weekday 1 (Tuesday)', () => {
    expect(karachiDayParts(tue(10))).toEqual({ weekday: 1, minutes: 600 });
  });
});

describe('isOpenNow (Asia/Karachi)', () => {
  const tueDay = [slot(1, '09:00', '21:00')]; // Tuesday 09:00-21:00
  it('a provider open now returns true', () => {
    expect(isOpenNow(tueDay, tue(10))).toBe(true);
    expect(isOpenNow(tueDay, tue(9))).toBe(true); // exactly at opens
    expect(isOpenNow(tueDay, tue(20, 59))).toBe(true);
  });
  it('a provider whose availability ended returns false', () => {
    expect(isOpenNow(tueDay, tue(21))).toBe(false); // exactly at closes
    expect(isOpenNow(tueDay, tue(22))).toBe(false);
    expect(isOpenNow(tueDay, tue(8, 59))).toBe(false);
  });
  it('a provider on a day-off returns false', () => {
    expect(isOpenNow([slot(1, null, null, true)], tue(10))).toBe(false);
    expect(isOpenNow([slot(1, '09:00', '21:00'), slot(1, null, null, true)], tue(10))).toBe(false);
  });
  it('a provider with no row for today returns false', () => {
    expect(isOpenNow([slot(0, '09:00', '21:00')], tue(10))).toBe(false); // Monday row only
    expect(isOpenNow([], tue(10))).toBe(false);
  });
  it('an overnight availability works (22:00-02:00)', () => {
    const overnight = [slot(0, '22:00', '02:00')]; // Monday 22:00 -> Tue 02:00
    expect(isOpenNow(overnight, mon(23))).toBe(true); // Mon 23:00
    expect(isOpenNow(overnight, mon(22))).toBe(true); // exactly at opens
    expect(isOpenNow(overnight, mon(21))).toBe(false); // before opens
    expect(isOpenNow(overnight, tue(1))).toBe(true); // Tue 01:00 tail
    expect(isOpenNow(overnight, tue(2))).toBe(false); // exactly at closes
    expect(isOpenNow(overnight, tue(3))).toBe(false);
  });
  it('a day-off overrides the overnight tail from the previous day', () => {
    const slots = [slot(0, '22:00', '02:00'), slot(1, null, null, true)];
    expect(isOpenNow(slots, tue(1))).toBe(false);
    expect(isOpenNow(slots, mon(23))).toBe(true); // Monday itself still open
  });
});
