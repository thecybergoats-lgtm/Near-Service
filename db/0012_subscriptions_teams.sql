-- Near Service — 0012_subscriptions_teams.sql (Phase 3: Subscriptions + Teams)
-- ADDITIVE ONLY: no earlier table/column is dropped or renamed.
-- Run after 0001–0009 (0010/0011 belong to other Phase 3 workers — do not
-- renumber; this file is 0012 by assignment).
-- Plans seed the three tiers; provider_profiles.subscription_plan (0001)
-- is kept in sync by the subscriptions service on subscribe/change/expire.

-- 1. Subscription plans (admin-managed; prices are PKR per month).
CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL UNIQUE,
  name text NOT NULL,
  price_pkr numeric(12,2) NOT NULL DEFAULT 0 CHECK (price_pkr >= 0),
  -- Multiplier applied to the commission-engine base rate, then clamped to
  -- the 0.05–0.15 band (see SubscriptionsService.applyPlanCommissionRate).
  -- free 1.00 (no discount), pro 0.80, business 0.60.
  commission_multiplier numeric(5,4) NOT NULL DEFAULT 1.0
    CHECK (commission_multiplier > 0 AND commission_multiplier <= 1),
  max_staff_accounts int NOT NULL DEFAULT 0 CHECK (max_staff_accounts >= 0),
  featured boolean NOT NULL DEFAULT false,
  analytics_enabled boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO subscription_plans (code, name, price_pkr, commission_multiplier, max_staff_accounts, featured, analytics_enabled)
VALUES
  ('free', 'Free', 0, 1.00, 0, false, false),
  ('pro', 'Pro', 999, 0.80, 0, false, true),
  ('business', 'Business', 2499, 0.60, 5, true, true)
ON CONFLICT (code) DO NOTHING;

-- 2. One subscription per provider (at most one ACTIVE row — partial index).
CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  user_id uuid NOT NULL REFERENCES users(id),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'expired')),
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz NOT NULL,
  -- Downgrade target: applied at current_period_end by expireEndedSubscriptions.
  pending_plan_id uuid REFERENCES subscription_plans(id),
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_provider_active
  ON subscriptions (provider_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end ON subscriptions (current_period_end) WHERE status = 'active';

-- 3. Teams: one team per provider profile (a shop); the owner is the
-- provider-profile user. Workers are users invited into the team.
CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL UNIQUE REFERENCES provider_profiles(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams (owner_user_id);

CREATE TABLE IF NOT EXISTS team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role varchar(12) NOT NULL CHECK (role IN ('owner', 'manager', 'worker')),
  status varchar(12) NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'removed')),
  invited_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members (team_id, status);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id, status);

-- 4. Job assignments: at most one worker per job (UNIQUE job_id); a row
-- exists only while the job is assigned. Reassignment updates the row.
CREATE TABLE IF NOT EXISTS team_job_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  worker_user_id uuid NOT NULL REFERENCES users(id),
  assigned_by uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_team_assignments_team ON team_job_assignments (team_id);
CREATE INDEX IF NOT EXISTS idx_team_assignments_worker ON team_job_assignments (worker_user_id);
