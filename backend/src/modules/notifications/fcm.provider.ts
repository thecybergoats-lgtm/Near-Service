// Real FCM provider (Batch 2) — FCM HTTP v1, no extra dependency.
//
// Credentials come from env FCM_SERVICE_ACCOUNT_JSON (the service-account
// JSON as a string; see docs/push-notifications-setup.md). The constructor
// parses it once: missing / unparsable / incomplete JSON => configured
// stays false and send() is never attempted — the module falls back to
// the Noop provider instead (see notifications.module.ts).
//
// Send flow (plain fetch, Node 20+): sign a short-lived JWT with the
// service-account private key (RS256 via node:crypto), exchange it for a
// Google OAuth access token, then POST the message to
// fcm.googleapis.com/v1/projects/{project_id}/messages:send.
// No Firebase Admin SDK is vendored — the whole flow is ~60 lines and
// keeps the dependency surface unchanged.
//
// The raw device token is passed to FCM only; it is never logged.
import { Injectable, Logger } from '@nestjs/common';
import { createSign } from 'crypto';
import { env } from '../../config/env';
import { NotificationProvider, PushMessage } from './notification-provider.interface';

interface ServiceAccount {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

@Injectable()
export class FcmNotificationProvider implements NotificationProvider {
  readonly name = 'fcm';
  readonly configured: boolean;
  private readonly logger = new Logger(FcmNotificationProvider.name);
  private readonly account: ServiceAccount | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor() {
    let parsed: ServiceAccount | null = null;
    try {
      parsed = env.fcmServiceAccountJson ? (JSON.parse(env.fcmServiceAccountJson) as ServiceAccount) : null;
    } catch {
      parsed = null;
    }
    if (parsed?.project_id && parsed?.client_email && parsed?.private_key) {
      this.account = parsed;
      this.configured = true;
    } else {
      if (env.fcmServiceAccountJson) {
        this.logger.warn('[push fcm] FCM_SERVICE_ACCOUNT_JSON is set but unparsable/incomplete — push disabled (noop fallback)');
      }
      this.configured = false;
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;
    const account = this.account as ServiceAccount;
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    signer.end();
    const signature = base64Url(signer.sign(account.private_key as string));
    const jwt = `${header}.${claims}.${signature}`;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FCM token exchange failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('FCM token exchange returned no access_token');
    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  async send(deviceToken: string, message: PushMessage): Promise<void> {
    if (!this.configured || !this.account) throw new Error('FCM provider is not configured');
    const token = await this.getAccessToken();
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id as string)}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: message.title, body: message.body },
            data: message.data ?? {},
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`FCM send failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
  }
}
