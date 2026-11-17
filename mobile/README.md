# Near Service — Flutter Mobile App (Phase 1 MVP)

Local services marketplace for Pakistan. Launch city **Quetta**, 5 categories
(Book Binding, AC Repair, Electrician, Plumber, Mobile Repair). InDrive-style
bidding: customer posts a request with a PKR offer, providers accept or
counter (max 3 rounds), customer accepts one, job tracked, cash payment,
rating. Built from the approved Phase 0 PRD v1.1
(`~/workspace/your_files/near-service-phase-0-prd/near-service-phase-0-prd.pdf`,
design system p.26, screen map p.22) and its OpenAPI 3.1 skeleton
(`near-service-openapi.yaml`, Phase 1 only, 43 paths / 47 ops).

> **PRD v1.1 applied (17 Nov 2026):** manual verification only in
> Phase 1; one wallet per user with profile-level views; `category_id`
> is a UUID end-to-end (slugs are sent as `category_slug` and resolved
> by the server, see `lib/core/category_resolver.dart`); onboarding is
> `{step, data}` with step `identity | business | service_area |
> payout`; confirm-payment is cash-only with no request body.
> Phase 1 timeline (v1.1): **16–20 weeks to the Quetta pilot for
> 1 Flutter + 1 backend dev** (the v1.0 estimate is withdrawn).

> **Verification status — read this first:** this VM has **NO Flutter/Dart
> installed, so compilation was NOT verified here**. Do not claim it compiles
> until `flutter analyze` / `flutter run` passes on a machine with Flutter.
> What was done instead: a careful manual review pass — every import checked
> against files created, no missing files referenced, Dart syntax reviewed
> file by file (see "Review pass" below).

## Setup

```bash
cd ~/workspace/near-service/mobile
flutter pub get
flutter run
```

Requirements: Flutter 3.22+, Dart 3.4+, Android SDK (Android first; iOS is
Phase 3). Package name: `com.nearservice.app`. The `android/` scaffold
(Manifest with location + internet permissions, `MainActivity.kt`,
Gradle files with `applicationId com.nearservice.app`) is included; create
`android/local.properties` with `flutter.sdk=<path>` on first run, or run
`flutter create --org com.nearservice --project-name near_service .` to
regenerate the platform folders if the hand-written scaffold ever drifts
from your Flutter version.

## API base URL

Default: `http://localhost:3000/api/v1` (local NestJS dev server), configured
in `lib/core/constants.dart` (`AppConstants.apiBaseUrl`). Override at build
time without editing code:

```bash
flutter run --dart-define=API_BASE_URL=https://api.example.com/api/v1
```

Socket.IO uses `AppConstants.socketUrl` (default `http://localhost:3000`).

## Auth / dev OTP

Phone + OTP (`POST /auth/otp/request`, `POST /auth/otp/verify`). **Dev mode:
the backend prints the OTP to its console** — the OTP screen shows this hint;
check the backend terminal if no SMS arrives. Never paste OTPs in chat.
Tokens are stored in `flutter_secure_storage`; the API client attaches the
JWT, refreshes once on 401 (`POST /auth/refresh`), and sends an
`Idempotency-Key` UUID on every mutating call.

## Maps

`flutter_map` + OpenStreetMap tiles — **no paid Maps key needed**. (The PRD
names Google Maps as primary with OSM as the documented fallback; this build
uses the free OSM route so the demo runs with zero billing setup.)

## Structure

```
lib/
  main.dart                     App entry, locale loading, MaterialApp.router
  router.dart                   go_router routes for every screen
  core/
    constants.dart              API URLs, Quetta centre, radii, category slugs
    theme.dart                  PRD tokens: teal #0F766E, amber #D97706,
                                16–20px radius, 48px min touch
    api_client.dart             REST client: JWT + 401 refresh + Idempotency-Key,
                                UUID category ids (slugs sent as category_slug),
                                OpenAPI 3.1 contract (Phase 1 only)
    category_resolver.dart      slug <-> UUID resolution via GET /categories
    socket_service.dart         Socket.IO: offer.received/updated, job.state_changed,
                                offer.closed, chat.message
    models.dart                 User, Category, Provider, Offer, Request, Job, Chat, Wallet
    money.dart                  PKR formatting + FairRange (min/typical/max)
    errors.dart                 {error:{code,message}} -> ApiException
    demo_data.dart              DEMO FALLBACK: 7 realistic Quetta providers (offline only)
  l10n/app_localizations.dart   en / ur / ur-roman string maps (core keys)
  features/
    auth/                       language, onboarding (3 slides), phone, OTP, role
    customer/                   home map, search, categories, provider list/profile,
                                request form, live offers, job tracking, chat,
                                cash payment + receipt, rating, history, favorites,
                                wallet, settings
    provider/                   onboarding wizard (4 steps, resumable), dashboard,
                                incoming request sheet, counter composer, active job,
                                earnings
    common/                     provider_card, offer_card, job_stepper,
                                fair_price_meter, offline banner, skeletons
```

## Demo data fallback

If the API is unreachable, screens fall back to the seeded Quetta providers
in `lib/core/demo_data.dart` (7 providers, clearly marked "Demo data" in the
UI via `OfflineBanner(isDemo: true)`). The API is always the primary path.
Names are invented realistic Quetta names — the backend seed was not
available when this was written, so align them with the real `db/` seed
before the pilot.

## Known limits (honest, Phase 1 scope)

- **Not compiled here** — no Flutter/Dart in this VM (see top).
- History screen shows an honest empty state until the backend ships a
  `GET /jobs` list endpoint; it does not fabricate jobs.
- Voice search, AI intent parsing, masked calling, wallet top-up/payout,
  escrow, JazzCash/Easypaisa are Phase 2/3 — shown disabled or labelled,
  never faked.
- Chat uses a local sender id (`'me'`) until app state wires the real user
  id from `GET /me`; replace `_myId` in `chat_screen.dart` when wiring.
- Fair-price meter marker position uses a fixed-width approximation.
- Urdu-script strings are launch copy — a native reviewer should re-check
  them before store submission (PRD p.26).

## Review pass (manual, no compiler)

- All `import` paths checked against the file tree below; no file referenced
  that does not exist.
- go_router routes in `router.dart` match every screen's constructor args.
- API paths match the OpenAPI 3.1 skeleton (`near-service-openapi.yaml`):
  onboarding `{step, data}`, document upload `{upload_url, storage_key}`,
  `GET /me/profiles`, cash-only `confirm-payment` (no body), disputes
  `POST /jobs/{id}/disputes`, error shape `{error:{code,message},
  request_id}`. No Phase 2 endpoints (wallet top-up, payment intents,
  payouts) are called.
- Brace/paren balance spot-checked per file with a script (see report).

## File tree

Run `find lib -name '*.dart' | sort` for the authoritative list.
