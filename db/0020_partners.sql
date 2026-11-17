-- Near Service — 0020_partners.sql (Phase 4, item 5: partner integrations)
--
-- Partnerships — parts-supplier affiliate ordering (AC parts, hardware),
-- disclosed in-app (PRD v1.1, Phase 4 scope).
--
-- ADDITIVE ONLY: no earlier table/column is touched. New tables:
--   partners, partner_catalog_items, partner_orders, partner_order_items.
--
-- Money model (all integer paisa; 1 PKR = 100 paisa):
--   PLACE:    no money moves. Stock is reserved (stock_qty decremented);
--             the order total is priced from the catalog snapshot stored
--             on each order line — the client never sets prices.
--   CONFIRM:  the affiliate fee (partner.affiliate_fee_rate of the order
--             total, default 5%) is recorded as a balanced double-entry
--             pair under ONE txn_id on the PROVIDER's wallet, exactly like
--             the tender lead fee (0013) and the cash commission (0003):
--               D 'wallet' / C 'affiliate_fee_rev' (fee paisa).
--             The provider wallet balance is debited the fee (it may go
--             negative, same rule as commission settlement, PRD p.18).
--             Checked at COMMIT by the deferred trigger from 0008.
--   DELIVER:  no money moves.
--   CANCEL from 'placed':     stock is restored; no ledger entries.
--   CANCEL from 'confirmed':  stock is restored AND the fee is reversed
--             under a NEW txn_id: D 'affiliate_fee_rev' / C 'wallet',
--             balance credited back. The reversal txn is also balanced.
--   A fee of 0 paisa (tiny order rounding to zero) writes no ledger
--   entries at all — there is nothing to balance.
--
-- DISCLOSURE: every partner order is disclosed in-app. The API returns a
-- partner_disclosure block (partner name + affiliate fee + plain-language
-- text) on every order view and on the job's partner-orders view, for
-- BOTH the customer and the provider of the job. There is no silent
-- affiliate order anywhere in this module.
--
-- LOCAL CATALOG ONLY: no live supplier API key or account exists in this
-- build. The seeded catalog below IS the working implementation
-- (LocalPartnerProvider). See docs/phase4-partners.md for the swap-in
-- guide (what account/API the user needs for a live supplier).
--
-- Run after 0001–0019.

-- ---- 1. Global default affiliate fee rate (feature_flags) ---------------
-- partner_affiliate_fee_rate: default rate applied to NEW partners
-- (existing partners keep their own affiliate_fee_rate). 0.05 = 5%.
INSERT INTO feature_flags (key, enabled, config) VALUES
  ('partner_affiliate_fee_rate', true, '{"value_rate": 0.05}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---- 2. Partners ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug varchar(60) UNIQUE NOT NULL,
  kind varchar(24) NOT NULL DEFAULT 'parts_supplier'
    CHECK (kind IN ('parts_supplier', 'hardware_supplier', 'general_supplier')),
  contact_name text,
  contact_phone varchar(20),
  website text,
  city text,
  -- Affiliate fee Near Service earns on confirmed orders, e.g. 0.05 = 5%.
  affiliate_fee_rate numeric(5,4) NOT NULL DEFAULT 0.05 CHECK (affiliate_fee_rate >= 0 AND affiliate_fee_rate < 1),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_partners_active ON partners (is_active, slug);

-- ---- 3. Partner catalog items -------------------------------------------
-- unit_price_paisa is the price the provider is charged; order lines
-- snapshot it at placement time so later price edits never rewrite
-- history. stock_qty is reserved on place, restored on cancel.
CREATE TABLE IF NOT EXISTS partner_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  sku varchar(60) UNIQUE NOT NULL,
  name text NOT NULL,
  category varchar(24) NOT NULL DEFAULT 'hardware'
    CHECK (category IN ('ac_parts', 'hardware', 'electrical', 'plumbing')),
  description text,
  unit_price_paisa bigint NOT NULL CHECK (unit_price_paisa > 0),
  stock_qty int NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_catalog_partner_category
  ON partner_catalog_items (partner_id, category, is_active);
CREATE INDEX IF NOT EXISTS idx_catalog_search
  ON partner_catalog_items USING gin (to_tsvector('simple', name || ' ' || sku || ' ' || COALESCE(description, '')));

-- ---- 4. Partner orders ---------------------------------------------------
-- One order = one partner, one job, one provider. Status machine
-- (enforced in backend/src/modules/partners/domain/partner-order-math.ts):
--   placed -> confirmed -> delivered
--   placed -> cancelled
--   confirmed -> cancelled (fee reversed, see header)
--   delivered / cancelled are terminal.
CREATE TABLE IF NOT EXISTS partner_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  customer_id uuid NOT NULL REFERENCES users(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  status varchar(12) NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed', 'confirmed', 'delivered', 'cancelled')),
  total_paisa bigint NOT NULL CHECK (total_paisa > 0),
  affiliate_fee_paisa bigint NOT NULL DEFAULT 0 CHECK (affiliate_fee_paisa >= 0),
  affiliate_fee_rate numeric(5,4) NOT NULL CHECK (affiliate_fee_rate >= 0 AND affiliate_fee_rate < 1),
  fee_txn_id uuid,
  reversal_txn_id uuid,
  cancel_reason text,
  placed_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_partner_orders_job ON partner_orders (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_orders_provider ON partner_orders (provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_orders_partner_status ON partner_orders (partner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_orders_fee_txn ON partner_orders (fee_txn_id) WHERE fee_txn_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS partner_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES partner_orders(id) ON DELETE CASCADE,
  catalog_item_id uuid NOT NULL REFERENCES partner_catalog_items(id),
  quantity int NOT NULL CHECK (quantity > 0 AND quantity <= 100),
  unit_price_paisa bigint NOT NULL CHECK (unit_price_paisa > 0),
  line_total_paisa bigint NOT NULL CHECK (line_total_paisa > 0),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_partner_order_items_order ON partner_order_items (order_id);

-- ---- 5. Seed: local partner suppliers + real catalog --------------------
-- Prices are representative Quetta retail prices in PKR (converted to
-- paisa here). These are the LOCAL catalog — no live supplier is wired.
INSERT INTO partners (id, name, slug, kind, contact_name, contact_phone, city, affiliate_fee_rate) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Quetta AC Spares', 'quetta-ac-spares', 'parts_supplier', 'Haji Kareem', '+923008000001', 'Quetta', 0.05),
  ('a0000000-0000-4000-8000-000000000002', 'Quetta Hardware House', 'quetta-hardware-house', 'hardware_supplier', 'Malik Javed', '+923008000002', 'Quetta', 0.05)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO partner_catalog_items (partner_id, sku, name, category, description, unit_price_paisa, stock_qty) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'QAS-CAP-35', 'AC Capacitor 35uF', 'ac_parts', 'Run capacitor for split AC, 35 microfarad, 450V', 85000, 40),
  ('a0000000-0000-4000-8000-000000000001', 'QAS-CAP-45', 'AC Capacitor 45uF', 'ac_parts', 'Run capacitor for split AC, 45 microfarad, 450V', 95000, 35),
  ('a0000000-0000-4000-8000-000000000001', 'QAS-GAS-R22', 'AC Gas R22 (1 kg)', 'ac_parts', 'Refrigerant R22, 1 kg cylinder refill', 280000, 25),
  ('a0000000-0000-4000-8000-000000000001', 'QAS-GAS-R410', 'AC Gas R410A (1 kg)', 'ac_parts', 'Refrigerant R410A, 1 kg cylinder refill', 350000, 20),
  ('a0000000-0000-4000-8000-000000000001', 'QAS-CU-14', 'Copper Pipe 1/4 inch (per ft)', 'ac_parts', 'Refrigeration copper pipe, 1/4 inch, sold per foot', 22000, 500),
  ('a0000000-0000-4000-8000-000000000001', 'QAS-CU-12', 'Copper Pipe 1/2 inch (per ft)', 'ac_parts', 'Refrigeration copper pipe, 1/2 inch, sold per foot', 38000, 400),
  ('a0000000-0000-4000-8000-000000000001', 'QAS-REM-UNI', 'AC Remote Universal', 'ac_parts', 'Universal remote for split AC, all major brands', 65000, 60),
  ('a0000000-0000-4000-8000-000000000001', 'QAS-RELAY', 'Compressor Relay', 'ac_parts', 'Compressor start relay, universal fit', 120000, 30),
  ('a0000000-0000-4000-8000-000000000001', 'QAS-FAN-15', 'AC Fan Motor 1.5 Ton', 'ac_parts', 'Indoor fan motor for 1.5 ton split AC', 650000, 12),
  ('a0000000-0000-4000-8000-000000000001', 'QAS-SENSOR', 'Thermostat Sensor', 'ac_parts', 'Room temperature sensor for split AC', 45000, 50),
  ('a0000000-0000-4000-8000-000000000002', 'QHH-DRILL-13', 'Drill Bit Set 13pc', 'hardware', 'HSS drill bit set, 13 pieces, 1.5-6.5 mm', 145000, 45),
  ('a0000000-0000-4000-8000-000000000002', 'QHH-SCREW-6', 'Screwdriver Set 6pc', 'hardware', 'Magnetic screwdriver set, 6 pieces', 98000, 70),
  ('a0000000-0000-4000-8000-000000000002', 'QHH-PLUG-100', 'Wall Plug + Screw Box 100pc', 'hardware', 'Nylon wall plugs with screws, box of 100', 35000, 120),
  ('a0000000-0000-4000-8000-000000000002', 'QHH-TAPE-PVC', 'PVC Insulation Tape', 'hardware', 'Electrical PVC tape, 18 m roll', 12000, 200),
  ('a0000000-0000-4000-8000-000000000002', 'QHH-WIRE-329', 'Copper Wire 3/29 (per metre)', 'electrical', 'Copper wire 3/29, sold per metre', 9500, 1000),
  ('a0000000-0000-4000-8000-000000000002', 'QHH-MCB-16', 'Circuit Breaker 16A', 'electrical', 'Single-pole MCB circuit breaker, 16 amp', 75000, 80),
  ('a0000000-0000-4000-8000-000000000002', 'QHH-SOCK-1', 'Switch Socket Combo', 'electrical', 'Switch + socket combo plate', 42000, 90),
  ('a0000000-0000-4000-8000-000000000002', 'QHH-TEFLON', 'Plumber Teflon Tape', 'plumbing', 'PTFE thread seal tape, 12 m roll', 6000, 300)
ON CONFLICT (sku) DO NOTHING;
