-- Near Service — 0019_warranty.sql (Phase 4, item 4: Warranty Product)
-- ADDITIVE ONLY: three new tables + two new columns on jobs. No earlier
-- table/column is dropped, renamed or widened. Run after 0001–0015
-- (0016–0018 belong to other Phase 4 items and are not required here).
--
-- Product (PRD v1.1): "Optional 7-day workmanship guarantee on Tier 3
-- jobs (Phase 4 product): rework or refund per published rules, priced
-- into the warranty fee"; "Warranty / insurance fee — per-job fee on
-- Tier 3 warranty jobs (Phase 4)"; Tier 3 Trusted Pro eligible for
-- 7-day warranty jobs; "warranty only on-platform".
--
-- Money model (all integer paisa; 1 PKR = 100 paisa). Every movement is
-- balanced double-entry under ONE txn_id, checked at COMMIT by the
-- deferred trigger from db/0008 (SUM(D) = SUM(C) per txn_id):
--   FEE COLLECTION (at payment, WarrantyService.collectFee):
--     D 'wallet' / C 'warranty_fee_rev' on the CUSTOMER wallet, fee
--     amount. Customer balance -= fee. The fee is platform revenue;
--     the provider never receives it and is never debited it.
--   REFUND (admin approves refund after rework failed/refused):
--     txn A (customer credit, one txn_id, two D/C pairs):
--       D 'warranty_refund_expense' (job price) / C 'wallet' (job price)
--       D 'warranty_fee_rev' (fee) / C 'wallet' (fee)
--       — the customer gets the FULL job price back PLUS the warranty
--       fee (the guarantee failed, so the fee is refunded too).
--       Customer balance += price + fee. A payments row (status
--       'refunded', amount = price + fee in PKR) is written in the same
--       transaction, mirroring the dispute resolver (admin.service.ts).
--     txn B (provider recovery, ONLY if the job was already settled):
--       D 'wallet' / C 'warranty_refund_expense' (job price) on the
--       PROVIDER wallet. Provider balance -= price. (Cash jobs that
--       were never settled debit nobody — the platform bears the refund,
--       exactly like the dispute resolver's wasSettled rule.)
--   Rework itself moves no money.
-- Only 'wallet'-coded legs move wallet_accounts.balance_paisa (the same
-- rule the reconciliation job uses).

-- ---- 1. Admin-configurable fee rule + claim window (feature_flags) -----
-- fee = clamp(flat + round(job_price * rate), min, max), all paisa
-- except the rate. Defaults: 5% of the job price, no flat fee,
-- min PKR 50, max PKR 500, 7-day claim window.
INSERT INTO feature_flags (key, enabled, config) VALUES
  ('warranty_fee_rate', true, '{"value_rate": 0.05}'::jsonb),
  ('warranty_fee_flat_paisa', true, '{"value_paisa": 0}'::jsonb),
  ('warranty_fee_min_paisa', true, '{"value_paisa": 5000}'::jsonb),
  ('warranty_fee_max_paisa', true, '{"value_paisa": 50000}'::jsonb),
  ('warranty_claim_days', true, '{"value_days": 7}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---- 2. One warranty per job -------------------------------------------
CREATE TABLE IF NOT EXISTS job_warranties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  customer_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  provider_user_id uuid NOT NULL REFERENCES users(id),
  fee_paisa bigint NOT NULL CHECK (fee_paisa >= 0),
  job_price_paisa bigint NOT NULL CHECK (job_price_paisa > 0),
  status varchar(16) NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'active', 'claimed', 'expired', 'refunded', 'void')),
  coverage_starts_at timestamptz,
  coverage_ends_at timestamptz,
  fee_txn_id uuid,
  fee_collected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_job_warranties_customer ON job_warranties (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_warranties_provider ON job_warranties (provider_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_warranties_expiry ON job_warranties (status, coverage_ends_at)
  WHERE status IN ('active', 'claimed');

-- ---- 3. Claims: strict state machine ------------------------------------
-- filed -> under_review -> rework_offered -> rework_done -> closed
--                                  \-> rework_failed -> refunded
-- filed | under_review -> rejected
-- Every transition (including rejected illegal attempts) is logged in
-- warranty_claim_events; admin decisions are additionally written to
-- audit_logs by the service, inside the same transaction.
CREATE TABLE IF NOT EXISTS warranty_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warranty_id uuid NOT NULL REFERENCES job_warranties(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  customer_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  provider_user_id uuid NOT NULL REFERENCES users(id),
  status varchar(16) NOT NULL DEFAULT 'filed'
    CHECK (status IN ('filed', 'under_review', 'rework_offered', 'rework_done',
                      'rework_failed', 'refunded', 'rejected', 'closed')),
  reason varchar(60) NOT NULL,
  description text NOT NULL,
  rework_note text,
  refund_amount_paisa bigint CHECK (refund_amount_paisa IS NULL OR refund_amount_paisa >= 0),
  refund_txn_id uuid,
  decided_by uuid REFERENCES users(id),
  decision_reason text,
  filed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  rework_offered_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_warranty_claims_job ON warranty_claims (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_status ON warranty_claims (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_warranty ON warranty_claims (warranty_id, created_at DESC);

CREATE TABLE IF NOT EXISTS warranty_claim_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES warranty_claims(id),
  from_status varchar(16),
  to_status varchar(16) NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  actor_role varchar(20),
  note text,
  illegal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_warranty_claim_events_claim ON warranty_claim_events (claim_id, created_at);

-- ---- 4. Published rules (versioned, admin-editable) ---------------------
CREATE TABLE IF NOT EXISTS warranty_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version int NOT NULL,
  title text NOT NULL,
  body_md text NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version));
CREATE INDEX IF NOT EXISTS idx_warranty_rules_current ON warranty_rules (is_current) WHERE is_current;

INSERT INTO warranty_rules (version, title, body_md, is_current) VALUES
  (1, 'Near Service 7-Day Workmanship Warranty — Published Rules', $md$# Near Service 7-Day Workmanship Warranty — Published Rules

## 1. Who is covered
- Only jobs done by a **Tier 3 — Trusted Pro** provider, on the Near Service platform.
- The customer must opt in **at booking** (before the job is completed). Warranty is not sold after a job is settled.

## 2. The fee
- Fee = **5% of the job price**, minimum **PKR 50**, maximum **PKR 500** (admin-configurable; the current fee is always shown before you opt in).
- The fee is collected at payment time and is shown separately on the job receipt.

## 3. Coverage
- **7 days from completion** of the job. A claim filed after the 7th day is rejected automatically.
- Covers **workmanship faults** — the work was not done properly, is incomplete, or fails because of how it was done.

## 4. What happens when you claim
1. You file a claim within 7 days of completion, describing the fault.
2. Near Service reviews the claim.
3. **Rework is offered first** — the provider returns and fixes the work at no extra charge.
4. **Refund if rework fails or the provider refuses rework** — you get the **full job price back, plus the warranty fee**.
5. A refund is paid as wallet credit you can use on your next job.

## 5. What is NOT covered
- Damage caused by the customer after completion, normal wear and tear, or misuse.
- Materials the customer supplied themselves.
- Jobs done off-platform, or jobs where the warranty was not opted in at booking.
- Claims filed more than 7 days after completion.

## 6. Decisions
- Near Service support/finance decides claims. Every decision records a reason and is auditable.
$md$, true)
ON CONFLICT (version) DO NOTHING;

-- ---- 5. Jobs: warranty flags (receipt + badge lookups) ------------------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS warranty_opted_in boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS warranty_fee_paisa bigint NOT NULL DEFAULT 0 CHECK (warranty_fee_paisa >= 0);
