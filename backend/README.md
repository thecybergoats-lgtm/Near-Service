# Near Service — Backend (Phase 1 MVP, PRD v1.1)

NestJS 11 modular monolith (TypeScript) + PostgreSQL 15/PostGIS + Redis + Socket.IO.
Base URL: `/api/v1`. Port `3000`. The contract of record is `openapi.yaml` — an
exact copy of the v1.1 OpenAPI 3.1 skeleton (43 paths / 47 ops, Phase 1 only).
No endpoints exist beyond that skeleton (plus a dev-only local upload receiver,
see below).

**Timeline (v1.1): 16–20 weeks to the Quetta pilot for 1 Flutter + 1 backend dev**
(13–15 weeks to feature-complete, plus 3–5 weeks of pilot hardening). The v1.0
10–12-week figure was withdrawn in v1.1.

## Setup
```bash
cp .env.example .env        # edit secrets; OTP_DEV_MODE=true in dev only
npm install
npm run migrate             # applies ../db/0001..0004 (needs live Postgres)
npm run seed                # applies ../db/0004_seed.sql
npm run start:dev           # http://localhost:3000/api/v1/categories
```

## Env
`DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`JWT_ACCESS_TTL_SECONDS` (900), `JWT_REFRESH_TTL_SECONDS` (2592000),
`OTP_DEV_MODE` (true = OTP printed to console, clearly labelled; **false in prod**,
where Firebase phone auth / SMS gateway sends it), `OTP_TTL_SECONDS` (300),
`COMMISSION_RATE_DEFAULT` (0.10), `PORT` (3000),
`CNIC_PEPPER` — HMAC key for `cnic_hmac`; loaded from the **secrets manager in
production, never hardcoded, never logged, never stored in the DB**,
`STORAGE_UPLOAD_BASE_URL` (object storage for document uploads; unset = local
dev receiver only).

## Stubs (the only two allowed)
- **OTP dev mode**: code logged as `[DEV OTP]`; no SMS sent. Production must use Firebase/SMS.
- **FCM**: `src/common/utils/push.ts` logs `[FCM STUB]` and the notification is
  recorded in-app; no push is delivered. Wire real FCM in Phase 2.

Everything else is real business logic — no TODO/placeholder logic.

## Key rules implemented (PRD v1.1)
- Auth: OTP request (**202**, rate-limited) → verify (**200**, creates account on
  first verify, `device_fingerprint` required) → access + rotating refresh JWT;
  refresh reuse detection revokes the whole family; logout revokes (**204**).
- Identifiers: `category_id` is a **UUID end-to-end**. Clients may send
  `category_slug` instead; the API resolves it server-side to the canonical
  UUID. If both are sent and disagree → **422** `CATEGORY_MISMATCH`.
- Dual profiles: one phone = one account; customer + provider profiles on it.
- Providers: resumable onboarding `{step, data}` (identity/business/service
  area/payout); **Phase 1 verification is MANUAL review only** — a human
  verification officer decides each document (CNIC front/back + selfie
  side-by-side); the admin queue lists pending documents. CNIC stored encrypted
  + `cnic_hmac` (HMAC-SHA256 with `CNIC_PEPPER`, never a plain hash).
- Wallet: **exactly one wallet per user** (`wallet_accounts.user_id` UNIQUE,
  get-or-create only). Customer and provider are profile-level views over that
  one wallet — never separate wallets.
- Nearby: PostGIS `ST_DWithin` + ranking formula (w1 .30, w2 .22, w3 .13, w4 .13,
  w5 .10, w6 .07, w7 .05; Bayesian rating prior 3.8/10 jobs). Returns an array of
  ProviderCards.
- Search: pg_trgm fuzzy + keyword aliases incl. Roman Urdu/Urdu (`jild saazi`,
  `جلد سازی`, `AC theek karwana`, `bijli wala`, `nalka band`…).
- Fair range: p10/p50/p90 over completed-job prices, seed fallback; client hides
  it when `sample_size` is too small.
- Bidding: wave-1 broadcast to nearest 5–10 online providers; max 3 counter
  rounds; TTL 10 min; `Idempotency-Key` on mutating calls; **atomic accept** =
  Redis lock + DB transaction (`SELECT … FOR UPDATE`) + in-process acceptor —
  exactly one job, 409 otherwise.
- Jobs: strict state machine (illegal transition → 409 **and** a `job_events`
  row); price adjustments need customer approval; cash payment confirmed by
  **both** sides → settlement + double-entry ledger (commission 10%, the user's
  single wallet may go negative); reviews only after `PAYMENT_SETTLED`, one per
  side, Bayesian rating update. `payment_status` is `unpaid` → `settled`.
- Messaging: chat with contact-sharing regex flag (`is_flagged`); cursor
  pagination; Socket.IO rooms `request:{id}`, `job:{id}`, `user:{id}`.
- Trust: disputes (SLA 4h first response / 48h resolve), reports, mutual blocks,
  SOS (**202**, never rate-limited).
- Admin: manual verification queue + per-document decide (approving the last
  pending identity document upgrades Tier 0→1), users, categories (read),
  jobs, disputes, audit-logs; every admin write → `audit_logs`.
- Errors: single shape `{error:{code,message,details},request_id}`. Creates
  return **201**, OTP/SOS **202**, logout **204**, conflicts **409**,
  slug/id mismatch **422**.

## Tests
```bash
npm test        # Jest; unit tests are DB-free. Contract tests skip DB-backed checks when DATABASE_URL is unset.
npm run build   # nest build -> dist/
```

## Not verified in this VM
No Docker / Postgres / psql here, so **boot against a live database and
migration execution were NOT verified** (migrations were reviewed as SQL only).
Run `docker compose up` (Postgres 15 + PostGIS + Redis) on a machine with
Docker, then `npm run migrate && npm run seed && npm run start:dev`.
