// CORS options — FIX 12 (Stage 3).
//
// The allowlist comes from env CORS_ORIGINS (comma-separated origins, e.g.
// "https://admin.nearservice.pk,http://localhost:3001"). Rules:
//   - Non-empty allowlist: only those origins get Access-Control-Allow-Origin.
//   - Empty allowlist in PRODUCTION: NO browser origin is allowed
//     (origin: false). A production deploy with no allowlist configured is
//     closed to browsers by default, never open.
//   - Empty allowlist outside production: allow all (old behaviour), so
//     local dev / tests keep working without config.
// Credentials are allowed only for listed origins (never with origin: true
// in production, where origin is false anyway).
import type { Env } from './env';

export interface CorsOptions {
  origin: boolean | string[];
  credentials: boolean;
}

export function buildCorsOptions(env: Env): CorsOptions {
  if (env.corsOrigins.length > 0) {
    return { origin: env.corsOrigins, credentials: true };
  }
  if (env.isProduction) {
    return { origin: false, credentials: false };
  }
  return { origin: true, credentials: false };
}
