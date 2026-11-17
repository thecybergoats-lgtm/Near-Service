// Push provider interface (Batch 2, plumbing only).
//
// Two implementations exist:
//   - FcmNotificationProvider: real FCM HTTP v1 sends, only when
//     FCM_SERVICE_ACCOUNT_JSON is configured (configured === true).
//   - NoopNotificationProvider: configured === false, send() logs + returns.
// NotificationsService only attempts a send when a device token exists AND
// the active provider reports configured — an unconfigured deploy can
// never 500 a request because of push.
export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface NotificationProvider {
  readonly name: string;
  /** False when the provider has no credentials — callers must skip sends. */
  readonly configured: boolean;
  send(deviceToken: string, message: PushMessage): Promise<void>;
}
