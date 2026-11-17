-- Near Service — 0023_batch2_trust_safety.sql (Batch 2)
-- ADDITIVE ONLY: new tables/columns + one feature_flags seed row. No
-- earlier table/column is dropped, renamed or widened. Run after 0001–0022.
--
-- Batch 2 contents:
--   (1) user_favourites — one favourite per (user, provider).
--   (2) reviews.photos (jsonb) — up to 3 photo storage keys per review.
--   (3) support_threads + support_messages — customer <-> support tickets.
--       No fake/agent replies: an unanswered thread stays status 'open'.
--   (4) users.push_enabled — notification preference, default true.
--   (5) jobs.completion_confirmed_at / completion_confirmed_by — the
--       customer-confirms-completion rule (§6a). Escrow release and both
--       settlement paths (cash confirmPayment, wallet payWithWallet) are
--       gated on this flag; see docs/batch2-api-addendum.md.
--   (6) provider_profiles.no_show_count — incremented by
--       POST /jobs/:id/report-no-show; also written as a 'no_show'
--       risk_events row so the risk engine (weight 12, db/0011) sees it.
--   (7) feature_flags 'completion_confirm_window_hours' (default 48) —
--       same admin-configurable pattern as 'review_window_days' (db/0022):
--       read at sweep time, changing the flag needs no migration.
--
-- scheduled_at is deliberately NOT a new jobs column: the pickup-time
-- commitment lives on service_requests.scheduled_at (the Phase 2
-- reschedule flow already writes/reads it there) and GET /jobs/:id and
-- GET /jobs already surface it via jobs-query.service.ts. One source of
-- truth, no divergence between two scheduled_at columns.
BEGIN;

CREATE TABLE IF NOT EXISTS user_favourites (
  user_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider_id));
CREATE INDEX IF NOT EXISTS idx_user_favourites_user ON user_favourites (user_id, created_at DESC);

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS support_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id),
  subject text NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  closed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_support_threads_customer ON support_threads (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_threads_status ON support_threads (status, created_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id),
  sender_role varchar(12) NOT NULL CHECK (sender_role IN ('customer', 'support')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages (thread_id, created_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS push_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completion_confirmed_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completion_confirmed_by uuid REFERENCES users(id);

ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS no_show_count int NOT NULL DEFAULT 0;

INSERT INTO feature_flags (key, enabled, config) VALUES
  ('completion_confirm_window_hours', true, '{"value_hours": 48}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Partial index for the auto-confirm sweep: it scans only COMPLETED jobs
-- that are still unconfirmed (same shape as db/0022's review-window index).
CREATE INDEX IF NOT EXISTS idx_jobs_auto_confirm ON jobs (completed_at)
  WHERE state = 'COMPLETED' AND completion_confirmed_at IS NULL;

COMMIT;
