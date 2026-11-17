// Provider "open now" — FIX 11 (Stage 3).
//
// SINGLE SOURCE OF TRUTH for weekday numbering in this repo. There are TWO
// different weekday conventions, and mixing them up sends customers to a
// provider who is off that day:
//
//   1. provider_availability.weekday (OpenAPI v1.2, AvailabilitySlot):
//      0 = Monday ... 6 = Sunday. This is also what the API accepts in
//      PUT /providers/me/availability and what the nearby query returns.
//   2. recurring_jobs.day_of_week (Postgres EXTRACT(DOW) / JS Date.getDay()):
//      0 = Sunday ... 6 = Saturday. Used ONLY by recurring jobs
//      (SchedulingService.advanceNextRun, which compares against
//      Date.getDay(), also 0=Sunday).
//
// The two are related by a +1 / -1 rotation, never by identity:
//   availabilityWeekday = (postgresDow + 6) % 7
//   postgresDow         = (availabilityWeekday + 1) % 7
// The nearby SQL used to do ((EXTRACT(DOW FROM now())+6)%7) inline; that
// conversion now lives here as postgresDowToAvailabilityWeekday() so there
// is exactly one place to get it right. The SQL open-now filter was also
// wrong in two more ways — it compared against the DATABASE server's local
// time, not Asia/Karachi, and it could never match an overnight slot
// (e.g. 22:00-02:00, where opens > closes). Open-now is therefore computed
// in TypeScript from the provider's availability rows, in Asia/Karachi.
//
// Day-off rule (documented choice): a slot with is_day_off=true closes the
// whole calendar day, including any overnight tail from the previous day's
// slot. A provider who marks Tuesday off is not bookable at Tuesday 01:00
// even if Monday's shift ran 22:00-02:00.

export const AVAILABILITY_TIMEZONE = 'Asia/Karachi';

export interface AvailabilitySlot {
  /** 0 = Monday ... 6 = Sunday (OpenAPI v1.2). */
  weekday: number;
  /** 'HH:MM' local time, null when is_day_off. */
  opens: string | null;
  /** 'HH:MM' local time, null when is_day_off. */
  closes: string | null;
  is_day_off: boolean;
}

/** Postgres EXTRACT(DOW) / JS getDay() (0=Sunday) -> availability weekday (0=Monday). */
export function postgresDowToAvailabilityWeekday(dow: number): number {
  return ((dow % 7) + 6) % 7;
}

/** Availability weekday (0=Monday) -> Postgres DOW / JS getDay() (0=Sunday). */
export function availabilityWeekdayToPostgresDow(weekday: number): number {
  return ((weekday % 7) + 1) % 7;
}

/** Recurring-job day_of_week (0=Sunday, same as Postgres DOW) -> availability weekday (0=Monday). */
export function recurringDowToAvailabilityWeekday(dow: number): number {
  return postgresDowToAvailabilityWeekday(dow);
}

/** Availability weekday (0=Monday) -> recurring-job day_of_week (0=Sunday). */
export function availabilityWeekdayToRecurringDow(weekday: number): number {
  return availabilityWeekdayToPostgresDow(weekday);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

const WEEKDAY_SHORT: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Karachi calendar day (0=Monday..6=Sunday) and minutes since midnight for `now`. */
export function karachiDayParts(now: Date): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: AVAILABILITY_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { weekday: WEEKDAY_SHORT[get('weekday')] ?? 0, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/**
 * Is the provider open NOW (Asia/Karachi) given their weekly availability
 * rows? Handles overnight slots (opens > closes, e.g. 22:00-02:00, which
 * also covers the after-midnight tail on the next calendar day) and
 * day-offs. A provider with no availability row for today is closed.
 * `now` defaults to the current time; pass it in tests to pin the clock.
 */
export function isOpenNow(slots: AvailabilitySlot[], now: Date = new Date()): boolean {
  const { weekday, minutes } = karachiDayParts(now);
  const byWeekday = new Map(slots.map((s) => [s.weekday, s]));
  const today = byWeekday.get(weekday);
  // A day-off closes the whole calendar day (see module doc above).
  if (today?.is_day_off) return false;
  const slotCovers = (slot: AvailabilitySlot | undefined, mins: number): boolean => {
    if (!slot || slot.is_day_off || !slot.opens || !slot.closes) return false;
    const opens = toMinutes(slot.opens);
    const closes = toMinutes(slot.closes);
    if (opens === closes) return false; // zero-length slot
    if (opens < closes) return mins >= opens && mins < closes;
    // Overnight: open from `opens` to midnight and from midnight to `closes`.
    return mins >= opens || mins < closes;
  };
  if (slotCovers(today, minutes)) return true;
  // After-midnight tail of yesterday's overnight slot.
  const yesterday = byWeekday.get((weekday + 6) % 7);
  if (yesterday && !yesterday.is_day_off && yesterday.opens && yesterday.closes) {
    const opens = toMinutes(yesterday.opens);
    const closes = toMinutes(yesterday.closes);
    if (opens > closes && minutes < closes) return true;
  }
  return false;
}
