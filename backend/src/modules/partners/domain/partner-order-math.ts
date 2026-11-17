// Partner order domain — pure functions, no DB (Phase 4, item 5).
// State machine, line validation, totals, affiliate fee, disclosure text.
// Unit-tested in backend/test/unit/partners.spec.ts.

export type PartnerOrderStatus = 'placed' | 'confirmed' | 'delivered' | 'cancelled';

/** Strict state machine: placed -> confirmed -> delivered, either of
 *  placed/confirmed -> cancelled. Delivered and cancelled are terminal. */
const TRANSITIONS: Record<PartnerOrderStatus, PartnerOrderStatus[]> = {
  placed: ['confirmed', 'cancelled'],
  confirmed: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

export function isLegalPartnerOrderTransition(from: PartnerOrderStatus, to: PartnerOrderStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function legalNextPartnerOrderStates(from: PartnerOrderStatus): PartnerOrderStatus[] {
  return [...(TRANSITIONS[from] ?? [])];
}

export interface CatalogLine {
  catalog_item_id: string;
  quantity: number;
  /** Client-supplied price, when present, must equal the catalog price. */
  unit_price_pkr?: number;
  line_total_pkr?: number;
}

export interface PricedLine {
  catalog_item_id: string;
  partner_id: string;
  quantity: number;
  unit_price_paisa: number;
  line_total_paisa: number;
}

export interface CatalogPrice {
  id: string;
  partner_id: string;
  unit_price_paisa: number;
  stock_qty: number;
  is_active: boolean;
}

/**
 * Validate order lines against catalog prices. Returns an error code
 * (or null when valid) — the service maps the code to a 422/409 ApiError.
 * Checks, in order: non-empty lines, integer quantity 1..100, item known
 * + active, single partner across all lines, client price (when given)
 * equals catalog price, client line total (when given) equals qty*price,
 * client order total (when given) equals the sum of lines, stock covers
 * the quantity.
 */
export function validateOrderLines(
  lines: CatalogLine[],
  prices: Map<string, CatalogPrice>,
  totalPkr?: number,
): string | null {
  if (!Array.isArray(lines) || lines.length === 0) return 'EMPTY_ITEMS';
  if (lines.length > 20) return 'TOO_MANY_ITEMS';
  const partnerIds = new Set<string>();
  let totalPaisa = 0;
  for (const line of lines) {
    if (!line || typeof line.catalog_item_id !== 'string' || !line.catalog_item_id) return 'ITEM_INVALID';
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 100) return 'ITEM_INVALID';
    const price = prices.get(line.catalog_item_id);
    if (!price) return 'ITEM_NOT_FOUND';
    if (!price.is_active) return 'ITEM_INACTIVE';
    partnerIds.add(price.partner_id);
    if (line.unit_price_pkr !== undefined) {
      if (typeof line.unit_price_pkr !== 'number' || Math.round(line.unit_price_pkr * 100) !== price.unit_price_paisa) {
        return 'PRICE_MISMATCH';
      }
    }
    const lineTotal = line.quantity * price.unit_price_paisa;
    if (line.line_total_pkr !== undefined && Math.round(line.line_total_pkr * 100) !== lineTotal) {
      return 'LINE_TOTAL_MISMATCH';
    }
    if (line.quantity > price.stock_qty) return 'INSUFFICIENT_STOCK';
    totalPaisa += lineTotal;
  }
  if (partnerIds.size > 1) return 'MIXED_PARTNERS';
  if (totalPkr !== undefined && Math.round(totalPkr * 100) !== totalPaisa) return 'ORDER_TOTAL_MISMATCH';
  return null;
}

/** Price lines from the catalog (server-side pricing — the client never
 *  sets prices) and total them. Call only after validateOrderLines. */
export function priceOrderLines(lines: CatalogLine[], prices: Map<string, CatalogPrice>): { priced: PricedLine[]; total_paisa: number } {
  const priced = lines.map((line) => {
    const price = prices.get(line.catalog_item_id)!;
    return {
      catalog_item_id: line.catalog_item_id,
      partner_id: price.partner_id,
      quantity: line.quantity,
      unit_price_paisa: price.unit_price_paisa,
      line_total_paisa: line.quantity * price.unit_price_paisa,
    };
  });
  return { priced, total_paisa: priced.reduce((s, l) => s + l.line_total_paisa, 0) };
}

/** Affiliate fee in paisa: round(total * rate), half-up. */
export function affiliateFeePaisa(totalPaisa: number, rate: number): number {
  return Math.round(totalPaisa * rate);
}

/** The disclosure shown on every partner order and on the job's
 *  partner-orders view — customer and provider see the same text. */
export function partnerDisclosureText(partnerName: string, feePkr: number): string {
  return (
    `Partner order — parts for this job were supplied by ${partnerName} through Near Service. ` +
    `This is an affiliate order: Near Service may earn an affiliate fee of PKR ${feePkr} on this order. ` +
    `The fee is charged to the provider, not to the customer, and does not change the job price.`
  );
}
