import { Module } from '@nestjs/common';
import { FcmNotificationProvider } from './fcm.provider';
import { NoopNotificationProvider } from './noop.provider';
import { NOTIFICATION_PROVIDER, NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

// Provider selection happens once at boot: the FCM provider when
// FCM_SERVICE_ACCOUNT_JSON is configured, otherwise the no-op provider.
// Either way the token is the same, so callers never branch on config.
@Module({
  controllers: [NotificationsController],
  providers: [
    FcmNotificationProvider,
    NoopNotificationProvider,
    {
      provide: NOTIFICATION_PROVIDER,
      useFactory: (fcm: FcmNotificationProvider, noop: NoopNotificationProvider) =>
        fcm.configured ? fcm : noop,
      inject: [FcmNotificationProvider, NoopNotificationProvider],
    },
    NotificationsService,
  ],
  exports: [NotificationsService, NOTIFICATION_PROVIDER],
})
export class NotificationsModule {}
