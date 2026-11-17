-- Near Service — 0003_money_trust.sql (PRD pp.18-19)
-- v1.1 (6): ONE wallet per user (wallet_accounts.user_id UNIQUE).
-- Profile-level views (customer vs provider balances) are derived queries
-- over ledger_entries/jobs, not separate wallet rows.
CREATE TABLE wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  balance_paisa bigint NOT NULL DEFAULT 0,
  escrow_held_paisa bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'PKR',
  updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txn_id uuid NOT NULL,
  wallet_id uuid REFERENCES wallet_accounts(id),
  account_code varchar(40) NOT NULL,
  direction char(1) NOT NULL CHECK (direction IN ('D','C')),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  job_id uuid REFERENCES jobs(id), payment_id uuid,
  memo text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_ledger_txn ON ledger_entries (txn_id);
-- Rule (enforced by application + nightly reconciliation, PRD p.18):
-- SUM(D) = SUM(C) per txn_id.

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  payer_id uuid NOT NULL REFERENCES users(id),
  method varchar(12) NOT NULL,
  provider_name varchar(30) NOT NULL,
  provider_ref text, amount numeric(12,2) NOT NULL,
  status varchar(14) NOT NULL DEFAULT 'initiated',
  idempotency_key varchar(80) UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz);

CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallet_accounts(id),
  amount numeric(12,2) NOT NULL, fee numeric(12,2) NOT NULL DEFAULT 0,
  destination varchar(12) NOT NULL,
  status varchar(14) NOT NULL DEFAULT 'requested',
  approved_by uuid REFERENCES users(id), tax jsonb,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid REFERENCES categories(id), city_id uuid,
  tier smallint, rate numeric(5,4) NOT NULL,
  valid_from date NOT NULL, valid_to date, is_promo boolean DEFAULT false);

CREATE TABLE promos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(30) UNIQUE NOT NULL, kind varchar(14) NOT NULL,
  value numeric(12,2) NOT NULL, max_uses int, per_user_limit int DEFAULT 1,
  valid_from timestamptz, valid_to timestamptz, is_active boolean DEFAULT true);
CREATE TABLE promo_redemptions (
  promo_id uuid REFERENCES promos(id), user_id uuid REFERENCES users(id),
  job_id uuid REFERENCES jobs(id), device_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (promo_id, user_id, job_id));

CREATE TABLE referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES users(id),
  referred_id uuid NOT NULL UNIQUE REFERENCES users(id),
  credit_paisa bigint NOT NULL DEFAULT 0, status varchar(12) DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  opened_by uuid NOT NULL REFERENCES users(id), reason_code varchar(30),
  description text, status varchar(16) NOT NULL DEFAULT 'open',
  sla_first_response_at timestamptz, sla_resolve_at timestamptz,
  assigned_to uuid REFERENCES users(id), resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz);
CREATE INDEX idx_disputes_status ON disputes (status, created_at);

CREATE TABLE dispute_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES disputes(id),
  uploader_id uuid NOT NULL REFERENCES users(id),
  kind varchar(10) NOT NULL, storage_key text, note text,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES users(id), reported_id uuid REFERENCES users(id),
  context varchar(12), reason_code varchar(30), detail text,
  status varchar(12) NOT NULL DEFAULT 'open', created_at timestamptz DEFAULT now());
CREATE TABLE blocks (
  blocker_id uuid REFERENCES users(id), blocked_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id));

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  channel varchar(10) NOT NULL,
  template_key varchar(50) NOT NULL, payload jsonb,
  status varchar(12) NOT NULL DEFAULT 'queued', sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_notif_user ON notifications (user_id, created_at DESC);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text, audience jsonb, template_key varchar(50),
  created_by uuid REFERENCES users(id), sent_at timestamptz,
  stats jsonb, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE fraud_signals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users(id), job_id uuid REFERENCES jobs(id),
  signal varchar(40) NOT NULL,
  score_delta numeric(5,2), detail jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE risk_scores (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  score numeric(6,2) NOT NULL DEFAULT 0, hold_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, slug varchar(40) UNIQUE NOT NULL,
  center geography(Point,4326), is_launched boolean NOT NULL DEFAULT false,
  default_radius_km numeric(5,2) DEFAULT 5, launched_at timestamptz);
CREATE TABLE zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES cities(id), name text NOT NULL,
  polygon geography(Polygon,4326));
CREATE INDEX idx_zones_geo ON zones USING gist (polygon);

CREATE TABLE waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id), category_id uuid REFERENCES categories(id),
  point geography(Point,4326), created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid, action varchar(60) NOT NULL, entity varchar(40),
  entity_id uuid, before jsonb, after jsonb, ip inet,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_audit_actor ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs (entity, entity_id);

CREATE TABLE feature_flags (
  key varchar(60) PRIMARY KEY, enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}', updated_by uuid, updated_at timestamptz);
