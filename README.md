# Near Service — Phase 4 (Search Scale-out, Analytics Warehouse, Multi-city Ops, Warranty, Partner Integrations)

Local services marketplace for Pakistan. Launch city: **Quetta**. Launch
categories: **Book Binding, AC Repair, Electrician, Plumber, Mobile Repair**.
InDrive-style price negotiation applied to services: the customer posts a
request with their own PKR offer; nearby providers accept or counter-offer
(max 3 rounds); the customer accepts one; the job is tracked, paid in cash,
**wallet, or sandbox JazzCash/Easypaisa top-up**, and rated.

**Source of truth: Phase 0 PRD v1.1** (36 pages) +
`backend/openapi.yaml` (OpenAPI 3.1, **v1.6.0, 227 paths / 252 ops** — the
Phase 4 endpoints are folded into the YAML, enforced by the route-diff
test) + `docs/phase4-api-addendum.md` (human guide to every Phase 4
endpoint, env vars, schedules, vendor swap-in pointers, honesty notes) +
`docs/phase3-api-addendum.md` (Phase 3 endpoints) +
`docs/phase2-api-addendum.md` (Phase 2 endpoints; the v1.2 YAML was not
edited — folded into v1.5.0 here).
Name confirmed: **Near Service** (working title "Khidmat" dropped).
Timeline (v1.1): **16–20 weeks to the Quetta pilot for 1 Flutter + 1
backend dev** — the v1.0 "10–12 weeks" estimate was withdrawn.

Local services marketplace for Pakistan. Launch city: **Quetta**. Launch
categories: **Book Binding, AC Repair, Electrician, Plumber, Mobile Repair**.
InDrive-style price negotiation applied to services: the customer posts a
request with their own PKR offer; nearby providers accept or counter-offer
(max 3 rounds); the customer accepts one; the job is tracked, paid in cash,
and rated.

**Source of truth: Phase 0 PRD v1.1** (36 pages) +
`backend/openapi.yaml` (OpenAPI 3.1, Phase 1 only, 43 paths / 47 ops).
Name confirmed: **Near Service** (working title "Khidmat" dropped).
Timeline (v1.1): **16–20 weeks to the Quetta pilot for 1 Flutter + 1
backend dev** — the v1.0 "10–12 weeks" estimate was withdrawn.

## Layout

| Part | Path | Stack |
|---|---|---|
| Backend + API | `backend/` | NestJS 11 + TypeScript, port 3000, `/api/v1` |
| Database | `db/` | PostgreSQL 15 + PostGIS + pg_trgm, migrations + seed |
| Mobile app | `mobile/` | Flutter, Riverpod, go_router, flutter_map + OpenStreetMap |
| Admin panel | `admin/` | Next.js 14 + React + TypeScript + Tailwind, port 3001 |
| API contract | `backend/openapi.yaml` | Byte-identical copy of the PRD v1.1 skeleton |
| Demo script | `DEMO_SCRIPT.md` | Full end-to-end demo walkthrough |

## Quick start — local run with Docker (Fix C)

```bash
cp backend/.env.example backend/.env   # set real secrets before any real use
docker compose up -d --build
# The `migrate` one-shot service applies db/*.sql automatically and the
# backend only starts after it exits 0. Seed once, manually:
docker compose exec backend node backend/dist/scripts/seed.js
docker compose logs -f backend          # wait for "Near Service API listening on :3000"
curl http://localhost:3000/api/v1/ready  # {"status":"ready",...} (200)
# backend: http://localhost:3000/api/v1   admin: http://localhost:3001 (login page)
# mobile: cd mobile && flutter pub get && flutter run --dart-define=API_BASE_URL=http://<your-ip>:3000/api/v1
```

Images (Fix C): `backend/Dockerfile` (multi-stage, node:20-alpine,
non-root `app` user, production deps only, `/app/db` next to
`/app/backend/dist` so `node dist/scripts/migrate.js` works) and
`admin/Dockerfile` (multi-stage Next.js `output: "standalone"`, non-root
`nextjs` user, port **3001**). Build them directly with:

```bash
docker build -f backend/Dockerfile -t near-service-backend:latest .
docker build --build-arg NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1 \
  -t near-service-admin:latest ./admin
```

The admin listens on port **3001 everywhere** — `admin/package.json`
(`next start -p 3001`), `admin/Dockerfile` (`PORT=3001`), both compose
files (`3001:3001`), `infra/k8s/21-admin.yaml` and the Ingress.

Postgres note: the compose stack ships `postgis/postgis:15-3.4`
(Postgres 15). Postgres 16 was verified in this repo via the apt
install in the dev VM and the CI `migrate` job (`postgis/postgis:16-3.4`
service) — **not** via a local Docker run, because this VM has no
Docker. Both 15 and 16 are therefore supported in the senses stated;
do not read the CI 16 run as a Docker-Compose 16 run.

## Production-style run (docker-compose.prod.yml)

```bash
cp infra/docker-compose.prod.env.example .env.prod   # fill in EVERY value (see below)
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
# Migrations run automatically via the `migrate` one-shot service.
docker compose -f docker-compose.prod.yml logs -f backend
curl http://localhost:3000/api/v1/ready   # 200 when Postgres + Redis are up
# admin (behind a reverse proxy in real deployments): http://localhost:3001
```

In production the compose file expects pre-built registry images
(`BACKEND_IMAGE` / `ADMIN_IMAGE`, built by CI from the Dockerfiles and
pushed to the ECR repos Terraform creates). The Kubernetes path is
documented in `infra/README.md` and `infra/k8s/README.md`.

### Required environment variables for production

Generate fresh values — never reuse the dev placeholders. Secrets are
32+ characters unless noted:

| Variable | How to generate / value |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -base64 24` |
| `DATABASE_URL` | `postgresql://nearservice:<POSTGRES_PASSWORD>@postgres:5432/nearservice` (compose) or the RDS endpoint (managed path) |
| `REDIS_URL` | `redis://redis:6379` (compose) or the ElastiCache endpoint |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 32` |
| `JWT_REFRESH_SECRET` | `openssl rand -base64 32` (different value from the access secret) |
| `CNIC_PEPPER` | `openssl rand -base64 32` (HMAC pepper for `cnic_hmac`; never log, never store in the DB) |
| `OTP_HASH_SECRET` | `openssl rand -base64 32` |
| `FIELD_ENCRYPTION_KEY` | Base64 of exactly 32 bytes: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` (AES-256-GCM; rotate via `FIELD_ENCRYPTION_KEY_V2`, same format) |
| `PILOT_LOGIN_PHONE` / `PILOT_LOGIN_CODE` | **TEMPORARY PILOT ONLY — remove before public launch.** A single allowlisted owner phone (e.g. `+923333079204`) + a fixed 6-digit code, so the app can be tested end-to-end before an SMS provider exists. The code is never returned or logged; verify/lockout/TTL behaviour is identical to a normal OTP. The real path is Firebase phone auth / SMS gateway (PRD p.4). Unset both vars to disable the pilot path entirely. |
| `CORS_ORIGINS` | The admin origin only, e.g. `https://admin.nearservice.pk` (empty = no browser origin allowed) |
| `BACKEND_IMAGE` | ECR URL + tag, e.g. `<account>.dkr.ecr.ap-south-1.amazonaws.com/near-service/backend:<tag>` |
| `ADMIN_IMAGE` | ECR URL + tag, same pattern as above |
| `NEXT_PUBLIC_API_URL` | Public API base, e.g. `https://api.nearservice.pk/api/v1` (baked in at admin **build** time) |

Also set in production: `NODE_ENV=production`, `OTP_DEV_MODE=false`
(true prints OTPs to logs — dev only), `PAYMENT_GATEWAY_MODE=sandbox`
until live merchant onboarding is complete (live refuses to boot
without live keys), `STORAGE_UPLOAD_BASE_URL` to the S3 bucket URL
from Terraform (empty keeps the local dev receiver — not for
production). Optional with safe defaults: `JWT_ACCESS_TTL_SECONDS=900`,
`JWT_REFRESH_TTL_SECONDS=2592000`, `OTP_TTL_SECONDS=300`,
`OTP_MAX_ATTEMPTS_PER_PHONE_PER_HOUR=5`,
`COMMISSION_RATE_DEFAULT=0.10`. Sandbox gateway credentials
(`JAZZCASH_SANDBOX_*`, `EASYPAISA_SANDBOX_*`) come from the sandbox
portals; live equivalents stay empty until onboarding (see
`docs/phase2-payments-guide.md`).

## Environment variables

Backend (`backend/.env.example`): `DATABASE_URL`, `REDIS_URL`,
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CNIC_PEPPER` (HMAC pepper for
`cnic_hmac` — from a secrets manager in production, never hardcoded, never
logged), `OTP_DEV_MODE=true` (dev only: OTP is printed to the backend
console log, labelled `[DEV OTP]`), `PORT=3000`,
`STORAGE_UPLOAD_BASE_URL` (empty in dev: a local upload receiver serves
document uploads; in production point at configured object storage),
`COMMISSION_RATE_DEFAULT=0.10`,
`PAYMENT_GATEWAY_MODE=sandbox` (`sandbox` | `live` — live refuses to boot:
no live gateway client ships in this build),
`JAZZCASH_SANDBOX_MERCHANT_ID`, `JAZZCASH_SANDBOX_PASSWORD`,
`JAZZCASH_SANDBOX_RETURN_URL`, `EASYPAISA_SANDBOX_STORE_ID`,
`EASYPAISA_SANDBOX_HASH_KEY` (sandbox placeholders only; live equivalents
`JAZZCASH_LIVE_*` / `EASYPAISA_LIVE_*` stay empty until merchant onboarding
— see `docs/phase2-payments-guide.md`).
Admin (`admin/.env.example`): `NEXT_PUBLIC_API_URL`
(default `http://localhost:3000/api/v1`).

## What Phase 1 contains

- **Auth:** phone + OTP (dev-mode OTP logged; Firebase/WhatsApp/voice are
  production integrations, not in this repo), JWT access + rotating refresh
  with reuse detection, device fingerprint, dual customer/provider profiles.
- **Providers:** resumable onboarding wizard (identity, business, service
  area, payout), **manual-only verification** — Tier 0 → Tier 1 by a human
  officer in the admin queue. No OCR / face-match / liveness in Phase 1
  (OCR assist is manual-only in Phase 3, face-match + liveness are
  heuristic in Phase 3 — no real vendor is integrated; see
  `docs/phase3-api-addendum.md` §8 for the swap guides).
- **Discovery:** 3-level taxonomy with Roman Urdu / Urdu aliases, trigram
  fuzzy search, PostGIS nearby with the PRD ranking formula, fair-price
  range (percentile rules).
- **Bidding:** wave broadcast, accept / counter (max 3 rounds) / decline,
  10-minute TTL, atomic accept (Redis lock + `SELECT … FOR UPDATE` +
  idempotency key) — 10 concurrent accepts yield exactly 1 job (tested).
- **Jobs:** strict state machine with `job_events` audit log, illegal
  transitions return 409, mid-job price adjustments need customer approval,
  both-sides cash confirmation → double-entry ledger (10% commission,
  provider wallet goes negative until top-up).
- **Chat, trust, admin:** in-app chat with contact-sharing flag, SOS,
  reports/blocks, disputes, admin verification queue, users, categories,
  jobs, disputes, audit log.

## What Phase 2 adds

- **Wallet (one per user, profile-level views):** `GET /wallet` (balance +
  customer/provider views over the same wallet), `GET /wallet/transactions`
  (cursor-paginated ledger), top-up via sandbox JazzCash/Easypaisa
  (`POST /wallet/topup` + `/confirm`, every response labelled
  `sandbox:true`), `GET /payments/methods`, wallet-paid settlement
  (`POST /jobs/:id/pay-wallet`, 409 when short). Cash still works.
- **Gateways:** `PaymentProvider` interface + `CashProvider`,
  `JazzCashSandboxProvider`, `EasypaisaSandboxProvider` — deterministic
  mock references, never touch the network. Live mode refuses to boot
  (no live client ships). Merchant onboarding guide:
  `docs/phase2-payments-guide.md`.
- **Commission engine:** most-specific-rule-wins resolution
  (category+city+tier → global), 5–15% band enforced, snapshotted on the
  job at accept, admin CRUD at `/admin/commission-rules`, negative-balance
  block threshold (`commission_block_threshold_paisa`, default −PKR 5,000).
- **Promo / referral:** side-effect-free `POST /promos/validate`
  (per-user / per-device / first-job-only / expiry / scope checks),
  redemption recorded only at payment, seeded `FIRSTJOB10` (10% off,
  first job only), referral codes (`NS-…`) with PKR 200 credit on the
  referred user's first paid job, admin promo CRUD.
- **Dispute centre:** evidence upload, user dispute list, admin resolve
  (`refund` / `partial_refund` / `compensation` / `no_action`) — all
  ledger-backed with balanced entries, job → `REFUNDED` / `PAYMENT_SETTLED`
  / pre-dispute state, SLA timers (4h first response, 48h resolve) with
  breach flags, assign-to-officer. Admin disputes page is fully functional.
- **Live tracking:** `provider.location` Socket.IO event (provider-only,
  en-route states only, >200 km/h points rejected + flagged), `GET
  /jobs/:id/tracking` (live point + distance/ETA + 48h trail), tracking
  stops at `ARRIVED`/completion. Mobile shows the live marker + ETA and
  emits while en route at adaptive intervals.
- **Dynamic forms:** admin `PUT /admin/categories/:id/form-schema`
  (validated JSON Schema, live immediately, no app release); all 5 launch
  forms verified real and re-asserted by migration `0006`.
- **Scheduling:** `POST /jobs/:id/reschedule` (price kept; scope change →
  409, renegotiate first), recurring jobs (`POST/GET/PATCH
  /recurring-jobs`, `skip-next`, `POST /admin/recurring-jobs/run-due` for
  an external cron — no cron infra in this repo), `job.reminder`
  notification rows for both parties.
- **Contract gaps closed:** `GET /jobs` + `GET /jobs/:id`, `GET
  /admin/kpis`, `GET /admin/requests`, `PATCH /admin/users/:id/suspend`,
  category writes, provider services / service-area / availability /
  reviews, `POST /waitlist`, `/me/devices`, `/me/trusted-contacts`,
  `GET /chats`, `GET /requests/:id/chat`. Admin and mobile now call real
  data for these (labelled demo fallback remains only when the API is
  unreachable).
- **Weekday numbering decided:** availability uses the v1.2 contract
  (0=Monday..6=Sunday); the nearby open-now check converts Postgres
  `EXTRACT(DOW)` accordingly. Recurring `day_of_week` uses JS/Postgres
  DOW (0=Sunday); the mobile picker converts with `_dayOfWeek % 7`.

## What Phase 3 adds

- **AI Gateway (local provider only):** `POST /ai/intent` (rule-based
  intent parsing over the live taxonomy, PII redacted before any provider
  call), `POST /ai/photo-search` (heuristic keyword match — NOT vision),
  `POST /ai/voice-search` (client transcript only; audio-only → 422
  `STT_UNAVAILABLE`, no STT in the local provider), `GET /ai/fair-price`
  (OLS regression, used only when n ≥ 8 and R² ≥ 0.30, else the percentile
  range), chat translation toggle + per-message translate
  (`/ai/chats/:id/translation`, `/ai/chats/:id/messages/:messageId/translate`
  — exact-phrase dictionary, never invented). `GET /ai/health` reports the
  provider + capabilities. `AI_PROVIDER` must be `local` or the service
  refuses to boot. Swap guide: `backend/src/modules/ai-gateway/README.md`.
- **Risk engine:** stored scores only (`GET /risk/me`, admin review queue
  + settings, recompute). `ProvidersService.nearby()` applies the stored
  penalty per candidate via `applyRiskPenaltyToRankScore` — **blocking is
  deliberately NOT applied in ranking**.
- **Subscriptions:** seeded plans Free (PKR 0) / Pro (PKR 999, ×0.80
  commission) / Business (PKR 2,499, ×0.60, featured, 5 staff). The
  effective rate is snapshotted onto the job at accept
  (`effectiveCommissionRate`, clamped 0.05–0.15); featured providers show
  `sponsored: true` with label "Sponsored". Analytics for Pro/Business.
- **Teams:** create/invite/accept/remove, job assign/unassign, team jobs
  + earnings; size capped by the owner's plan (`TEAM_LIMIT_REACHED`).
- **Tenders (B2B):** sealed quotes, audit trail, award creates the job
  and charges a **flat PKR 500 lead fee once to the winning provider**
  (never per quote). Deadline expiry via `POST /admin/tenders/expire-due`
  (operator runs it hourly — no cron infra in this repo).
- **Verification:** heuristic face-match + challenge liveness + manual
  OCR extraction record — all advisory, all labelled
  `is_real_biometric: false` where applicable. Evidence feeds the admin
  verification queue (`verification_evidence`); **the module never
  approves anything** — tier upgrades stay gated on the officer's explicit
  decision. Swap guide (AWS Rekognition / NADRA e-KYC):
  `backend/src/modules/verification/README.md`.
- **Escrow & payouts:** holds, release (customer/admin/auto-release
  sweep, 48h default, min PKR 5,000), payout requests + admin
  approve/reject + run-due sweep. **Every payout response carries
  `sandbox: true`** — no live payout rail exists.
- **iOS target configured only:** `mobile/ios/` (bundle id
  `com.nearservice.app`, permissions in `Info.plist`, signing
  placeholders) — **never built** (no macOS/Xcode in this VM). See
  `mobile/ios/README.md`.
- **Admin:** new Risk Review, Subscriptions, and Finance — Escrow pages;
  the Verifications page now shows face-match/liveness/OCR evidence.
- **Mobile:** new AI search, tenders, subscription, teams, verification,
  and escrow screens; chat translation toggle. **Not compiled** — no
  Flutter/Dart in this VM (see Verification status).

## What Phase 4 adds

- **Search scale-out:** `GET /search` keeps its wire shape; the gateway
  now runs one of three `SearchProvider`s — `trigram` (Phase 1 SQL,
  default), `scaled` (pg full-text + trigram + Redis cache), `remote`
  (HTTP forward to `SEARCH_SERVICE_URL`). New admin endpoints
  `GET /admin/search/metrics`, `GET /admin/search/gate`,
  `PATCH /admin/search/gate/thresholds`, plus public
  `POST /search/click` for real CTR. Env: `SEARCH_PROVIDER`,
  `SEARCH_SERVICE_URL`, `SEARCH_CACHE_TTL_SECONDS` (120),
  `SEARCH_CACHE_ENABLED` (true). Cache invalidation is wired at every
  category/provider write (best-effort, never fails the write). Swap
  guide: `docs/phase4-api-addendum.md` §1.
- **Analytics warehouse:** nightly ETL (`POST /admin/analytics/etl/run`,
  **02:00 PKT from the external scheduler** — no in-repo cron) copies
  operational data into `analytics_*` facts; dashboards read facts only
  (`/admin/analytics/funnel`, `/revenue`, `/supply-demand`,
  `/etl/status`, `/export/:table`). Exports are operational reports,
  **not a tax filing**.
- **Multi-city ops:** cities table + go/no-go gate
  (`/admin/cities`, targets, gate config/evaluations, checklist,
  category overrides, effective commission, fair price). **Quetta is
  `live`; Karachi is `in_preparation` — its gate honestly FAILS (3
  providers vs 10 needed).** Public SEO landing pages: `/services`,
  `/services/{categorySlug}/{areaSlug}`, `/shops/{providerId}`.
- **Warranty product:** 7-day workmanship warranty, **Tier 3 only,
  rework first, refund only if rework fails** (13 user + 10 admin
  routes under `/warranty` and `/admin/warranty`). The fee is collected
  at settlement — hooked into **both** settlement paths (cash +
  wallet) — and never throws: a failed collection leaves the warranty
  `pending_payment` with the manual `collect-fee` fallback. Daily
  expiry sweep via `POST /admin/warranty/expire-due`. **Known gap:**
  a refunded claim on an escrow-held job does not yet coordinate with
  escrow release (see Known gaps).
- **Partner integrations:** parts-supplier affiliate ordering
  (`/partners/catalog`, `/partners/orders`, `/admin/partners`, fee
  report). **The local catalog is the working implementation** — no live
  supplier exists; swap in one adapter via
  `PartnersService.setProvider(...)`. Prices are always server-priced;
  every order view carries the partner disclosure.
- **Admin:** new Analytics (+ exports), Cities, Partners, Warranty and
  Search Metrics pages; Sidebar entries for all five; typed helpers in
  `admin/src/lib/api.ts` and row types in `admin/src/lib/types.ts`.
- **Mobile:** `ApiClient` gains the partner methods (implements
  `PartnerApi`) and seven warranty methods; router entries
  `/provider/parts` and `/admin/search-metrics`; `WarrantyBadge` on the
  provider profile. **Not compiled** — no Flutter/Dart in this VM.

## Verification status (honest)

Verified in this workspace (Node v24):

- Backend: `npm test` — **12 suites, 86 tests, all passed** (Phase 1: 34
  tests; Phase 2 adds wallet ledger, commission math, promo abuse limits,
  referral credit, dispute refund flow, scheduling, tracking, contract
  gaps). `npm run build` — exit 0. `npm run lint` (`tsc --noEmit`) —
  exit 0. (One transient failure during the parallel build — a sibling's
  unfinished spec file — was fixed by that stream before final
  verification; the final run is clean.)
- Admin: `npm run build` ✅ (14 pages incl. new `/promos` and
  `/commission`), `npx tsc --noEmit` ✅.
- Mobile: **not compiled** — no Flutter/Dart in this VM. Review pass:
  tokenizer brace-balance check over all 38 Dart files (0 errors), every
  import resolves, every route used exists in `router.dart`, every API
  method called exists in `api_client.dart`, no TODOs. Run `flutter
  analyze` / build on a Flutter machine before shipping.
- **Live-DB boot and migration execution were NOT verified here** — no
  Docker / Postgres / psql in this VM. Migrations `0005`/`0006` were
  reviewed as SQL only. Run them on a machine with Docker before claiming
  the stack runs end-to-end.
- **Phase 3 (2026-11-17, this workspace — Postgres 16 + PostGIS 3 +
  Redis, all running locally):** full backend suite `npx jest --config
  test/jest.config.js --runInBand --forceExit` — **36 suites, 469 tests,
  all passed** (was 35/456 at the tenders worker's run; +1 wiring spec,
  13 tests). `npm run lint` exit 0, `npm run build` exit 0. Fresh-DB
  migrate (`nearservice_p3_fresh`) applied **0001–0015, exit 0**,
  `schema_migrations` count 15. `openapi.yaml` v1.5.0 (161 paths /
  179 ops) validated with **openapi-spec-validator: 0 errors**; route-diff
  test passing (contract + wiring specs: 2 suites / 21 tests). Admin
  `npm run build` exit 0 — **17 pages** incl. new `/risk`,
  `/subscriptions`, `/finance`. Mobile: **still not compiled** (no
  Flutter/Dart in this VM); iOS target **configured only, never built**
  (no macOS/Xcode). The reported `tsc` errors in `ai-gateway.service.ts`
  (×2) and `verification.controller.ts` (×1) **do not reproduce** — lint
  and build pass clean.

- **Phase 4 (2026-11-17, this workspace — Postgres 16 + PostGIS 3 +
  Redis, all running locally):** fresh-DB migrate (`nearservice_p4_fresh`)
  applied **0001–0020, exit 0**, `schema_migrations` count 20 (the
  earlier reported FK violation in 0018 did **not** reproduce — it was a
  mid-write read). Backend `npx tsc --noEmit` exit 0, `npm run build`
  exit 0. `openapi.yaml` v1.6.0 (227 paths / 252 ops) validated with
  **openapi-spec-validator: 0 errors**; route-diff test passing
  (spec == code, zero extra, zero missing). Admin `npx tsc --noEmit`
  exit 0, `npm run build` exit 0 — **22 pages** incl. new `/analytics`,
  `/cities`, `/partners`, `/warranty`, `/search-metrics`. Search-click
  integration test 3/3 passed. Mobile: **still not compiled** (no
  Flutter/Dart in this VM); brace-balance + import checks only.
  **Full backend suite: started in the background 2026-11-17 and still
  running at the time of writing — its result is in the integrator's
  report; do not treat this line as a pass.**

## Known gaps (do not silently ignore)

1. **OCR assist is manual-only in Phase 3** (extraction record +
   officer confirm, no OCR vendor). Face-match is a heuristic and
   liveness is challenge-response — neither is a real biometric check,
   and none of them verifies a CNIC against NADRA. Vendor swaps are a
   Phase 4 decision; see `docs/phase3-api-addendum.md` §8.
2. Backend dev-only extra route: `POST /api/v1/uploads/:key` (local
   upload receiver when `STORAGE_UPLOAD_BASE_URL` is unset).
3. In-app photo upload for dispute evidence does not exist yet — mobile
   records a photo as a note for support and tells the user to share the
   actual photo on chat.
4. Promo race: concurrent redemptions on *different* jobs could race past
   a per-user limit (same-job races are closed in-transaction). Add a
   DB-level guard if abuse is observed.
5. `GET /chats` and `GET /requests/:id/chat` live in the jobs/requests
   modules, not the messaging module — marked in code for a later move.
6. No `payments` row is written on dispute refund (ledger + wallets + job
   state + dispute resolution + audit log capture it fully).
7. Escrow release and provider payouts are **built, sandbox only**
   (every payout response carries `sandbox: true`). Live gateway clients
   and live payout rails are **not** built (live mode refuses to boot).
8. **Warranty ↔ escrow coordination gap (Phase 4):** a refunded warranty
   claim on an escrow-held (not yet released) job does not coordinate
   with escrow release — the platform bears the refund and the hold
   still needs releasing/refunding via the escrow flow. See
   `docs/phase4-api-addendum.md` §4.
9. **Cities mobile picker not built (Phase 4):** no public `GET /cities`
   endpoint exists, so the mobile app has no city list to show. Adding
   it is a new route + openapi entry + tests.
10. **Warranty mobile widgets partially placed (Phase 4):** only the
    `WarrantyBadge` is wired (provider profile). `WarrantyOptInCard`
    (booking), `WarrantyClaimForm` (job detail) and
    `WarrantyReceiptSection` (receipt) are built but not yet placed.

## What needs a real key / account before production

- **Firebase** (phone OTP + FCM) — project, Android app + SHA fingerprints.
- **Google Play Console** — organisation account, USD 25 one-time.
- **Google Maps Platform** — only if switching from OSM tiles; the MVP
  uses OpenStreetMap via flutter_map, no key needed.
- **SMS / WhatsApp gateway** — Pakistan-capable provider + sender ID
  (fallback OTP, critical SMS).
- **JazzCash / Easypaisa merchant accounts** — Phase 2 only; apply during
  Phase 1 so wallet launches on time.
- **AI / verification vendors (Phase 3 swaps, when the user chooses):**
  a Google Cloud project (Vertex AI / Vision / Speech-to-Text /
  Translation) or an OpenAI account for the AI Gateway; an AWS account
  with Rekognition CompareFaces + FaceLiveness (or a NADRA-integrated
  e-KYC vendor) for verification. The user creates these accounts;
  no key exists in this repo and none was invented.
- **Secrets manager + object storage + managed Postgres/Redis hosting**
  for production; `CNIC_PEPPER`, JWT secrets must come from the secrets
  manager. **No real keys exist in this repo — none were invented.**
- **Pakistan-qualified lawyer** before public launch (data protection,
  wallet/escrow fund-holding, FBR/PRA/SRB tax, PTA) — flagged in PRD v1.1.

## Phase 4 is done — stop here

Do **not** start Phase 5. There is no Phase 5 scope in PRD v1.1 —
Phase 4's remaining work is the honest gaps listed above (warranty ↔
escrow coordination, `GET /cities`, warranty widget placement), each a
separate go-ahead, not a new phase.
