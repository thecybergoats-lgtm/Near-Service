# Phase 2 — Payments Guide (Merchant Onboarding)

How Near Service takes money: wallet top-ups via **JazzCash** and
**Easypaisa**. This guide is for the app owner (the person who must sign
the merchant agreements). **No live API keys, merchant IDs or credentials
exist in this repo — none were invented.** Every value below marked
"obtain from vendor" must come from the vendor's own portal or
representative.

> Current status: **sandbox only**. The backend ships with mock
> JazzCash/Easypaisa providers (`gateway-sandbox.ts`) that never call the
> network and label every response `sandbox: true`. Real money cannot move
> until the steps below are done AND the live provider integration is
> implemented (it is not in this build — see "What is still code work").

## 1. Sandbox vs live — what the difference is

| | Sandbox | Live |
|---|---|---|
| Money | Fake — no real rupees move | Real customer money |
| Credentials | Test merchant ID / password from the vendor sandbox portal | Production merchant ID / password / hash key from the vendor after onboarding |
| Behaviour in this app | `PAYMENT_GATEWAY_MODE=sandbox` (default). Top-up confirm always succeeds deterministically; references look like `JC-SANDBOX-3F9A1C2E` | `PAYMENT_GATEWAY_MODE=live`. **The app refuses to boot** if any live credential is missing, and refuses to boot even with credentials present until the live provider code lands — it never silently falls back to sandbox. |
| What the user sees | The app must show "Sandbox — no real money" (the mobile wallet screen already does) | Normal payment flow |

## 2. What account / key the owner must obtain

### JazzCash
1. **Register as a JazzCash merchant** — apply on the JazzCash merchant
   portal (search "JazzCash merchant registration" on the JazzCash
   website; do not trust links from third parties). You will need:
   - Business / sole-proprietor details, CNIC of the owner, business
     NTN (if registered), bank account in the business name.
   - A mobile number and email for the merchant account.
2. **Sandbox access first** — request sandbox credentials from the
   JazzCash developer/merchant portal. You will receive:
   - Sandbox Merchant ID, sandbox Password, sandbox Return URL
     configuration. Put them in `JAZZCASH_SANDBOX_MERCHANT_ID`,
     `JAZZCASH_SANDBOX_PASSWORD`, `JAZZCASH_SANDBOX_RETURN_URL`.
3. **Go-live** — after sandbox testing, JazzCash issues production
   credentials: live Merchant ID + live Password. Put them in
   `JAZZCASH_LIVE_MERCHANT_ID` / `JAZZCASH_LIVE_PASSWORD` (and
   `JAZZCASH_LIVE_RETURN_URL`). Keep them in the secrets manager, never
   in chat, email or the repo.

### Easypaisa
1. **Register as an Easypaisa merchant** — apply on the Easypaisa
   merchant portal (search "Easypaisa merchant account" on the Easypaisa
   website). You will need the same business/CNIC/bank details as above.
2. **Sandbox access** — request sandbox credentials: Store ID + Hash Key.
   Put them in `EASYPAISA_SANDBOX_STORE_ID` / `EASYPAISA_SANDBOX_HASH_KEY`.
3. **Go-live** — Easypaisa issues production Store ID + Hash Key. Put
   them in `EASYPAISA_LIVE_STORE_ID` / `EASYPAISA_LIVE_HASH_KEY`, via the
   secrets manager only.

## 3. Step by step (owner checklist)

1. [ ] Decide the legal entity for the merchant accounts (sole
       proprietor vs registered business) — a Pakistan-qualified lawyer
       should confirm this before launch (flagged in PRD v1.1: wallet /
       fund-holding, FBR/PRA/SRB tax, PTA).
2. [ ] Apply for JazzCash merchant + sandbox credentials; save the
       sandbox Merchant ID / Password.
3. [ ] Apply for Easypaisa merchant + sandbox credentials; save the
       sandbox Store ID / Hash Key.
4. [ ] Put sandbox values in the backend `.env` (from
       `backend/.env.example` — never commit `.env`).
5. [ ] Test a top-up end to end in the app (see "Demo" in the handoff
       report): top-up → confirm → wallet balance rises; check the
       ledger rows balance per `txn_id`.
6. [ ] Complete live onboarding with both vendors; store live
       credentials in the secrets manager.
7. [ ] Commission the live provider integration (see "What is still code
       work") and a real-money test with a small amount before launch.
8. [ ] Set `PAYMENT_GATEWAY_MODE=live` only after (6) and (7) are done.

## 4. Costs

**Verify on the vendor site — do not rely on this document for pricing.**
Merchant discount rates / transaction fees, settlement timelines and any
monthly charges change frequently and differ by merchant category and
negotiated volume. Check the current JazzCash merchant fee schedule and
the Easypaisa merchant fee schedule on their official sites (or ask your
vendor representative) before promising any fee to users. No fee numbers
are quoted here on purpose.

## 5. How top-ups work in this build (sandbox)

1. `POST /wallet/topup {method, amount_pkr, phone}` — the sandbox
   provider returns a mock reference (`JC-SANDBOX-…` /
   `EP-SANDBOX-…`) and a `payments` row is created with
   `status='initiated'`, `sandbox: true`.
2. `POST /wallet/topup/confirm {payment_id}` — the sandbox provider
   confirms deterministically; the wallet is credited with a balanced
   double-entry (`D cash_in / C wallet`) and `balance_paisa` is updated
   in the same DB transaction.
3. Both calls accept an `Idempotency-Key` header; replaying a key
   returns the stored response instead of crediting twice.

## 6. What is still code work (not done in Phase 2, items 1–3)

- **Live JazzCash/Easypaisa providers**: real API clients (request
  signing, hashes, callback/webhook verification, production endpoints).
  The interface is `PaymentProvider` in
  `backend/src/modules/payments/gateway.interface.ts`; the live classes
  slot in beside `gateway-sandbox.ts`.
- **Escrow release flow**: `escrow_held_paisa` is recorded only; the
  release/claim flow is out of scope.
- **Payouts to providers** (bank/mobile-account withdrawal): the
  `payout()` provider method and the `payouts` table exist, but no
  admin approval flow or live payout call is wired up.
- **Refunds beyond the sandbox mock**: `refund()` returns a mock
  result; the dispute-refund flow is a separate scope item.

## 7. Safety rules (do not break these)

- Never paste a live key, password or hash key in chat, email, or any
  file in this repo. Secrets manager only.
- Never set `PAYMENT_GATEWAY_MODE=live` while sandbox providers are
  the only implementation — the boot check exists to stop exactly that.
- Every money movement must write balanced `ledger_entries` per
  `txn_id` (sum of D = sum of C); the nightly reconciliation in PRD
  p.18 depends on it.
