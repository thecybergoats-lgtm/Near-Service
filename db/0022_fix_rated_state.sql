-- Near Service — 0022_fix_rated_state.sql (Fix B)
-- ADDITIVE ONLY: one feature_flags seed row + one partial index. No
-- earlier table/column is dropped, renamed or widened. Run after 0001–0021.
--
-- Fix B: the RATED job state existed in the state machine
-- (PAYMENT_SETTLED -> RATED) but no code ever wrote it — reviews were
-- only allowed in PAYMENT_SETTLED and left the job there forever, so
-- analytics / warranty / subscriptions / admin reports that expect RATED
-- never saw it.
--
-- The rule (see docs/phase4-api-addendum.md §10):
--   PAYMENT_SETTLED -> RATED when BOTH sides have submitted their review,
--   OR when the review window closes — whichever comes first. Until then
--   the job stays PAYMENT_SETTLED and each side can still review once.
--   After RATED no more reviews (409 REVIEW_WINDOW_CLOSED).
--
-- Window: admin-configurable via feature_flags key `review_window_days`
-- (integer days, default 7), same pattern as `warranty_claim_days`
-- (db/0019). The window starts at the latest job_events row with
-- to_state='PAYMENT_SETTLED' for the job (every settlement path — cash,
-- wallet, escrow release, dispute resolution — writes that event), so a
-- dispute that returns a job to PAYMENT_SETTLED restarts the window.
-- The closing sweep (POST /admin/jobs/close-review-windows) reads the
-- flag at run time; changing the flag needs no migration.
INSERT INTO feature_flags (key, enabled, config) VALUES
  ('review_window_days', true, '{"value_days": 7}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Partial index for the closing sweep: it scans only PAYMENT_SETTLED jobs.
CREATE INDEX IF NOT EXISTS idx_jobs_review_window ON jobs (updated_at)
  WHERE state = 'PAYMENT_SETTLED';
