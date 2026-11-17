// Single source of truth for ALL environment configuration (Stage 1, FIX 5).
// Imported first by main.ts: validation runs once at boot and the process
// EXITS with a clear message if production config is missing/invalid.
// Dev/test defaults exist ONLY when NODE_ENV is not 'production' — there are
// no hard-coded dev-secret fallbacks anywhere in src/ (enforced by CI grep).
// All JWT secret readers (AuthService, JwtAuthGuard, RealtimeGateway) and
// the CNIC pepper reader must use this module, never process.env directly.
import { z } from 'zod';

const DEV_ACCESS_SECRET = 'dev-only-access-secret-not-for-production-01';
const DEV_REFRESH_SECRET = 'dev-only-refresh-secret-not-for-production-02';
const DEV_CNIC_PEPPER = 'dev-only-cnic-pepper-not-for-production-03';
const DEV_OTP_HASH_SECRET = 'dev-only-otp-hash-secret-not-for-production-04';
// Dev-only field-encryption key: base64 of 32 ASCII '0' bytes. NEVER used in
// production (production requires FIELD_ENCRYPTION_KEY to be set).
const DEV_FIELD_KEY_B64 = Buffer.from('0'.repeat(32)).toString('base64');

const secretField = (name: string) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .refine((s) => !s.toLowerCase().includes('change-me'), `${name} must not contain "change-me"`);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).optional(),
    JWT_ACCESS_SECRET: z.string().optional(),
    JWT_REFRESH_SECRET: z.string().optional(),
    CNIC_PEPPER: z.string().optional(),
    OTP_HASH_SECRET: z.string().optional(),
    FIELD_ENCRYPTION_KEY: z.string().optional(),
    FIELD_ENCRYPTION_KEY_V2: z.string().optional(),
    OTP_DEV_MODE: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    OTP_MAX_ATTEMPTS_PER_PHONE_PER_HOUR: z.coerce.number().int().positive().default(5),
    // FIX 9 (Stage 2): per-endpoint rate limits (fixed windows). The guard
    // reads these through env.rateLimits; each has a sane production
    // default, so existing deploys/tests need no new config. SOS is
    // deliberately high (30/min) — throttled, never fully blocked.
    RATE_LIMIT_OTP_REQUEST_PER_HOUR: z.coerce.number().int().positive().default(5),
    RATE_LIMIT_OTP_VERIFY_PER_HOUR: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_REFRESH_PER_HOUR: z.coerce.number().int().positive().default(30),
    RATE_LIMIT_SEARCH_PER_MINUTE: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_NEARBY_PER_MINUTE: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_CREATE_REQUEST_PER_HOUR: z.coerce.number().int().positive().default(30),
    RATE_LIMIT_OFFERS_PER_HOUR: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_REPORTS_PER_HOUR: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_BLOCKS_PER_HOUR: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_SOS_PER_MINUTE: z.coerce.number().int().positive().default(30),
    // Phase 4, item 1 (search scale-out): validated here; search.config.ts
    // reads the same keys from process.env with identical defaults, so
    // the feature works even before this validation landed.
    SEARCH_PROVIDER: z.enum(['trigram', 'scaled']).default('trigram'),
    SEARCH_SERVICE_URL: z.string().optional(),
    SEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(120),
    SEARCH_CACHE_ENABLED: z
      .string()
      .optional()
      .transform((v) => v !== 'false'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
    STORAGE_UPLOAD_BASE_URL: z.string().optional(),
    PAYMENT_GATEWAY_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
    // FIX 12 (Stage 3): CORS allowlist, comma-separated origins
    // (e.g. "https://admin.nearservice.pk,http://localhost:3001"). Empty
    // in production means NO browser origin is allowed (see config/cors.ts).
    CORS_ORIGINS: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const prod = v.NODE_ENV === 'production';
    const requireField = (value: string | undefined, name: string) => {
      if (prod && !value) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} is REQUIRED in production` });
      }
    };
    requireField(v.DATABASE_URL, 'DATABASE_URL');
    requireField(v.REDIS_URL, 'REDIS_URL');
    for (const [value, name] of [
      [v.JWT_ACCESS_SECRET, 'JWT_ACCESS_SECRET'],
      [v.JWT_REFRESH_SECRET, 'JWT_REFRESH_SECRET'],
      [v.CNIC_PEPPER, 'CNIC_PEPPER'],
      [v.OTP_HASH_SECRET, 'OTP_HASH_SECRET'],
      [v.FIELD_ENCRYPTION_KEY, 'FIELD_ENCRYPTION_KEY'],
    ] as const) {
      requireField(value, name);
      if (value !== undefined) {
        if (value.length < 32) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} must be at least 32 characters` });
        }
        if (value.toLowerCase().includes('change-me')) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} must not contain "change-me"` });
        }
      }
    }
    if (v.JWT_ACCESS_SECRET && v.JWT_REFRESH_SECRET && v.JWT_ACCESS_SECRET === v.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
      });
    }
    if (v.FIELD_ENCRYPTION_KEY !== undefined) {
      try {
        if (Buffer.from(v.FIELD_ENCRYPTION_KEY, 'base64').length !== 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['FIELD_ENCRYPTION_KEY'],
            message: 'FIELD_ENCRYPTION_KEY must be base64 of exactly 32 bytes',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FIELD_ENCRYPTION_KEY'],
          message: 'FIELD_ENCRYPTION_KEY must be valid base64',
        });
      }
    }
    if (v.FIELD_ENCRYPTION_KEY_V2 !== undefined) {
      try {
        if (Buffer.from(v.FIELD_ENCRYPTION_KEY_V2, 'base64').length !== 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['FIELD_ENCRYPTION_KEY_V2'],
            message: 'FIELD_ENCRYPTION_KEY_V2 must be base64 of exactly 32 bytes',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FIELD_ENCRYPTION_KEY_V2'],
          message: 'FIELD_ENCRYPTION_KEY_V2 must be valid base64',
        });
      }
    }
  })
  .transform((v) => {
    const prod = v.NODE_ENV === 'production';
    // Dev defaults apply ONLY outside production.
    const fieldKey = (b64: string | undefined, devB64: string): Buffer =>
      b64 ? Buffer.from(b64, 'base64') : Buffer.from(devB64, 'base64');
    return {
      nodeEnv: v.NODE_ENV,
      isProduction: prod,
      port: v.PORT,
      databaseUrl: v.DATABASE_URL,
      redisUrl: v.REDIS_URL,
      jwtAccessSecret: v.JWT_ACCESS_SECRET ?? (prod ? '' : DEV_ACCESS_SECRET),
      jwtRefreshSecret: v.JWT_REFRESH_SECRET ?? (prod ? '' : DEV_REFRESH_SECRET),
      cnicPepper: v.CNIC_PEPPER ?? (prod ? '' : DEV_CNIC_PEPPER),
      otpHashSecret: v.OTP_HASH_SECRET ?? (prod ? '' : DEV_OTP_HASH_SECRET),
      // OTP dev mode: defaults to false. Even an explicit 'true' is
      // neutralised in production by callers (codes are never logged there).
      otpDevMode: v.OTP_DEV_MODE,
      otpTtlSeconds: v.OTP_TTL_SECONDS,
      otpMaxAttemptsPerPhonePerHour: v.OTP_MAX_ATTEMPTS_PER_PHONE_PER_HOUR,
      // FIX 9: per-endpoint limits as { limit, windowSeconds } pairs.
      rateLimits: {
        otpRequest: { limit: v.RATE_LIMIT_OTP_REQUEST_PER_HOUR, windowSeconds: 3600 },
        otpVerify: { limit: v.RATE_LIMIT_OTP_VERIFY_PER_HOUR, windowSeconds: 3600 },
        refresh: { limit: v.RATE_LIMIT_REFRESH_PER_HOUR, windowSeconds: 3600 },
        search: { limit: v.RATE_LIMIT_SEARCH_PER_MINUTE, windowSeconds: 60 },
        nearby: { limit: v.RATE_LIMIT_NEARBY_PER_MINUTE, windowSeconds: 60 },
        createRequest: { limit: v.RATE_LIMIT_CREATE_REQUEST_PER_HOUR, windowSeconds: 3600 },
        offers: { limit: v.RATE_LIMIT_OFFERS_PER_HOUR, windowSeconds: 3600 },
        messages: { limit: v.RATE_LIMIT_MESSAGES_PER_MINUTE, windowSeconds: 60 },
        reports: { limit: v.RATE_LIMIT_REPORTS_PER_HOUR, windowSeconds: 3600 },
        blocks: { limit: v.RATE_LIMIT_BLOCKS_PER_HOUR, windowSeconds: 3600 },
        // SOS: high limit on purpose — emergency calls are throttled, never
        // fully blocked. See src/common/guards/rate-limit.guard.ts.
        sos: { limit: v.RATE_LIMIT_SOS_PER_MINUTE, windowSeconds: 60 },
      },
      jwtAccessTtlSeconds: v.JWT_ACCESS_TTL_SECONDS,
      jwtRefreshTtlSeconds: v.JWT_REFRESH_TTL_SECONDS,
      // Phase 4, item 1 (search scale-out): mirrors search.config.ts
      // defaults (provider trigram, cache on, TTL 120s). The seeded
      // search_gate_config row is the admin-editable gate, not this.
      search: {
        provider: v.SEARCH_PROVIDER,
        serviceUrl: v.SEARCH_SERVICE_URL?.trim() ? v.SEARCH_SERVICE_URL.trim() : undefined,
        cacheTtlSeconds: v.SEARCH_CACHE_TTL_SECONDS,
        cacheEnabled: v.SEARCH_CACHE_ENABLED,
      },
      storageUploadBaseUrl: v.STORAGE_UPLOAD_BASE_URL,
      paymentGatewayMode: v.PAYMENT_GATEWAY_MODE,
      // FIX 12: split + trim; empty string -> [] (no origins allowed in prod).
      corsOrigins: v.CORS_ORIGINS ? v.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : [],
      fieldEncryptionKey: fieldKey(v.FIELD_ENCRYPTION_KEY, DEV_FIELD_KEY_B64),
      fieldEncryptionKeyV2: v.FIELD_ENCRYPTION_KEY_V2
        ? Buffer.from(v.FIELD_ENCRYPTION_KEY_V2, 'base64')
        : null,
    };
  });

export type Env = z.infer<typeof envSchema>;

/** Validate a raw env record (defaults to process.env). Throws a single
 *  Error listing every problem — main.ts catches it and exits at startup. */
export function parseEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${problems}`);
  }
  return parsed.data;
}

/** The validated config, parsed exactly once at import time. */
export const env: Env = parseEnv();

/** Key bytes for field encryption by key version ('v1' = FIELD_ENCRYPTION_KEY,
 *  'v2' = FIELD_ENCRYPTION_KEY_V2). Throws if the requested version has no key. */
export function fieldEncryptionKey(version: 'v1' | 'v2'): Buffer {
  if (version === 'v2') {
    if (!env.fieldEncryptionKeyV2) throw new Error('FIELD_ENCRYPTION_KEY_V2 is not set (no v2 key for rotation)');
    return env.fieldEncryptionKeyV2;
  }
  return env.fieldEncryptionKey;
}
