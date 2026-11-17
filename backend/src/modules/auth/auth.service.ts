import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'crypto';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { Errors } from '../../common/errors/api-error';
import { generateOtpCode, hashOtp, normalizePhone, safeEqualHex } from '../../common/utils/otp';
import { ensureWallet } from '../../common/utils/wallet';

// FIX 3 — OTP brute-force limits. After 5 failed verifications for a phone
// the stored OTP is deleted and verify is blocked for 15 minutes (429
// OTP_LOCKED with Retry-After). IP and device-fingerprint failures are
// counted separately so one phone cannot be used to burn another's budget
// and one attacker cannot hammer many phones from one IP/device.
const OTP_FAIL_LIMIT_PHONE = 5;
const OTP_FAIL_LIMIT_IP = 20;
const OTP_FAIL_LIMIT_DEVICE = 10;
const OTP_LOCK_SECONDS = 900; // 15 minutes
const OTP_FAIL_WINDOW_SECONDS = 900;

/** SHA-256 hex of a full refresh token (FIX 2). bcrypt must never be used
 *  for refresh tokens: it reads only the first 72 bytes of a JWT, which are
 *  identical for all tokens of one user, so reuse detection never fired. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(private db: DatabaseService, private redis: RedisService) {}

  async requestOtp(phoneRaw: string, deviceFingerprint?: string): Promise<{ expires_in_seconds: number }> {
    const phone = normalizePhone(phoneRaw);
    // FIX 3(d): atomic INCR + EXPIRE-on-create (Lua). The old code did
    // INCR then a separate SET, which races under concurrency.
    const count = await this.redis.incrWithExpire(`otp:rl:${phone}`, 3600);
    if (count > env.otpMaxAttemptsPerPhonePerHour) throw Errors.rateLimited('Too many OTP requests for this phone');
    const code = generateOtpCode();
    const ttl = env.otpTtlSeconds;
    // TEMPORARY PILOT LOGIN (remove before public launch): when the request
    // is for the single allowlisted owner phone, store the hash of the
    // configured pilot code instead of a random one. The code is NEVER
    // returned or logged; verify, lockout, rate-limit and TTL behaviour
    // are identical to a normal OTP. The real path is Firebase phone auth
    // / SMS gateway (PRD p.4).
    const isPilotPhone =
      !!env.pilotLoginPhone &&
      !!env.pilotLoginCode &&
      normalizePhone(phone) === normalizePhone(env.pilotLoginPhone);
    const storedCode = isPilotPhone ? env.pilotLoginCode! : code;
    // FIX 3(f): keyed HMAC-SHA256, not bcrypt.
    await this.redis.set(`otp:${phone}`, hashOtp(storedCode), ttl);
    if (deviceFingerprint) await this.redis.set(`otp:device:${deviceFingerprint}`, phone, ttl);
    if (isPilotPhone) {
      this.logger.warn(`[PILOT OTP] pilot login code issued for allowlisted phone ${phone} — TEMPORARY, remove before launch (code never logged)`);
    } else if (env.otpDevMode && !env.isProduction) {
      // DEV MODE ONLY — clearly labelled. No SMS is sent. Production uses
      // Firebase phone auth / SMS gateway (PRD p.4). FIX 15(b): the OTP
      // code itself is NEVER logged, not even in dev — it used to be
      // printed here. Tests seed Redis directly with hashOtp(code).
      this.logger.warn(`[DEV OTP] phone=${phone} — DEV MODE ONLY, code issued (never logged), no SMS sent`);
    } else {
      this.logger.log(`[OTP] SMS gateway send requested for ${phone} (configure Firebase/SMS provider)`);
    }
    return { expires_in_seconds: ttl };
  }

  async verifyOtp(phoneRaw: string, code: string, deviceFingerprint?: string, fullName?: string, language?: string, ip?: string) {
    const phone = normalizePhone(phoneRaw);
    const lockKey = `otp:locked:${phone}`;
    const lockedTtl = await this.redis.ttl(lockKey);
    if (lockedTtl > 0 || (await this.redis.get(lockKey)) !== null) {
      throw Errors.otpLocked(lockedTtl > 0 ? lockedTtl : OTP_LOCK_SECONDS);
    }
    const hash = await this.redis.get(`otp:${phone}`);
    if (!hash) throw Errors.badRequest('OTP_EXPIRED', 'OTP expired or not requested');
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      // Legacy (pre-FIX-3) bcrypt hash can never match an HMAC comparison;
      // OTPs live at most 5 minutes, so treat it as expired.
      await this.redis.del(`otp:${phone}`);
      throw Errors.badRequest('OTP_EXPIRED', 'OTP expired or not requested');
    }
    if (!safeEqualHex(hashOtp(code), hash)) {
      await this.recordOtpFailure(phone, deviceFingerprint, ip);
      throw Errors.badRequest('OTP_INVALID', 'Invalid OTP code');
    }
    // FIX 3(e): a successful verify resets all failure counters.
    await this.resetOtpFailures(phone, deviceFingerprint, ip);
    await this.redis.del(`otp:${phone}`);
    const user = await this.db.withTransaction(async (c) => {
      let r = await c.query('SELECT id, phone, full_name, language, status FROM users WHERE phone=$1 AND deleted_at IS NULL', [phone]);
      let u = r.rows[0];
      if (!u) {
        r = await c.query(
          `INSERT INTO users (phone, full_name, language) VALUES ($1,$2,$3) RETURNING id, phone, full_name, language, status`,
          [phone, fullName ?? null, language ?? 'ur'],
        );
        u = r.rows[0];
        await c.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name='customer' ON CONFLICT DO NOTHING`, [u.id]);
        // Single wallet per user (v1.1): get-or-create the account's ONE wallet.
        await ensureWallet(c as unknown as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, u.id);
      }
      if (u.status !== 'active') throw Errors.forbidden('Account is suspended');
      if (deviceFingerprint) {
        await c.query(
          `INSERT INTO user_devices (user_id, device_fingerprint, platform, last_seen_at) VALUES ($1,$2,'android', now())
           ON CONFLICT (user_id, device_fingerprint) DO UPDATE SET last_seen_at=now()`,
          [u.id, deviceFingerprint],
        );
      }
      return u;
    });
    const roles = (await this.db.query<{ name: string }>(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1`, [user.id])).rows.map((x) => x.name);
    return this.issueTokens(user.id, phone, roles);
  }

  /** Count one failed verification. On any threshold breach: delete the
   *  stored OTP and lock verify for this phone for 15 minutes. */
  private async recordOtpFailure(phone: string, deviceFingerprint?: string, ip?: string): Promise<void> {
    const phoneFails = await this.redis.incrWithExpire(`otp:fail:phone:${phone}`, OTP_FAIL_WINDOW_SECONDS);
    let ipFails = 0;
    let deviceFails = 0;
    if (ip) ipFails = await this.redis.incrWithExpire(`otp:fail:ip:${ip}`, OTP_FAIL_WINDOW_SECONDS);
    if (deviceFingerprint) deviceFails = await this.redis.incrWithExpire(`otp:fail:device:${deviceFingerprint}`, OTP_FAIL_WINDOW_SECONDS);
    if (phoneFails >= OTP_FAIL_LIMIT_PHONE || ipFails >= OTP_FAIL_LIMIT_IP || deviceFails >= OTP_FAIL_LIMIT_DEVICE) {
      await this.redis.del(`otp:${phone}`);
      await this.redis.set(`otp:locked:${phone}`, '1', OTP_LOCK_SECONDS);
      this.logger.warn(`[AUTH] OTP verify locked for ${phone} (phone=${phoneFails} ip=${ipFails} device=${deviceFails})`);
      throw Errors.otpLocked(OTP_LOCK_SECONDS);
    }
  }

  private async resetOtpFailures(phone: string, deviceFingerprint?: string, ip?: string): Promise<void> {
    await this.redis.del(`otp:fail:phone:${phone}`);
    await this.redis.del(`otp:locked:${phone}`);
    if (ip) await this.redis.del(`otp:fail:ip:${ip}`);
    if (deviceFingerprint) await this.redis.del(`otp:fail:device:${deviceFingerprint}`);
  }

  private async issueTokens(userId: string, phone: string, roles: string[]) {
    const familyId = randomUUID();
    // FIX 2: every refresh token carries a random jti; the stored hash is
    // SHA-256 of the FULL token, compared with timingSafeEqual.
    const refreshToken = jwt.sign({ sub: userId, phone, fid: familyId, jti: randomUUID() }, env.jwtRefreshSecret, { expiresIn: env.jwtRefreshTtlSeconds });
    await this.db.query(
      `INSERT INTO refresh_token_families (family_id, user_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval)`,
      [familyId, userId, sha256Hex(refreshToken), String(env.jwtRefreshTtlSeconds)],
    );
    return { access_token: this.accessToken(userId, phone, roles), refresh_token: refreshToken, expires_in: env.jwtAccessTtlSeconds };
  }
  private accessToken(userId: string, phone: string, roles: string[], profile?: string) {
    return jwt.sign({ sub: userId, phone, roles, profile }, env.jwtAccessSecret, { expiresIn: env.jwtAccessTtlSeconds });
  }

  async refresh(refreshToken: string) {
    let payload: jwt.JwtPayload;
    try { payload = jwt.verify(refreshToken, env.jwtRefreshSecret) as jwt.JwtPayload; }
    catch { throw Errors.unauthorized('Invalid refresh token'); }
    const familyId = payload.fid as string;
    const rows = (await this.db.query<{ user_id: string; token_hash: string; revoked_at: Date | null; expires_at: Date }>(
      `SELECT user_id, token_hash, revoked_at, expires_at FROM refresh_token_families WHERE family_id=$1`, [familyId])).rows;
    if (rows.length === 0) throw Errors.unauthorized('Unknown refresh family');
    const fam = rows[0];
    if (fam.revoked_at || new Date(fam.expires_at) < new Date()) throw Errors.unauthorized('Refresh token revoked or expired');
    if (!safeEqualHex(sha256Hex(refreshToken), fam.token_hash)) {
      // REUSE DETECTED: a verified token that is not the current one means
      // the token was stolen/replayed — revoke the whole family (PRD p.19).
      await this.db.query(`UPDATE refresh_token_families SET revoked_at=now() WHERE family_id=$1`, [familyId]);
      this.logger.warn(`[AUTH] refresh reuse detected, family revoked: ${familyId}`);
      throw Errors.unauthorized('Refresh token reuse detected — family revoked', 'REFRESH_REUSE_DETECTED');
    }
    const user = (await this.db.query<{ phone: string }>(`SELECT phone FROM users WHERE id=$1`, [fam.user_id])).rows[0];
    const roles = (await this.db.query<{ name: string }>(`SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1`, [fam.user_id])).rows.map((x) => x.name);
    const newRefresh = jwt.sign({ sub: fam.user_id, phone: user.phone, fid: familyId, jti: randomUUID() }, env.jwtRefreshSecret, { expiresIn: env.jwtRefreshTtlSeconds });
    await this.db.query(
      `UPDATE refresh_token_families SET token_hash=$1, expires_at=now() + ($2 || ' seconds')::interval WHERE family_id=$3`,
      [sha256Hex(newRefresh), String(env.jwtRefreshTtlSeconds), familyId],
    );
    return { access_token: this.accessToken(fam.user_id, user.phone, roles), refresh_token: newRefresh, expires_in: env.jwtAccessTtlSeconds };
  }

  async logout(refreshToken: string): Promise<void> {
    try {
      const payload = jwt.verify(refreshToken, env.jwtRefreshSecret) as jwt.JwtPayload;
      await this.db.query(`UPDATE refresh_token_families SET revoked_at=now() WHERE family_id=$1`, [payload.fid as string]);
    } catch { /* logout is best-effort for an already-invalid token */ }
  }
}
