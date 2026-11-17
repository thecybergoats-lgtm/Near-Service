-- Near Service — 0011_risk_engine.sql (Phase 3, item 2: risk engine)
-- ADDITIVE ONLY: risk_scores + fraud_signals already exist (0003); this
-- migration only ADDS columns/tables, never drops, renames or alters an
-- existing column's type. Run after 0001–0010.
--   risk_scores (0003): user_id PK, score, hold_until, updated_at.
--     + level + breakdown columns below.
--   risk_events: append-only log of every scored signal occurrence.
--   risk_settings: admin-configurable weights + thresholds (read by
--     RiskService.getSettings; PATCH /admin/risk/settings writes here).
BEGIN;

ALTER TABLE risk_scores
  ADD COLUMN IF NOT EXISTS level varchar(12) NOT NULL DEFAULT 'low'
    CHECK (level IN ('low', 'medium', 'high', 'critical'));
ALTER TABLE risk_scores
  ADD COLUMN IF NOT EXISTS breakdown jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_risk_scores_score ON risk_scores (score DESC);

CREATE TABLE IF NOT EXISTS risk_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  job_id uuid REFERENCES jobs(id),
  signal varchar(40) NOT NULL,
  -- Points one occurrence of this signal adds before the per-signal cap
  -- (the signal weight at record time); NULL for system-derived rows
  -- whose points are computed at recompute time instead.
  score_delta numeric(5,2),
  detail jsonb,
  source varchar(20) NOT NULL DEFAULT 'system'
    CHECK (source IN ('system', 'manual', 'realtime', 'reconciliation')),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_risk_events_user ON risk_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_signal ON risk_events (signal, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_job ON risk_events (job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS risk_settings (
  key varchar(60) PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now());

-- Defaults mirror DEFAULT_RISK_WEIGHTS / DEFAULT_RISK_THRESHOLDS in
-- src/common/utils/risk-scoring.ts. Admins change them via
-- PATCH /admin/risk/settings; the engine reads this table on every
-- recompute, so a change applies to the next score, never retroactively
-- to already-stored scores.
INSERT INTO risk_settings (key, value) VALUES
  ('weights', '{"cancellation": 5, "no_show": 12, "upheld_dispute": 20, "device_change": 8, "sim_change": 8, "mock_location": 15, "teleport": 15, "duplicate_account": 18, "payout_account_reuse": 15, "velocity": 10, "report": 3, "ledger_anomaly": 10}'::jsonb),
  ('review_threshold', '60'::jsonb),
  ('block_threshold', '85'::jsonb),
  ('hold_hours', '24'::jsonb),
  ('window_days', '90'::jsonb),
  ('velocity_max_requests_per_hour', '10'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
