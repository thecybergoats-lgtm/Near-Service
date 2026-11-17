# Phase 4, Item 3 — Multi-City Ops Tooling

## What was built

### (a) Cities table + go/no-go gate — `db/0018_multi_city.sql`, `backend/src/modules/cities/`

- `cities` extended (additive): `status` lifecycle
  `planned → in_preparation → gate_review → live → paused` (paused re-enters
  `gate_review`), `manager_id`, `supply_target_providers`, `population_estimate`,
  timestamps. A `CHECK (status <> 'live' OR is_launched)` keeps the new status
  in agreement with the legacy `is_launched` flag. Quetta backfilled to `live`.
- `city_gate_configs` — per-city thresholds, editable in admin:
  `min_providers` (10), `min_supply_density_per_100k` (0.8),
  `min_fill_rate` (0.5), `max_time_to_first_offer_seconds` (900).
- `city_gate_evaluations` — every evaluation persisted with its metrics,
  per-metric results and `passed`, plus an `audit_logs` row
  (`city.gate_evaluate`). Metrics are computed live by
  `CitiesService.computeMetrics`: providers inside the city's default radius,
  density per 100k residents, and — over non-cancelled requests in the last
  30 days inside the radius — fill rate and mean time to first offer.
  Pure decision in `gate.ts:evaluateGate` — **a null metric is a FAIL, not a
  skip** (no requests = no evidence of fill rate / offer speed; no population
  = no density denominator).
- Going live requires the **latest** evaluation to have passed
  (`GATE_NOT_PASSED`, 409); illegal jumps are `ILLEGAL_CITY_TRANSITION`, 409.
  Pausing clears `is_launched`; re-going-live requires a fresh pass.

### (b) City Manager scoped admin

- Scoping is enforced **server-side in `CitiesService`** against
  `user_roles.city_id` (schema already existed, 0001): global `super_admin`
  sees everything; a `city_manager` sees/acts only on assigned cities; any
  attempt on an unassigned city is **403** (`requireCityAccess`). The JWT
  roles alone are never trusted for scope — the token carries no city.
- `POST /admin/cities/:id/assign-manager` (super_admin) assigns a manager
  (user must already hold the `city_manager` role).
- Managers can manage their cities' supply targets, radius rules, gate
  config, categories, commission rules, fair prices, checklist and run gate
  evaluations. Status transitions and manager assignment are super_admin only.

### (c) Per-city overrides (precedence proven by tests)

- **Commission:** no new table — `commission_rules.city_id` (0003) + the
  shared `pickCommissionRule` specificity order
  (`city+category > category > city > global > default`). `GET
  /admin/cities/:id/effective-commission` returns `{rate, ruleId, source}`.
  Test proves: city 12% beats global 10%; a global category rule 8% beats a
  city-only rule (specificity category 4 > city 3); city+category 13% beats both.
- **Pricing:** `fair_price_seed.city_id` (0001); city row wins, else the
  global row (`city_id NULL`), else null. `POST /admin/cities/:id/fair-price`
  upserts the city row.
- **Categories:** new `city_category_overrides` (city, category, is_enabled).
  Quetta: 5 launch categories enabled. Karachi: same 5, disabled (pending).

### (d) Karachi launch seed + gate evaluation

- Karachi row (`in_preparation`, pop. ~16M, target 10 providers, **default
  radius 12 km** — Karachi is a sprawling metro; the pilot's 5 km radius
  would have excluded the Gulshan/Clifton seed supply from the gate count),
  5 areas, 7-item launch checklist (all pending), gate config (defaults),
  3 seed providers (Karachi Cool Air, Ustad Rashid Electrician, Al-Rehman
  Plumbing Karachi) + fair-price seed for 3 categories.
- **Karachi gate evaluation result (honest FAIL, from the live run):**
  `passed: false` — `providerCount: 3` (need 10),
  `supplyDensityPer100k: 0.019` (need 0.8), `fillRate: null` (no requests —
  reason `no_data`), `timeToFirstOfferSeconds: null` (reason `no_data`).
  Quetta stays the live pilot city — its status was not changed.
- Quetta checklist seeded all-done (history); Karachi checklist all pending.

### (e) SEO landing pages + shop pages

- **Backend-served server-rendered HTML** in `SeoController` (public, no
  auth). Chosen over a Next.js route because the admin app is the admin
  console, not the public site, and this keeps the pages testable against
  the live DB in the same module.
  - `GET /api/v1/services/:categorySlug/:areaSlug` — e.g.
    `/api/v1/services/ac-repair/satellite-town-quetta`. Real providers
    offering that category within the city radius of the area centre, real
    review summaries, real fair-price range, `<title>`, meta description
    and schema.org `Service` JSON-LD. Areas are seeded in `city_areas`
    (5 Quetta, 5 Karachi); the slug carries the city.
  - `GET /api/v1/shops/:providerId` — public shop page with the real review
    summary (average, count, 1–5 distribution, 3 latest comments).
  - `GET /api/v1/services` — index of enabled landing pages (disabled
    categories, e.g. Karachi book-binding, do not appear).
- All provider/review text is HTML-escaped; JSON-LD `<`/`>`/`&` are
  unicode-escaped after stringify (a hostile provider name must not break
  out of the `<script>` block — caught by a unit test).
- **Path note:** the global prefix puts these under `/api/v1/...`; the path
  after the prefix already matches the PRD format. A reverse proxy can
  expose them at the site root later. The 404 for an unknown area is the
  shared JSON error shape (in the response text, since the route serves
  `text/html`).

## Files created (nothing outside this item was edited)

- `db/0018_multi_city.sql`
- `backend/src/modules/cities/gate.ts` — pure gate + lifecycle
- `backend/src/modules/cities/cities.service.ts`
- `backend/src/modules/cities/seo.service.ts` + `seo-render.ts`
- `backend/src/modules/cities/cities-admin.controller.ts`
- `backend/src/modules/cities/seo.controller.ts`
- `backend/src/modules/cities/cities.module.ts`
- `backend/src/modules/cities/uuid.pipe.ts` — see gotcha below
- `backend/test/unit/cities-gate.spec.ts`, `backend/test/unit/cities-seo-render.spec.ts`
- `backend/test/integration/cities.spec.ts`
- `admin/src/app/cities/page.tsx` — Cities admin page (new file only)
- `docs/phase4-cities.md` (this file)

## Wiring still needed (integrator — these files were NOT touched)

1. **`backend/src/app.module.ts`**: add
   `import { CitiesModule } from './modules/cities/cities.module';` and
   `CitiesModule` to `imports`. (The module imports `DatabaseModule`
   explicitly so it also boots standalone in tests.)
2. **`backend/openapi.yaml`** (currently v1.5.0): add these routes
   (the route-diff test will fail until they are added, by design):
   - `GET/POST /admin/cities`, `GET /admin/cities/{id}`
   - `PATCH /admin/cities/{id}/targets`, `PATCH /admin/cities/{id}/gate-config`
   - `POST/GET /admin/cities/{id}/gate-evaluations`
   - `POST /admin/cities/{id}/status`, `POST /admin/cities/{id}/assign-manager`
   - `GET /admin/cities/{id}/checklist`, `PATCH /admin/cities/{id}/checklist/{itemKey}`
   - `GET /admin/cities/{id}/categories`, `PATCH /admin/cities/{id}/categories/{categoryId}`
   - `GET /admin/cities/{id}/effective-commission`, `POST /admin/cities/{id}/commission-rules`
   - `GET/POST /admin/cities/{id}/fair-price`
   - `GET /services`, `GET /services/{categorySlug}/{areaSlug}`, `GET /shops/{id}` (public HTML)
3. **Admin nav**: add a Cities entry in `admin/src/components/Sidebar.tsx`
   (shared file — not edited). The page itself
   (`admin/src/app/cities/page.tsx`) is self-contained: it calls the API
   with `fetch` using `NEXT_PUBLIC_API_URL` + the `ns_admin_token`
   localStorage key, exactly like `lib/api.ts`. Optional follow-up: move its
   calls into `admin/src/lib/api.ts` + add `City`/`GateEvaluation`/
   `ChecklistItem` types to `admin/src/lib/types.ts`.
4. **Mobile city selection**: NOT built — there is no Flutter/Dart toolchain
   in this VM to verify it, and the mobile `ApiClient` has no cities
   endpoints yet. Wiring: add `GET /admin/cities`-style public endpoint
   `GET /cities` (live cities only) to this module, add `City` model +
   `fetchCities()` to `mobile/lib/core/api_client.dart` / `models.dart`,
   and a `CitySelector` widget under `mobile/lib/features/common/` wired
   into the customer home router.

## Verification (all run for real)

- `npx tsc --noEmit` in `backend/`: **exit 0**.
- `npx nest build` in `backend/`: **exit 0**.
- Fresh-DB migrate 0001–0015 + 0018 on scratch DB `nearservice_p4_cities`:
  **clean** (`ALL MIGRATIONS OK`; Quetta `live`, Karachi `in_preparation`,
  3 Karachi providers within radius, 10 areas, Quetta 5 categories enabled,
  Karachi 5 disabled). `node db/check-uuids.js`: OK (428 literals).
- Unit: `npx jest --config test/jest.config.js --runInBand
  test/unit/cities-gate.spec.ts test/unit/cities-seo-render.spec.ts` —
  **18 passed**. Full unit suite: **31 suites, 485 passed, 1 skipped**.
- Integration (real Postgres 16 + PostGIS):
  `DATABASE_URL=postgresql://root@/nearservice_p4_cities?host=/var/run/postgresql
  NODE_ENV=test npx jest --config test/jest.config.js --runInBand
  test/integration/cities.spec.ts` — **12 passed**, including:
  Karachi gate FAIL (see (d)), 403 scoping, override precedence,
  scratch-city pass → live → pause, landing page with real reviews +
  meta tags, shop page, index + 404.
- Admin page: `npx tsc --noEmit` in `admin/` — `src/app/cities/page.tsx`
  is clean. (The admin tsc run still exits 2 on `src/app/warranty/page.tsx`
  — another parallel worker's in-progress file, untouched here.)

## Gotchas found while building (for the next worker)

- **Seed UUIDs were version-0, not v4 — fixed by Fix A.**
  Quetta was a version-0 UUID; the house
  `uuidParamPipe` (v4) and validator.js `IsUUID` both 422'd it, so this
  module used a shape-only pipe (`uuid.pipe.ts`) and a
  `Matches(CANONICAL_UUID)` DTO validator. `db/0021_fix_seed_uuids.sql`
  rewrote every seeded id to RFC-4122 v4 (Quetta is now
  `00000000-0000-4000-8000-0000aaaa0001`); the shape-only pipe is kept
  for compatibility and now accepts the v4 ids.
- **node-pg untyped params + `CASE`**: reusing one `$n` parameter both as
  an assignment and inside `CASE WHEN $n='live' ...` makes Postgres fail
  type deduction (`inconsistent types deduced for parameter $2`). The
  status UPDATE computes `is_launched` in JS and passes plain booleans.
- **Karachi radius**: 12 km, not 5 km (see (d)). Quetta stays 5 km.
- **Bilal AC Services is 5,140 m from Satellite Town centre** — just
  outside Quetta's 5 km radius, so it honestly does not appear on the
  `/services/ac-repair/satellite-town-quetta` page (2 providers, not 3).
- **Migration 0018 is not transactional** (like the other migrations) and
  re-running it on the same DB would fail at the `chk_cities_live_flag`
  constraint; the integration spec drops the schema first, as house style.

## Not verified

- The module is **not wired into `AppModule` or `openapi.yaml`** (forbidden
  files) — the routes are unreachable in the live app until the integrator
  does steps 1–2 above. Verified only standalone via
  `Test.createTestingModule({ imports: [CitiesModule] })`.
- Admin Cities page never rendered in a browser (no live browser here);
  type-checked only. It is not linked in the sidebar (step 3).
- Mobile city selection not built (step 4).
- `next build` for the admin app not run (the other worker's warranty page
  currently fails `tsc`, so a full admin build would fail for reasons
  outside this item).
- The full backend suite (36 suites/469 tests baseline) was not re-run in
  full: other integration specs need their own dedicated DBs and other
  workers are editing those modules live. Unit suite (31 suites) passes;
  this item edits no shared file, so it cannot affect other suites.
