// Push notifications — plumbing only (Batch 2).
//
// What is built here:
//   * Device registration: POST /devices/register stores the caller's FCM
//     device token on their user_devices row (upsert per user+device).
//   * Preferences: users.push_enabled (default true), PATCH/GET
//     /users/me/notification-preferences.
//   * A server-side send path behind NotificationProvider: FCM when
//     FCM_SERVICE_ACCOUNT_JSON is configured, Noop otherwise.
//   * Best-effort sends on offer accepted/countered, job completed and
//     support reply (wired in OffersService / JobsService / SupportService).
//
// Token handling (deliberate, documented): FCM can only deliver to the
// raw device token, so the token itself must be stored to be usable —
// the existing user_devices.fcm_token column (POST /me/devices already
// stored it raw) is reused. What is hashed, like refresh tokens
// (auth.service.ts FIX 2: SHA-256 of the full token), is the
// device_fingerprint — the upsert/lookup key. Raw tokens are NEVER
// logged (the redactSecrets path in push.ts applies to the stub log, and
// this service logs only user ids + template keys) and NEVER returned in
// any API response.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { NotificationProvider, PushMessage } from './notification-provider.interface';

export const NOTIFICATION_PROVIDER = 'NOTIFICATION_PROVIDER';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const TEMPLATE_MESSAGES: Record<string, { title: string; body: string }> = {
  'offer.accepted': { title: 'Offer accepted', body: 'Your offer was accepted — a new job is waiting.' },
  'offer.countered': { title: 'New counter-offer', body: 'The customer sent a counter-offer on your job.' },
  'job.completed': { title: 'Work completed', body: 'The provider marked your job as completed. Please confirm it.' },
  'support.reply': { title: 'Support replied', body: 'Support replied to your ticket.' },
};

export type PushSendResult =
  | { sent: true; attempted: number }
  | { sent: false; reason: 'push_disabled' | 'no_device_token' | 'provider_not_configured' | 'send_failed' };

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  constructor(
    private db: DatabaseService,
    @Inject(NOTIFICATION_PROVIDER) private provider: NotificationProvider,
  ) {}

  /** Exposed for tests/admin: which provider is active and whether it can send. */
  providerStatus(): { provider: string; configured: boolean } {
    return { provider: this.provider.name, configured: this.provider.configured };
  }

  /** Register (or refresh) the caller's FCM device token. Upsert per
   *  user + device: the device key is the SHA-256 of the token, so the
   *  same token re-registered updates last_seen_at instead of duplicating.
   *  The response never echoes the token. */
  async registerDevice(userId: string, deviceToken: string, platform: 'android' | 'ios'): Promise<{ device_id: string; platform: string; last_seen_at: string }> {
    const fingerprint = sha256Hex(deviceToken);
    const row = (await this.db.query(
      `INSERT INTO user_devices (user_id, device_fingerprint, platform, fcm_token, last_seen_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (user_id, device_fingerprint) DO UPDATE SET platform=EXCLUDED.platform, fcm_token=EXCLUDED.fcm_token, last_seen_at=now()
       RETURNING id, platform, last_seen_at`,
      [userId, fingerprint, platform, deviceToken])).rows[0];
    return { device_id: String(row.id), platform: String(row.platform), last_seen_at: String(row.last_seen_at) };
  }

  async getPreferences(userId: string): Promise<{ push_enabled: boolean }> {
    const row = (await this.db.query<{ push_enabled: boolean }>(
      `SELECT push_enabled FROM users WHERE id=$1`, [userId])).rows[0];
    return { push_enabled: row?.push_enabled ?? true };
  }

  async setPreferences(userId: string, pushEnabled: boolean): Promise<{ push_enabled: boolean }> {
    const row = (await this.db.query<{ push_enabled: boolean }>(
      `UPDATE users SET push_enabled=$2 WHERE id=$1 RETURNING push_enabled`, [userId, pushEnabled])).rows[0];
    return { push_enabled: row?.push_enabled ?? pushEnabled };
  }

  /** Best-effort push to every registered device of a user. NEVER throws:
   *  disabled preference, no token, unconfigured provider, or a failed
   *  send all degrade to a logged skip + a notifications row with status
   *  'skipped'/'failed' — the calling request (offer accept, job
   *  complete, support reply) always succeeds regardless of push. */
  async sendToUser(userId: string, templateKey: string, payload: Record<string, unknown> = {}): Promise<PushSendResult> {
    const prefs = await this.getPreferences(userId).catch(() => ({ push_enabled: true }));
    if (!prefs.push_enabled) {
      await this.recordNotification(userId, templateKey, payload, 'skipped').catch(() => undefined);
      return { sent: false, reason: 'push_disabled' };
    }
    let tokens: string[] = [];
    try {
      const rows = (await this.db.query<{ fcm_token: string }>(
        `SELECT fcm_token FROM user_devices WHERE user_id=$1 AND fcm_token IS NOT NULL`, [userId])).rows;
      tokens = rows.map((r) => r.fcm_token).filter(Boolean);
    } catch (e) {
      this.logger.warn(`push token lookup failed for user ${userId}: ${(e as Error).message}`);
      return { sent: false, reason: 'send_failed' };
    }
    if (tokens.length === 0) {
      await this.recordNotification(userId, templateKey, payload, 'skipped').catch(() => undefined);
      return { sent: false, reason: 'no_device_token' };
    }
    if (!this.provider.configured) {
      this.logger.warn(`[push] provider=${this.provider.name} not configured — push to user ${userId} template=${templateKey} skipped (no token logged)`);
      await this.recordNotification(userId, templateKey, payload, 'skipped').catch(() => undefined);
      return { sent: false, reason: 'provider_not_configured' };
    }
    const tpl = TEMPLATE_MESSAGES[templateKey] ?? { title: 'Near Service', body: 'You have a new update.' };
    const message: PushMessage = {
      title: tpl.title,
      body: tpl.body,
      data: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])),
    };
    let attempted = 0;
    try {
      for (const token of tokens) {
        await this.provider.send(token, message);
        attempted += 1;
      }
    } catch (e) {
      this.logger.warn(`push send failed for user ${userId} template=${templateKey}: ${(e as Error).message}`);
      await this.recordNotification(userId, templateKey, payload, 'failed').catch(() => undefined);
      return { sent: false, reason: 'send_failed' };
    }
    await this.recordNotification(userId, templateKey, payload, 'sent').catch(() => undefined);
    return { sent: true, attempted };
  }

  private async recordNotification(userId: string, templateKey: string, payload: Record<string, unknown>, status: string): Promise<void> {
    await this.db.query(
      `INSERT INTO notifications (user_id, channel, template_key, payload, status) VALUES ($1,'push',$2,$3,$4)`,
      [userId, templateKey, JSON.stringify(payload), status]);
  }
}
