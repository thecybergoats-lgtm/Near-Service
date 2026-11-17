// Commission engine (Phase 2) — PRD v1.1 p.18.
// Rules live in commission_rules; the most specific matching rule wins.
// Specificity order (highest first):
//   category+city+tier > category+city > category+tier > city+tier
//   > category > city > tier > global.
// Rates are clamped to the 0.05–0.15 band; rules outside the band are
// rejected at creation (admin endpoints) and clamped if read back.
export const COMMISSION_MIN_RATE = 0.05;
export const COMMISSION_MAX_RATE = 0.15;
/** Default block threshold: a provider whose wallet falls below this
 *  (paisa) cannot create new offers until they top up. -500000 paisa =
 *  -PKR 5,000. Overridable via feature_flags key
 *  'commission_block_threshold_paisa' (config.value_paisa). */
export const COMMISSION_BLOCK_THRESHOLD_PAISA_DEFAULT = -500000;

export function defaultCommissionRate(): number {
  const v = Number(process.env.COMMISSION_RATE_DEFAULT ?? 0.1);
  return Number.isFinite(v) ? v : 0.1;
}

export function clampCommissionRate(rate: number): number {
  return Math.min(COMMISSION_MAX_RATE, Math.max(COMMISSION_MIN_RATE, rate));
}

export function isCommissionRateInBand(rate: number): boolean {
  return Number.isFinite(rate) && rate >= COMMISSION_MIN_RATE && rate <= COMMISSION_MAX_RATE;
}

export interface CommissionRuleRow {
  id?: string;
  category_id?: string | null;
  city_id?: string | null;
  tier?: number | null;
  rate: number | string;
  valid_from: string | Date;
  valid_to?: string | Date | null;
  is_promo?: boolean;
}

export interface CommissionScope {
  categoryId?: string | null;
  cityId?: string | null;
  tier?: number | null;
}

// Weights chosen so the sort order is exactly the specificity order above:
// category(4) + city(3) + tier(2): 9 > 7 > 6 > 5 > 4 > 3 > 2 > 0.
export function commissionRuleSpecificity(rule: CommissionRuleRow): number {
  let s = 0;
  if (rule.category_id) s += 4;
  if (rule.city_id) s += 3;
  if (rule.tier !== null && rule.tier !== undefined) s += 2;
  return s;
}

function toDay(d: string | Date): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

export function isRuleValidOn(rule: CommissionRuleRow, on: Date = new Date()): boolean {
  const day = toDay(on);
  if (toDay(rule.valid_from) > day) return false;
  if (rule.valid_to && toDay(rule.valid_to) < day) return false;
  return true;
}

function ruleMatchesScope(rule: CommissionRuleRow, scope: CommissionScope): boolean {
  if (rule.category_id && rule.category_id !== scope.categoryId) return false;
  if (rule.city_id && rule.city_id !== scope.cityId) return false;
  if (rule.tier !== null && rule.tier !== undefined && rule.tier !== scope.tier) return false;
  return true;
}

/** Pick the single most specific valid rule for a scope, or null. */
export function pickCommissionRule(
  rules: CommissionRuleRow[],
  scope: CommissionScope,
  on: Date = new Date(),
): CommissionRuleRow | null {
  const candidates = rules.filter((r) => isRuleValidOn(r, on) && ruleMatchesScope(r, scope));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const spec = commissionRuleSpecificity(b) - commissionRuleSpecificity(a);
    if (spec !== 0) return spec;
    // Tie-break: most recently started rule wins.
    return toDay(b.valid_from).localeCompare(toDay(a.valid_from));
  });
  return candidates[0];
}

/** Resolve a rate from already-fetched rules; falls back to `fallback`
 *  (default env rate) when nothing matches. Result is always clamped. */
export function resolveCommissionRateFromRules(
  rules: CommissionRuleRow[],
  scope: CommissionScope,
  fallback: number = defaultCommissionRate(),
  on: Date = new Date(),
): number {
  const rule = pickCommissionRule(rules, scope, on);
  if (!rule) return clampCommissionRate(fallback);
  return clampCommissionRate(Number(rule.rate));
}

export type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** DB-backed resolver: fetches currently-valid rules and picks the most
 *  specific one for the scope. Used by offers accept (job snapshot). */
export async function resolveCommissionRate(client: QueryClient, scope: CommissionScope): Promise<number> {
  const rows = (await client.query(
    `SELECT category_id, city_id, tier, rate, valid_from, valid_to FROM commission_rules
     WHERE valid_from <= CURRENT_DATE AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`,
  )).rows as unknown as CommissionRuleRow[];
  return resolveCommissionRateFromRules(rows, scope);
}

/** Admin-set block threshold (paisa) from feature_flags, with default. */
export async function getCommissionBlockThresholdPaisa(client: QueryClient): Promise<number> {
  const row = (await client.query(
    `SELECT config FROM feature_flags WHERE key='commission_block_threshold_paisa'`,
  )).rows[0] as unknown as { config?: { value_paisa?: number } } | undefined;
  const v = row?.config?.value_paisa;
  return typeof v === 'number' && Number.isFinite(v) ? v : COMMISSION_BLOCK_THRESHOLD_PAISA_DEFAULT;
}

/** Pure block check: provider is blocked when balance is below threshold. */
export function isCommissionBlocked(balancePaisa: number, thresholdPaisa: number): boolean {
  return balancePaisa < thresholdPaisa;
}
