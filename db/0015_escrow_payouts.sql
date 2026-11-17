-- Near Service — 0015_escrow_payouts.sql (Phase 3, item 8: escrow release +
-- provider payouts; carried forward from Phase 2, where escrow was
-- recorded only as wallet_accounts.escrow_held_paisa and release was
-- explicitly NOT in scope — see backend/src/modules/payments/wallet.service.ts).
--
-- ADDITIVE ONLY: no earlier table/column is dropped, renamed or widened
-- except payouts.status, which stays varchar(14) — every new status
-- ('approved', 'scheduled', 'executed', 'failed', 'cancelled',
-- 'rejected') fits in 14 chars. The payouts table created by 0003 is
-- EXTENDED, not recreated: its legacy numeric amount/fee columns keep
-- working and are populated alongside the new integer-paisa columns.
--
-- Money model (all integer paisa in the new columns; 1 PKR = 100 paisa):
--   HOLD:    customer wallet D 'wallet' / C 'escrow_held' for the full
--            job amount. wallet_accounts.balance_paisa -= amount,
--            escrow_held_paisa += amount. Money has left the customer's
--            spendable balance but is not yet the provider's.
--   RELEASE: one txn_id, D 'escrow_held' (customer wallet, full amount)
--            = C 'wallet' (provider wallet, amount - commission)
--            + C 'commission_rev' (provider wallet, commission).
--            escrow_held_paisa -= amount; provider balance += net.
--   REFUND (dispute path, via the existing dispute resolver, NOT this
--            module): D 'escrow_held' / C 'wallet' on the customer wallet.
--   PAYOUT:  one txn_id, D 'wallet' (provider wallet, gross amount)
--            = C 'payout_out' (net) + C 'payout_fee_rev' (fee, if > 0)
--            + C 'payout_tax_payable' (tax, if > 0). Balance -= gross.
--   Every movement above is written by backend/src/modules/escrow and is
--   checked at COMMIT by the deferred trigger from 0008
--   (SUM(D) = SUM(C) per txn_id) — an unbalanced write fails the txn.
--
-- SANDBOX ONLY: live JazzCash/Easypaisa payout execution does NOT exist
-- in this build — no live merchant keys exist (same as Phase 2). Payout
-- execution calls the Phase 2 sandbox providers, which never touch the
-- network and label every reference sandbox. If PAYMENT_GATEWAY_MODE=live
-- the app refuses to boot (see gateway-sandbox.ts assertGatewayConfig).
--
-- Run after 0001–0014.

-- ---- 1. Admin-set escrow / payout config (feature_flags) ----------------
-- escrow_auto_release_hours: hours after hold creation at which an
-- un-disputed hold auto-releases (default 48). Changed by finance via
-- PATCH /api/v1/admin/escrow/config.
-- escrow_min_amount_paisa: only jobs at/above this amount may be escrowed
-- (default PKR 5,000 = 500000 paisa) — escrow is for high-value jobs.
-- payout_fee_flat_paisa / payout_fee_rate: per-payout fee =
--   flat + round(gross * rate)  (defaults 0 / 0).
-- payout_tax_rate: tax = round((gross - fee) * rate) (default 0).
INSERT INTO feature_flags (key, enabled, config) VALUES
  ('escrow_auto_release_hours', true, '{"value_hours": 48}'::jsonb),
  ('escrow_min_amount_paisa', true, '{"value_paisa": 500000}'::jsonb),
  ('payout_fee_flat_paisa', true, '{"value_paisa": 0}'::jsonb),
  ('payout_fee_rate', true, '{"value_rate": 0}'::jsonb),
  ('payout_tax_rate', true, '{"value_rate": 0}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---- 2. Escrow holds -----------------------------------------------------
CREATE TABLE IF NOT EXISTS escrow_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  customer_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  provider_user_id uuid NOT NULL REFERENCES users(id),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  commission_paisa bigint NOT NULL CHECK (commission_paisa >= 0),
  status varchar(12) NOT NULL DEFAULT 'held'
    CHECK (status IN ('held', 'released', 'refunded', 'cancelled')),
  held_at timestamptz NOT NULL DEFAULT now(),
  auto_release_at timestamptz NOT NULL,
  released_at timestamptz,
  released_by uuid REFERENCES users(id),
  release_txn_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_escrow_holds_due
  ON escrow_holds (status, auto_release_at);
CREATE INDEX IF NOT EXISTS idx_escrow_holds_customer
  ON escrow_holds (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_escrow_holds_provider
  ON escrow_holds (provider_user_id, created_at DESC);

-- ---- 3. Extend the Phase 1 payouts table (0003) --------------------------
-- Legacy columns kept: amount/fee numeric(12,2) (PKR), destination
-- varchar(12) (now stores the payout method, 'jazzcash'/'easypaisa'),
-- tax jsonb (now stores {"rate": <number>, "amount_paisa": <int>}).
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS amount_paisa bigint CHECK (amount_paisa > 0);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS fee_paisa bigint NOT NULL DEFAULT 0 CHECK (fee_paisa >= 0);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS tax_paisa bigint NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS net_paisa bigint CHECK (net_paisa > 0);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS kind varchar(12) NOT NULL DEFAULT 'instant'
  CHECK (kind IN ('instant', 'scheduled'));
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS provider_method varchar(12)
  CHECK (provider_method IN ('jazzcash', 'easypaisa'));
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS destination_phone varchar(20);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS executed_at timestamptz;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS provider_ref text;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS escrow_hold_id uuid REFERENCES escrow_holds(id);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES jobs(id);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_payouts_wallet ON payouts (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_due
  ON payouts (status, kind, scheduled_for)
  WHERE status = 'approved' AND kind = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts (status, created_at DESC);
