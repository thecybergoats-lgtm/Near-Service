// B2B tenders — pure domain logic (DB-free, unit-testable).
//
// Lead-fee choice (Phase 3, item 5): a FLAT lead fee of PKR 500 is charged
// ONCE, to the WINNING provider only, at acceptance, debited from their
// wallet as a balanced ledger pair (see tenders.service.ts). Losing quotes
// pay nothing, and tender jobs keep the normal commission rate resolved
// by the commission engine — no higher tender commission rate is used.

/** Flat tender lead fee, charged once to the winning provider at acceptance. */
export const TENDER_LEAD_FEE_PAISA = 50000; // PKR 500
export const TENDER_LEAD_FEE_PKR = 500;

export interface TenderItem {
  label: string;
  quantity: number;
  unit_price: number; // PKR, <= 2 decimals
  line_total: number; // PKR, must equal quantity * unit_price
}

export const MAX_TENDER_ITEMS = 100;
export const MAX_TENDER_QUANTITY = 100000;

/** PKR -> integer paisa (same rounding as common/utils/money). */
export function tenderPkrToPaisa(pkr: number): number {
  return Math.round(pkr * 100);
}

function isValidMoney(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v > 0 &&
    v <= 10_000_000 &&
    Math.round(v * 100) === v * 100
  );
}

/**
 * Validate an itemized quote. Returns null when valid, otherwise the
 * 422 error code the service throws (Errors.unprocessable maps these).
 *   EMPTY_ITEMS        — no items, or more than MAX_TENDER_ITEMS
 *   ITEM_INVALID       — bad label / quantity / money value on one line
 *   ITEM_LINE_MISMATCH — a line_total != quantity * unit_price
 *   ITEM_TOTAL_MISMATCH— sum(line_totals) != total_price
 */
export function validateQuoteItems(items: unknown, totalPrice: unknown): string | null {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_TENDER_ITEMS) return 'EMPTY_ITEMS';
  if (!isValidMoney(totalPrice)) return 'ITEM_INVALID';
  let sumPaisa = 0;
  for (const raw of items as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') return 'ITEM_INVALID';
    if (typeof raw.label !== 'string' || raw.label.trim().length === 0 || raw.label.length > 200) return 'ITEM_INVALID';
    if (typeof raw.quantity !== 'number' || !Number.isInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > MAX_TENDER_QUANTITY) return 'ITEM_INVALID';
    if (!isValidMoney(raw.unit_price) || !isValidMoney(raw.line_total)) return 'ITEM_INVALID';
    const expectedLinePaisa = tenderPkrToPaisa(Number(raw.quantity) * Number(raw.unit_price));
    if (tenderPkrToPaisa(Number(raw.line_total)) !== expectedLinePaisa) return 'ITEM_LINE_MISMATCH';
    sumPaisa += tenderPkrToPaisa(Number(raw.line_total));
  }
  if (sumPaisa !== tenderPkrToPaisa(Number(totalPrice))) return 'ITEM_TOTAL_MISMATCH';
  return null;
}

/** Sum of line totals, in paisa. Assumes items already validated. */
export function quoteItemsTotalPaisa(items: TenderItem[]): number {
  return items.reduce((s, i) => s + tenderPkrToPaisa(i.line_total), 0);
}
