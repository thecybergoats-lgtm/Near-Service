# Phase 4 — Item 4: Warranty Product

PRD v1.1 basis: "Optional 7-day workmanship guarantee on Tier 3 jobs
(Phase 4 product): rework or refund per published rules, priced into the
warranty fee"; "Warranty / insurance fee — per-job fee on Tier 3 warranty
jobs (Phase 4)"; Tier 3 Trusted Pro eligible for 7-day warranty jobs;
"warranty only on-platform".

## What was built

### Migration — `db/0019_warranty.sql` (additive only)
- `job_warranties` — one row per warranted job: fee (paisa), job price,
  status (`pending_payment` → `active` → `claimed` → `active`/`expired`/
  `refunded`/`void`), coverage window, fee txn id.
- `warranty_claims` — claim state machine (below), reason/description,
  rework note, refund amount + txn id, decider + decision reason.
- `warranty_claim_events` — every transition, including rejected illegal
  attempts (`illegal=true`), mirroring the jobs service's illegal-transition
  logging. Admin decisions are additionally written to `audit_logs` in the
  same transaction as the state change.
- `warranty_rules` — versioned published rules text (v1 seeded; admin
  edits create a new version, old versions kept).
- `feature_flags`: `warranty_fee_rate` (0.05), `warranty_fee_flat_paisa`
  (0), `warranty_fee_min_paisa` (PKR 50), `warranty_fee_max_paisa`
  (PKR 500), `warranty_claim_days` (7).
- `jobs.warranty_opted_in` / `jobs.warranty_fee_paisa` (receipt + badge
  lookups). Applies cleanly after 0001–0015 (verified on a scratch DB;
  0016–0018 belong to other Phase 4 items and did not exist in the repo
  at build time — 0019 does not depend on them).

### Backend — `backend/src/modules/warranty/`
- `warranty-calc.ts` (pure, unit-tested): `computeWarrantyFee` =
  `clamp(flat + round(price × rate), min, max)`; `coverageEndsAt`
  (completion + 7 days); inclusive window check (a claim exactly at the
  deadline is in time, one second later is late); strict claim state
  machine; `validateWarrantyConfig`.
- `warranty.service.ts` — `WarrantyService` (reuses `ensureWallet` and
  the dispute resolver's refund shape: customer credit, provider debit
  only when the job was already settled).
- `warranty.controller.ts` — user routes; `warranty-admin.controller.ts`
  — admin routes (roles `super_admin` / `finance` / `support_agent`).
- `warranty.module.ts` — standalone module (compiles alone in tests).

### (a) Opt-in + pricing
- `POST /jobs/:id/warranty/opt-in` (customer, at booking — allowed job
  states ACCEPTED…COMPLETED). Tier 3 only: any other tier is rejected
  with **422 `WARRANTY_TIER_NOT_ELIGIBLE`** naming the provider's tier.
  Fee is priced from `final_price ?? agreed_price` at opt-in and stored
  on the warranty + job rows. No money moves at opt-in.
- `GET /warranty/quote?job_price_pkr=…` — public quote before opting in.
- Fee rule is admin-configurable: `GET/PATCH /admin/warranty/config`
  (rate 0–0.5, flat/min/max in PKR in, paisa stored, min ≤ max enforced
  on the merged config). Defaults: 5%, min PKR 50, max PKR 500.
- Fee collection: `POST /jobs/:id/warranty/collect-fee` at payment time
  (job COMPLETED or PAYMENT_SETTLED; 409 `WARRANTY_FEE_TOO_EARLY`
  before that). Balanced ledger on the customer wallet:
  **D `wallet` / C `warranty_fee_rev`**, balance −= fee. Coverage window
  starts at `completed_at`, ends +7 days. **Integrator hook:** call
  `collectFee` from the payment settlement step (cash
  `JobsService.confirmPayment` / wallet settlement) — this piece does not
  edit `JobsService` (outside this item), so until that one-line hook
  lands the customer calls collect-fee after completion; the endpoint
  itself is the payment-time step.

### (b) Claim flow — strict state machine
```
filed -> under_review -> rework_offered -> rework_done -> closed
                               \-> rework_failed -> refunded
filed | under_review -> rejected
```
- `POST /jobs/:id/warranty/claims` (customer, within 7 days of
  completion). Late claims: **422 `WARRANTY_CLAIM_WINDOW_CLOSED`**
  (day 8 rejected; deadline instant itself still accepted). One open
  claim per warranty (409 `WARRANTY_CLAIM_ALREADY_OPEN`).
- Rework first: admin/provider `offer-rework`, then `rework-done` /
  `rework-failed` (customer or provider). There is deliberately **no**
  direct filed/under_review → refunded edge — a refund requires a
  failed/refused rework.
- Illegal transitions: **409 `ILLEGAL_CLAIM_TRANSITION`**, and the
  attempt is still written to `warranty_claim_events` (`illegal=true`).
- Refund (admin, `approve-refund`, reason required, only from
  `rework_failed`): customer credited **full job price + warranty fee**
  in one txn_id — D `warranty_refund_expense` (price) / C `wallet`
  (price) + D `warranty_fee_rev` (fee) / C `wallet` (fee); a `payments`
  row (status `refunded`, amount = price + fee) is written in the same
  transaction. Provider wallet debited the price in a second txn **only
  if the job was already settled** (cash jobs never settled debit
  nobody — the platform bears the refund, same rule as the dispute
  resolver). Warranty → `refunded`.

### (c) Admin review + decisions
- `GET /admin/warranty/claims?status=…`, `POST .../review`
  (filed → under_review), `POST .../offer-rework`,
  `POST .../reject` (reason required), `POST .../approve-refund`
  (reason required, moves money). Every admin decision writes an
  `audit_logs` row (`warranty.claim.<to-status>`) in the same txn.
- `POST /admin/warranty/expire-due` — daily sweep: active warranties
  past their coverage window → `expired`.

### (d) Badge + receipt
- `GET /providers/:id/warranty-badge` → `{ tier, tier_name,
  warranty_eligible, badge: "WARRANTY_7_DAY" | null, coverage_days,
  fee_rate }`. Tier 3 → badge; other tiers → `badge: null`.
- `GET /jobs/:id/warranty/receipt` → job price, warranty fee,
  `total_charged_pkr`, coverage window, warranty status, latest claim.
  `GET /jobs/:id/warranty` → warranty + latest claim.
- Admin page `admin/src/app/warranty/page.tsx` (new file) renders the
  claims queue, fee config, rules editor and expiry sweep. Mobile
  widgets `mobile/lib/features/warranty/warranty_widgets.dart` (new
  file): `WarrantyBadge`, `WarrantyOptInCard`, `WarrantyClaimForm`,
  `WarrantyReceiptSection` + endpoint constants.

### (e) Published rules
- Seeded as `warranty_rules` v1 (7-day window, 5% fee, rework-first,
  refund = price + fee, exclusions). Served publicly:
  `GET /warranty/rules` (no auth — a customer reads it before opting
  in). Admin: `GET /admin/warranty/rules`, `PUT /admin/warranty/rules`
  (new version; old versions kept, only one `is_current`).

### (f) Ledger balance (0008 trigger)
All warranty money is balanced per txn_id (fee: 1 D + 1 C; refund:
2 D + 2 C in one txn, provider recovery a separate balanced pair).
Proven in `test/integration/warranty.spec.ts`: after a fee collection
and a refunded claim, `SUM(D) − SUM(C) = 0` for every txn_id, and the
exact legs are asserted.

## Routes (for the integrator — add to `backend/openapi.yaml` + `app.module.ts`)
`WarrantyModule` is NOT wired into `AppModule` (integrator-owned) and
the routes below are NOT yet in `openapi.yaml` (also integrator-owned;
the route-diff contract test enforces spec == code, so both land
together — do not add one without the other).

| Method | Path | Roles |
|---|---|---|
| GET | /warranty/rules | public |
| GET | /warranty/quote?job_price_pkr= | auth |
| POST | /jobs/{id}/warranty/opt-in | customer |
| POST | /jobs/{id}/warranty/collect-fee | customer |
| GET | /jobs/{id}/warranty | party/admin |
| GET | /jobs/{id}/warranty/receipt | party/admin |
| GET | /providers/{id}/warranty-badge | auth |
| POST | /jobs/{id}/warranty/claims | customer |
| GET | /warranty/claims | auth (own) |
| GET | /warranty/claims/{id} | party/admin |
| POST | /warranty/claims/{id}/rework-done | customer/provider |
| POST | /warranty/claims/{id}/rework-failed | customer/provider |
| POST | /warranty/claims/{id}/close | customer |
| GET | /admin/warranty/claims?status= | super_admin/finance/support_agent |
| POST | /admin/warranty/claims/{id}/review | super_admin/finance/support_agent |
| POST | /admin/warranty/claims/{id}/offer-rework | super_admin/finance/support_agent |
| POST | /admin/warranty/claims/{id}/reject | super_admin/finance/support_agent |
| POST | /admin/warranty/claims/{id}/approve-refund | super_admin/finance/support_agent |
| GET/PATCH | /admin/warranty/config | super_admin/finance |
| GET/PUT | /admin/warranty/rules | super_admin/finance |
| POST | /admin/warranty/expire-due | super_admin/finance |

## Admin / mobile wiring left for the integrator (shared files untouched)
- Admin: move the fetch helpers in `admin/src/app/warranty/page.tsx`
  into `lib/api.ts` + row types into `lib/types.ts`; add a "Warranty"
  sidebar entry → `/warranty`.
- Mobile: add the six `ApiClient` methods listed at the top of
  `mobile/lib/features/warranty/warranty_widgets.dart` to
  `core/api_client.dart`; wire `WarrantyBadge` into provider cards,
  `WarrantyOptInCard` into booking, `WarrantyClaimForm` into job detail,
  `WarrantyReceiptSection` into the receipt screen. No Flutter/Dart
  toolchain exists in this VM, so the widgets were not compiled.
- Backend: add `WarrantyModule` to `app.module.ts` imports; add the
  routes above to `openapi.yaml`; call `WarrantyService.collectFee`
  from the payment settlement step so the fee is collected
  automatically at payment (see (a)).

## Verification (run for real)
- Unit: `npx jest --config test/jest.config.js --runInBand
  test/unit/warranty.spec.ts` — **15 passed** (fee incl. min/max caps,
  window boundary incl. day-8, state machine, standalone module wiring).
- Integration (real Postgres 16 + PostGIS 3 + Redis, DB
  `nearservice_p4_warranty`, migrations 0001–0009 + 0019):
  `npx jest --config test/jest.config.js --runInBand
  test/integration/warranty.spec.ts` — **9 passed** (0019 applied,
  quote/config caps, Tier 3 opt-in + tiers 0–2 rejected 422, fee
  collection with exact ledger legs, window boundary + day-8 rejection,
  rework→close flow with illegal-refund attempt logged, rework→refund
  flow with exact refund legs + provider debit + audit row, admin
  reject, rules v2 + expiry sweep; `ledgerDiffs()` empty after every
  money test).
- Fresh-DB migrate: 0001–0015 + 0019 applied cleanly in order on scratch
  DB `nearservice_p4_warranty_full` (`psql -v ON_ERROR_STOP=1 -f` per
  file, all succeeded; rules v1 + 5 warranty flags present).
- `npx tsc --noEmit` in `backend/`: **no errors in any warranty file**
  (grep warranty → empty). The full run reports 11 errors, all in
  other Phase 4 workers' in-progress files
  (`src/modules/partners/partner-provider.interface.ts`,
  `src/modules/search/*.ts` — bad relative import paths), so
  `nest build` also currently fails on those files, not on warranty.
  See "Not verified" below.

## Not verified / known limits
- `nest build` exit 0 NOT achieved: the build fails on other workers'
  `partners`/`search` files (11 tsc errors, none in warranty files).
  Warranty files alone compile clean; the full build will pass once
  those files are fixed by their owners.
- End-to-end HTTP check not run: the module is not wired into
  `AppModule` / `openapi.yaml` (integrator-owned), so no live server
  route was exercised. Service-level integration tests cover the same
  logic against real Postgres + the 0008 trigger.
- Admin page (`admin/src/app/warranty/page.tsx`) not type-checked
  against the admin app (its `DataTable`/`Badge` props follow the
  finance page's usage; the page is new and unwired — see wiring note).
- Mobile widgets not compiled (no Flutter/Dart in this VM).
- Refund for an escrow-held (not yet released) job: the provider is
  not debited (job not `settled`), so the platform bears the refund
  and the escrow hold still needs releasing/refunding via the escrow
  flow — the two flows do not yet coordinate; documented here, not
  silently handled.
- `collectFee` is a separate call after completion until the settlement
  hook lands (see (a)); a job that settles without it simply has a
  `pending_payment` warranty and no coverage.
