# Near Service — Phase 4 Demo Script

Walk the full golden flow end-to-end (Phase 1 flow + Phase 2 flows +
Phase 3 flows + Phase 4 flows below). Assumes the stack is up (`docker compose up`,
migrations + seed run — see root `README.md`; migrations now include
`0005_phase2_payments.sql` and `0006_phase2_ops.sql` (Phase 2),
`0009_stage3_fixes.sql`, and `0010_ai_gateway.sql` through
`0015_escrow_payouts.sql` (Phase 3), plus `0016_search_scaleout.sql`
through `0020_partners.sql` (Phase 4)), plus `0021_fix_seed_uuids.sql`
(Fix A: seeded ids rewritten to RFC-4122 v4).
Demo accounts (seeded, dev OTP mode): customer `+923001234567`,
provider `+923007654321`, admin `+923001111111`. In dev mode the OTP is
printed to the backend console log as `[DEV OTP]`.
`PAYMENT_GATEWAY_MODE=sandbox` (default) — every gateway response is
labelled `sandbox:true`; **no real money moves anywhere in this demo**.

## 0. Setup (2 min)

1. `docker compose up -d --build`
2. `docker compose exec backend npm run migrate`
3. `docker compose exec backend npm run seed`
4. Admin: open http://localhost:3001 — you should see the login page.
   Backend health: `curl http://localhost:3000/api/v1/categories`
   should return the taxonomy tree (Book Binding first).

## 1. Register a customer (mobile app)

1. Open the Flutter app. Choose language: **Roman Urdu**.
2. Phone: `+923001234567` → request OTP → read the `[DEV OTP]` code
   from the backend logs → enter it. You are logged in as a customer.
3. Role select: **"I need a service"**.

Expected: home map centred on Quetta, category chips visible,
"Post a request" button visible.

## 2. Search "book binding"

1. Tap the search bar, type `book binding`.
2. Also try `jild saazi` and `جلد سازی` — all three must find
   **Book Binding**.
3. Tap **Book Binding**.

Expected: nearest providers listed with distance (km), ETA, rating,
Tier badge (Tier 0/1), SHOP/INDIVIDUAL badge, starting price in PKR,
"Open now" status. Closest first. Try the filters: radius 3 km,
verified only, min rating 4.0.

## 3. Post a request — PKR 2,400

1. Tap **Post a request** on a Book Binding provider (or the FAB).
2. Fill the dynamic form: **20 books, size A4, binding hard**,
   fulfillment **Pickup & Delivery**, location = current location.
3. Offer: **PKR 2,400**.

Expected: the fair-price meter shows the range (seeded range
PKR 2,200–3,000, typical 2,600). No warning blocks posting; an offer
below the range would show "few providers may accept".

## 4. Provider counters PKR 2,550

Switch to the provider side (log in as `+923007654321`, role Provider,
or use the provider dashboard on the same account via profile switch):

1. Go online (toggle). An incoming request appears with a countdown.
2. Counter-offer: **PKR 2,550**, ETA 60 min, note "today pickup,
   tomorrow delivery", breakdown labour 2,000 + parts 400 + visit 150.
3. Send the counter.

Expected: the customer sees the live offer with a countdown ring.

## 5. Customer accepts — atomic

1. Back as the customer, open **Live offers**.
2. Counter back once if you like (max 3 rounds), then tap **Accept**
   on the PKR 2,550 offer.

Expected: a job is created at the locked price PKR 2,550. All other
offers show "offer closed". (Double-tapping Accept, or two customers
accepting at once, still creates exactly one job — covered by the
atomic-accept test: 10 concurrent accepts → 1 job.)

## 6. Job progresses to completed

As the provider, move the job through the stepper:
`ACCEPTED → ITEM_PICKED_UP → IN_PROGRESS → COMPLETED`
(use **Job tracking**; each move writes a `job_events` row).
Try an illegal jump (e.g. `ACCEPTED → COMPLETED`) — the API must
return **409** and log the attempt.

Expected: customer sees each state change live on the tracking screen
(Socket.IO `job.state_changed`).

## 7. Cash payment + receipt

1. Provider taps **Complete**; customer confirms the work.
2. Both sides tap **Confirm cash payment**.

Expected: payment status becomes `settled`; the receipt shows
PKR 2,550; the ledger records the 10% commission (PKR 255) against
the provider's single wallet (balance −PKR 255 owed — visible in the
provider earnings screen and in `ledger_entries`).

> Phase 2 alternative: pay this same job from the wallet instead —
> see step 12 below (top up first, then `POST /jobs/:id/pay-wallet`).

## 11. Phase 2 — wallet top-up (sandbox)

1. As the customer, open **Wallet**. Balance starts at PKR 0.
2. Tap **Top up**, choose **JazzCash**, amount **PKR 2,000**, phone
   `+923001234567` → note the `payment_id` and the `JC-SANDBOX-…`
   reference in the response.
3. Confirm the top-up (`POST /wallet/topup/confirm`).

Expected: response carries `sandbox:true` everywhere; wallet balance is
now PKR 2,000 (`balance_paisa: 200000`); `GET /wallet/transactions`
shows the balanced `D cash_in / C wallet` entries for the same `txn_id`.
The mobile top-up sheet shows the **"SANDBOX — no real money moves"**
badge. Try Easypaisa too — reference starts `EP-SANDBOX-…`.

## 12. Phase 2 — wallet-paid job with promo + commission

1. Post a second Book Binding request (same flow as step 3) for
   **PKR 1,000**, and apply promo code **`FIRSTJOB10`** at payment time
   (`POST /promos/validate` first — expect `{valid:true, kind:"percent",
   value:10, discount_paisa:10000}`).
2. Provider accepts/counters, customer accepts, job moves to
   `COMPLETED` (same as steps 4–6).
3. Pay from the wallet: `POST /jobs/:id/pay-wallet
   {promo_code:"FIRSTJOB10"}`.

Expected: job is `PAYMENT_SETTLED`. Customer wallet: 2,000 − 900
(price 1,000 − 100 promo) = **PKR 1,100** left. Provider wallet:
+900 (1,000 − 100 commission at the 10% snapshot rate). The
`promo_expense` ledger entry (PKR 100) balances the discount.
`GET /wallet` shows the same single wallet from both the customer view
(spent) and the provider view (earnings / commission owed).
Try paying with an empty wallet — expect **409
`INSUFFICIENT_WALLET_BALANCE`**.

## 13. Phase 2 — dispute opened and resolved

1. On the wallet-paid job, open a dispute as the customer
   (`POST /jobs/:id/disputes`, reason `work_not_done`, description
   "Books came back with loose pages").
2. Add evidence: `POST /disputes/:id/evidence {kind:"photo",
   storage_key:"dispute-photo-1", note:"Loose binding, page 12"}`.
3. As the admin (`+923001111111`), open **Disputes**: the dispute shows
   with its SLA timers (first response 4h, resolve 48h) and the evidence.
   Assign it to yourself, then resolve with outcome **`refund`**.

Expected: job → `REFUNDED`; customer wallet credited the full final
price; provider wallet debited the same amount (it was settled);
ledger stays balanced per `txn_id`; `job.state_changed` emitted.
Repeat on another job with `partial_refund` (amount < price → job
stays `PAYMENT_SETTLED`) and `no_action` (job returns to its
pre-dispute state).

## 14. Phase 2 — scheduled + recurring job

1. Post an AC Repair request with schedule **Tomorrow 10:00**
   (`scheduled_at`) instead of Now.
2. After acceptance, reschedule it: `POST /jobs/:id/reschedule
   {scheduled_at:"<day after tomorrow> 10:00", reason:"Customer
   asked to move it"}`.

Expected: the accepted price is unchanged; both parties get a
`job.reminder` notification row. Now try the same call with
`scope_changed:true` — expect **409
`SCOPE_CHANGED_REQUIRES_RENEGOTIATION`** and the date **not** moved.
3. Create a recurring job: `POST /recurring-jobs
   {category_slug:"ac-repair", frequency:"monthly", day_of_month:1,
   starts_at:"<next 1st> 09:00", fulfillment:"PROVIDER_COMES", lat, lng,
   customer_offer:1500}`.
4. Run the due-job sweep: `POST /admin/recurring-jobs/run-due`
   (admin). Then `POST /recurring-jobs/:id/skip-next` and
   `PATCH /recurring-jobs/:id {status:"paused"}`.

Expected: one broadcast request is created per due recurring job and
`next_run_at` advances; skip-next advances it with no request; paused
jobs generate nothing. (A real cron must call `run-due` on a schedule —
there is no cron in this repo.)

## 15. Phase 2 — live tracking + contract gaps (quick checks)

1. While a job is `PROVIDER_EN_ROUTE`, open **Job tracking** as the
   customer: the provider marker moves live on the map with distance +
   ETA; the trail draws behind it.
2. Open **History** (mobile): real jobs list with role/state filters —
   no empty state. Open **Wallet → Transactions**: cursor pagination
   (`Load more`).
3. Admin: **Dashboard** shows real KPIs from `GET /admin/kpis`;
   **Requests** lists real requests; suspend a test user from
   **Users** (confirm step, then refresh); open **Promos** and
   **Commission** and create one rule + one promo; open **Categories**,
   edit a form schema (JSON must have `type:"object"` + `properties`)
   and see the mobile request form pick it up with no app release.

## 16. Phase 3 — AI search (local provider, honest labels)

1. `GET /api/v1/ai/health` → `{provider:"local", capabilities:{intent:true,
   photo:true, voiceStt:false, translation:true}}`.
2. `POST /api/v1/ai/intent {"text":"AC repair karwana hai, foran"}` →
   `service.category_slug:"ac-repair"`, `urgency:"now"`,
   `fallbackToKeywordSearch:false`.
3. `POST /api/v1/ai/intent {"text":"xyzabc nonsense"}` → `service:null`,
   `fallbackToKeywordSearch:true` — the client falls back to keyword
   search (`GET /search`).
4. `GET /api/v1/ai/fair-price?category_slug=book-binding` → estimate
   with `method` (`regression` or `percentile-fallback`), `sample_size`,
   `r2`.
5. `POST /api/v1/ai/voice-search {"audio_key":"x.mp3"}` (no transcript)
   → **422 `STT_UNAVAILABLE`** — the local provider has no STT; the
   mobile app must use on-device speech recognition and send the
   transcript instead.

Expected: no step claims vision, STT, or a real LLM — the responses say
what they are.

## 17. Phase 3 — subscriptions change the commission

1. As the provider, `GET /api/v1/subscription-plans` → free / pro /
   business.
2. `POST /api/v1/subscriptions {"plan_code":"pro"}` → plan `pro`.
3. Run the golden flow again (§3–§7): the accepted job's
   `commission_rate` is the base rate × 0.80 (clamped 0.05–0.15), not the
   base rate.
4. `GET /api/v1/subscriptions/me/analytics?days=30` → provider analytics
   (Pro/Business only; a Free plan gets 403 `PLAN_REQUIRED`).
5. `GET /api/v1/providers/nearby?...` — a Business-plan provider shows
   `sponsored:true`, label `"Sponsored"`.

## 18. Phase 3 — risk penalty in ranking

1. Admin: `POST /api/v1/risk/events {"user_id":"<provider>","kind":"cancellation"}` then `POST /api/v1/risk/users/<provider>/recompute`.
2. `GET /api/v1/risk/users/<provider>` → score > 0, level above `low`.
3. `GET /api/v1/providers/nearby?...` — the provider's rank score is
   reduced by the penalty (see `rankScore` + `applyRiskPenaltyToRankScore`).
   The provider is **not hidden** — blocking is deliberately not applied
   in ranking.

## 19. Phase 3 — tender with sealed quotes + PKR 500 lead fee

1. Customer: `POST /api/v1/tenders {"organization_name":"City School",
   "organization_type":"school", "title":"Bind 500 books",
   "description":"...", "delivery_deadline":"<future>"}`.
2. Two providers: `POST /api/v1/tenders/<id>/quotes {"amount_pkr":...}`
   each. Each provider sees **only their own quote** on
   `GET /api/v1/tenders/<id>/quotes`; the owner sees all.
3. Owner: `POST /api/v1/tenders/quotes/<quoteId>/accept` → a job is
   created and the **flat PKR 500 lead fee** is charged once from the
   winning provider's wallet (`tender_lead_fee_rev` ledger entry).
   Quoting itself was free.
4. Admin: `POST /api/v1/admin/tenders/expire-due` → expired tenders past
   their deadline (run hourly by the operator; no cron infra in this repo).

## 20. Phase 3 — verification evidence is advisory only

1. Provider: `POST /api/v1/verification/face-match
   {"selfie_key":"...","cnic_photo_key":"..."}` → heuristic result with
   `is_real_biometric:false` — say so out loud; it is not a biometric check.
2. Admin → **Verifications**: open the case — the modal now shows the
   face-match verdict/similarity, liveness status, and OCR extraction
   count as supporting evidence.
3. Approve with a note → Tier 0 → Tier 1, decision in **Audit Log**
   with `verification_evidence` in the `after` payload. Note: the
   approval came from the officer, not from the verification module.

## 21. Phase 3 — escrow hold + payout (sandbox)

1. Customer: `POST /api/v1/jobs/<id>/escrow/hold {"amount_pkr":...}` →
   hold created.
2. `POST /api/v1/escrow/holds/<id>/release` → released to the provider.
3. Provider: `POST /api/v1/payouts {"amount_pkr":...,"method":"jazzcash"}`
   → response carries **`sandbox:true`** — no real money moves.
4. Admin → **Finance — Escrow**: payout queue → Approve; config shows
   auto-release 48h, min PKR 5,000.
5. Admin sweeps: `POST /api/v1/admin/escrow/auto-release` and
   `POST /api/v1/admin/payouts/run-due` (operator-scheduled).

## 22. Phase 3 — teams + chat translation

1. Provider (Business plan): `POST /api/v1/teams {"name":"Bilal Team"}`,
   invite a member, member accepts; assign a team job.
2. Customer/provider chat: open the chat, **Translate…** → pick Urdu +
   Auto-translate. A message in English shows its Urdu translation
   (exact-phrase dictionary only — unknown phrases stay untranslated,
   never invented).

## 23. Phase 4 — search metrics + gate + click

1. Run a few searches as a customer (`GET /api/v1/search?q=ac`),
   then click a result: `POST /api/v1/search/click
   {"target_type":"provider","target_id":"<provider id>"}` →
   `{recorded:true}`.
2. Admin → **Search Metrics**: the queries appear with p50/p95,
   zero-result rate, cache-hit rate and CTR; the gate panel shows the
   current recommendation (`stay_in_process` on the default thresholds).
3. Admin: change a threshold (`PATCH /admin/search/gate/thresholds`)
   and re-open the gate — the recommendation re-evaluates.

## 24. Phase 4 — analytics ETL + dashboards

1. Admin: `POST /api/v1/admin/analytics/etl/run` → run report with
   reconciliation (operational vs warehouse counts per entity).
2. Admin → **Analytics**: funnel (request → offer → accept → complete),
   revenue by city/category, supply/demand by city + hour.
3. Admin → **Analytics — Exports**: download a warehouse table as CSV.
   Say out loud: this is an operational report, **not a tax filing**.

## 25. Phase 4 — cities gate + SEO pages

1. Admin → **Cities**: Quetta shows `live`; Karachi shows
   `in_preparation` and its gate **FAILS** (3 providers vs 10 needed) —
   do not launch Karachi from this screen.
2. Open a public SEO page in the browser:
   `http://localhost:3000/api/v1/services/ac-repair/quetta` — real
   provider list, plain HTML, no login.
3. `GET /api/v1/services` lists the enabled landing pages.

## 26. Phase 4 — warranty opt-in, fee at settlement, claim

1. Customer: `GET /api/v1/warranty/quote?job_price_pkr=5000` → fee
   quote; `GET /api/v1/warranty/rules` → the published rules.
2. Customer opts a Tier 3 provider's job in:
   `POST /api/v1/jobs/<id>/warranty/opt-in` (201, no money moves).
3. Pay the job (cash confirm or wallet) → the warranty fee is collected
   automatically at settlement; `GET /api/v1/jobs/<id>/warranty/receipt`
   shows price, fee, coverage window.
4. Within 7 days, file a claim:
   `POST /api/v1/jobs/<id>/warranty/claims
   {"reason":"poor_work","description":"..."}`.
5. Admin → **Warranty**: review the claim → offer rework → provider
   marks rework done (or failed → approve refund). Every admin decision
   lands in **Audit Log**.
6. Admin sweep: `POST /api/v1/admin/warranty/expire-due` → warranties
   past their window become `expired`.
7. **Do not demo a refund on an escrow-held job as end-to-end settled**
   — the warranty ↔ escrow coordination gap (see README Known gaps)
   means the hold still needs handling via the escrow flow.

## 27. Phase 4 — partner parts order (disclosed)

1. Provider: `GET /api/v1/partners/catalog?q=teflon` → catalog items
   with server prices.
2. Provider: `POST /api/v1/partners/orders {"job_id":"<id>","lines":
   [{"catalog_item_id":"<id>","quantity":2}]}` → order with totals
   priced by the server and the **partner disclosure** text.
3. `POST /api/v1/partners/orders/<id>/confirm` → affiliate fee recorded
   (ledger); `POST .../deliver` → delivered; a cancel after confirm
   reverses the fee.
4. Customer: `GET /api/v1/partners/jobs/<jobId>/orders` → the same
   disclosure text on their side.
5. Admin → **Partners**: orders list, fee report
   (`/admin/partners/affiliate-fees`) with the ledger check.
6. Say out loud: the catalog is **local** — no live supplier exists;
   a live supplier is a future swap-in, not a hidden dependency.

## Done

The golden flow is complete: register → search → nearest providers →
request PKR 2,400 → counter PKR 2,550 → accept → track → cash pay →
rate → **wallet top-up (sandbox) → wallet-paid job with FIRSTJOB10
promo → commission settled → dispute opened + refunded → scheduled
job rescheduled → monthly AC recurring job**. If any step above fails,
record the exact step, the API response
(`{error:{code,message},request_id}`), and the backend log lines —
do not work around it silently.

## 8. Rating

1. Both sides rate the job (stars 1–5 + tags + comment).

Expected: one review per side only — a second review attempt returns
**409**. Provider rating updates (Bayesian average).

## 9. Admin verification (parallel track)

1. Log in to the admin panel as `+923001111111` (dev OTP).
2. Open **Verifications**: a pending provider shows CNIC front/back +
   selfie side-by-side — **manual review only, no scores**.
3. Approve with a note → provider upgrades Tier 0 → Tier 1; the
   decision lands in **Audit Log**.
4. Open **Jobs**: the demo job appears with its full `job_events`
   timeline.

## 10. Chat (optional)

Open the job chat as either side, send a message, and send a message
containing a phone number (e.g. "call me on 03001234567") — it must be
flagged (`is_flagged: true`) by the contact-sharing filter.

## Done

The golden flow is complete: register → search → nearest providers →
request PKR 2,400 → counter PKR 2,550 → accept → track → cash pay →
rate. If any step above fails, record the exact step, the API response
(`{error:{code,message},request_id}`), and the backend log lines —
do not work around it silently.
