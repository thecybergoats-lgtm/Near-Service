# Batch 3 API addendum — provider earnings, provider QR, deals of the day, Overpass timeout

OpenAPI **v1.9.0** — 246 paths / 275 ops (+3 paths / +3 ops over v1.8.0).
No new tables, no migration.

## 1. Provider earnings dashboard — `GET /providers/me/earnings`

Role: `provider`. 403 when the account has no provider profile.

Response (`ProviderEarnings`):

```json
{
  "provider_id": "<uuid>",
  "currency": "PKR",
  "today": { "earnings_pkr": 1000, "commission_pkr": 100, "completed_jobs": 2 },
  "last_7_days": { "earnings_pkr": 5000, "commission_pkr": 500, "completed_jobs": 8 },
  "last_30_days": { "earnings_pkr": 20000, "commission_pkr": 2000, "completed_jobs": 30 },
  "all_time": { "earnings_pkr": 90000, "commission_pkr": 9000, "completed_jobs": 120 },
  "pending_payout_pkr": 3500,
  "wallet_balance_pkr": 2500,
  "payouts": [{ "id": "<uuid>", "amount_pkr": 1000, "fee_pkr": 0, "destination": "JazzCash", "status": "requested", "kind": "instant", "created_at": "..." }]
}
```

Rules (all documented in the code, not just here):

- **Earnings = `final_price − commission_amount` for SETTLED jobs only.**
  Unpaid / disputed / refunded jobs never count as earnings.
- **Periods are calendar days in Asia/Karachi** (same convention as FIX 11
  open-now): today = since local midnight; last 7 days = today + previous
  6 days; last 30 days = today + previous 29 days. Bucketing uses
  `COALESCE(completed_at, updated_at)` so legacy settled jobs without a
  `completed_at` still land in a period.
- **Pending payout** = sum of `final_price` for COMPLETED-but-unpaid jobs
  (money earned, not yet settled into the wallet). It is NOT the wallet
  balance: settled wallet payments already credit the wallet.
- **Wallet balance** is read from `wallet_accounts` (integer paisa) and
  converted to PKR. A missing wallet row reads as 0 — the endpoint never
  creates a wallet as a side effect of a GET.
- **Payouts** are the latest 10 rows from the `payouts` table via the
  caller's wallet. A payout only exists once requested (`POST /payouts`),
  so an empty list is normal until the provider requests one. Payout
  execution is still sandbox-only (Phase 3 escrow module).

Money note: jobs store `final_price` / `commission_amount` as PKR
(`numeric(12,2)`), unlike the wallet ledger which is integer paisa —
the endpoint converts only the wallet balance and payout amounts.

## 2. Own provider profile — `GET /providers/me`

Role: `provider`. Returns the caller's `provider_profiles` row
(`id`, `display_name`, `shop_name`, `provider_type`, `tier`,
`is_online`, `rating_avg`, `jobs_completed`, `created_at`). 403 when the
account has no provider profile. The `id` is what the "My QR code"
screen encodes — see `docs/provider-qr-code.md`.

## 3. Deals of the day — `GET /promotions/today` (public)

Same active promos as `GET /promotions/active` (same `promos` table, same
validity window, no parallel system), plus `valid_from` / `valid_to` and
`ends_today` (true when `valid_to` falls on today in Asia/Karachi).
Max-uses-exhausted promos are excluded, exactly like the active list.

Admins create a deal for today with the existing `POST /admin/promos`
(`valid_from` / `valid_to` set to today). `first_job_only` promos
(e.g. `FIRSTJOB10`) are included in the list — eligibility is still
checked at validation time (`POST /promos/validate`), not here.
An empty promos table returns `{items: []}` — the UI never invents a deal.

## 4. Overpass timeout 25 s → 50 s

`OVERPASS_TIMEOUT_MS` in `places.service.ts` and the `[timeout:…]` in
the Overpass QL query both raised from 25 s to 50 s. Rationale: at peak
Overpass was taking ~28–37 s (or 502), so `GET /places/nearby` almost
always returned `degraded: true` with no shops even though the 5 Quetta
shops exist. The degraded fallback is unchanged (HTTP 200
`{items: [], degraded: true}`, never 500; degraded results are NOT
cached). Live smoke result is in the batch 3 report.

## Tests

- `test/unit/provider-earnings.spec.ts` — period mapping, pending payout,
  wallet paisa→PKR conversion, payout mapping, empty wallet/payouts,
  403 without a provider profile.
- `test/unit/deals-today.spec.ts` — discount text, `ends_today` (PKT),
  max-uses exclusion, empty table → empty list.
- `test/unit/places.service.spec.ts` — query now carries `[timeout:50]`,
  abort fires at 50 s.
