# Phase 4 — Analytics Warehouse (item 2)

PRD v1.1 Phase 4 line: "analytics warehouse". Monthly statements and
tax-ready exports are generated from the ledger, designed for FBR/PRA/SRB
reporting **subject to legal review** (PRD p.32).

## What was built

### (a) Schema — `db/0017_analytics_warehouse.sql` (additive only)

Star schema in the public schema, `analytics_*` tables; no operational
table is touched.

| Table | Grain / notes |
|---|---|
| `analytics_dim_city` | one row per city (from `cities`) |
| `analytics_dim_category` | one row per category (from `categories`, with parent slug) |
| `analytics_dim_zone` | one row per zone (from `zones`) |
| `analytics_dim_time` | one row per calendar day, generated from the earliest source row to today |
| `analytics_dim_provider_tier` | one row per tier (from `provider_tiers`) |
| `analytics_fact_requests` | one row per `service_requests` (PK = request id). Flags precomputed at load: `offers_count`, `first_offer_seconds`, `had_offer`, `is_accepted`, `is_completed`, `is_rated`. City = nearest city centre, zone = containing zone polygon (both nullable outside every city/zone). |
| `analytics_fact_jobs` | one row per `jobs` (PK = job id); `commission_pkr`, `stars` (latest review), `is_completed`/`is_rated` |
| `analytics_fact_payments` | one row per `payments` (PK = payment id) |
| `analytics_fact_providers` | **daily snapshot**, PK = (provider_id, snapshot_date): tier, rating, jobs completed, online flag, nearest city |
| `analytics_etl_runs` | one row per ETL run: status, `counts`, `reconciliation` (operational vs warehouse counts per entity) |

Money is PKR as stored on jobs/payments. The double-entry ledger
(paisa) remains the system of record for money (PRD p.18) and is NOT
copied into the warehouse.

### (b) Nightly ETL — `backend/src/modules/analytics/`

- `POST /admin/analytics/etl/run` (roles: `super_admin`, `finance`) —
  runs the load on demand; returns the run report including reconciliation.
- `GET /admin/analytics/etl/status` (roles: `super_admin`, `finance`,
  `city_manager`) — latest run.
- **Idempotent:** every fact upsert is `INSERT ... ON CONFLICT DO UPDATE`
  keyed by the source id (providers by (provider_id, snapshot_date)), so
  re-running the same day never duplicates a fact row. The run log
  appends one row per run (that is a log, not duplicated facts).
- **Reconciliation:** each run counts operational vs warehouse rows for
  requests / jobs / payments / providers (providers against the latest
  snapshot date) and stores the result on the run row. A mismatch is
  reported in the response — never hidden. A failed run inserts a
  `status='failed'` run row with the error.
- The ETL reads operational tables only; it never writes them. Dashboards
  read warehouse facts only, so admin queries cannot slow down booking.

**Scheduling — no scheduler exists in this repo, so there is no
in-process cron.** The operator runs the ETL nightly from an external
scheduler (same pattern as the ledger reconciliation,
`POST /admin/reconciliation/run`):

```cron
0 2 * * * curl -X POST https://<host>/api/v1/admin/analytics/etl/run \
  -H "Authorization: Bearer <service-token>"
```

02:00 PKT, after the day's business, before the morning dashboards are
read. On-demand runs use the same endpoint.

### (c) Admin dashboards — backend + admin UI

Backend (`AnalyticsService`, warehouse facts only; date filters default
to the last 30 days, `from`/`to` are `YYYY-MM-DD`):

- `GET /admin/analytics/funnel?from&to` — request → offer → accept →
  complete → rate counts + `offerRate` / `fillRate` / `completionRate` /
  `ratingRate` + median time-to-first-offer (seconds, `percentile_cont`).
- `GET /admin/analytics/revenue?group_by=city|category&from&to` —
  jobs, completed jobs, revenue PKR, commission PKR per city/category.
- `GET /admin/analytics/supply-demand?from&to` — demand by city + hour
  of day (requests, with-offers) and supply by city from the latest
  provider snapshot (total / online providers).

Admin pages (new files only): `admin/src/app/analytics/page.tsx`
(dashboard: funnel cards, revenue tables, supply/demand, ETL run +
reconciliation, "Run ETL now" button) and
`admin/src/app/analytics/exports/page.tsx` (CSV downloads + disclaimer).
API helpers live in `admin/src/app/analytics/analytics-api.ts` (imports
`API_URL`/`getToken`/`ApiError` from `@/lib/api`; no shared admin file
was edited).

### (d) CSV exports — FBR/PRA/SRB-style reporting

- `GET /admin/analytics/export/:table` (roles: `super_admin`, `finance`),
  tables: `fact_requests`, `fact_jobs`, `fact_payments`,
  `fact_providers`, `revenue_by_city`, `revenue_by_category`.
  Returns real CSV from the warehouse tables (RFC 4180 quoting).
- **Every export is labelled subject to legal review:** the file starts
  with `# SUBJECT TO LEGAL REVIEW — ...` comment lines naming FBR/PRA/SRB,
  and the response carries an `X-Analytics-Disclaimer` header with the
  same text. These figures are derived from the warehouse as of the last
  ETL run and are **not** a tax filing — Finance / legal counsel must
  verify before any submission (PRD p.32).

## Integrator wiring (files this piece must not touch)

1. `backend/src/app.module.ts` — add `AnalyticsModule` to the imports
   array (`import { AnalyticsModule } from './modules/analytics/analytics.module';`).
2. `backend/openapi.yaml` — add the 6 routes below (bump the version
   note; the route-diff test will enforce spec == code once wired).
   The admin sidebar link (`Analytics`) is a one-line addition in
   `admin/src/components/Sidebar.tsx` pointing at `/analytics` — left
   for the integrator; the pages work unlinked at `/analytics` and
   `/analytics/exports` until then.

```yaml
/admin/analytics/etl/run:
  post:
    operationId: runAnalyticsEtl
    security: [{ bearerAuth: [] }]
    responses: { '200': { description: 'ETL run report with reconciliation' } }
/admin/analytics/etl/status:
  get:
    operationId: getAnalyticsEtlStatus
    responses: { '200': { description: 'Latest ETL run, or null' } }
/admin/analytics/funnel:
  get:
    operationId: getAnalyticsFunnel
    parameters:
      - { name: from, in: query, schema: { type: string, format: date } }
      - { name: to, in: query, schema: { type: string, format: date } }
    responses: { '200': { description: 'Funnel counts, rates, median time-to-first-offer' } }
/admin/analytics/revenue:
  get:
    operationId: getAnalyticsRevenue
    parameters:
      - { name: group_by, in: query, schema: { type: string, enum: [city, category] } }
      - { name: from, in: query, schema: { type: string, format: date } }
      - { name: to, in: query, schema: { type: string, format: date } }
    responses: { '200': { description: 'Revenue / commission rows' } }
/admin/analytics/supply-demand:
  get:
    operationId: getAnalyticsSupplyDemand
    parameters:
      - { name: from, in: query, schema: { type: string, format: date } }
      - { name: to, in: query, schema: { type: string, format: date } }
    responses: { '200': { description: 'Demand by city/hour + supply by city' } }
/admin/analytics/export/{table}:
  get:
    operationId: exportAnalyticsCsv
    parameters:
      - { name: table, in: path, required: true, schema: { type: string, enum: [fact_requests, fact_jobs, fact_payments, fact_providers, revenue_by_city, revenue_by_category] } }
    responses: { '200': { description: 'CSV export, subject to legal review', content: { 'text/csv': { schema: { type: string } } } } }
```

## Verification

- Unit: `backend/test/unit/analytics-csv.spec.ts` — CSV escaping/quoting,
  funnel-rate math (incl. zero denominators), standalone Nest module
  wiring (`AnalyticsModule` + stub `DatabaseService`), ETL/dashboards/
  CSV against the stub. 14 tests.
- Integration: `backend/test/integration/analytics-warehouse.spec.ts`
  (real Postgres 16 + PostGIS 3, scratch DB `nearservice_p4_analytics`;
  skipped without `DATABASE_URL`/`REDIS_URL`) — migration 0017 tables,
  ETL fixture correctness (first-offer 60s, flags, Quetta derivation,
  PKR 1,500 / commission 150, 5 stars), idempotency (second run changes
  no fact counts), reconciliation match on all four entities, funnel /
  revenue / supply-demand aggregates vs operational SQL, CSV content +
  disclaimer.
- `npx tsc --noEmit` and `nest build` in `backend/` — see the delivery
  report: both are currently blocked repo-wide by other parallel
  Phase 4 workers' in-progress files (see "Not verified").

## Known limits

- City/zone on a fact is the nearest city / containing zone at load
  time; if a city centre or zone polygon moves, facts refresh on the
  next ETL run (upsert overwrites them).
- Requests hard-deleted from the operational DB are not removed from
  the warehouse (operational deletes are soft-deletes via `deleted_at`,
  which the ETL excludes; a hard delete would surface as a
  reconciliation mismatch to investigate).
- Provider supply is a daily snapshot, not intraday — hourly supply is
  the latest snapshot repeated; demand is hourly.
- No scheduler is wired in-repo (see above); until the operator adds
  the 02:00 cron line, the ETL only runs on demand.
