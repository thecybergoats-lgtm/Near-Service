// Pure CSV helpers for the analytics warehouse exports (Phase 4, item 2).
// No database access here — unit-tested without Postgres.

/** Legal-review disclaimer stamped on every warehouse CSV export
 *  (PRD v1.1 p.32: monthly statements / tax-ready exports are generated
 *  from the ledger, designed for FBR/PRA/SRB reporting subject to legal
 *  review). It is emitted as `#`-comment lines at the top of the file so
 *  it is visible in any viewer without becoming a data row. */
export const ANALYTICS_CSV_DISCLAIMER =
  'SUBJECT TO LEGAL REVIEW — figures are derived from the Near Service analytics warehouse ' +
  '(operational data as of the last ETL run) and are NOT a tax filing. ' +
  'Verify with Finance / legal counsel before submitting to FBR, PRA, SRB or any other authority.';

/** Escape one CSV cell (RFC 4180): quote when it contains a comma, quote,
 *  newline or leading/trailing space; double any embedded quotes. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(s) || s !== s.trim()) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Render rows as CSV text. `columns` fixes the column order (and the
 *  header when rows is empty); without it the header comes from the
 *  first row's keys. */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? (rows.length ? Object.keys(rows[0]) : []);
  const lines = [cols.map(csvEscape).join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvEscape(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Full export file: disclaimer comment lines, then the CSV body. */
export function toCsvExport(rows: Record<string, unknown>[], columns?: string[]): string {
  const disclaimer = ANALYTICS_CSV_DISCLAIMER.split(' — ')
    .map((part) => `# ${part}`)
    .join('\r\n');
  return `${disclaimer}\r\n${toCsv(rows, columns)}`;
}

/** Funnel rates from stage counts. Pure so the dashboard math is
 *  unit-testable; the service only supplies the counts. */
export function funnelRates(stages: {
  requests: number;
  withOffers: number;
  accepted: number;
  completed: number;
  rated: number;
}): {
  requests: number;
  withOffers: number;
  accepted: number;
  completed: number;
  rated: number;
  offerRate: number;
  fillRate: number;
  completionRate: number;
  ratingRate: number;
} {
  const { requests, withOffers, accepted, completed, rated } = stages;
  const rate = (num: number, den: number) => (den > 0 ? num / den : 0);
  return {
    requests,
    withOffers,
    accepted,
    completed,
    rated,
    offerRate: rate(withOffers, requests),
    fillRate: rate(accepted, requests),
    completionRate: rate(completed, accepted),
    ratingRate: rate(rated, completed),
  };
}
