# Near Service — Phase 4 API Addendum

Phase 4 endpoints added on top of OpenAPI 3.1 v1.5.0. **Like Phase 3,
this addendum is folded into the YAML:** `backend/openapi.yaml` is now
**v1.6.0 — 228 paths / 253 operations** (v1.5.0's 161/179 + 66 paths /
73 ops for Phase 4, + 1 path / 1 op for Fix B, §10), and the route-diff test
(`backend/test/contract/api.contract.spec.ts`) enforces spec == code, so
this document is a human guide, not a second contract. If the two
disagree, the YAML + the code win and this file must be fixed.

Base URL: `/api/v1`. All responses use the Phase 1 error shape
`{ "error": { "code", "message", "details" }, "request_id" }`.
List endpoints return the v1.2 envelope `{ "items": [...], "next_cursor" }`
unless noted. Mutating marketplace calls accept `Idempotency-Key`
(replay returns the original response; same key + different body → 422
`IDEMPOTENCY_KEY_REUSED`). All money is integer paisa in the ledger;
amounts in request/response bodies are PKR decimals. Currency is PKR.

**What Phase 4 is (PRD v1.1 scope):** search scale-out (item 1),
analytics warehouse (item 2), multi-city ops tooling (item 3),
warranty product (item 4), partner integrations (item 5). Infra
(item 6) has no backend module — it is deployment work, not API.

**No in-repo scheduler.** Like the Phase 3 ledger reconciliation, every
recurring job in this addendum runs from an **external scheduler**
(cron / ops job calling an HTTP endpoint with a service token). See §7
for the three schedule lines.

## 1. Search scale-out (item 1 — migration 0016)

`GET /search` keeps its Phase 1 wire shape. `CatalogService.search`
now delegates to `SearchGatewayService` instead of running SQL inline.
Three providers behind the `SearchProvider` interface
(`backend/src/modules/search/search-provider.interface.ts`):

| Provider | Behaviour |
|---|---|
| `trigram` (default) | Phase 1 SQL, verbatim — the fallback that always works |
| `scaled` | pg full-text + trigram + Redis cache |
| `remote` | HTTP forward to an extracted search service (`SEARCH_SERVICE_URL`) |

| Method | Path | Purpose | Roles / notes |
|---|---|---|---|
| GET | `/admin/search/metrics` | Per-query events, p50/p95, zero-result rate, cache-hit rate, CTR, window stats | super_admin |
| GET | `/admin/search/gate` | `evaluateGate()` — recommends `stay_in_process` or `switch_on_dedicated_tier` against admin-editable thresholds | super_admin |
| PATCH | `/admin/search/gate/thresholds` | Update the gate thresholds | super_admin |
| POST | `/search/click` | Record a click for CTR `{query_event_id?, target_type: 'category'|'provider', target_id?}` → `{recorded: boolean}`. Public, rate-limited (`search`). A click without `query_event_id` is accepted and counted. | Public |

**Env vars** (`backend/src/config/env.ts`, `env.search.*`; defaults match
the seeded gate config in `search.config.ts`):

| Key | Default | Meaning |
|---|---|---|
| `SEARCH_PROVIDER` | `trigram` | `trigram` / `scaled` (remote is selected by `SEARCH_SERVICE_URL`, not this key) |
| `SEARCH_SERVICE_URL` | — (unset) | Set → `RemoteSearchProvider` (HTTP forward) |
| `SEARCH_CACHE_TTL_SECONDS` | `120` | Redis cache TTL for scaled-provider results |
| `SEARCH_CACHE_ENABLED` | `true` | Only the literal string `'false'` disables the cache |

**Cache invalidation (integrator wiring):** category writes
(`AdminController` create/update category, `CatalogController.putFormSchema`)
call `SearchCacheService.invalidateCategory`; provider writes
(`ProvidersService` onboarding, `setOnline`, `updateMyServices`,
`updateServiceArea`) call `invalidateProvider`. Invalidation is
best-effort and **never fails the write** — the cache service is injected
`@Optional()` and every call is guarded. There are no
`category_keywords` writers in `src/`, so nothing was wired there.

**Vendor swap-in (extraction):** implement `SearchProvider` (or point
`SEARCH_SERVICE_URL` at an extracted service) — callers talk to the
gateway, never to SQL or HTTP directly. What extraction does NOT yet
cover: the metrics/gate admin endpoints and the click endpoint still
live in the monolith; if the extracted service also records events,
point both at the same metrics store, and CTR across the boundary needs
the extracted service to share the same Redis. **Daily rollup:**
schedule `rollupDaily()` daily from the external scheduler once one
exists — there is no in-repo cron to run it yet (§7).

Admin page: `admin/src/app/search-metrics/page.tsx` (Search Metrics).
Mobile: `mobile/lib/features/search/search_metrics_screen.dart`,
route `/admin/search-metrics` (token passed via `state.extra` — the
endpoint needs super_admin; a customer/provider token gets 403).

## 2. Analytics warehouse (item 2 — migration 0017)

The ETL reads operational tables only; it never writes them. Dashboards
read warehouse facts only, so admin queries cannot slow down booking.
Date filters default to the last 30 days; `from`/`to` are `YYYY-MM-DD`.

| Method | Path | Purpose | Roles |
|---|---|---|---|
| POST | `/admin/analytics/etl/run` | Run the ETL on demand; returns the run report including reconciliation (operational vs warehouse counts per entity) | super_admin, finance |
| GET | `/admin/analytics/etl/status` | Latest ETL run, or null | super_admin, finance |
| GET | `/admin/analytics/funnel?from&to` | Request → offer → accept → complete funnel | super_admin, finance |
| GET | `/admin/analytics/revenue?group_by=city\|category&from&to` | Revenue by city or category | super_admin, finance |
| GET | `/admin/analytics/supply-demand?from&to` | Demand by city + hour | super_admin, finance |
| GET | `/admin/analytics/export/:table` | CSV download of a warehouse table | super_admin, finance |

**Scheduling — nightly ETL, 02:00 PKT** (external scheduler; no
in-process cron exists in this repo):

```cron
0 2 * * * curl -X POST https://<host>/api/v1/admin/analytics/etl/run \
  -H "Authorization: Bearer <service-token>"
```

02:00 PKT, after the day's business, before the morning dashboards are
read. On-demand runs use the same endpoint. Until the operator adds
this cron line, the ETL only runs on demand.

**Honesty:** export CSVs are operational reports, **not a tax filing** —
Finance / legal counsel must review before any filing use. An ETL run
row with `status='failed'` carries the error; a failed run does not
touch warehouse facts.

Admin pages: `admin/src/app/analytics/page.tsx` (funnel, revenue,
supply/demand, ETL run + reconciliation, "Run ETL now") and
`admin/src/app/analytics/exports/page.tsx` (CSV downloads + disclaimer).

## 3. Multi-city ops tooling (item 3 — migration 0018)

Cities table + go/no-go gate. **Quetta is `live`; Karachi is
`in_preparation`.** The Karachi gate honestly **FAILS** today: 3 seeded
providers against a target of 10 — Karachi does not launch until the
gate passes. Seeded UUIDs are RFC-4122 v4 since Fix A
(db/0021_fix_seed_uuids.sql rewrote the old version-0 seeds); the cities
module keeps its shape-only pipe for compatibility — it accepts v4 ids.

| Method | Path | Purpose | Roles |
|---|---|---|---|
| GET | `/admin/cities` | List cities | super_admin, city_manager, support_agent |
| POST | `/admin/cities` | Create a city | super_admin |
| GET | `/admin/cities/{id}` | One city | super_admin, city_manager, support_agent |
| PATCH | `/admin/cities/{id}/targets` | Update launch targets (providers, categories, …) | super_admin |
| PATCH | `/admin/cities/{id}/gate-config` | Update gate thresholds | super_admin |
| POST | `/admin/cities/{id}/gate-evaluations` | Run the gate evaluation now | super_admin |
| GET | `/admin/cities/{id}/gate-evaluations` | Gate evaluation history | super_admin, city_manager, support_agent |
| POST | `/admin/cities/{id}/status` | Move lifecycle (`in_preparation` → `live` → …) | super_admin |
| POST | `/admin/cities/{id}/assign-manager` | Assign a city manager | super_admin |
| GET | `/admin/cities/{id}/checklist` | Launch checklist | super_admin, city_manager, support_agent |
| PATCH | `/admin/cities/{id}/checklist/{itemKey}` | Tick a checklist item | super_admin, city_manager |
| GET | `/admin/cities/{id}/categories` | Per-city category overrides | super_admin, city_manager, support_agent |
| PATCH | `/admin/cities/{id}/categories/{categoryId}` | Set a category override | super_admin, city_manager |
| GET | `/admin/cities/{id}/effective-commission` | `{rate, ruleId, source}` — city rule wins, else the global row (`city_id NULL`), else null | super_admin, city_manager, support_agent |
| POST | `/admin/cities/{id}/commission-rules` | Add a city commission rule | super_admin |
| GET | `/admin/cities/{id}/fair-price` | City fair-price view | super_admin, city_manager, support_agent |
| POST | `/admin/cities/{id}/fair-price` | Refresh the city fair-price view | super_admin |

**Public SEO landing pages** (plain HTML, no auth):

| Method | Path | Purpose |
|---|---|---|
| GET | `/services` | Index of enabled landing pages (disabled categories excluded) |
| GET | `/services/{categorySlug}/{areaSlug}` | e.g. `/services/ac-repair/quetta` — category × area page with the real provider list |
| GET | `/shops/{providerId}` | Public shop page with the real review summary |

Admin page: `admin/src/app/cities/page.tsx`.

**Not built (honest gap):** the mobile city picker needs a public
`GET /cities` (live cities only) — that endpoint does not exist in the
backend, and no cities screen was created in the mobile app. Adding it
is a new route + openapi entry + tests, not a wiring fix; it is left
for a follow-up, not silently stubbed.

## 4. Warranty product (item 4 — migration 0019)

7-day workmanship warranty, **Tier 3 providers only, rework first,
refund only if rework fails**. Fee is a percentage of the job price,
admin-configurable. States: `pending_payment` → `active` → `claimed`
→ `active` / `expired` / `refunded`. Claims live 7 days from
completion; the window is enforced server-side
(422 `WARRANTY_CLAIM_WINDOW_CLOSED`).

| Method | Path | Purpose | Roles |
|---|---|---|---|
| GET | `/warranty/rules` | Published warranty rules — read before opting in | Public |
| GET | `/warranty/quote?job_price_pkr=…` | Fee quote before opting in | Auth |
| POST | `/jobs/{id}/warranty/opt-in` | Opt a job in (customer, at booking). No money moves here. | customer |
| POST | `/jobs/{id}/warranty/collect-fee` | Collect the fee at payment time | customer |
| GET | `/jobs/{id}/warranty` | Warranty + latest claim | party / admin |
| GET | `/jobs/{id}/warranty/receipt` | Job price, warranty fee, coverage window, claim status | party / admin |
| GET | `/providers/{id}/warranty-badge` | `{tier, tier_name, warranty_eligible, coverage_days}` — Tier 3 shows `WARRANTY_7_DAY` | Auth |
| POST | `/jobs/{id}/warranty/claims` | File a claim (customer, within 7 days of completion) | customer |
| GET | `/warranty/claims` | My claims | Auth (own) |
| GET | `/warranty/claims/{id}` | One claim | party / admin |
| POST | `/warranty/claims/{id}/rework-done` | Rework completed | customer / provider |
| POST | `/warranty/claims/{id}/rework-failed` | Rework failed → refund path | customer / provider |
| POST | `/warranty/claims/{id}/close` | Close the claim | customer |

| Method | Path | Purpose | Roles |
|---|---|---|---|
| GET | `/admin/warranty/claims?status=…` | Claims queue | super_admin, finance, support_agent |
| POST | `/admin/warranty/claims/{id}/review` | filed → under_review | super_admin, finance, support_agent |
| POST | `/admin/warranty/claims/{id}/offer-rework` | Offer rework | super_admin, finance, support_agent |
| POST | `/admin/warranty/claims/{id}/reject` | Reject (reason required) | super_admin, finance, support_agent |
| POST | `/admin/warranty/claims/{id}/approve-refund` | Approve refund (moves money) | super_admin, finance, support_agent |
| GET / PATCH | `/admin/warranty/config` | Fee config | super_admin, finance |
| GET / PUT | `/admin/warranty/rules` | Published rules text | super_admin, finance |
| POST | `/admin/warranty/expire-due` | Daily sweep: active warranties past their coverage window → `expired` | super_admin, finance |

**Fee collection at settlement (integrator wiring):**
`WarrantyService.collectFeeAtSettlement(jobId, customerId)` is called
from **both** settlement paths — cash
(`JobsService.confirmPaymentInner`, after the settlement transaction
commits, job `PAYMENT_SETTLED`) and wallet
(`WalletService.payWithWalletInner`, after its transaction). It is a
no-op when the job did not opt in or the fee was already collected, and
it **never throws**: a failure (e.g. `INSUFFICIENT_WALLET_BALANCE` on a
cash job) logs a warning and leaves the warranty `pending_payment`, so
the customer can still pay via `POST /jobs/{id}/warranty/collect-fee`.
A job that settles without the fee simply has a `pending_payment`
warranty and **no coverage** until the fee is collected.

**Daily sweep:** `POST /admin/warranty/expire-due` runs daily from the
external scheduler (§7).

**KNOWN GAP — escrow coordination (not fixed, documented honestly):**
a refunded warranty claim on an **escrow-held** (not yet released) job
does not coordinate with escrow release. The provider is not debited
(the job is not `settled`), so the platform bears the refund, and the
escrow hold still needs releasing/refunding via the escrow flow — the
two flows do not yet coordinate. Do not present an escrow-held refund
as settled end-to-end until this is built.

Admin page: `admin/src/app/warranty/page.tsx` (claims queue, fee
config, rules editor, expiry sweep). Mobile: `mobile/lib/features/
warranty/warranty_widgets.dart` (`WarrantyBadge`, `WarrantyOptInCard`,
`WarrantyClaimForm`, `WarrantyReceiptSection`); the badge is wired into
the provider profile screen, the other three widgets are not yet placed
into the booking / job-detail / receipt screens (see §6).

## 5. Partner integrations (item 5 — migration 0020)

Parts-supplier affiliate ordering (AC parts, hardware), disclosed
in-app. **The local catalog is the working implementation** — there is
no live supplier. Prices are ALWAYS server-priced from the catalog:
the app sends item ids + quantities only; totals come from the API
response, never from a client-side sum. The affiliate fee is recorded
on confirm and reversed on cancel-after-confirm; every order view
carries the partner disclosure text.

| Method | Path | Purpose | Roles |
|---|---|---|---|
| GET | `/partners/catalog` | Search/list catalog (`q`, `category`, `partner_id`, `in_stock_only`, `limit`, `offset`) | Auth |
| GET | `/partners/catalog/{id}` | One catalog item | Auth |
| POST | `/partners/orders` | Place an order (provider; `Idempotency-Key` supported) | provider |
| GET | `/partners/orders` | My orders (provider) | provider |
| GET | `/partners/orders/{id}` | One order (job party only) | party |
| POST | `/partners/orders/{id}/confirm` | Confirm (records the affiliate fee) | provider / admin |
| POST | `/partners/orders/{id}/deliver` | Mark delivered | provider / admin |
| POST | `/partners/orders/{id}/cancel` | Cancel (+ fee reversal when confirmed) | provider / admin |
| GET | `/partners/jobs/{jobId}/orders` | Job partner-orders + disclosure (customer or provider) | party |

| Method | Path | Purpose | Roles |
|---|---|---|---|
| GET | `/admin/partners` | List partners (incl. inactive) | super_admin, finance, support_agent |
| POST | `/admin/partners` | Create partner | super_admin, finance |
| PATCH | `/admin/partners/{id}` | Update partner | super_admin, finance |
| POST | `/admin/partners/catalog-items` | Create catalog item | super_admin, finance |
| PATCH | `/admin/partners/catalog-items/{id}` | Update catalog item | super_admin, finance |
| GET | `/admin/partners/orders` | Order list (`status`, `partner_id`, `job_id`) | super_admin, finance, support_agent |
| GET | `/admin/partners/orders/{id}` | One order | super_admin, finance, support_agent |
| POST | `/admin/partners/orders/{id}/confirm` | Admin confirm | super_admin, finance |
| POST | `/admin/partners/orders/{id}/deliver` | Admin deliver | super_admin, finance |
| POST | `/admin/partners/orders/{id}/cancel` | Admin cancel | super_admin, finance |
| GET | `/admin/partners/affiliate-fees?from&to&partner_id` | Fee report + ledger check | super_admin, finance |

**Vendor swap-in (live supplier):** the supplier is one adapter behind
the `PartnerProvider` interface
(`backend/src/modules/partners/partner-provider.interface.ts`);
`LocalPartnerProvider` serves the real Postgres catalog (`partners` +
`partner_catalog_items`). To swap in a live supplier, implement
`PartnerProvider` for that supplier and call
`PartnersService.setProvider(new LiveSupplierProvider(...))` — one
class, no flow changes: the order flow, ledger and disclosure do not
care which adapter serves the catalog. What the operator needs before
that is a supplier contract (see `docs/phase4-partners.md` §swap-in).

Admin page: `admin/src/app/partners/page.tsx`. Mobile:
`mobile/lib/features/provider/parts_order_screen.dart`
(`PartsOrderScreen`, route `/provider/parts?jobId=…`).

## 6. What the integrator wired (shared files)

- `backend/src/app.module.ts`: `SearchModule` (was already imported),
  `AnalyticsModule`, `CitiesModule`, `WarrantyModule`, `PartnersModule`.
- `backend/openapi.yaml`: v1.5.0 → v1.6.0, all 73 new operations.
- `backend/src/config/env.ts`: the four `SEARCH_*` keys (§1).
- Search cache invalidation at every category/provider write (§1);
  `POST /search/click` + its integration test
  (`backend/test/integration/search-click.spec.ts`).
- Warranty fee collection hooked into both settlement paths (§4).
- Admin: Sidebar entries for Analytics, Cities, Partners, Warranty,
  Search Metrics; typed helpers in `admin/src/lib/api.ts` and row types
  in `admin/src/lib/types.ts` mirroring each new page's local helpers
  (the five new pages keep their local helpers and still work — the
  lib surface is the shared typed API for future pages).
- Mobile: `ApiClient` gains the six partner methods (+ `getPartnerOrder`)
  and seven warranty methods (`mobile/lib/core/api_client.dart`);
  `ApiClient implements PartnerApi`; router entries `/provider/parts`
  and `/admin/search-metrics` (`mobile/lib/router.dart`); `WarrantyBadge`
  wired into the provider profile screen. **Nothing mobile was
  compile-verified — no Flutter/Dart exists in this VM** (brace-balance
  and import checks only). Not yet wired: `WarrantyOptInCard` into the
  booking flow, `WarrantyClaimForm` into job detail,
  `WarrantyReceiptSection` into the receipt screen, and the cities
  mobile picker (needs the missing `GET /cities`, §3).

## 7. Schedules (external scheduler — no in-repo cron)

| Job | Schedule | Endpoint |
|---|---|---|
| Analytics ETL | Daily 02:00 PKT | `POST /admin/analytics/etl/run` (§2) |
| Ledger reconciliation | Nightly (existing Phase 3 pattern) | `POST /admin/reconciliation/run` |
| Warranty expiry sweep | Daily | `POST /admin/warranty/expire-due` (§4) |
| Close review windows (Fix B) | Nightly | `POST /admin/jobs/close-review-windows` (§10) |
| Search daily rollup | Daily (once a scheduler exists) | `rollupDaily()` — no HTTP endpoint yet; run it from an ops job, not from the API |

## 8. Migrations 0016–0020 (all additive, fresh-DB verified)

| File | Contents |
|---|---|
| `0016_search_scaleout.sql` | Full-text vectors on categories / `category_keywords`, raw search events + daily rollup tables, gate config seed |
| `0017_analytics_warehouse.sql` | `analytics_*` warehouse facts + `analytics_etl_runs` (status, counts, reconciliation) |
| `0018_multi_city.sql` | `cities` lifecycle + gate tables, per-city category overrides + commission rules, Karachi seed (3 providers, gate FAILs — §3) |
| `0019_warranty.sql` | `job_warranties`, `warranty_claims`, `warranty_config` (+ two columns on `jobs`) |
| `0020_partners.sql` | `partners`, `partner_catalog_items`, `partner_orders`, `partner_order_items`, affiliate fee ledger wiring |
| `0021_fix_seed_uuids.sql` | Fix A: rewrites the 35 seeded version-0 category/city ids to RFC-4122 v4 UUIDs and every reference to them |
| `0022_fix_rated_state.sql` | Fix B (§10): `review_window_days` flag (default 7) + partial index for the review-window closing sweep |

Fresh-DB migrate 0001–0020 verified clean by the Phase 4 integrator
(2026-11-17, `npm run migrate`, exit 0 — 20 rows in
`schema_migrations`). The earlier report of an FK violation in 0018 on
provider `20000000-0202-4000-8000-000000000003` did **not** reproduce;
it was a mid-write read while the cities worker was still editing.

## 9. Tests

Per-item suites (unit + integration, real Postgres + Redis where
marked): search 21 + 9 (+ 3 new click tests), analytics 14 + 8,
cities 18 + 12, warranty 15 + 9, partners 19 + 10. The route-diff test
(`backend/test/contract/api.contract.spec.ts`) enforces spec == code
for all 253 operations (252 + Fix B's `POST /admin/jobs/close-review-windows`).
Full backend suite: see the integrator's
verification report (started in the background; over an hour on this
machine — report its real final result, never a partial run as a pass).

## 10. Fix B — jobs reach RATED (migration 0022)

**The problem.** The `RATED` state existed in `JOB_STATE_VALUES`, in the
state machine (`PAYMENT_SETTLED -> RATED`) and in reports, but no code
ever wrote it: reviews were only allowed in `PAYMENT_SETTLED` and left
the job there forever, so any logic or report that expects `RATED`
(analytics, warranty, subscriptions, admin dashboards) never saw it.

**The decided rule.** A job moves `PAYMENT_SETTLED -> RATED` when **both
sides have submitted their review, OR when the review window closes
(admin-configurable, default 7 days) — whichever comes first.** Until
then it stays `PAYMENT_SETTLED` and each side can still review once.
After `RATED` no more reviews are accepted (`409 REVIEW_WINDOW_CLOSED`).

- **Window start:** the latest `job_events` row with
  `to_state='PAYMENT_SETTLED'` for the job. Every settlement path (cash,
  wallet, escrow release, dispute resolution) writes that event, so a
  dispute that returns a job to `PAYMENT_SETTLED` restarts the window.
  Fallback (jobs settled before this migration): the later of the two
  payment-confirmation timestamps, then `jobs.updated_at`.
- **Window length:** `feature_flags` key `review_window_days`
  (integer days, default 7; valid 1–90, anything else falls back to 7),
  same pattern as `warranty_claim_days`. Changing it needs no migration;
  the sweep reads it at run time.
- **Both reviews:** `POST /jobs/:id/reviews` inserts the review and,
  in the SAME transaction, counts distinct party reviews; when the count
  reaches 2 it transitions to `RATED` through the normal state machine
  (actor = the reviewer whose review completed the pair,
  `reason='both_reviews_submitted'`), so `job_events` records it. The
  201 response carries `job_state` (`PAYMENT_SETTLED` or `RATED`).
  Reviews are party-only now (a non-party gets 403) — the old code
  computed the reviewee as "the other party" for any caller, which
  would have let a stranger's review count toward "both sides".
- **Window closing:** `POST /admin/jobs/close-review-windows`
  (super_admin / city_manager; nightly external scheduler, §7 — no
  in-process scheduler exists in this repo) moves every
  `PAYMENT_SETTLED` job past its window to `RATED` (actor `system`,
  `reason='review_window_closed'`). Idempotent. If the window elapsed
  but the sweep has not run yet, a late review attempt closes the job
  first and still returns `409 REVIEW_WINDOW_CLOSED` — the window, not
  the sweep schedule, is the rule.
- **Disputes:** a `RATED` job cannot move to `DISPUTED` (the state
  machine has no `RATED` exit; `TrustService.openDispute` already left
  `RATED` jobs untouched). Dispute resolution only ever restores
  `PAYMENT_SETTLED`/`IN_PROGRESS`, so a resolved job can still be
  reviewed and then reach `RATED` normally.

**Settled-state audit (every query that reads job state was checked).**

| Surface | Finding | Change |
|---|---|---|
| Analytics ETL (`COMPLETED_STATES = COMPLETED, PAYMENT_SETTLED, RATED`) | GMV/commission are price sums over fact rows; `is_completed` already includes `RATED` | None — verified identical totals before/after `RATED` (§10 tests) |
| Admin KPIs | `state IN ('PAYMENT_SETTLED','RATED')` for GMV + commission | None |
| Subscriptions counters | `jobs_settled` counts `PAYMENT_SETTLED` or `RATED` | None |
| Warranty `collectFee` | Required `COMPLETED`/`PAYMENT_SETTLED` — a job could reach `RATED` (both reviews in) before the fee was paid and strand the warranty in `pending_payment` | `RATED` added to the allowed states |
| Warranty `fileClaim` / opt-in | Claim filing checks warranty status + coverage window, not job state; opt-in already stops at `COMPLETED` | None |
| Disputes (`TrustService`) | `RATED` jobs stay `RATED` when a dispute is opened (pre-existing, deliberate) | None |
| Partners parts ordering | `ORDERABLE_JOB_STATES` ends at `PRICE_ADJUSTMENT_PENDING` — `COMPLETED` onwards (incl. `RATED`) cannot order | None |
| Escrow / payouts | Operate pre-settlement only | None |
| SEO / review summaries, provider rating | Derived from the `reviews` table, not job state | None |
| Risk engine | Cancellation-based only | None |

**Clients.** OpenAPI v1.6.0 now has 228 paths / 253 operations (+1 path:
`POST /admin/jobs/close-review-windows`, `CloseReviewWindowsResponse`;
`createReview` documents the `RATED` transition and
`REVIEW_WINDOW_CLOSED`). Mobile already modelled `RATED`
(`jobStates`, `Rated` history filter); the provider had no way to
submit their review, so the provider active-job screen now shows
"Rate customer" on `PAYMENT_SETTLED` jobs via a new
`/provider/rating/:jobId` route reusing `RatingScreen`, and History
shows the Rate button for either role. Admin Jobs page gains a
"Close review windows" button (`closeReviewWindows()` in
`admin/src/lib/api.ts`).

**Tests.** `backend/test/integration/rated-state.spec.ts` (real Postgres
+ Redis): full cash golden flow (request → offer → accept → complete →
confirm ×2 → customer review stays `PAYMENT_SETTLED` → provider review
becomes `RATED` with the `job_events` row → third review 409); window
sweep with a fake clock (elapsed → `RATED`, not elapsed → unchanged,
idempotent re-run); warranty claim fileable on a `RATED` job; analytics
ETL GMV/commission, admin KPI GMV/commission and subscription
`jobs_settled` identical before and after the job becomes `RATED`.
