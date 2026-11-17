# Near Service — Phase 3 API Addendum

Phase 3 endpoints added on top of OpenAPI 3.1 v1.4.0. **Unlike Phase 2,
this addendum is folded into the YAML:** `backend/openapi.yaml` is now
**v1.5.0 — 161 paths / 179 operations** (v1.4.0's 102 + 77 new), and the
route-diff test (`backend/test/contract/api.contract.spec.ts`) enforces
spec == code, so this document is a human guide, not a second contract.
If the two disagree, the YAML + the code win and this file must be
fixed.

Base URL: `/api/v1`. All responses use the Phase 1 error shape
`{ "error": { "code", "message", "details" }, "request_id" }`.
List endpoints return the v1.2 envelope `{ "items": [...], "next_cursor" }`
unless noted. Mutating marketplace calls accept `Idempotency-Key`
(replay returns the original response; same key + different body → 422
`IDEMPOTENCY_KEY_REUSED`). All money is integer paisa in the ledger;
amounts in request/response bodies are PKR decimals. Currency is PKR.

## 1. AI Gateway (item 1 — AI search; item 9 — chat translation)

One provider interface (`AiProvider`) behind which the service runs.
The only provider wired in this repo is the **local provider**: rule-based,
no network, no API key, no vendor. Nothing in this module invents a key,
calls a vendor, or sends PII anywhere. `AI_PROVIDER` must be `local`
or the service refuses to boot — a real provider is a code change, not a
config flip (see §8). `GET /ai/health` reports the provider and
capabilities, so any client can show honest labels.

| Method | Path | Purpose | Roles / notes |
|---|---|---|---|
| GET | `/ai/health` | `{provider:"local", capabilities:{intent:true, photo:true, voiceStt:false, translation:true}}`. | Public |
| POST | `/ai/intent` | Parse free text `{text}` (≤1000 chars) → `{service:{category_id, category_slug, name_en, confidence}, quantity, quantity_unit, urgency, confidence, fallbackToKeywordSearch, search_query, pii_redacted[]}`. Rule-based over the live category taxonomy + `category_keywords`. No match → `service:null`, `fallbackToKeywordSearch:true` — the client silently uses normal keyword search (`GET /search`). Quantity from digits, Urdu/Arabic digits, or Roman-Urdu/English number words (`bees` = 20). Urgency: `now` (foran/abhi/فوری), `today` (aaj), `scheduled` (kal/next week), else `flexible`. | Public |
| POST | `/ai/photo-search` | `{media_key?, description?, tags?[]}` (≥1 required) → up to 3 ranked categories `{category_id, category_slug, name_en, confidence}` + `method:"heuristic-keyword"`, `note`. **Heuristic keyword match only** on description/tags/filename — no image pixels are read. This is NOT vision; the response says so. | Public |
| POST | `/ai/voice-search` | `{transcript?, audio_key?, language?}`. With a client-supplied `transcript` (on-device speech recognition on the phone) it redacts PII, parses intent, and returns `requires_confirmation:true` — the client MUST show the transcript for manual correction before a request is posted. Audio-only (`audio_key` without transcript) → 422 `STT_UNAVAILABLE`. **No STT in the local provider.** | Bearer |
| GET | `/ai/fair-price?category_id\|category_slug&city_id?&quantity?` | Fair-price estimate `{category_slug, estimate_pkr, low_pkr, high_pkr, sample_size, r2, method, confidence}`. OLS regression on completed-job prices (quantity + nearest city). Used ONLY when n ≥ 8, quantity varies, R² ≥ 0.30 — otherwise falls back to the percentile range (`GET /pricing/fair-range`). Every estimate writes an audit row to `fair_price_snapshots` (migration 0010). | Public |
| GET | `/ai/chats/:id/translation` | The caller's per-chat translation preference `{chat_id, target_lang, auto_translate}`. | Bearer, chat participant |
| PUT | `/ai/chats/:id/translation` | Set it `{target_lang?, auto_translate}` (`target_lang` null = off). | Bearer, chat participant |
| POST | `/ai/chats/:id/messages/:messageId/translate` | `{target_lang}` → `{original, translated, translated_by_provider}`. Local translation is an **exact-phrase dictionary** (common chat phrases EN↔UR). Unknown text is returned untranslated (`translated_by_provider:false`, original preserved) — a translation is never invented. `messages.body` is never overwritten; translations live in `message_translations`. | Bearer, chat participant |

**PII rule (enforced in code, tested):** every free-text input is passed
through `redactPii()` **before** any provider call — CNIC (dashed or
13-digit), Pakistani mobile (`03xx` / `+92 3xx`), email, passport-style
numbers become `[REDACTED_*]` tokens. Providers defensively call
`assertNoPii()` and refuse to run on unredacted input. Intent logs store
the redacted text only.

## 2. Risk engine (item 2)

Stored scores only — nothing in a request path recomputes a score.
`POST /risk/users/:id/recompute` is the only recompute entry point
(admin-triggered, rate-limited by the operator).

| Method | Path | Purpose | Roles |
|---|---|---|---|
| GET | `/risk/me` | The caller's own score `{user_id, score, level, penalty, blocked, review_threshold, block_threshold}`. | Any authenticated user |
| GET | `/risk/users/:id` | One user's stored score. | super_admin, support_agent |
| POST | `/risk/users/:id/recompute` | Recompute from events (cancellations, no-shows, upheld disputes, reviews) and store. | super_admin, support_agent |
| GET | `/risk/users/:id/events` | Risk events for a user, paginated. | super_admin, support_agent |
| POST | `/risk/events` | Record an event `{user_id, kind, job_id?, note?}`. | super_admin, support_agent |
| GET | `/risk/users/:id/ranking-penalty` | `{penalty}` for ranking — the same value the search path uses. | super_admin, support_agent |
| GET | `/risk/jobs/:id` | Risk view of a job (events + parties' scores). | super_admin, support_agent |
| GET | `/admin/risk/review-queue` | Users above the review threshold, paginated. | super_admin, support_agent |
| GET | `/admin/risk/settings` | `{review_threshold, block_threshold, weights}`. | super_admin, support_agent |
| PATCH | `/admin/risk/settings` | Update thresholds/weights. | super_admin |

**Wiring (integrator):** `ProvidersService.nearby()` fetches the stored
penalty per candidate (≤50 rows) via `rankingPenaltyForUser()` and
applies `applyRiskPenaltyToRankScore(rankScore({...}), penalty.score)`.
**Blocking is deliberately NOT applied in ranking** — a blocked provider
is handled at offer time, never by silently hiding them from search.
The ranking inputs `cancellations/noShows/upheldDisputes` are still
hard-coded 0 inside `rankScore({...})` — the penalty now comes from the
stored score instead (see `src/common/utils/risk-scoring.ts`).

## 3. Subscriptions (item 3)

Three seeded plans (migration 0012, `ON CONFLICT DO NOTHING`):

| Plan | Price | Commission multiplier | Featured | Analytics | Max staff |
|---|---|---|---|---|---|
| `free` | PKR 0 | 1.00 | no | no | 0 |
| `pro` | PKR 999 | 0.80 | no | yes | 0 |
| `business` | PKR 2,499 | 0.60 | yes | yes | 5 |

| Method | Path | Purpose | Roles |
|---|---|---|---|
| GET | `/subscription-plans` | Public plan list. | Public |
| GET | `/subscriptions/me` | The caller's subscription (defaults to `free`). | Bearer |
| POST | `/subscriptions` | Subscribe `{plan_code}`. | Bearer |
| POST | `/subscriptions/change` | Change plan `{plan_code}`. | Bearer |
| POST | `/subscriptions/cancel` | Cancel (reverts to `free` at period end). | Bearer |
| GET | `/subscriptions/me/analytics?days=` | Provider analytics (jobs, earnings, acceptance) — `pro`/`business` only; `free` → 403 `PLAN_REQUIRED`. | Bearer |
| POST | `/admin/subscription-plans` | Create a plan. | super_admin |
| PATCH | `/admin/subscription-plans/:id` | Update a plan. | super_admin |
| GET | `/admin/subscriptions` | All subscriptions, paginated. | super_admin |
| POST | `/admin/subscriptions/expire` | Expire due subscriptions (sweep; the operator runs it on a schedule — no cron infra in this repo, same pattern as tenders §5). | super_admin |

**Wiring (integrator):** `OffersService.acceptOffer` resolves the base
rate with `resolveCommissionRate(...)`, then applies
`SubscriptionsService.effectiveCommissionRate(providerUserId, baseRate)`
(clamped 0.05–0.15) and snapshots the **effective** rate onto
`jobs.commission_rate`. If the subscription lookup fails, accept falls
back to the base rate so an offer never breaks on it.
`JobsService.confirmPayment` is unchanged — it uses the snapshotted rate.
**Featured:** `ProvidersService.nearby()` and `getById()` now return
`sponsored` from `SubscriptionsService.isProviderFeatured(providerId)`
(business plan); the label is always `"Sponsored"`.

## 4. Teams (item 4)

| Method | Path | Purpose | Roles / notes |
|---|---|---|---|
| POST | `/teams` | Create a team `{name}` (owner = caller). | Bearer (provider) |
| GET | `/teams` | The caller's teams. | Bearer |
| GET | `/teams/:id` | Team detail. | Bearer, member |
| POST | `/teams/:id/members` | Invite a member `{user_id, role}`. | Bearer, team owner |
| POST | `/teams/:id/members/accept` | Accept an invite. | Bearer, invitee |
| DELETE | `/teams/:id/members/:memberId` | Remove a member. | Bearer, team owner |
| GET | `/teams/:id/members` | Member list. | Bearer, member |
| POST | `/teams/:id/jobs/:jobId/assign` | Assign a job to a member `{member_id}`. | Bearer, team owner |
| DELETE | `/teams/:id/jobs/:jobId/assignment` | Unassign. | Bearer, team owner |
| GET | `/teams/:id/jobs` | Team jobs, paginated. | Bearer, member |
| GET | `/teams/:id/jobs/:jobId` | One team job. | Bearer, member |
| GET | `/teams/:id/earnings` | Team earnings split. | Bearer, member |

Team size is capped by the owner's plan (`max_staff_accounts`: free/pro
0, business 5) — inviting beyond the cap → 422 `TEAM_LIMIT_REACHED`.

## 5. Tenders (item 5 — B2B)

Sealed-quote tenders for organisations (schools, offices, housing
societies). Quotes are **sealed**: a provider sees only their own quote
until award.

| Method | Path | Purpose | Roles / notes |
|---|---|---|---|
| POST | `/tenders` | Create `{request_id?, organization_name, organization_type, title, description, delivery_deadline}`. | Bearer |
| GET | `/tenders` | The caller's tenders. | Bearer |
| GET | `/tenders/open` | Open tenders (public board). | Bearer |
| GET | `/tenders/:id` | Tender detail. | Bearer |
| POST | `/tenders/:id/quotes` | Submit a sealed quote `{amount_pkr, note?}`. **Quoting is free.** | Bearer (provider) |
| GET | `/tenders/:id/quotes` | Quotes — owner sees all, provider sees only their own. | Bearer |
| GET | `/tenders/:id/audit` | Audit trail for the tender. | Bearer, owner/admin |
| POST | `/tenders/:id/cancel` | Cancel an open tender. | Bearer, owner |
| POST | `/tenders/quotes/:quoteId/withdraw` | Withdraw an un-awarded quote. | Bearer, quote owner |
| POST | `/tenders/quotes/:quoteId/accept` | Award: creates the job and charges the **flat lead fee PKR 500** once, from the winning provider's wallet (`tender_lead_fee_rev` ledger credit). | Bearer, tender owner |
| POST | `/admin/tenders/expire-due` | Expire open tenders past `delivery_deadline` → `{expired_count, expired_tender_ids, checked_count}`. Idempotent. | super_admin, support_agent |

**Lead fee (decided in Phase 3):** a FLAT **PKR 500** (`TENDER_LEAD_FEE_PAISA
= 50000`), charged once to the **winning** provider at acceptance —
never per quote, never at quote time. (An earlier draft of this doc said
PKR 100 per quote; that was wrong and is corrected here.)

**Expiry:** there is no scheduler/cron infra in this repo, so deadline
expiry is an explicit admin call — the operator runs
`POST /admin/tenders/expire-due` hourly (same pattern as the recurring-jobs
sweep and the subscription expiry sweep). Lazy expiry on a late quote
attempt remains as a backstop. Do not invent a cron service.

## 6. Verification — face-match, liveness, OCR assist (items 6 + OCR)

**There is no real biometric or OCR vendor in this environment, and none
is integrated.** The local face-match is a **heuristic** (image metadata
+ similarity placeholder), liveness is a **challenge-response** flow, and
OCR assist is a **manual extraction record** — none of them verifies a
CNIC against NADRA and none of them approves a provider. Every result
carries `is_real_biometric: false` where applicable so the UI can label
it honestly.

| Method | Path | Purpose | Roles / notes |
|---|---|---|---|
| POST | `/verification/face-match` | Submit a face-match `{selfie_key, cnic_photo_key}` → heuristic result `{id, verdict, similarity, is_real_biometric:false}`. | Bearer (provider) |
| GET | `/verification/face-match/:id` | One result. | Bearer, owner/admin |
| POST | `/verification/face-match/:id/override` | Officer override `{verdict, note}` — advisory record only, never an approval. | super_admin, verification_officer |
| POST | `/verification/liveness/start` | Start a liveness challenge `{challenge_type}`. | Bearer (provider) |
| POST | `/verification/liveness/:id/respond` | Answer the challenge `{response}`. | Bearer (provider) |
| GET | `/verification/liveness/:id` | Challenge status. | Bearer, owner/admin |
| POST | `/verification/ocr/extract` | Record a manual OCR extraction `{document_key, fields}` (OCR assist, re-scoped in Phase 3: **manual-only**, no OCR vendor). | Bearer (provider) |
| POST | `/verification/ocr/:id/confirm` | Officer confirms the extraction. | super_admin, verification_officer |
| GET | `/verification/review-queue` | Verification cases awaiting an officer. | super_admin, verification_officer |
| GET | `/verification/providers/:id/evidence` | All evidence for a provider `{provider_id, face_match, liveness, ocr_extractions, rule}`. | super_admin, verification_officer |

**Wiring (integrator):** `AdminService.decideVerification` calls
`VerificationService.evidenceForProvider(providerId)` and attaches the
result as `verification_evidence` on the officer view and the audit
`after` payload — **supporting evidence only**. Tier upgrades stay gated
on the officer's explicit approved decision; the verification module
never approves anything.

## 7. Escrow & payouts (items 7 + 8)

Escrow release and provider payouts, built on the Phase 2 wallet ledger.
**Every payout response carries `sandbox: true`.** No live payout rail
exists in this repo.

| Method | Path | Purpose | Roles / notes |
|---|---|---|---|
| POST | `/jobs/:id/escrow/hold` | Hold the job amount in escrow `{amount_pkr}`. | Bearer, job customer |
| POST | `/escrow/holds/:id/release` | Release a hold to the provider. | Bearer, job customer |
| GET | `/escrow/holds/:id` | One hold. | Bearer, party/admin |
| GET | `/escrow/holds` | The caller's holds. | Bearer |
| POST | `/payouts` | Request a payout `{amount_pkr, method}`. | Bearer (provider) |
| GET | `/payouts/:id` | One payout. | Bearer, owner/admin |
| GET | `/payouts` | The caller's payouts. | Bearer |
| GET | `/admin/escrow/config` | `{auto_release_hours:48, min_amount_paisa:500000, fee_flat_paisa:0, fee_rate:0, tax_rate:0}`. | super_admin, finance |
| PATCH | `/admin/escrow/config` | Update config. | super_admin, finance |
| GET | `/admin/escrow/holds` | All holds, paginated. | super_admin, finance |
| GET | `/admin/payouts` | Payout queue, paginated. | super_admin, finance |
| POST | `/admin/payouts/:id/approve` | Approve a payout. | super_admin, finance |
| POST | `/admin/payouts/:id/reject` | Reject a payout `{reason}`. | super_admin, finance |
| POST | `/admin/escrow/holds/:id/release` | Admin release of a hold. | super_admin, finance |
| POST | `/admin/escrow/auto-release` | Release holds past `auto_release_hours` (sweep; operator-scheduled, no cron infra in this repo). | super_admin, finance |
| POST | `/admin/payouts/run-due` | Run due payouts (sweep; operator-scheduled). | super_admin, finance |

Auto-release default is **48 hours**; minimum hold is **PKR 5,000**
(`min_amount_paisa: 500000`); fees and tax are **0** in this build.
Release writes balanced ledger rows; the Phase 2 rule still holds —
refunds write no `payments` row.

## 8. Provider-swap guides (summary — full guides in module READMEs)

All three swaps are **code changes by a developer, after the user creates
the vendor account**. Muse cannot create vendor accounts or keys, and no
key is stored in this repo. Every swap must keep the module contract:
redacted input only, unsupported capabilities reported honestly, local
fallback kept and labelled.

| Module | Recommended vendor | What it replaces | Rough cost (list prices, verify first) |
|---|---|---|---|
| AI Gateway | **Google Cloud** — Vertex AI (Gemini 2.5 Flash) for intent + translation, Cloud Vision for photos, Cloud Speech-to-Text (`ur-PK`) for voice, Cloud Translation as fallback | Local rules / keyword heuristic / no STT / phrase dictionary | Gemini ~$0.30/1M input tokens; Vision ~$1.50/1,000 images; STT ~$0.016/min; Translation ~$20/1M chars. Free tiers: Vision 1,000/mo, Translation 500k chars/mo, Speech 60 min/mo. |
| AI Gateway (alt) | **OpenAI** — `gpt-4o-mini` intent/translation, `gpt-4o` vision, Whisper `whisper-1` STT | Same as above | gpt-4o-mini ~$0.15/1M input; Whisper $0.006/min. No free tier beyond trial credit. |
| Verification | **AWS Rekognition** — `CompareFaces` (similarity threshold 80) + `StartFaceLivenessSession` | Heuristic face-match + challenge liveness | CompareFaces $0.001/comparison (first 5,000/mo free 12 months); FaceLiveness $0.01/session. ~1,000 verifications/mo ≈ $10–11/mo. Needs an S3 bucket for selfie/CNIC photos. |
| Verification — OCR only | **Google Cloud Vision** Document Text Detection | Manual OCR extraction record | ~$1.50/1,000 pages after 1,000 free pages/mo. Vision has **no 1:1 face-match API** — it is not a face-match replacement. |
| Verification — CNIC-authoritative | **NADRA-integrated e-KYC vendor** (via a Pakistani fintech partner) | Nothing — no such vendor is integrated | Quoted per verification; confirm commercially. This module's OCR assist does **not** verify a CNIC against NADRA. |

Full guides: `backend/src/modules/ai-gateway/README.md` (§ "Swapping in
a real LLM / vision / STT provider") and
`backend/src/modules/verification/README.md` (§ "Production vendor —
what the user must create").

## 9. What Phase 3 deliberately did NOT add

- A live AI/LLM/vision/STT vendor, live biometric vendor, live OCR
  vendor, or live payout rail (all sandbox/local/heuristic — see §8 for
  the swap guides).
- A scheduler/cron service — expiry and sweep endpoints are explicit
  admin calls the operator runs on a schedule (§5, §7).
- An iOS App Store release — the Flutter iOS target is configured only
  (`mobile/ios/`, bundle id `com.nearservice.app`); it has **never been
  built** (no macOS/Xcode in this environment). See `mobile/ios/README.md`.
- Face-match or liveness as an approval — verification evidence is
  advisory only (§6).
- Any change to `JobsService.confirmPayment` (it uses the snapshotted
  commission rate) or to the Phase 2 refund rule.

## 10. Known gaps / decisions carried forward

1. **Risk ranking inputs** (`cancellations/noShows/upheldDisputes`) are
   still hard-coded 0 inside `rankScore({...})` in `nearby()`; the
   penalty now comes from the stored risk score instead (§2).
2. **Tender lead fee** is PKR 500 flat at award (§5) — not per quote.
3. **Promo race** (Phase 2 §11.3) is unchanged: concurrent redemptions
   on *different* jobs could still race past a per-user limit.
4. **Commission city scope** (Phase 2 §11.4) is unchanged.
5. **Refund writes no `payments` row** (Phase 2 §11.5) — unchanged.
6. **Waitlist cell size** is ≈110 m (Phase 2 §11.2) — unchanged.
7. **Chat-fetch endpoints** live outside the messaging module
   (Phase 2 §11.6) — unchanged.
8. **In-app photo upload for dispute evidence does not exist yet**
   (Phase 2 §11.7) — mobile records a photo as a note for support.
9. **OCR assist is manual-only** in Phase 3 (§6) — a vendor swap is a
   Phase 4 decision, not a silent upgrade.
10. **iOS target never built** (§9); **Flutter never compiled in this
    VM** (no Dart/Flutter installed) — mobile Phase 3 screens are code
    only, listed file by file in the integration report.
