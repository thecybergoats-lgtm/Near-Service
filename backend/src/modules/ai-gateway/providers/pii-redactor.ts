// PII redaction for the AI Gateway — HONESTY / SAFETY RULE (Phase 3).
//
// No CNIC or other sensitive PII is EVER sent to a model provider. Every
// free-text input is passed through redactPii() BEFORE it reaches any
// provider (local or remote). The local provider only ever sees redacted
// text; a future remote provider receives the same redacted text.
//
// Redacted (replaced with a [REDACTED_*] token, original never retained):
//   - CNIC: 35202-1234567-1 and bare 13-digit runs
//   - Pakistani mobile: 03xx-xxxxxxx, +92 3xx xxxxxxx
//   - Email addresses
//   - Passport-style numbers (2 letters + 7 digits, e.g. AB1234567)
// Phone numbers and CNICs are the PII this product actually collects
// (see src/common/utils/cnic.ts and log-redaction.ts); the regexes here
// are deliberately kept in sync with redactSecrets() in log-redaction.ts.

export type PiiKind = 'cnic' | 'phone' | 'email' | 'passport';

export interface RedactionResult {
  /** Text safe to hand to a provider (local or remote). */
  text: string;
  /** PII kinds found and removed, in first-seen order. Empty = clean input. */
  redacted: PiiKind[];
  /** True when anything was removed. */
  hadPii: boolean;
}

const CNIC_DASHED_RE = /\b\d{5}-\d{7}-\d\b/g;
const CNIC_BARE_RE = /\b\d{13}\b/g;
const PHONE_RE = /(?:\+92[\s-]?|0)3\d{2}[\s-]?\d{7}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PASSPORT_RE = /\b[A-Z]{2}\d{7}\b/g;

/** Redact sensitive PII from free text. Idempotent. Pure — unit-tested. */
export function redactPii(input: string): RedactionResult {
  const redacted: PiiKind[] = [];
  const mark = (kind: PiiKind) => {
    if (!redacted.includes(kind)) redacted.push(kind);
  };
  let text = input;
  text = text.replace(CNIC_DASHED_RE, () => { mark('cnic'); return '[REDACTED_CNIC]'; });
  text = text.replace(CNIC_BARE_RE, () => { mark('cnic'); return '[REDACTED_CNIC]'; });
  text = text.replace(PHONE_RE, () => { mark('phone'); return '[REDACTED_PHONE]'; });
  text = text.replace(EMAIL_RE, () => { mark('email'); return '[REDACTED_EMAIL]'; });
  text = text.replace(PASSPORT_RE, () => { mark('passport'); return '[REDACTED_PASSPORT]'; });
  return { text, redacted, hadPii: redacted.length > 0 };
}

/** Fail-closed guard for provider calls: throws if the text still looks
 *  like it contains a CNIC or phone number (e.g. a redactor bypass). */
export function assertNoPii(text: string): void {
  if (CNIC_DASHED_RE.test(text) || CNIC_BARE_RE.test(text) || PHONE_RE.test(text) || EMAIL_RE.test(text)) {
    throw new Error('PII detected in provider input — refusing to call provider');
  }
}
