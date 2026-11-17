# Near Service — Batch 2 API Addendum (Trust & Safety)

Batch 2 endpoints added on top of OpenAPI 3.1 v1.7.0. **Folded into the
YAML:** `backend/openapi.yaml` is now **v1.8.0 — 243 paths / 272
operations** (+14 paths / +19 ops), and the route-diff test
(`backend/test/contract/api.contract.spec.ts`) enforces spec == code, so
this document is a human guide, not a second contract. If the two
disagree, the YAML + the code win and this file must be fixed.

Base URL: `/api/v1`. All responses use the Phase 1 error shape
`{ "error": { "code", "message", "details" }, "request_id" }`. List
endpoints return the v1.2 envelope `{ "items": [...], "next_cursor" }`
unless noted. Migration: `db/0023_batch2_trust_safety.sql` (additive
only). Tests: `backend/test/integration/batch2.spec.ts` (8 tests, real
Postgres + Redis).

## 1. Favourites

- `POST /providers/{providerId}/favourite` → 201 `{provider_id,
  favourited_at, already}`. **Idempotent:** favouriting twice returns
  the same row with `already: true` and never creates a duplicate
  (enforced by the `(user_id, provider_id)` PK on `user_favourites`).
  Unknown provider → 404.
- `DELETE /providers/{providerId}/favourite` → 204. **Idempotent:**
  removing a favourite that does not exist is still 204.
- `GET /favourites` → `{items: [{provider_id, display_name,
  provider_type, rating_bayes, jobs_completed, favourited_at}],
  next_cursor}` (cursor-paginated, newest first).

## 2. Photo reviews

Same signed-URL upload flow as dispute evidence
(`TrustService.requestEvidenceUpload`): the client requests a slot,
PUTs/POSTs the photo bytes to the returned `upload_url`, then passes
the `storage_key` when creating the review.

- `POST /jobs/{jobId}/reviews/upload-request` → 200 `{upload_url,
  storage_key}`. Key shape: `reviews/{jobId}/photo-{uuid}.bin`. Only a
  job party, only while the job is `PAYMENT_SETTLED` (reviews are only
  allowed then) — otherwise 403 / 409 `NOT_SETTLED`.
- `POST /jobs/{jobId}/reviews` now accepts optional `photo_keys:
  string[]` (max 3, enforced by the DTO and the service). Each key must
  have been issued for **this** job — a hand-typed or foreign key is
  rejected **422 `INVALID_PHOTO_KEY`** (same rule as dispute evidence
  `INVALID_EVIDENCE_KEY`); more than 3 keys is 422 `TOO_MANY_PHOTOS`.
  Photos are stored on the review row (`reviews.photos` jsonb) and
  returned in the review response.
- `GET /providers/{providerId}/reviews` and the provider detail
  (`GET /providers/{id}`) now return `photos: string[]` per review
  (empty array when none).

## 3. Live support

New tables `support_threads` + `support_messages` — **not** the
`chats`/`messages` tables. `chats` are keyed to a job + provider
(`job_id`/`provider_id` NOT NULL, every read joins
`provider_profiles`), so a support thread has no job and no provider
to hang off; reusing them would mean nullable FKs and a thread-type
column threaded through every chat query. The new tables mirror the
messaging shapes (cursor pagination, oldest-first message pages), so
the mobile client can render both the same way.

- `POST /support/threads` `{subject, message}` → 201 thread +
  `first_message` (one transaction). Rate-limited like chat
  (`messages` preset).
- `GET /support/threads` → the caller's own threads, newest first.
- `GET /support/threads/{threadId}/messages` → oldest-first page;
  `next_cursor` is the oldest message id in the page (pass it back for
  older messages). Customer or support only (403 otherwise).
- `POST /support/threads/{threadId}/messages` → customer replies on
  their own thread. Closed thread → 409 `THREAD_CLOSED`.
- `GET /admin/support/threads?status=open|closed` → all threads
  (roles `super_admin`, `support_agent`).
- `POST /admin/support/threads/{threadId}/messages` → support/admin
  reply. Best-effort push to the customer (`support.reply` template).
- `POST /admin/support/threads/{threadId}/close` → 200 closed thread.
  Close is final — a closed thread cannot be re-opened; the customer
  opens a new thread.

**No fake agent replies:** there is no bot, no canned reply, no
auto-response. An unanswered thread stays `status: 'open'` as a
ticket until a human replies or closes it.

## 4. Push notifications — plumbing only

What is built: device registration, a persisted preference, a
provider interface with an FCM implementation and a no-op fallback,
and best-effort sends on offer accepted/countered, job completed and
support reply. What is **not** built: any Firebase credential — see
`docs/push-notifications-setup.md` for exactly what the user must
still provide.

- `POST /devices/register` `{device_token, platform: 'android'|'ios'}`
  → 201 `{device_id, platform, last_seen_at}`. Upsert per user+device
  on `user_devices`. **The response never echoes the token.** The
  device key is the SHA-256 of the token (same hashing as refresh
  tokens, `auth.service.ts` FIX 2); the raw token is stored in the
  existing `user_devices.fcm_token` column because FCM can only
  deliver to the raw token (the same column `POST /me/devices`
  already stored it in). Raw tokens are never logged and never
  returned.
- `GET /users/me/notification-preferences` → `{push_enabled}`
  (default `true`, `users.push_enabled`, migration 0023).
- `PATCH /users/me/notification-preferences` `{push_enabled:
  boolean}` → updated preference. `false` stops all push sends.
- Send path: `NotificationsService.sendToUser(userId, templateKey,
  payload)` — **never throws**. Disabled preference → skip; no token
  → skip; provider unconfigured → log + skip; send failure → log.
  Every attempt writes a `notifications` row (`status` sent / skipped
  / failed). Sends are wired (best-effort) on: offer accepted
  (`offer.accepted` → provider), offer countered (`offer.countered` →
  provider), job completed (`job.completed` → customer), support reply
  (`support.reply` → customer). A push failure can never fail the
  calling request.
- Templates are plain titles/bodies keyed by template (`offer.accepted`
  etc.); payloads carry ids only, no PII.

## 5. Promo listing (home banner)

- `GET /promotions/active` → **public** (no auth — the banner renders
  before login) `{items: [{code, title, discount_text}]}`. Only
  promos that are active, inside their validity window, and (when
  `max_uses` is set) not yet exhausted. The `promos` table has no
  title column, so `title` echoes the code; `discount_text` is
  derived from kind/value (`"10% off"` / `"PKR 500 off"`). **No promo
  code is invented** — every row comes from the `promos` table.
  `FIRSTJOB10` (percent 10, seeded in `db/0005`) is listed while
  active.

## 6. Trust & safety

### 6a. Customer-confirms-completion

The old rule let **either** party mark a job `COMPLETED` (verified
gap: `JobsService.complete()` had no role check). The new rule:

1. **Provider marks work done** — `POST /jobs/{jobId}/complete` is
   now **provider-only**: a customer calling it gets **403**, a
   non-party gets 403. (The generic transition to `COMPLETED` by the
   customer is blocked the same way — it is the same act through
   another route.) On success the customer gets a best-effort
   `job.completed` push asking them to confirm.
2. **Customer confirms** — `POST /jobs/{jobId}/confirm-completion`
   (customer-only; provider → 403, non-party → 403). Double-confirm →
   **409 `ALREADY_CONFIRMED`**; confirming a job that is not
   `COMPLETED` → **409 `NOT_COMPLETED`**. Confirmation is stored as
   `jobs.completion_confirmed_at` (+ `completion_confirmed_by`) **and**
   as a `job_events` row (`COMPLETED` → `COMPLETED`, actor customer,
   payload `{event: 'completion_confirmed'}`) — the same dual
   recording the RATED transition uses.
3. **Payment is blocked until confirmation** — `confirmPayment`
   (cash), `payWithWallet`, and escrow release all return **409
   `COMPLETION_NOT_CONFIRMED`** while `completion_confirmed_at` is
   null. **Disputes stay available before settlement** (DISPUTED is
   legal from COMPLETED, unchanged).
4. **Auto-confirm** — if the customer does not confirm within the
   window, the sweep confirms it: `POST
   /admin/jobs/auto-confirm-completions` (roles `super_admin`,
   `city_manager`; cron entry point, no in-process scheduler).
   Window: feature flag `completion_confirm_window_hours`, **default
   48**, admin-configurable 1–720 hours — same pattern as
   `review_window_days` (read at sweep time; changing the flag needs
   no migration). Auto-confirmed jobs get a `job_events` row (actor
   `system`, payload `{reason: 'completion_auto_confirmed'}`).
   Idempotent: a re-run confirms nothing. Returns
   `{confirmed_count, confirmed_job_ids,
   completion_confirm_window_hours, checked_at}`.
5. **Escrow** — release waits for confirmation or auto-confirm:
   - Customer release (`POST /escrow/holds/{id}/release`) **is** the
     confirmation: it stamps `completion_confirmed_at` in the same
     transaction before any money moves, so no separate
     confirm-completion call is needed on that path.
   - Admin override (`POST /admin/escrow/holds/{id}/release`) does
     **not** imply confirmation — it requires the job to be confirmed
     already, else 409 `COMPLETION_NOT_CONFIRMED`.
   - Auto-release sweep (`POST /admin/escrow/auto-release`) skips
     unconfirmed due holds and reports them as `skipped_unconfirmed`
     (new field on the response, alongside `released` and
     `skipped_dispute`); disputes still take precedence (a disputed
     hold is `skipped_dispute`).
6. `GET /jobs/{jobId}` and `GET /jobs` now return
   `completion_confirmed_at` and `completion_confirmed_by` (null
   until confirmed).

### 6b. Pickup-time commitment + no-show

- `POST /offers/{offerId}/accept` accepts optional `scheduled_at`
  (ISO 8601 date-time). It must be in the future — a past value is
  **422 `SCHEDULED_AT_PAST`**, an unparsable value is 422
  `INVALID_SCHEDULED_AT`. It is stored on the linked
  `service_requests.scheduled_at` — **deliberately not a new
  `jobs.scheduled_at` column**: the Phase 2 reschedule flow already
  writes/reads that column, and `GET /jobs/{jobId}` / `GET /jobs`
  already surface it, so there is one source of truth and no
  divergence between two `scheduled_at` columns. The accept response
  echoes `scheduled_at` (null when not committed).
- `POST /jobs/{jobId}/report-no-show` (customer-only; provider →
  403, non-party → 403):
  - No committed time → 409 `NO_SCHEDULED_TIME`.
  - `now <= scheduled_at` → 409 `TOO_EARLY`.
  - Job already `COMPLETED` → 409 `JOB_ALREADY_COMPLETED`;
    terminal job → 409 `JOB_TERMINAL`.
  - On success: `provider_profiles.no_show_count` is incremented
    (returned as `no_show_count`), a `risk_events` row is written
    (`signal='no_show'`, `score_delta=12` — the risk engine weight
    from `db/0011`, so the next risk recompute sees it), and a
    `job_events` row is written (payload
    `{reason: 'provider_no_show', scheduled_at, no_show_count}`).
    **The job state does not change** — the customer can then cancel
    it via the normal transition, which is what "allows the customer
    to cancel afterwards" means. Returns `{job_id, provider_id,
    no_show_count, scheduled_at, reported_at}`.
  - The counter lives on `provider_profiles.no_show_count` (migration
    0023) so the risk/standing logic can read it directly; the
    `risk_events` row is the append-only record the risk engine
    scores from.

## Cron / scheduler entry points (no in-process scheduler in-repo)

| Endpoint | Schedule | Notes |
|---|---|---|
| `POST /admin/jobs/auto-confirm-completions` | Hourly | Confirms COMPLETED jobs older than the confirm window |
| `POST /admin/jobs/close-review-windows` | Nightly | Existing Fix B sweep, unchanged |
| `POST /admin/escrow/auto-release` | Hourly | Existing; now skips unconfirmed holds (`skipped_unconfirmed`) |
