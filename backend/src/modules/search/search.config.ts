// Search scale-out configuration (Phase 4, item 1).
//
// Read from process.env directly with safe defaults. These keys are NOT
// (yet) in src/config/env.ts — adding them there is a coordinator wiring
// step (see docs/phase4-search.md); env.ts uses zod, which strips unknown
// keys, so reading them here works whether or not that step has landed.
// No value here is a secret.
//
//   SEARCH_PROVIDER        'trigram' (default) | 'scaled'
//                          Which in-process provider the gateway uses
//                          when SEARCH_SERVICE_URL is unset.
//   SEARCH_SERVICE_URL     e.g. http://search.internal:3000 — when set,
//                          the gateway forwards every search to that
//                          extracted service instead of running it
//                          in-process. Unset = in-process.
//   SEARCH_CACHE_TTL_SECONDS  Redis TTL for scaled-provider results
//                          (default 120). 0 disables the cache.
//   SEARCH_CACHE_ENABLED   'true' (default) | 'false'.
import { Logger } from '@nestjs/common';

export interface SearchConfig {
  provider: 'trigram' | 'scaled';
  serviceUrl: string | undefined;
  cacheEnabled: boolean;
  cacheTtlSeconds: number;
}

const logger = new Logger('SearchConfig');

export function readSearchConfig(env: NodeJS.ProcessEnv = process.env): SearchConfig {
  const rawProvider = (env.SEARCH_PROVIDER ?? 'trigram').trim().toLowerCase();
  const provider = rawProvider === 'scaled' ? 'scaled' : 'trigram';
  if (rawProvider !== 'trigram' && rawProvider !== 'scaled') {
    logger.warn(`SEARCH_PROVIDER='${rawProvider}' is not a known provider — falling back to 'trigram'`);
  }
  const serviceUrl = (env.SEARCH_SERVICE_URL ?? '').trim() || undefined;
  const cacheEnabled = (env.SEARCH_CACHE_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  const parsedTtl = Number.parseInt(env.SEARCH_CACHE_TTL_SECONDS ?? '120', 10);
  const cacheTtlSeconds = Number.isFinite(parsedTtl) && parsedTtl >= 0 ? parsedTtl : 120;
  return { provider, serviceUrl, cacheEnabled, cacheTtlSeconds };
}
