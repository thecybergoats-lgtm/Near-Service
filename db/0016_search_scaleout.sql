-- Near Service — 0016_search_scaleout.sql (Phase 4, item 1: search scale-out).
--
-- ADDITIVE ONLY: no earlier table/column is dropped, renamed or widened.
-- New: full-text vectors on categories / category_keywords, raw search
-- query + click events, a daily metrics rollup, and the metrics-gate
-- threshold store. Nothing here changes what GET /search returns.
--
-- Design (see docs/phase4-search.md):
--   * The scaled provider ranks with pg full-text (tsvector, 'simple'
--     config so Roman Urdu / English mix is not stemmed away) COMBINED
--     with trigram similarity — the trigram behaviour of the default
--     provider is preserved as a fallback signal, never removed.
--   * Metrics are recorded per query (search_query_events) so p50/p95,
--     zero-result rate and click-through rate are measured, not guessed.
--     The gate that decides whether a dedicated search tier is switched
--     on reads its thresholds from search_gate_config (seeded below);
--     admins change them via PATCH /admin/search/gate/thresholds.
--   * search_metrics_daily is a rollup written by
--     SearchMetricsService.rollupDaily(); the admin view reads the rollup,
--     the gate reads the live window.
--
-- Run after 0001–0015.

-- ---- 1. Full-text vectors (generated, always in sync with the names) ----
ALTER TABLE categories ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(name_en, '') || ' ' ||
      coalesce(name_roman, '') || ' ' ||
      coalesce(name_ur, ''))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_categories_search_vector
  ON categories USING gin (search_vector);

ALTER TABLE category_keywords ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(keyword, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_category_keywords_search_vector
  ON category_keywords USING gin (search_vector);

-- ---- 2. Raw search query events (one row per served search) -------------
-- query is stored as typed (max 100 chars at the API layer); never store
-- lat/lng or any user identifier here — these events are aggregates input,
-- not a per-user history. Retention is an ops decision, not enforced here
-- (see docs/phase4-search.md); the daily rollup is the long-lived record.
CREATE TABLE IF NOT EXISTS search_query_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query text NOT NULL,
  provider varchar(16) NOT NULL DEFAULT 'trigram'
    CHECK (provider IN ('trigram', 'scaled', 'remote')),
  cache_hit boolean NOT NULL DEFAULT false,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_search_query_events_created
  ON search_query_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_query_events_provider_created
  ON search_query_events (provider, created_at DESC);

-- ---- 3. Search click events (CTR input) ----------------------------------
-- A click is recorded by the client after a search (POST /search/click is
-- NOT part of this item — see docs/phase4-search.md wiring note; until it
-- exists, CTR reports 0 clicks and the gate treats CTR as "no data").
CREATE TABLE IF NOT EXISTS search_click_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_event_id uuid REFERENCES search_query_events(id) ON DELETE SET NULL,
  target_type varchar(16) NOT NULL CHECK (target_type IN ('category', 'provider')),
  target_id uuid,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_search_click_events_created
  ON search_click_events (created_at DESC);

-- ---- 4. Metrics-gate thresholds (admin-editable, one row per key) -------
CREATE TABLE IF NOT EXISTS search_gate_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now());
-- Defaults: switch the dedicated tier ON when, over the window, ANY of
-- these holds (and the sample is big enough — see min_queries_for_gate):
--   p95 latency above 500 ms, zero-result rate above 25%, CTR below 5%
--   (only when clicks are being recorded), or volume above 10,000
--   queries/day. These are starting points, not measurements — tune them
--   from the admin view once real traffic exists.
INSERT INTO search_gate_config (key, value) VALUES
  ('p95_latency_ms_threshold', '{"value": 500}'::jsonb),
  ('zero_result_rate_threshold', '{"value": 0.25}'::jsonb),
  ('ctr_floor', '{"value": 0.05}'::jsonb),
  ('queries_per_day_threshold', '{"value": 10000}'::jsonb),
  ('min_queries_for_gate', '{"value": 100}'::jsonb),
  ('window_hours', '{"value": 24}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---- 5. Daily metrics rollup (long-lived admin view data) ---------------
CREATE TABLE IF NOT EXISTS search_metrics_daily (
  day date NOT NULL,
  provider varchar(16) NOT NULL DEFAULT 'all'
    CHECK (provider IN ('all', 'trigram', 'scaled', 'remote')),
  queries integer NOT NULL DEFAULT 0 CHECK (queries >= 0),
  zero_result_queries integer NOT NULL DEFAULT 0 CHECK (zero_result_queries >= 0),
  cache_hits integer NOT NULL DEFAULT 0 CHECK (cache_hits >= 0),
  clicks integer NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  latency_p50_ms integer CHECK (latency_p50_ms IS NULL OR latency_p50_ms >= 0),
  latency_p95_ms integer CHECK (latency_p95_ms IS NULL OR latency_p95_ms >= 0),
  PRIMARY KEY (day, provider));
