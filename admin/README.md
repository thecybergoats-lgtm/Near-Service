# Near Service — Admin Panel (Phase 1 MVP)

Web admin panel for the Near Service local services marketplace (launch city: Quetta).
Next.js (App Router) + React + TypeScript + Tailwind CSS. Port **3001**.

Built against the Phase 0 PRD v1.1 (`near-service-phase-0-prd.pdf`, admin modules §12, design
tokens §13: teal `#0F766E` primary, amber `#D97706` accent) and the Phase 1 OpenAPI skeleton
(`near-service-openapi.yaml`, 43 paths / 47 ops). **Phase 1 verification is MANUAL review only**
— OCR / face-match / liveness are Phase 2/3, so the verification queue shows CNIC front/back +
selfie side-by-side for a human decision and carries no automated scores.

Phase 1 timeline (PRD v1.1): **16–20 weeks to the Quetta pilot for 1 Flutter + 1 backend dev**.

## Setup

```bash
cp .env.example .env.local   # edit NEXT_PUBLIC_API_URL if the API is not on localhost:3000
npm install
npm run dev                  # http://localhost:3001
npm run build                # production build
npm start                    # serve the production build on port 3001
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000/api/v1` | Backend API base URL |

## Auth

OTP login (`POST /auth/otp/request`, `POST /auth/otp/verify`). Dev admin account:
`+923001111111` (dev OTP). The JWT is stored in **localStorage** for this MVP — that is
acceptable for the pilot but must move to httpOnly cookies + rotating refresh tokens before
production (PRD §14). Every page redirects to `/login` without a token.

Roles (PRD §4): `super_admin`, `verification_officer`, `support_agent`, `finance`,
`marketing`, `city_manager`. The role is shown in the top bar. UI gating is applied on top of
server-side RBAC (never instead of it):

- Verification approve/reject: Super Admin + Verification Officer only.
- Suspend/unsuspend users: Super Admin + Support Agent only.
- Disputes: **read-only in Phase 1** for every role — resolution needs the finance dispute
  workflow with step-up auth and ledger entries, which is not wired yet.

## Pages

| Route | Contents |
|---|---|
| `/` | KPI dashboard: GMV, jobs, take rate, active users/providers, acceptance rate, time-to-first-offer, cancellation rate, NPS, open disputes; jobs-by-category SVG chart; latest jobs; open disputes |
| `/login` | OTP login (phone → OTP → verify) |
| `/verifications` | Manual review queue (PRD v1.1): CNIC front/back + selfie side-by-side, approve/reject with mandatory note (`{decision: approved\|rejected, note}`) |
| `/users` | Users/providers table, search, role/status filters, suspend/unsuspend |
| `/categories` | Category tree (3-level taxonomy), add/edit category + keywords/aliases (locale-prefixed); `category_id` is the UUID, slug is a separate resolver |
| `/requests` | Service requests table, status filter, search, fair-price range |
| `/jobs` | Jobs table with state filter; detail drawer with full `job_events` timeline |
| `/disputes` | List + detail drawer, SLA timers, read-only in Phase 1 (see note on the page) |
| `/audit-logs` | Read-only, cursor-paginated audit trail of every admin action (`GET /admin/audit-logs`) |

## API wiring

All calls go through `src/lib/api.ts` (typed fetch client, JWT `Authorization: Bearer`,
`{error:{code,message}}` error shape). Endpoints used:

- `POST /auth/otp/request`, `POST /auth/otp/verify`
- `GET /admin/kpis`, `GET /admin/verifications`, `POST /admin/verifications/:documentId/decide`
  with body `{ decision: "approved" | "rejected", note }`
- `GET /admin/users`, `PATCH /admin/users/:id/suspend`
- `GET/POST/PATCH /admin/categories`
- `GET /admin/requests`, `GET /admin/jobs`, `GET /admin/disputes`
- `GET /admin/audit-logs?cursor&limit` (cursor-paginated, read-only)

Note: of the admin routes above, only `GET /admin/verifications`,
`POST /admin/verifications/{documentId}/decide`, `GET /admin/users`,
`GET /admin/categories`, `GET /admin/jobs`, `GET /admin/disputes` and
`GET /admin/audit-logs` are in the Phase 1 OpenAPI skeleton. `GET /admin/kpis`,
`GET /admin/requests`, the category writes and `PATCH /admin/users/:id/suspend`
are panel conveniences not yet in the skeleton — the backend must confirm their
contract before Phase 1 sign-off. No Phase 2 endpoints are called: wallet/payouts,
payment intents, commission editor and promo manager are intentionally excluded.

## Demo fallback

If the API is unreachable, list endpoints fall back to a **clearly-labelled demo dataset**
(`DEMO_*` in `src/lib/api.ts`) and every affected page shows a yellow **DEMO DATA** banner.
Demo data is never presented as live data. A real HTTP error from the API (e.g. 401/403/409)
is surfaced as an error state instead — it is not masked by demo data. Mutations
(approve/reject, suspend, category save) have no demo fallback: they call the real API and
show the error if it is down.

## Not in Phase 1 (gaps)

- Pricing & commission rules editor, growth/promos, ledger viewer / payout approvals,
  city launch manager, RBAC role-grant UI (PRD §12 modules beyond the Phase 1 scope in the
  task) — the API routes for these do not exist in the Phase 1 skeleton either. Wallet is
  Phase 2 and is exactly one wallet per user (profile-level); the panel has no wallet UI.
- Dispute resolution actions (see above).
- httpOnly-cookie auth + refresh-token rotation.
- Live operations map / request-provider heatmap (dashboard shows KPI cards + charts instead).
