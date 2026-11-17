// FIX 12 (Stage 3) — CORS allowlist from env CORS_ORIGINS.
import { buildCorsOptions } from '../../src/config/cors';
import { parseEnv } from '../../src/config/env';
import type { Env } from '../../src/config/env';

const envLike = (over: Partial<Env>): Env => ({ isProduction: false, corsOrigins: [], ...over } as Env);

describe('buildCorsOptions', () => {
  it('production + empty allowlist allows NO browser origin', () => {
    expect(buildCorsOptions(envLike({ isProduction: true, corsOrigins: [] }))).toEqual({
      origin: false,
      credentials: false,
    });
  });
  it('production + allowlist echoes only the listed origins', () => {
    const opts = buildCorsOptions(envLike({ isProduction: true, corsOrigins: ['https://admin.nearservice.pk'] }));
    expect(opts.origin).toEqual(['https://admin.nearservice.pk']);
    expect(opts.credentials).toBe(true);
  });
  it('non-production + empty allowlist keeps the old allow-all dev behaviour', () => {
    expect(buildCorsOptions(envLike({ isProduction: false, corsOrigins: [] })).origin).toBe(true);
  });
  it('non-production + allowlist still restricts to the list', () => {
    const opts = buildCorsOptions(envLike({ isProduction: false, corsOrigins: ['http://localhost:3001'] }));
    expect(opts.origin).toEqual(['http://localhost:3001']);
  });
});

describe('parseEnv CORS_ORIGINS', () => {
  it('splits + trims a comma-separated list', () => {
    const env = parseEnv({ NODE_ENV: 'development', CORS_ORIGINS: 'https://a.example, http://localhost:3001 , ' });
    expect(env.corsOrigins).toEqual(['https://a.example', 'http://localhost:3001']);
  });
  it('missing CORS_ORIGINS parses to an empty list', () => {
    expect(parseEnv({ NODE_ENV: 'development' }).corsOrigins).toEqual([]);
  });
});
