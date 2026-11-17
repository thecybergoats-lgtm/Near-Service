# Phase 4, Item 1 — Search Scale-Out

Status: built 2026-11-17. Backend + migration + tests + load harness verified
in this VM (see "Verification" below). Admin page type-checks clean; the
mobile screen is NOT compile-verified (no Flutter/Dart in this VM).

## What changed

| Area | Change |
|---|---|
| `GET /search` | Unchanged wire shape. `CatalogService.search` now delegates to `SearchGatewayService` instead of running SQL inline. |
| Search providers | `SearchProvider` interface (`backend/src/modules/search/search-provider.interface.ts`). Three implementations: `trigram` (Phase 1 SQL, verbatim), `scaled` (pg full-text + trigram + Redis cache), `remote` (HTTP forward to an extracted service). |
| Metrics + gate | `SearchMetricsService`: per-query events, p50/p95, zero-result rate, cache-hit rate, CTR; `evaluateGate()` recommends `stay_in_process` or `switch_on_dedicated_tier` against admin-editable thresholds. New admin endpoints `GET /admin/search/metrics`, `GET /admin/search/gate`, `PATCH /admin/search/gate/thresholds` (super_admin). |
| Cache | `SearchCacheService`: Redis result cache for the scaled provider, generation-counter invalidation (`search:cache:generation`). |
| Migration | `db/0016_search_scaleout.sql` (additive only): `search_vector` generated columns + GIN indexes, `search_query_events`, `search_click_events`, `search_gate_config` (seeded defaults), `search_metrics_daily`. |
| Load harness | `backend/src/scripts/search-load-test.ts` (compiled to `dist/scripts/search-load-test.js`). |
| Admin UI | `admin/src/app/search-metrics/page.tsx` (new file only). |
| Mobile UI | `mobile/lib/features/search/search_metrics_screen.dart` (new file only). |

## How the provider is chosen

```
SEARCH_SERVICE_URL set  -> RemoteSearchProvider (HTTP forward)
else SEARCH_PROVIDER=scaled -> ScaledSearchProvider (full-text + trigram + cache)
else                          -> TrigramSearchProvider (Phase 1 behaviour)
```

On any non-trigram provider failure the gateway falls back to trigram and
records `trigram` as the serving provider, so a cache/remote outage
degrades to the proven search instead of failing the request. Config lives
in `search.config.ts` (reads `process.env` directly; see "Wiring" — the
keys are not yet in `src/config/env.ts`).

## The scaled provider — ranking, exactly

Score per category = `0.6 * ts_rank(search_vector, plainto_tsquery('simple', q))`
`+ 0.4 * max trigram similarity` over `name_en`, `name_roman` and keywords.
A row matches if EITHER signal matches, so scaled recall is a strict
superset of trigram recall (asserted in the integration test); only the
ORDER can differ. `search_vector` is a generated `tsvector` (migration
0016, `'simple'` config so Roman Urdu is not stemmed away) with a GIN
index. Provider ranking (PostGIS distance) is identical to Phase 1.

## Cache + invalidation

- Key: `search:v1:gen:{generation}:{sha256(normalised query)}`; TTL
  `SEARCH_CACHE_TTL_SECONDS` (default 120), `SEARCH_CACHE_ENABLED`
  (default true). Lat/lng are rounded to 3 decimals (~100 m) so GPS
  jitter does not defeat the cache.
- Invalidation bumps ONE counter (`search:cache:generation`, Redis INCR).
  Old entries are never read again and die on TTL. This is deliberately
  coarse: invalidating one category/provider invalidates ALL cached
  searches. Reason: the shared `RedisService` has no SCAN /
  delete-by-pattern, and editing it is outside this item. Fine-grained
  per-category invalidation is a documented follow-up once that method
  exists. The TTL is short, so worst case a cached result is 120 s stale.
- **Wiring still open (call sites, not code):** after a successful
  mutation, call `SearchCacheService.invalidateCategory(id)` /
  `invalidateProvider(id)` / `invalidateAll(reason)` from:
  - admin category create/update (`PUT /admin/categories/:id/form-schema`,
    `POST/PATCH /admin/categories` in `AdminController`),
  - provider profile/service writes (`ProvidersService`: profile update,
    `is_online` toggle, service add/remove),
  - category keyword changes (if any writer is added).
  Until those calls land, cached results can be at most TTL-seconds stale.

## Metrics + gate

- Every served search writes one `search_query_events` row (query,
  provider that actually served, cache_hit, latency_ms, result_count).
  Recording is fire-and-forget and never fails a search.
- CTR needs clicks: `recordClick()` exists on the gateway/metrics
  service, but **no `POST /search/click` endpoint exists yet** — until
  one is added (coordinator step, new route + openapi entry), clicks stay
  0 and the gate treats CTR as "no data", never as 0%. An unmeasured CTR
  can never trigger the tier.
- Gate rule (`evaluateGateDecision`, pure, unit-tested): with at least
  `min_queries_for_gate` queries (default 100) in the last `window_hours`
  (default 24), switch on when ANY of: p95 latency > 500 ms,
  zero-result rate > 25%, CTR < 5% (only when clicks exist), volume >
  10,000 queries/day. Otherwise stay. With too few queries the gate
  abstains explicitly ("insufficient data").
- The gate is a RECOMMENDATION. It switches nothing. An admin acts on it
  by setting `SEARCH_SERVICE_URL` (extracted service) or
  `SEARCH_PROVIDER=scaled` and deploying.
- `search_metrics_daily` is the long-lived rollup; write it with
  `SearchMetricsService.rollupDaily('YYYY-MM-DD')` from an ops/admin job.
  No scheduler/cron service exists in this repo — scheduling the rollup
  is an ops step, not part of this item. Raw events have no retention
  policy enforced; decide one in ops (the rollup is the durable record).

## Extraction seam (item 1c) — how to pull search out as a service

Module boundaries, as built:

- `SearchModule` imports ONLY `DatabaseModule` (global). It does not
  import `CatalogModule`, `AdminModule`, or any other feature module.
- Providers read ONLY `categories`, `category_keywords`,
  `provider_profiles`, `provider_services` — the search read model. No
  cross-module DB joins from search. (The `search_*` metrics tables are
  owned by this module.)
- `SearchGatewayService` is the only thing callers use; it talks to the
  `SearchProvider` interface, never to SQL or HTTP directly.

To extract:

1. Copy `backend/src/modules/search/` + `DatabaseService` +
   `RedisService` into a new Nest app that exposes
   `GET /api/v1/search` with the same `SearchResults` shape (the
   existing `CatalogController.search` + `SearchQueryDto` are the
   contract; reuse them verbatim).
2. Give the new service its own `DATABASE_URL` (read replica is fine —
   search only reads the four tables above plus its own metrics tables)
   and `REDIS_URL`.
3. Set `SEARCH_SERVICE_URL=https://<search-service>` on the main API.
   The gateway forwards every search there; on failure it falls back to
   the in-process trigram provider. No API change, no client change.
4. The remote service must answer within 5 s (the provider's timeout)
   and return `{ categories, providers: { items, next_cursor } }`; a
   malformed body is treated as a failure, not passed through.

What extraction does NOT yet cover: the metrics/gate admin endpoints
stay on the main API (they read the same `search_*` tables); if the
extracted service also records events, point both at the same metrics
tables or the gate will only see in-process traffic. Cache invalidation
across the boundary needs the extracted service to share the same Redis
(the generation counter is the invalidation signal).

## Wiring notes for the coordinator (shared files this item did NOT edit)

1. **`backend/openapi.yaml` — REQUIRED before the contract test passes.**
   The route-diff test currently reports exactly these three extra
   routes (verified 2026-11-17, nothing missing):
   `GET /admin/search/gate`, `GET /admin/search/metrics`,
   `PATCH /admin/search/gate/thresholds`. Add (adapt the schema refs to
   the file's existing conventions):
   ```yaml
   /admin/search/metrics:
     get:
       operationId: getSearchMetrics
       tags: [admin]
       security: [{ bearerAuth: [] }]
       parameters:
         - { name: window_hours, in: query, schema: { type: integer, default: 24 } }
         - { name: days, in: query, schema: { type: integer, default: 14 } }
       responses:
         '200': { description: 'Search window stats, gate evaluation and daily rollup.' }
   /admin/search/gate:
     get:
       operationId: evaluateSearchGate
       tags: [admin]
       security: [{ bearerAuth: [] }]
       responses:
         '200': { description: 'Gate evaluation: stay_in_process or switch_on_dedicated_tier, with reasons.' }
   /admin/search/gate/thresholds:
     patch:
       operationId: updateSearchGateThresholds
       tags: [admin]
       security: [{ bearerAuth: [] }]
       requestBody:
         required: true
         content:
           application/json:
             schema:
               type: object
               properties:
                 p95_latency_ms: { type: integer, minimum: 1 }
                 zero_result_rate: { type: number, minimum: 0, maximum: 1 }
                 ctr_floor: { type: number, minimum: 0, maximum: 1 }
                 queries_per_day: { type: integer, minimum: 1 }
                 min_queries_for_gate: { type: integer, minimum: 0 }
                 window_hours: { type: integer, minimum: 1, maximum: 720 }
       responses:
         '200': { description: 'Updated gate thresholds.' }
   ```
   All three are `super_admin`-only (enforced by the `@Roles` guard).
2. **`backend/src/config/env.ts`** (optional, for validation): add
   `SEARCH_PROVIDER` (enum trigram/scaled, default trigram),
   `SEARCH_SERVICE_URL` (optional URL), `SEARCH_CACHE_TTL_SECONDS`
   (default 120), `SEARCH_CACHE_ENABLED` (default true). `search.config.ts`
   reads `process.env` directly, so this is validation-only — the feature
   works without it.
3. **Cache-invalidation call sites** — see "Cache + invalidation" above
   (AdminController category writes, ProvidersService profile/service
   writes).
4. **`POST /search/click`** (optional, for real CTR): new public,
   rate-limited endpoint taking `{ query_event_id?, target_type,
   target_id }` and calling `SearchGatewayService.recordClick`. Needs an
   openapi entry like (1). Until it exists, CTR reports "no data".
5. **Admin nav**: link `/search-metrics` from the admin sidebar (the
   page itself is complete at `admin/src/app/search-metrics/page.tsx`).
   It uses only already-exported `@/lib/api` helpers; no lib edit needed.
   If the coordinator prefers typed helpers in `lib/api.ts` /
   `lib/types.ts`, the page's local interfaces are the spec to copy.
6. **Mobile nav**: add a route to `SearchMetricsScreen`
   (`mobile/lib/features/search/search_metrics_screen.dart`, takes the
   admin token as a constructor arg) in `router.dart` — admin-only
   surface, not a customer flow.
7. **Rollup scheduling**: schedule `rollupDaily()` daily (ops job or a
   future scheduler service) once a scheduler exists.

## Load test — measured numbers (honest)

Harness: `backend/src/scripts/search-load-test.ts`. Single VM, single
Postgres 16 + PostGIS 3 + Redis, in-process gateway, pg pool max 20.
Runs 2026-11-17 against scratch DB `nearservice_p4_load`
(0001–0004 + 0016, seeded Quetta data), 12-query mix, Quetta lat/lng.

| Run | Concurrency | Completed | Errors | Wall | Throughput | p50 | p95 | p99 | Max |
|---|---|---|---|---|---|---|---|---|---|
| scaled | 5,000 | 5,000 | 0 | 1,107 ms | 4,516.7 req/s | 770 ms | 805 ms | 864 ms | 864 ms |
| trigram | 5,000 | 5,000 | 0 | 10,069 ms | 496.6 req/s | 8,388 ms | 9,687 ms | 9,816 ms | 9,888 ms |
| scaled | 100 | 100 | 0 | 101 ms | 990.1 req/s | 93 ms | 99 ms | 99 ms | 99 ms |

Notes, read before quoting these:

- The 5,000-concurrency latencies are dominated by QUEUEING behind the
  20-connection pg pool, not by query time: 5,000 concurrent searches ×
  2 queries each through 20 connections. The unqueued per-query latency
  is the ~100-concurrency row (p50 93 ms, p95 99 ms, cache-assisted).
- The scaled run is cache-assisted (cache-hit rate 0.618 over recorded
  events; the 50-search warmup pre-populates all 12 mix queries). The
  trigram run has no cache (hit rate 0). The ~9x gap at 5,000 is mostly
  the cache, not the ranking query.
- **NOT measured, NOT claimed:** there is no search cluster, no second
  machine and no 50,000-user load rig in this VM. 50,000 concurrent users
  is the Phase 4 load-test TARGET (PRD concurrency design point), to be
  measured on real load infrastructure with a deployed search tier.

## Verification (run 2026-11-17, this VM)

- Unit tests: `npx jest --config test/jest.config.js --runInBand
  test/unit/search-scaleout.spec.ts` — **21 passed**.
- Integration tests (real Postgres + Redis, scratch DB
  `nearservice_p4_search`): `npx jest --config test/jest.config.js
  --runInBand test/integration/search-scaleout.spec.ts` — **9 passed**
  (migration tables/vectors/seeds, trigram find, empty-query shape,
  scaled recall superset + typo tolerance, Redis cache hit then
  invalidation miss, marker stripping, metrics/clicks/gate/rollup,
  admin controller, CatalogService delegation).
- `npx tsc --noEmit` (backend): exit 0.
- `npm run build` (`nest build`): exit 0; `dist/scripts/search-load-test.js`
  produced. (Note: `dist/` was wiped mid-task by another worker/VM
  event and rebuilt; sources were unaffected.)
- Fresh-DB migrate: `npm run migrate` on scratch DB
  `nearservice_p4_fresh` — 0001–0017 applied including
  `0016_search_scaleout.sql` (recorded in `schema_migrations`, 6 gate
  seed rows). The runner then failed on `0018_multi_city.sql` (another
  worker's migration: FK violation on `provider_services`, provider
  `20000000-0202-4000-8000-000000000003` not present) — not this item.
- `node ../db/check-uuids.js`: OK (428 UUID literals valid, 20 files).
- Route-diff: `test/contract/api.contract.spec.ts -t "registered routes
  equal"` fails with ONLY the three new search-admin routes as extra,
  nothing missing (expected until openapi.yaml is updated — see (1)).
- Admin `npx tsc --noEmit`: the new search-metrics page is clean; the
  17 errors reported are all in `admin/src/app/analytics/*` and
  `admin/src/app/warranty/*` (other workers' items).
- Mobile screen: NOT compile-verified (no Flutter/Dart in this VM).

## Files created / changed (this item only)

Created:

- `backend/src/modules/search/search.types.ts`
- `backend/src/modules/search/search-provider.interface.ts`
- `backend/src/modules/search/search.config.ts`
- `backend/src/modules/search/trigram-search.provider.ts`
- `backend/src/modules/search/scaled-search.provider.ts`
- `backend/src/modules/search/remote-search.provider.ts`
- `backend/src/modules/search/search-cache.service.ts`
- `backend/src/modules/search/search-metrics.service.ts`
- `backend/src/modules/search/search-gateway.service.ts`
- `backend/src/modules/search/search-admin.controller.ts`
- `backend/src/scripts/search-load-test.ts`
- `backend/test/unit/search-scaleout.spec.ts`
- `backend/test/integration/search-scaleout.spec.ts`
- `db/0016_search_scaleout.sql`
- `docs/phase4-search.md` (this file)
- `admin/src/app/search-metrics/page.tsx`
- `mobile/lib/features/search/search_metrics_screen.dart`

Changed:

- `backend/src/modules/search/search.module.ts` (rewritten: providers +
  admin controller; dropped the old CatalogModule re-export)
- `backend/src/modules/catalog/catalog.module.ts` (imports SearchModule)
- `backend/src/modules/catalog/catalog.service.ts` (search() delegates
  to the gateway; the SQL moved verbatim to TrigramSearchProvider)

Not touched (per conflict rules): `app.module.ts`, `openapi.yaml`,
`README.md`, `DEMO_SCRIPT.md`, `docker-compose.yml`, `db/README.md`,
`src/config/env.ts`, any shared admin/mobile lib file, any other
worker's files.
