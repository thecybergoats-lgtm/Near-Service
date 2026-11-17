# Stage 3 fixes (FIX 11–15) — Near Service

All five MEDIUM-priority fixes from the independent review, verified on
real Postgres 16 + PostGIS 3 and real Redis (test DB
`nearservice_stage3_test`). Full backend suite after Stage 3: **23 suites /
284 tests, all passing** (`npm test -- --runInBand`; parallel workers share
one test DB and collide on schema drops, so run in band).

## FIX 11 — `is_open_now` equals `is_online`
- New `backend/src/common/utils/availability.ts`: `isOpenNow(slots, now)`
  computes open-now in **Asia/Karachi** from the provider's availability
  rows. Handles overnight slots (22:00–02:00, including the after-midnight
  tail) and day-offs. A day-off closes the whole calendar day, including
  any overnight tail from the previous day (documented choice).
- `ProvidersService.nearby()` and `getById()` use the computed value. The
  old SQL open-now filter (DB server local time, never matched overnight
  slots) is removed; `open_now=true` is applied in memory after computing.
- The hard-coded `isOpenNow: true` in the ranking call is gone (real
  computed value), and `fairTypicalPkr: null` is replaced by the real
  fair-price typical for the filtered category (null only when there is no
  category filter or the sample is too small to publish).
- **Weekday numbering — single source of truth is `availability.ts`:**
  `provider_availability.weekday` is 0=Monday..6=Sunday (OpenAPI v1.2);
  `recurring_jobs.day_of_week` is 0=Sunday..6=Saturday (Postgres DOW /
  JS `getDay()`). Conversion: availability = (postgresDow + 6) % 7.
  `SchedulingService` and `updateAvailability` comments point here.

## FIX 12 — CORS allowlist
- Env `CORS_ORIGINS` (comma-separated, `backend/src/config/env.ts`),
  `buildCorsOptions()` in `backend/src/config/cors.ts`, wired in `main.ts`.
  Non-empty list → only those origins (credentials allowed). Empty list in
  **production → no browser origin** (`origin: false`); empty outside
  production keeps the old allow-all dev behaviour. Set in
  `docker-compose.yml` (`CORS_ORIGINS: "http://localhost:3001"`) and
  documented in `backend/.env.example`.

## FIX 13 — `/health` and `/ready`
- New `HealthModule` (`GET /health` → 200 when up; `GET /ready` → 200 only
  when Postgres AND Redis answer, else 503 naming the failing dependency).
  Both `@Public()` and never rate-limited. `RedisService.ping()` returns
  true only for a real Redis PING within 2s (the in-memory fallback counts
  as down). Added to `openapi.yaml` (v1.4.0) and `docker-compose.yml`
  (backend healthcheck runs `node -e fetch(.../api/v1/ready)`).

## FIX 14 — known issues
- **(a) Promo race:** `WalletService.payWithWalletInner` now locks the
  promo row `SELECT ... FOR UPDATE` before the in-txn per-user re-count,
  serialising concurrent redemptions of the same promo. The old re-count
  without a lock could not stop two parallel payments on different jobs
  (the `promo_redemptions` PK is `(promo_id, user_id, job_id)`).
- **(b) Refunds write a payments row:** `AdminService.resolveDispute`
  inserts a `payments` row in the same transaction as the ledger legs —
  status `refunded` (full) / `partially_refunded` (partial), amount in PKR.
  Migration `db/0009_stage3_fixes.sql` widens `payments.status` to
  `varchar(20)` (`partially_refunded` is 18 chars).
- **(c) Dispute photo evidence:** new
  `POST /disputes/:id/evidence/upload-request` (`TrustService.
  requestEvidenceUpload`) issues a dispute-namespaced random storage key
  with an upload URL — the same flow as provider document uploads (local
  dev receiver `POST /api/v1/uploads/:key` when no storage is configured).
  `addEvidence` kind=photo now rejects any key not issued for that dispute
  (422 `INVALID_EVIDENCE_KEY`). `openapi.yaml` updated (old "no direct
  in-app upload API" note replaced).
- **(d) GET /chats moved:** `listChats` moved from `JobsQueryService` /
  `JobsController` to `MessagingService` / `MessagingController`
  (`GET /api/v1/chats`). Route, query params and response shape unchanged.

## FIX 15 — crypto-safe randomness and no secrets in logs
- **(a)** Sweep found no `Math.random` anywhere in `backend/src`,
  `admin/src` or `mobile/lib`. The one predictable value was the document
  storage key (`...-${Date.now()}.bin`) — now `crypto.randomUUID()`.
  OTP codes already used `crypto.randomInt`.
- **(b)** The dev OTP log no longer prints the code (it used to:
  `[DEV OTP] phone=... code=...`). New `common/utils/log-redaction.ts`
  (`redactSecrets`: JWTs, OTP/code values, secret key=value pairs, CNICs)
  applied in the unhandled-exception filter and the FCM push stub.
  Unit test feeds a log line with a JWT + OTP code and asserts neither
  survives (note: the phone `+923001234567` itself ends in `123456`, so
  the test uses code `654321` to keep the assertion meaningful).
- **(c) Flutter nearby parser:** `mobile/lib/core/api_client.dart` —
  `parsePage` and the inline parsers (wallet txns, jobs, recurring,
  disputes, search providers) now read ONLY `items` from the v1.2+
  envelope; the `{data}` and bare-list fallbacks are removed. A bare List
  is still accepted ONLY where the backend genuinely returns a bare array
  by contract (`GET /categories`, `GET /payments/methods`,
  `GET /me/trusted-contacts`, `GET /providers/me/services`). The nearby
  call site documents that it reads `items` and that `is_open_now` is
  computed server-side in Asia/Karachi (FIX 11). **Not compile-verified:
  no Flutter/Dart in this VM — hand-checked only.**

## OpenAPI
- Version bumped 1.3.0 → **1.4.0**: 92 paths / 102 ops (was 89/99).
  Added `/health`, `/ready`, `POST /disputes/{id}/evidence/upload-request`,
  `HealthStatus` / `ReadinessStatus` schemas. Contract route-diff test
  passes (no extra/missing routes).

## Remaining risks (see final report for the full list)
- Promo `validatePromo` still runs outside the payment transaction, so a
  loser can fail with `PROMO_INVALID` (wrapping `PROMO_PER_USER_LIMIT`)
  instead of the in-txn code — same outcome, different code.
- `/ready` treats the Redis in-memory fallback as down by design.
- Mobile changes are hand-checked only (no Flutter in VM).
