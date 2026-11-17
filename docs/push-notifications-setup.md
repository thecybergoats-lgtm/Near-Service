# Push Notifications — Setup Guide (Batch 2)

## What is already built (no action needed)

- **Device registration:** `POST /devices/register
  {device_token, platform: 'android'|'ios'}` — upsert per user+device
  on `user_devices` (device key = SHA-256 of the token; the raw token
  is stored in `user_devices.fcm_token` because FCM needs it to
  deliver; it is never logged or returned).
- **Preferences:** `GET` / `PATCH
  /users/me/notification-preferences` (`push_enabled`, default true).
- **Send path:** `NotificationsService.sendToUser(userId, templateKey,
  payload)` behind the `NotificationProvider` interface. Sends are
  wired best-effort on offer accepted/countered, job completed, and
  support reply — a push failure can never fail the calling request.
- **Providers:** `FcmNotificationProvider` (real FCM HTTP v1, no extra
  dependency — JWT signed with the service-account key via node:crypto,
  OAuth token exchange, then `messages:send`) and
  `NoopNotificationProvider` (logs + skips). The module picks FCM when
  it is configured, otherwise the no-op provider. **With no Firebase
  credentials configured, every send degrades cleanly** (logs a
  warning, writes a `notifications` row with status `skipped`, returns
  `{sent: false, reason: 'provider_not_configured'}`) — the API never
  500s because of push.
- **Existing stub untouched:** `src/common/utils/push.ts`
  (`sendPushStub`) is still the Phase 1 in-app record + labelled log;
  the new FCM path is separate.

## What the user must still provide

All three items need **his Google account** (the one that owns the
Firebase project). Nothing here can be created by Muse without it.

1. **A Firebase project on his Google account**
   - Go to [Firebase console](https://console.firebase.google.com) →
     Add project (any name, e.g. `near-service`) → enable **Cloud
     Messaging** (on by default for the project).
   - This is the project that owns the FCM sender — the same project
     the Android app registers against.

2. **`google-services.json` in the Android app**
   - Firebase console → Project settings → Your apps → Android app →
     download `google-services.json`.
   - Place it at `mobile/android/app/google-services.json` (the
     Flutter Android app reads it at build time; without it the app
     cannot obtain an FCM device token to send to
     `POST /devices/register`).
   - **Do not commit the file to a public repo if it ever contains
     secrets** — `google-services.json` itself holds only public
     identifiers (api key, project id), but keep it out of public
     history anyway.

3. **A service-account key as the `FCM_SERVICE_ACCOUNT_JSON` env var**
   - Firebase console → Project settings → Service accounts →
     **Generate new private key** → downloads a JSON file.
   - Set the **entire JSON file contents** (one line) as the
     `FCM_SERVICE_ACCOUNT_JSON` environment variable on the backend
     host (Railway → service → Variables). Example shape (never paste
     a real key into chat):
     `{"type":"service_account","project_id":"...","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...","client_email":"firebase-adminsdk-...@....iam.gserviceaccount.com", ...}`
   - **Treat the private key like a password:** only ever set it via
     the host's env-var UI, never in chat, files, or git. Rotate it in
     the Firebase console if it is ever exposed.
   - When the variable is set and parses (needs `project_id`,
     `client_email`, `private_key`), the backend logs nothing special
     at boot — the first send attempt uses it. If it is set but
     unparsable/incomplete, the backend logs a warning at boot and
     falls back to the no-op provider.

## How to verify it works

1. Deploy the backend with `FCM_SERVICE_ACCOUNT_JSON` set.
2. Install the app build that includes `google-services.json`, log
   in, and confirm a row appears in `user_devices` with a non-null
   `fcm_token` for your user.
3. Accept an offer (or complete a job) as the other party and check
   the device receives the push. In the backend logs a successful send
   is silent; a failed send logs `push send failed for user ...`.
4. The `notifications` table records every attempt (`status` sent /
   skipped / failed) — queryable per user for debugging.

## What is intentionally NOT built

- No Firebase Admin SDK dependency (the FCM HTTP v1 flow is plain
  `fetch` + `node:crypto`).
- No iOS APNs path yet — `POST /devices/register` accepts
  `platform: 'ios'` and stores the token, but FCM delivery to iOS
  needs the APNs key uploaded in the Firebase console (Cloud
  Messaging → Apple app configuration) — a Firebase-console step, not
  a backend change.
- No topic/segment messaging — sends are per-device-token only.
