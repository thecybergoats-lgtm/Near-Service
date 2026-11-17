// Per-endpoint fixed-window rate limiting (FIX 9, Stage 2).
//
// Usage: put @RateLimit('otp-request') (or any key below) on a handler. The
// guard is registered globally (AppModule APP_GUARD) and only acts when a
// handler carries the metadata; every other route passes through untouched
// (including /health and /ready, which do not exist yet — Stage 3 — and
// must never be rate-limited when they land).
//
// Keying: authenticated caller -> per-user id; anonymous -> per-IP. One user
// hammering an endpoint never blocks another user on the same IP, and one
// IP hammering a public endpoint (OTP) is still contained.
// Counting is atomic: RedisService.incrWithExpire (one Lua script, expiry
// set only when the counter is created — FIX 3's primitive).
//
// On breach: 429 RATE_LIMITED with a Retry-After header (seconds until the
// window resets, read from the key's real Redis TTL). If Redis itself is
// unreachable the guard FAILS OPEN (logs a warning, lets the request
// through): a down cache must not take the whole API down with it.
//
// SOS: deliberately a HIGH limit (30/min by default, env RATE_LIMIT_SOS_PER_MINUTE).
// An emergency call is throttled, never fully blocked — at the limit the
// caller waits at most the remainder of the current 60-second window.
import { CanActivate, ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../../database/redis.service';
import { env } from '../../config/env';
import { Errors } from '../errors/api-error';

export type RateLimitKey =
  | 'otp-request'
  | 'otp-verify'
  | 'refresh'
  | 'search'
  | 'nearby'
  | 'create-request'
  | 'offers'
  | 'messages'
  | 'reports'
  | 'blocks'
  | 'sos';

export interface RateLimitPreset {
  limit: number;
  windowSeconds: number;
}

/** Limits resolve from env (src/config/env.ts rateLimits) at import time. */
export const RATE_LIMIT_PRESETS: Record<RateLimitKey, RateLimitPreset> = {
  'otp-request': env.rateLimits.otpRequest,
  'otp-verify': env.rateLimits.otpVerify,
  refresh: env.rateLimits.refresh,
  search: env.rateLimits.search,
  nearby: env.rateLimits.nearby,
  'create-request': env.rateLimits.createRequest,
  offers: env.rateLimits.offers,
  messages: env.rateLimits.messages,
  reports: env.rateLimits.reports,
  blocks: env.rateLimits.blocks,
  sos: env.rateLimits.sos,
};

export const RATE_LIMIT_KEY = 'rateLimit';
/** Attach a per-endpoint limit to a handler, e.g. @RateLimit('otp-request'). */
export const RateLimit = (key: RateLimitKey) => SetMetadata(RATE_LIMIT_KEY, key);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const key = this.reflector.getAllAndOverride<RateLimitKey>(RATE_LIMIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!key) return true;
    const preset = RATE_LIMIT_PRESETS[key];
    if (!preset) return true;
    const req = ctx.switchToHttp().getRequest();
    if (!req) return true;
    // Authenticated -> per-user; anonymous -> per-IP. JwtAuthGuard (an
    // earlier APP_GUARD) has already populated req.user for authed calls.
    const subject = req.user?.id ? `user:${req.user.id}` : `ip:${req.ip ?? 'unknown'}`;
    const redisKey = `rl:${key}:${subject}`;
    let count: number;
    try {
      count = await this.redis.incrWithExpire(redisKey, preset.windowSeconds);
    } catch (e) {
      this.logger.warn(`rate-limit Redis failure for ${redisKey} — failing open: ${(e as Error).message}`);
      return true;
    }
    if (count <= preset.limit) return true;
    let retryAfter = preset.windowSeconds;
    try {
      const ttl = await this.redis.ttl(redisKey);
      if (ttl > 0) retryAfter = ttl;
    } catch {
      // Keep the window default; the 429 still goes out.
    }
    throw Errors.rateLimited(`Too many requests — try again in ${retryAfter}s`, 'RATE_LIMITED', retryAfter);
  }
}
