// FCM push — STUB (one of only two allowed stubs, alongside dev-mode OTP).
// Phase 1 records the notification row (in-app) and LOGS the push send
// (labelled); no push is actually delivered. Wire real FCM (service
// account / server key) in Phase 2. Never log device tokens.
// FIX 15(b): the payload is passed through redactSecrets() — a message body
// must never leak a token/OTP/CNIC into the log via this stub.
import { redactSecrets } from './log-redaction';

export function sendPushStub(userId: string, templateKey: string, payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.warn(redactSecrets(`[FCM STUB] push NOT actually sent — template=${templateKey} user=${userId} payload=${JSON.stringify(payload)} (stub only, wire real FCM in Phase 2)`));
}
