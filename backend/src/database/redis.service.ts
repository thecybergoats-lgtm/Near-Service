import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/** Redis wrapper with a transparent in-memory fallback so the API can boot
 *  and unit tests can run with no Redis. The fallback is process-local only
 *  and must never be relied on in production (multi-instance consistency). */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private mem = new Map<string, { v: string; exp: number }>();
  private warned = false;

  private getClient(): Redis | null {
    if (this.client) return this.client;
    const url = process.env.REDIS_URL;
    if (!url) { if (!this.warned) { this.logger.warn('REDIS_URL not set — using in-memory fallback (dev/tests only)'); this.warned = true; } return null; }
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.client.on('error', (e) => this.logger.error('redis error', e));
    return this.client;
  }
  async get(key: string): Promise<string | null> {
    const c = this.getClient();
    if (c) return c.get(key);
    const e = this.mem.get(key); if (!e) return null;
    if (e.exp && e.exp < Date.now()) { this.mem.delete(key); return null; }
    return e.v;
  }
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const c = this.getClient();
    if (c) { if (ttlSeconds) await c.set(key, value, 'EX', ttlSeconds); else await c.set(key, value); return; }
    this.mem.set(key, { v: value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
  }
  async del(key: string): Promise<void> { const c = this.getClient(); if (c) await c.del(key); else this.mem.delete(key); }
  async incr(key: string): Promise<number> {
    const c = this.getClient();
    if (c) return c.incr(key);
    const cur = parseInt((await this.get(key)) ?? '0', 10) + 1;
    await this.set(key, String(cur)); return cur;
  }
  /** Atomic INCR with EXPIRE set ONLY when the counter is created (FIX 3).
   *  Real Redis: one Lua script, so concurrent callers cannot race the
   *  expiry. In-memory fallback: single-process, same semantics. Returns the
   *  new counter value. */
  async incrWithExpire(key: string, ttlSeconds: number): Promise<number> {
    const c = this.getClient();
    if (c) {
      const r = await c.eval(
        `local n = redis.call('INCR', KEYS[1])
         if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
         return n`,
        1, key, ttlSeconds,
      );
      return Number(r);
    }
    const e = this.mem.get(key);
    if (!e || (e.exp && e.exp < Date.now())) {
      this.mem.set(key, { v: '1', exp: Date.now() + ttlSeconds * 1000 });
      return 1;
    }
    const cur = parseInt(e.v, 10) + 1;
    this.mem.set(key, { v: String(cur), exp: e.exp });
    return cur;
  }
  /** Remaining TTL in seconds (-2 when the key does not exist). */
  async ttl(key: string): Promise<number> {
    const c = this.getClient();
    if (c) return c.ttl(key);
    const e = this.mem.get(key);
    if (!e) return -2;
    if (!e.exp) return -1;
    return Math.max(0, Math.ceil((e.exp - Date.now()) / 1000));
  }
  /** SET key value NX EX ttl — distributed lock primitive. Returns true if acquired. */
  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const c = this.getClient();
    if (c) { const r = await c.set(key, value, 'EX', ttlSeconds, 'NX'); return r === 'OK'; }
    if (await this.get(key)) return false;
    await this.set(key, value, ttlSeconds); return true;
  }
  async geoAdd(key: string, lng: number, lat: number, member: string): Promise<void> {
    const c = this.getClient(); if (c) await c.geoadd(key, lng, lat, member);
  }
  /** Liveness probe for GET /ready (FIX 13). True only when a REAL Redis
   *  answers PING within 2s. The in-memory fallback is NOT Redis — when
   *  REDIS_URL is unset this returns false so /ready reports not-ready
   *  instead of silently passing on a dev-only stand-in. */
  async ping(): Promise<boolean> {
    const c = this.getClient();
    if (!c) return false;
    try {
      const res = await Promise.race([
        c.ping(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      return res === 'PONG';
    } catch {
      return false;
    }
  }
  async onModuleDestroy() { if (this.client) this.client.disconnect(); }
}
