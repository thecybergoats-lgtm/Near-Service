# Near Service — Phase 2 API Addendum

Phase 2 endpoints added on top of the OpenAPI 3.1 v1.2 contract
(`../your_files/near-service-phase-0-prd/near-service-openapi-v1.2.yaml`).
**The v1.2 YAML file was not edited.** This addendum is the contract for
everything below; a future v1.3 should fold it into the YAML.

Base URL: `/api/v1`. All responses use the Phase 1 error shape
`{ "error": { "code", "message", "details" }, "request_id" }`.
List endpoints return the v1.2 envelope `{ "items": [...], "next_cursor" }`
unless noted. Mutating marketplace calls accept `Idempotency-Key`
(replay returns the original response; same key + different body → 422
`IDEMPOTENCY_KEY_REUSED`). All money is integer paisa in the ledger;
amounts in request/response bodies are PKR decimals. Currency is PKR.

## 1. Wallet & payments

| Method | Path | Purpose | Roles / notes |
|---|---|---|---|
| GET | `/wallet` | The user's ONE wallet + derived profile views. `{balance_paisa, balance_pkr, escrow_held_paisa, currency:"PKR", profile_views:{customer:{balance_pkr,spent_pkr,pending_pkr}, provider:{balance_pkr,earnings_pkr,commission_owed_pkr,pending_pkr}}}`. Customer and provider are views over the same wallet — never two wallets. | Any authenticated user |
| GET | `/wallet/transactions?cursor=&limit=` | Cursor-paginated ledger. Items: `{id, txn_id, account_code, direction:"debit"\|"credit", amount_paisa, amount_pkr, job_id, memo, created_at}`. Limit default 20, max 50. | Owner only |
| GET | `/payments/methods` | Available payment methods: `cash`, `wallet`, `jazzcash` (sandbox), `easypaisa` (sandbox). | Public (authenticated) |
| POST | `/wallet/topup` | Initiate a gateway top-up. Body `{method:"jazzcash"\|"easypaisa", amount_pkr>0, phone}`. Returns `{payment_id, provider, status, reference, sandbox:true}`. Idempotency-Key. | Owner |
| POST | `/wallet/topup/confirm` | Confirm a sandbox top-up. Body `{payment_id}`. Credits the wallet with balanced `D cash_in / C wallet` ledger rows in one transaction. Idempotency-Key. | Owner |
| POST | `/jobs/:id/pay-wallet` | Pay a COMPLETED job from the wallet. Body `{promo_code?}`. One transaction: debit customer (price − promo), credit provider (price − commission per the job's `commission_rate` snapshot), promo absorbed as `promo_expense`. Job → `PAYMENT_SETTLED` + `job_events` + `job.state_changed`. 409 `INSUFFICIENT_WALLET_BALANCE` when short. Idempotency-Key. | Job customer only |

## 2. Gateways (PaymentProvider interface)

`PaymentProvider { initiate, confirm, refund, payout }`. Implementations
shipped: `CashProvider`, `JazzCashSandboxProvider`, `EasypaisaSandboxProvider`
— all sandbox responses carry `sandbox:true` and deterministic mock
references (`JC-SANDBOX-…`, `EP-SANDBOX-…`) and never touch the network.
`PAYMENT_GATEWAY_MODE=sandbox` (default) or `live`. Live mode refuses to
boot without live credentials **and** refuses to boot with them, because no
live provider implementation ships in this build — a live client, request
signing and callback verification are still to be built. See
`docs/phase2-payments-guide.md` for merchant onboarding. No escrow release
endpoint ships in Phase 2 (`escrow_held_paisa` is recorded only).

## 3. Commission engine

| Method | Path | Purpose | Roles |
|---|---|---|---|
| GET | `/admin/commission-rules` | List commission rules. | super_admin, finance |
| POST | `/admin/commission-rules` | Create a rule `{category_id?, city_id?, tier?, rate, valid_from, valid_to?, is_promo?}`. Rates outside 0.05–0.15 are rejected (422). | super_admin, finance |
| PATCH | `/admin/commission-rules/:id` | Update `{rate?, valid_to?, is_promo?}`. | super_admin, finance |

Resolution (shared util `common/utils/commission.ts`): most specific matching
rule wins — category+city+tier > category+city > category+tier > city+tier >
category > city > tier > global — within its valid date range, else the env
default `COMMISSION_RATE_DEFAULT` (0.10); result clamped to 0.05–0.15.
The rate is snapshotted onto the job as `commission_rate` at accept time.
Cash jobs accrue commission as a negative provider wallet balance; when the
balance falls below the `commission_block_threshold_paisa` feature flag
(default −500000 paisa = −PKR 5,000) the provider's new offers are rejected
with 409 `COMMISSION_BLOCKED` until they top up.

## 4. Promo & referral

| Method | Path | Purpose | Roles / notes |
|---|---|---|---|
| POST | `/promos/validate` | Side-effect-free validation. Body `{code, category_id?, amount_pkr}` → `{valid, kind, value, discount_paisa, reason?}`. Checks active flag, date window, category/city scope, max uses, per-user limit, per-device limit, first-job-only. | Any authenticated user |
| GET | `/referrals/me` | `{code, referred_count, credit_paisa, pending_count}`. Code is `NS-` + first 8 hex chars of the user id. | Owner |
| POST | `/referrals/claim` | Link this account to a referrer. Body `{code}`. One referrer per user, no self-referral. | Owner |
| GET | `/admin/promos` | List promos. | super_admin, marketing |
| POST | `/admin/promos` | Create a promo `{code, kind:"percent"\|"fixed", value, max_uses?, per_user_limit?, valid_from?, valid_to?, category_id?, city_id?, first_job_only?}`. | super_admin, marketing |
| PATCH | `/admin/promos/:id` | Update `{is_active?, valid_to?, …}`. | super_admin, marketing |

Promo redemption is recorded **only** at successful payment
(`POST /jobs/:id/pay-wallet`); validation never consumes a redemption.
Seeded promo: `FIRSTJOB10` (10% off, first-job-only, 1 per user).
Referral credit: PKR 200 to the referrer when a referred user completes
their **first paid job**, as a balanced ledger entry in the same settlement
transaction. Promo validate→redeem races on the same job are closed by an
in-transaction per-user re-check; concurrent redemptions on *different*
jobs could still race past a per-user limit — flagged for a future
DB-level guard.

## 5. Dispute centre

| Method | Path | Purpose | Roles / notes |
|---|---|---|---|
| POST | `/disputes/:id/evidence` | Add evidence `{kind:"photo"\|"chat"\|"gps", storage_key?, note?}`. | Job party or admin |
| GET | `/disputes?role=&status=&cursor=&limit=` | The caller's disputes, paginated. | Owner |
| GET | `/admin/disputes?status=&cursor=&limit=` | All disputes with evidence + `sla_first_response_breached` / `sla_resolve_breached` flags, paginated. | super_admin, support_agent |
| GET | `/admin/disputes/sla-breaches` | Open disputes past an SLA deadline. | super_admin, support_agent |
| POST | `/admin/disputes/:id/assign` | Assign to an officer `{assigned_to}`. | super_admin, support_agent |
| POST | `/admin/disputes/:id/resolve` | Resolve `{outcome:"refund"\|"partial_refund"\|"compensation"\|"no_action", amount_pkr?, note}`. Ledger-backed (see below), audited. | super_admin, support_agent |

Resolution outcomes (all write `disputes.resolution` + audit log + emit
`job.state_changed`):
- `refund` — customer wallet credited the full final price
  (`D refund_expense / C wallet`); provider wallet debited the same amount
  **only if the job was settled** (a cash job never paid never held platform
  money); job → `REFUNDED`.
- `partial_refund` — same with `amount_pkr` (< full price); job →
  `PAYMENT_SETTLED`.
- `compensation` — platform credit to the customer wallet
  (`D compensation_expense / C wallet`); job → `PAYMENT_SETTLED`.
- `no_action` — job returns to its pre-dispute state from `job_events`
  (`IN_PROGRESS` restores exactly, anything else → `PAYMENT_SETTLED` —
  the only other legal exit from `DISPUTED`).
Resolving a non-disputed job → 409 `DISPUTE_NOT_OPEN`. SLA: first response
4h, resolution 48h from opening. No `payments` row is written on refund —
ledger + wallets + job state + dispute resolution + audit log capture it.

## 6. Live tracking

Socket.IO (namespace `/`, JWT auth as in Phase 1):

| Direction | Event | Payload / notes |
|---|---|---|
| Client → server | `provider.location` | `{job_id, lat, lng, at?}`. Provider of the job only, and only while the job is `PROVIDER_EN_ROUTE` or `ITEM_PICKED_UP` — otherwise `{ok:false, error:"NOT_EN_ROUTE"}`. Points implying >200 km/h from the last stored point are ignored + a `fraud_signals` row is written, never emitted. Persisted to `provider_locations`; latest point cached in Redis (`provider:loc:{jobId}`, 48h TTL). |
| Server → room `job:{jobId}` | `provider.location` | `{job_id, lat, lng, at, distance_km, eta_minutes}`. ETA = haversine distance / 30 km/h urban assumption, minimum 1 minute. |

| Method | Path | Purpose |
|---|---|---|
| GET | `/jobs/:id/tracking` | `{job_id, state, provider:{lat,lng,updated_at}\|null, distance_km, eta_minutes, trail:[{lat,lng,at}]}` — trail is the last 20 points **within the 48h dispute window only** (retention rule). Parties only. |

Tracking stops automatically at `ARRIVED` and later states (location
events are rejected). Mobile sends while en route at adaptive intervals:
moving (>50 m) every 10–15 s, stationary backing off to 60 s+.

## 7. Scheduling & recurring jobs

| Method | Path | Purpose | Notes |
|---|---|---|---|
| POST | `/jobs/:id/reschedule` | Move a job's date `{scheduled_at, reason?, scope_changed?}`. Accepted price is kept; writes a `job_events` row + `job.reminder` notifications for both parties. `scope_changed:true` → 409 `SCOPE_CHANGED_REQUIRES_RENEGOTIATION`, date **not** moved — renegotiate via `POST /jobs/:id/adjustments` first. | Job party only, non-terminal jobs |
| POST | `/recurring-jobs` | Create a recurring job `{category_id\|category_slug, description?, specs?, fulfillment, lat, lng, address_id?, customer_offer?, frequency:"weekly"\|"monthly", day_of_week?, day_of_month?, starts_at, ends_at?}`. | Owner |
| GET | `/recurring-jobs?cursor=&limit=` | Own recurring jobs, paginated. | Owner |
| PATCH | `/recurring-jobs/:id` | `{status:"active"\|"paused"\|"cancelled"}`. A cancelled job cannot be resumed. | Owner |
| POST | `/recurring-jobs/:id/skip-next` | Advance `next_run_at` by one period; no request is created. | Owner |
| POST | `/admin/recurring-jobs/run-due` | Generate one broadcast request per due recurring job (reuses the normal request-creation path, idempotency key `recurring:<id>:<next_run_at>`) and advance `next_run_at`. A real external cron/scheduler **must** call this — there is no cron infra in this repo. | super_admin, city_manager |

**Weekday numbering (decided in Phase 2):** availability uses the v1.2
contract, **0=Monday..6=Sunday**, and the nearby open-now check converts
Postgres `EXTRACT(DOW)` (0=Sunday) with `((DOW+6)%7)`, so reads and writes
agree. Recurring `day_of_week` uses JS/Postgres DOW numbering
(**0=Sunday..6=Saturday**, as in `advanceNextRun`); the mobile client
converts its 1=Monday..7=Sunday picker with `_dayOfWeek % 7`.

## 8. Dynamic category forms

| Method | Path | Purpose | Roles |
|---|---|---|---|
| PUT | `/admin/categories/:id/form-schema` | Save a per-category JSON Schema `{schema}`. Validated: must be an object with `type:"object"` and a `properties` object. Upsert into `category_form_schemas`, `updated_by` = admin. Takes effect on the mobile request form immediately, no app release. | super_admin, marketing |
| GET | `/categories/:id/form-schema` | Read the form schema (Phase 1, unchanged). | Public |

Seeded forms (verified real in Phase 2, re-asserted by migration 0006):
Book Binding (books count / size / binding type), AC Repair (type /
tonnage / issue), Electrician (work / rooms), Plumber (work / urgency),
Mobile Repair (brand / model / issue).

## 9. Contract gaps closed (Phase 1 sign-off items)

| Method | Path | Purpose |
|---|---|---|
| GET | `/jobs?role=customer\|provider&state=&cursor=&limit=` | Job history, `JobPage` envelope. |
| GET | `/jobs/:id` | Job details. Customer or provider of that job only (else 403). |
| GET | `/admin/kpis` | `{gmv_pkr, jobs_total, take_rate, active_users, active_providers, acceptance_rate, time_to_first_offer_seconds, cancellation_rate, disputes_open}`. GMV = sum of settled job final prices; take_rate = commission / GMV. |
| GET | `/admin/requests?status=&cursor=&limit=` | Paginated service requests with customer phone + category. |
| PATCH | `/admin/users/:id/suspend` | `{suspended:boolean}` → `users.status` + audit log. |
| POST | `/admin/categories` | Create a category `{slug, name_en, name_ur?, name_roman?, parent_id?, level, icon_key?}`. |
| PATCH | `/admin/categories/:id` | Update `{name_en?, name_ur?, name_roman?, is_active?, sort_order?}`. |
| GET/PUT | `/providers/me/services` | Get / set the provider's offered categories `[{category_id\|category_slug, starting_price, is_active}]` (upsert `provider_services`). |
| PUT | `/providers/me/service-area` | Radius `{center:{lat,lng}, radius_km}` **or** GeoJSON `{polygon}` — exactly one required, else 422. |
| PUT | `/providers/me/availability` | Weekly hours `{slots:[{weekday, opens, closes, is_day_off}]}` (upsert per weekday; weekday 0=Monday, see §7). |
| GET | `/providers/:id/reviews` | Paginated `ReviewPage`. |
| POST | `/waitlist` | Join the area waitlist `{category_id\|category_slug, lat, lng}`. Idempotent per user + category + cell: lat/lng rounded to 3 decimals (≈110 m cells — the "~500 m cell" wording in the brief is approximate; the implementation documents 110 m). |
| POST/DELETE | `/me/devices`, `/me/devices/:id` | Register/update FCM token + device fingerprint (upsert on user+fingerprint); unregister. |
| GET/POST/DELETE | `/me/trusted-contacts`, `/me/trusted-contacts/:id` | Trusted contacts for SOS / job-status sharing. Max 5 per user. |
| GET | `/chats?job_id=&cursor=&limit=` | Fetch chats (optionally filtered by job). |
| GET | `/requests/:id/chat` | Fetch the chat for a request/job. |

Notes: `GET /chats` and `GET /requests/:id/chat` live in the jobs/requests
modules, not the messaging module — marked in code for a later move.
Admin `GET /admin/disputes` previously returned bare rows; it now returns
the paginated envelope with evidence + SLA flags (a Phase 2 change to a
Phase 1 endpoint, documented here rather than silently).

## 10. What Phase 2 deliberately did NOT add

- Live gateway clients, request signing, callback/webhook verification
  (sandbox only; live mode refuses to boot).
- Escrow release, provider payouts (payout requests/scheduling).
- OCR assist (Phase 2 in the PRD is "OCR assistance" for verification —
  **not built**: verification stays manual-only; OCR assist is deferred
  and must be re-scoped, see §11).
- iOS release, provider subscriptions, team accounts, B2B tenders,
  AI features (all Phase 3).

## 11. Known gaps / decisions carried forward

1. **OCR assist not built.** PRD v1.1 places "OCR assistance" in Phase 2
   for verification, but the Phase 2 task brief did not include it and no
   OCR provider was specified. Verification remains manual-only.
   Re-scope before building: choose an OCR vendor, decide whether it runs
   on-device or server-side, and keep CNIC images out of third-party
   models per the PRD privacy rule.
2. **Waitlist cell size** is ≈110 m (3-decimal rounding), not ~500 m.
3. **Promo race:** concurrent redemptions on *different* jobs could race
   past a per-user limit; same-job races are closed. Needs a DB-level
   guard if promo abuse is observed.
4. **Commission city scope:** `service_requests` carry no `city_id`, so
   accept-time resolution uses category + provider tier; city-scoped
   rules resolve when a `cityId` is supplied.
5. **Refund writes no `payments` row** — ledger + wallets + job state +
   dispute resolution + audit log capture it fully.
6. **Chat-fetch endpoints** live outside the messaging module (see §9).
7. **In-app photo upload for dispute evidence does not exist yet** —
   mobile records a photo as a note for support; the user is told to
   share the actual photo on chat.
