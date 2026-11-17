# Phase 4, Item 5 — Partner Integrations

Parts-supplier affiliate ordering (AC parts, hardware), disclosed in-app.
PRD v1.1: "Partnerships — Parts-supplier affiliate ordering (AC parts,
hardware) — Phase 4, disclosed in-app".

## What was built

| Piece | Location |
|---|---|
| Migration (additive) | `db/0020_partners.sql` |
| Supplier adapter interface + local catalog | `backend/src/modules/partners/partner-provider.interface.ts` |
| Pure domain (state machine, line validation, fee, disclosure) | `backend/src/modules/partners/domain/partner-order-math.ts` |
| Service (catalog, orders, disclosure, admin, fee report) | `backend/src/modules/partners/partners.service.ts` |
| Provider/customer controller | `backend/src/modules/partners/partners.controller.ts` |
| Admin controller | `backend/src/modules/partners/partners-admin.controller.ts` |
| Module | `backend/src/modules/partners/partners.module.ts` |
| DTOs | `backend/src/modules/partners/dto.ts` |
| Unit tests (19) | `backend/test/unit/partners.spec.ts` |
| Integration tests (10, real Postgres + Redis) | `backend/test/integration/partners.spec.ts` |
| Admin page (new file) | `admin/src/app/partners/page.tsx` |
| Mobile screen (new file) | `mobile/lib/features/provider/parts_order_screen.dart` |

## How it works

### Catalog — real, queryable, seeded

`LocalPartnerProvider` serves a real Postgres catalog (`partners` +
`partner_catalog_items`, seeded by `0020`): 2 suppliers
(Quetta AC Spares, Quetta Hardware House) and 18 items with real PKR
prices — AC capacitors, R22/R410A gas, copper pipe, remotes, fan motors,
drill/screwdriver sets, wall plugs, PVC tape, wire, MCBs, sockets,
Teflon tape. `GET /partners/catalog` supports `q` (name/SKU/description
search), `category` (`ac_parts` | `hardware` | `electrical` |
`plumbing`), `partner_id`, `in_stock_only`, `limit`/`offset`.

### Ordering flow

1. **Place** — provider only, on one of their jobs in an orderable state
   (`ACCEPTED` … `IN_PROGRESS`; terminal states reject with 409
   `JOB_NOT_ORDERABLE`). The client sends item ids + quantities only
   (plus optional price checks). The server prices every line from the
   catalog snapshot, rejects a client `unit_price_pkr` / `line_total_pkr`
   / `total_pkr` that does not match the catalog (422 `PRICE_MISMATCH` /
   `LINE_TOTAL_MISMATCH` / `ORDER_TOTAL_MISMATCH`), rejects quantity
   outside 1–100, unknown/inactive items, mixed-partner lines (422
   `MIXED_PARTNERS`) and short stock (409 `INSUFFICIENT_STOCK`). Stock is
   reserved on place and restored on cancel. One order = one partner.
2. **Confirm** — provider (or admin oversight). The affiliate fee
   (partner rate, default 5% of the order total) is recorded now.
3. **Deliver** — confirmed → delivered. No money moves.
4. **Cancel** — placed → cancelled (stock restored, no ledger), or
   confirmed → cancelled (stock restored AND the fee reversed).

State machine (strict, `partner-order-math.ts`):
`placed → confirmed → delivered`, `placed → cancelled`,
`confirmed → cancelled`. Anything else is 409
`ILLEGAL_PARTNER_ORDER_TRANSITION`.

### Affiliate fee + ledger

All integer paisa. On confirm, one `txn_id` on the **provider** wallet:

```
D wallet            / C affiliate_fee_rev   (fee paisa)
```

On cancel-after-confirm, a **new** `txn_id` reverses it:

```
D affiliate_fee_rev / C wallet             (fee paisa)
```

The provider wallet balance is debited/credited the fee (it may go
negative, same rule as commission settlement, PRD p.18). A fee of 0
paisa writes no ledger entries. Every pair is checked at COMMIT by the
deferred trigger from `0008` (SUM(D) = SUM(C) per txn_id). The fee
report (`GET /admin/partners/affiliate-fees`) aggregates earned fees
per partner (confirmed + delivered only) and cross-checks every fee /
reversal txn against `ledger_entries`, reporting any mismatch.

### Disclosure (in-app, both sides)

Every order view carries a `partner_disclosure` block (partner name +
affiliate fee + plain-language text), and `GET
/partners/jobs/:jobId/orders` returns the same disclosure text to the
**customer and the provider** of the job. The text states the parts
came from the named partner through Near Service, that Near Service
may earn the stated affiliate fee, and that the fee is charged to the
provider, not the customer, and does not change the job price. There is
no silent affiliate order anywhere in this module.

## Honesty: no live supplier exists

**No real supplier API key, account, or live ordering integration
exists in this build, and none was invented.** The seeded local catalog
is the working implementation. A live supplier is a future onboarding
step (see swap-in guide below), not a hidden dependency: nothing in
the order flow, ledger, or disclosure calls the network.

## Swap-in guide (live supplier)

What the user needs before a live supplier can replace the local catalog:

1. **A supplier account** with a parts supplier that serves Quetta
   (e.g. a wholesaler for AC spares / hardware) and is willing to
   fulfil orders placed by Near Service providers.
2. **An ordering API (or, failing that, a price/stock feed + a manual
   fulfilment channel)** from that supplier: an API key / OAuth
   credentials, a base URL, and documentation for at minimum:
   product list with SKU + price + stock, order placement, order
   status, and cancellation. If the supplier has no API, the honest
   fallback is a daily CSV/price-list import into
   `partner_catalog_items` plus phone/WhatsApp confirmation — the
   `PartnerProvider` interface still fits (an importer class instead
   of an HTTP client).
3. **A commercial agreement** stating the affiliate fee rate (today
   5% per partner, stored on `partners.affiliate_fee_rate`), who pays
   for delivery/returns, and how stock-outs are handled.

How to swap it in (one class, no flow changes):

1. Implement `PartnerProvider` (`partner-provider.interface.ts`) for
   the supplier — `listCatalog`, `searchCatalog`, `getCatalogItem`,
   `reserveStock`, `releaseStock`. Price/stock must come from the
   supplier at order time; keep the server-side pricing rule (the
   client never sets prices).
2. Register the new provider as the service's supplier, e.g. by
   calling `PartnersService.setProvider(new LiveSupplierProvider(...))`
   from the module, or by constructing it in `PartnersModule` and
   passing it in. Do **not** change `partners.service.ts` order,
   ledger, or disclosure code — it only talks to the interface.
3. Keep the local catalog as fallback: if the live supplier is down,
   orders fall back to local stock (or fail closed with a clear
   `PARTNER_UNAVAILABLE` error — never silently substitute a
   different supplier's parts).
4. Add the supplier's credentials to the secure credential store
   (never in chat, never in a migration, never in the repo). The
   service must refuse to boot in live mode without them, mirroring
   the escrow gateway guard (`assertGatewayConfig`).

## Integrator wiring (NOT done by this piece)

This piece deliberately did **not** edit `app.module.ts`,
`openapi.yaml`, `README.md`, `DEMO_SCRIPT.md`, `docker-compose.yml`,
`db/README.md`, or any shared file. The integrator adds:

### 1. AppModule (`backend/src/app.module.ts`)

```ts
import { PartnersModule } from './modules/partners/partners.module';
// add PartnersModule to the imports array
```

### 2. OpenAPI (`backend/openapi.yaml`, currently v1.5.0)

Add the routes below (the route-diff test enforces spec == code, so
add them together with the AppModule wiring). Response shapes are the
`PartnerOrderView` / `CatalogItemView` / `PartnerView` / fee-report
objects returned by `PartnersService`.

Provider/customer (`/partners`, auth required; ordering is `provider` role):

| Method | Path | Description |
|---|---|---|
| GET | `/partners/catalog` | Search/list catalog (`q`, `category`, `partner_id`, `in_stock_only`, `limit`, `offset`) |
| GET | `/partners/catalog/{id}` | One catalog item |
| POST | `/partners/orders` | Place an order (provider, `Idempotency-Key` supported) |
| GET | `/partners/orders` | My orders (provider) |
| GET | `/partners/orders/{id}` | One order (job party only) |
| POST | `/partners/orders/{id}/confirm` | Confirm (records the affiliate fee) |
| POST | `/partners/orders/{id}/deliver` | Mark delivered |
| POST | `/partners/orders/{id}/cancel` | Cancel (+ fee reversal when confirmed) |
| GET | `/partners/jobs/{jobId}/orders` | Job partner-orders + disclosure (customer or provider) |

Admin (`/admin/partners`, roles `super_admin`, `finance`, `support_agent`):

| Method | Path | Description |
|---|---|---|
| GET | `/admin/partners` | List partners (incl. inactive) |
| POST | `/admin/partners` | Create partner |
| PATCH | `/admin/partners/{id}` | Update partner |
| POST | `/admin/partners/catalog-items` | Create catalog item |
| PATCH | `/admin/partners/catalog-items/{id}` | Update catalog item |
| GET | `/admin/partners/orders` | Order list (`status`, `partner_id`, `job_id`) |
| GET | `/admin/partners/orders/{id}` | One order |
| POST | `/admin/partners/orders/{id}/confirm` | Admin confirm |
| POST | `/admin/partners/orders/{id}/deliver` | Admin deliver |
| POST | `/admin/partners/orders/{id}/cancel` | Admin cancel |
| GET | `/admin/partners/affiliate-fees` | Fee report (`from`, `to`, `partner_id`) + ledger check |

### 3. Admin UI (shared files — not edited by this piece)

- Add a Sidebar entry → `/partners` (`admin/src/components/Sidebar.tsx`).
- Add typed helpers to `admin/src/lib/api.ts` and row types to
  `admin/src/lib/types.ts` mirroring the local helpers in
  `admin/src/app/partners/page.tsx` (which currently calls the API
  directly so it works before that lands). The page shows the error
  state — never demo data — when the API is unreachable.

### 4. Mobile (shared files — not edited by this piece)

- Add to `mobile/lib/core/api_client.dart` (same `_send`/`_u` pattern
  as the escrow methods): `listPartnerCatalog`, `createPartnerOrder`,
  `listMyPartnerOrders`, `getPartnerOrder`, `transitionPartnerOrder`,
  `getJobPartnerOrders`. Signatures are in the header of
  `mobile/lib/features/provider/parts_order_screen.dart`.
- Add a router entry, e.g. `/provider/parts` → `PartsOrderScreen`,
  passing `ref.read(apiClientProvider)` as the `PartnerApi`.

## Verification (run for real)

```bash
# unit (19) + integration (10, real Postgres 16 + Redis)
DATABASE_URL="postgresql://root@/nearservice_p4_partners?host=/var/run/postgresql" \
REDIS_URL=redis://localhost:6379 NODE_ENV=test \
  npx jest --config test/jest.config.js test/unit/partners.spec.ts test/integration/partners.spec.ts --runInBand
# typecheck + build
npx tsc --noEmit   # exit 0
npx nest build     # exit 0
# fresh-DB migrate (scratch DB)
DATABASE_URL="postgresql://root@/nearservice_p4_migrate?host=/var/run/postgresql" \
  node dist/scripts/migrate.js   # applies 0001–0020, "migrations complete"
```

## Not verified / not built

- **Live supplier**: no live supplier account, API key, or ordering
  integration exists (see Honesty above). The local catalog is the
  working implementation.
- **AppModule / OpenAPI wiring**: `PartnersModule` is not imported in
  `AppModule` and its routes are not in `openapi.yaml` (conflict rule
  for parallel Phase 4 work). The module is verified standalone via
  `Test.createTestingModule` (see unit spec) and end-to-end at the
  service level against real Postgres; HTTP-level verification needs
  the integrator wiring + the route-diff test.
- **Admin page / mobile screen runtime**: both are new files written
  against the API contract, but neither has been run (admin needs the
  backend wiring + `next build`; mobile needs the `api_client.dart`
  methods + Flutter, which is not installed in this VM). No `dart
  analyze` / `flutter` run was possible here.
- **Concurrent stock race**: stock is reserved with an atomic
  `UPDATE … WHERE stock_qty >= qty` per line inside the order
  transaction, so two simultaneous orders cannot over-reserve the
  same item; a lost-update race across two different items in one
  order is not possible (rows are locked `FOR UPDATE` in line order).
