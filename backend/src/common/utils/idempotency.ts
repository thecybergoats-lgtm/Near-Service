// Idempotency: clients send Idempotency-Key on every mutating marketplace
// call. Keys are stored in Redis (24 h) with the response payload; a replay
// returns the stored response instead of re-executing.
import type { RedisService } from '../../database/redis.service';
export function idempotencyKeyFor(scope: string, key: string): string {
  return `idem:${scope}:${key}`;
}
export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
/** Run fn once per (scope, key); replays return the cached result. */
export async function withIdempotency<T>(
  redis: RedisService, scope: string, key: string | undefined, fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn();
  const cacheKey = idempotencyKeyFor(scope, key);
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as T;
  const result = await fn();
  await redis.set(cacheKey, JSON.stringify(result), IDEMPOTENCY_TTL_SECONDS);
  return result;
}
