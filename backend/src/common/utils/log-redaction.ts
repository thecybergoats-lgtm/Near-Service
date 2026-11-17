// Log redaction — FIX 15(b) (Stage 3).
//
// Secrets must never reach a log line or an error response: JWTs, OTP
// codes, passwords, tokens, CNIC numbers, payout accounts, API keys.
// Call redactSecrets() on any free-form string before logging it
// (unhandled-exception filter, push stub). Values that are secrets by
// construction (OTP codes, decrypted CNIC/payout fields) must not be
// logged at all — redaction is a safety net, not a licence to log them.
//
// What is redacted:
//   - JWTs (eyJ.<...>.<...>) -> [REDACTED_JWT]
//   - OTP / verification codes: code=123456, "code":"123456", otp: 123456
//     (4-8 digits in a code/otp context) -> [REDACTED_OTP]
//   - Key=value pairs for secret-bearing keys (password, token, secret,
//     cnic, payout_account, api_key, authorization, otp, access/refresh
//     token, hash) -> key=[REDACTED]
//   - Bare 13-digit CNIC-shaped numbers (xxxxx-xxxxxxx-x or 13 digits)
//     -> [REDACTED_CNIC]
// Phone numbers, user ids and request ids are NOT secrets and are kept,
// so logs stay debuggable.

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const OTP_CONTEXT_RE = /((?:otp|code|verification[_-]?code)\s*["':=]\s*["']?)\d{4,8}(["']?)/gi;
const SECRET_KEY_RE =
  /((?:password|passwd|pwd|token|secret|api[_-]?key|authorization|auth|otp|cnic|payout[_-]?account|access[_-]?token|refresh[_-]?token|hash)\s*["':=]\s*["']?)[^"'\s,}\]\[]+/gi;
const CNIC_RE = /\b\d{5}-\d{7}-\d\b|\b\d{13}\b/g;

/** Redact secrets from a log line / error string. Idempotent. */
export function redactSecrets(input: string): string {
  return input
    .replace(JWT_RE, '[REDACTED_JWT]')
    .replace(OTP_CONTEXT_RE, '$1[REDACTED_OTP]$2')
    .replace(SECRET_KEY_RE, '$1[REDACTED]')
    .replace(CNIC_RE, '[REDACTED_CNIC]');
}
