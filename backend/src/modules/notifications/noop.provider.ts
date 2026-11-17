// No-op push provider (Batch 2). Used whenever FCM is not configured:
// send() only logs (user id / template only — never a device token) and
// returns. It never throws, so a deploy without Firebase credentials
// behaves exactly like the old Phase 1 FCM stub.
import { Injectable, Logger } from '@nestjs/common';
import { NotificationProvider, PushMessage } from './notification-provider.interface';

@Injectable()
export class NoopNotificationProvider implements NotificationProvider {
  readonly name = 'noop';
  readonly configured = false;
  private readonly logger = new Logger(NoopNotificationProvider.name);

  async send(_deviceToken: string, message: PushMessage): Promise<void> {
    this.logger.warn(`[push noop] FCM not configured — push skipped (title=${message.title})`);
  }
}
