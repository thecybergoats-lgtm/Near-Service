// Single error shape for the whole API (PRD p.19):
// { "error": { "code": "...", "message": "...", "details": {} }, "request_id": "..." }
export class ApiError extends Error {
  /** retryAfterSeconds, when set, is emitted as a `Retry-After` header by
   *  the global exception filter (FIX 3: OTP lockout). */
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
export const Errors = {
  badRequest: (code: string, msg: string, details = {}) => new ApiError(400, code, msg, details),
  unauthorized: (msg = 'Unauthorized', code = 'UNAUTHORIZED') => new ApiError(401, code, msg),
  forbidden: (msg = 'Forbidden') => new ApiError(403, 'FORBIDDEN', msg),
  notFound: (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`),
  conflict: (code: string, msg: string, details = {}) => new ApiError(409, code, msg, details),
  rateLimited: (msg = 'Too many requests', code = 'RATE_LIMITED', retryAfterSeconds?: number) =>
    new ApiError(429, code, msg, {}, retryAfterSeconds),
  /** OTP verify lockout after too many failed codes (FIX 3): 429 OTP_LOCKED
   *  with Retry-After = seconds until the lock expires. */
  otpLocked: (retryAfterSeconds: number) =>
    new ApiError(429, 'OTP_LOCKED', 'Too many failed OTP attempts — try again later', { retry_after_seconds: retryAfterSeconds }, retryAfterSeconds),
  unprocessable: (code: string, msg: string, details = {}) => new ApiError(422, code, msg, details),
  illegalTransition: (from: string, to: string) => new ApiError(409, 'ILLEGAL_TRANSITION', `Illegal job transition ${from} -> ${to}`, { from, to }),
};
export function errorBody(err: ApiError, requestId: string) {
  return { error: { code: err.code, message: err.message, details: err.details }, request_id: requestId };
}
