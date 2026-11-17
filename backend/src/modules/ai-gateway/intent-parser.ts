// Rule-based intent parser (pure — no DB, no provider, unit-tested).
//
// Input is ALREADY PII-redacted text. Output is the strict JSON the
// task requires: { service, quantity, urgency } plus the machine-readable
// fallback signal. On parse failure the parser does NOT throw: it returns
// service=null with fallback_to_keyword_search=true and the redacted text
// as search_query, so the caller silently falls back to the normal
// keyword search path (GET /search).

import { BUILTIN_ALIASES, CategoryAlias } from './providers/builtin-aliases';

export type Urgency = 'now' | 'today' | 'scheduled' | 'flexible';

export interface ParsedIntent {
  service: { category_id: string; category_slug: string; name_en: string } | null;
  /** Numeric quantity when the text states one (e.g. 20 kitabein). Null when unstated. */
  quantity: number | null;
  /** Unit word attached to the quantity when recognisable (books, rooms, ...). */
  quantityUnit: string | null;
  urgency: Urgency;
  /** 0..1 — 1.0 exact phrase match, lower for token-overlap matches. */
  confidence: number;
  /** True when no service could be identified: caller must keyword-search. */
  fallbackToKeywordSearch: boolean;
  /** Redacted text, for the keyword-search fallback. */
  searchQuery: string;
}

const URDU_DIGITS: Record<string, string> = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
const ARABIC_DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

const NUMBER_WORDS: Record<string, number> = {
  ek: 1, aik: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5,
  che: 6, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12,
  bees: 20, beees: 20, tees: 30, chalees: 40, pachas: 50, saath: 60,
  sattar: 70, assi: 80, nabbe: 90, sau: 100, hazaar: 1000,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, hundred: 100,
};

const URGENCY_PHRASES: Array<{ re: RegExp; urgency: Urgency }> = [
  { re: /foran|abhi|urgent|emergency|فوری|ابھی|جلدی|as soon as possible|aaj hi|turant/, urgency: 'now' },
  { re: /aaj|today|آج/, urgency: 'today' },
  { re: /kal|tomorrow|اگلے ہفتے|next week|hafte|weekend|hafta/, urgency: 'scheduled' },
];

const UNIT_WORDS = ['kitabein', 'kitab', 'kitaabein', 'kitaab', 'books', 'book', 'rooms', 'kamre', 'kamra', 'fans', 'switch', 'taps', 'nalke', 'suits', 'kapde', 'pages', 'copies', 'ac', 'units'];

/** Normalise for matching: lower-case, fold Urdu/Arabic digits to Latin,
 *  collapse whitespace. Urdu script is preserved (aliases carry it). */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .split('')
    .map((c) => URDU_DIGITS[c] ?? ARABIC_DIGITS[c] ?? c)
    .join('')
    .replace(/[\s_]+/g, ' ')
    .trim();
}

function extractQuantity(normalized: string): { quantity: number | null; unit: string | null } {
  const digitMatch = normalized.match(/\b(\d{1,5})\b/);
  if (digitMatch) {
    const q = Number(digitMatch[1]);
    const after = normalized.slice(digitMatch.index! + digitMatch[0].length).trim().split(' ')[0] ?? '';
    const unit = UNIT_WORDS.includes(after) ? after : null;
    return { quantity: q, unit };
  }
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    const m = normalized.match(new RegExp(`\\b${word}\\b\\s+(\\w+)`));
    if (m) return { quantity: value, unit: UNIT_WORDS.includes(m[1]) ? m[1] : null };
    if (new RegExp(`\\b${word}\\b`).test(normalized)) return { quantity: value, unit: null };
  }
  return { quantity: null, unit: null };
}

function detectUrgency(normalized: string): Urgency {
  for (const { re, urgency } of URGENCY_PHRASES) if (re.test(normalized)) return urgency;
  return 'flexible';
}

/** Score one category: exact alias phrase present (longest wins) else
 *  token overlap. Returns 0 when nothing matches. */
function scoreCategory(normalized: string, cat: CategoryAlias): number {
  let best = 0;
  for (const alias of cat.aliases) {
    const a = alias.toLowerCase();
    if (normalized.includes(a)) best = Math.max(best, 0.6 + Math.min(0.4, a.length / 25));
  }
  if (best > 0) return best;
  const tokens = new Set(normalized.split(' ').filter((t) => t.length > 2));
  let hits = 0;
  for (const alias of cat.aliases) {
    for (const tok of alias.toLowerCase().split(' ')) if (tokens.has(tok) && tok.length > 2) hits += 1;
  }
  return hits >= 2 ? 0.45 : 0;
}

export function parseIntentLocal(redactedText: string, aliases: CategoryAlias[] = BUILTIN_ALIASES): ParsedIntent {
  const normalized = normalizeText(redactedText);
  const { quantity, unit } = extractQuantity(normalized);
  const urgency = detectUrgency(normalized);
  let bestCat: CategoryAlias | null = null;
  let bestScore = 0;
  for (const cat of aliases) {
    const s = scoreCategory(normalized, cat);
    if (s > bestScore) { bestScore = s; bestCat = cat; }
  }
  const base = { quantity, quantityUnit: unit, urgency, searchQuery: redactedText.trim() };
  if (!bestCat || bestScore < 0.4) {
    return { ...base, service: null, confidence: 0, fallbackToKeywordSearch: true };
  }
  return {
    ...base,
    service: { category_id: bestCat.categoryId, category_slug: bestCat.slug, name_en: bestCat.nameEn },
    confidence: Math.round(bestScore * 100) / 100,
    fallbackToKeywordSearch: false,
  };
}
