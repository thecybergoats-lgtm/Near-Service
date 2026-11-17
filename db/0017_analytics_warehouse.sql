-- Near Service — 0017_analytics_warehouse.sql (Phase 4, item 2: analytics warehouse)
--
-- ADDITIVE ONLY: creates new `analytics_*` tables in the public schema; no
-- earlier table/column is touched. The warehouse is a *copy* of operational
-- data, refreshed by the nightly ETL (POST /admin/analytics/etl/run, see
-- backend/src/modules/analytics/analytics.service.ts). Operational tables
-- are never written by the ETL — it only reads them.
--
-- Design (star schema, PRD v1.1 Phase 4 "analytics warehouse"; monthly
-- statements / tax-ready exports are generated from the ledger per PRD
-- p.32 and are labelled subject to legal review — see
-- docs/phase4-analytics.md):
--   Dimensions: analytics_dim_city, analytics_dim_category,
--     analytics_dim_zone, analytics_dim_time, analytics_dim_provider_tier.
--   Facts (grain = one row per source entity; PK = source id, so the ETL
--     upsert is idempotent — re-running a day never duplicates rows):
--     analytics_fact_requests, analytics_fact_jobs,
--     analytics_fact_payments, analytics_fact_providers (daily snapshot:
--     PK is (provider_id, snapshot_date)).
--   Run log: analytics_etl_runs — one row per ETL run, carrying the
--     reconciliation counts (operational vs warehouse) for that run.
--
-- Money: all *_pkr columns are numeric PKR as stored operationally
-- (jobs/payments store PKR; ledger paisa are NOT copied here — the
-- ledger stays the system of record for money, PRD p.18).
-- City/zone on a request/job are DERIVED at load time: nearest city
-- centre (ST_Distance) and the zone polygon containing the point
-- (ST_Within); both may be NULL for points outside every city/zone.
-- Run after 0001–0015 (0016 belongs to another Phase 4 item).

-- ---- Dimensions -------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_dim_city (
  city_id uuid PRIMARY KEY,
  slug varchar(40) NOT NULL,
  name text NOT NULL,
  is_launched boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics_dim_category (
  category_id uuid PRIMARY KEY,
  slug varchar(80) NOT NULL,
  name_en text NOT NULL,
  level smallint NOT NULL,
  parent_slug varchar(80),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics_dim_zone (
  zone_id uuid PRIMARY KEY,
  city_id uuid REFERENCES analytics_dim_city(city_id),
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics_dim_time (
  date date PRIMARY KEY,
  year smallint NOT NULL,
  month smallint NOT NULL,
  day smallint NOT NULL,
  day_of_week smallint NOT NULL,
  week_of_year smallint NOT NULL,
  quarter smallint NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_dim_provider_tier (
  tier smallint PRIMARY KEY,
  name text NOT NULL,
  min_rating numeric(3,2),
  min_jobs int,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Facts ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_fact_requests (
  request_id uuid PRIMARY KEY,
  request_date date NOT NULL REFERENCES analytics_dim_time(date),
  city_id uuid REFERENCES analytics_dim_city(city_id),
  zone_id uuid REFERENCES analytics_dim_zone(zone_id),
  category_id uuid REFERENCES analytics_dim_category(category_id),
  customer_id uuid NOT NULL,
  status varchar(24) NOT NULL,
  customer_offer_pkr numeric(12,2),
  offers_count int NOT NULL DEFAULT 0,
  first_offer_seconds int,
  had_offer boolean NOT NULL DEFAULT false,
  is_accepted boolean NOT NULL DEFAULT false,
  is_completed boolean NOT NULL DEFAULT false,
  is_rated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  etl_loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_afr_date_cat ON analytics_fact_requests (request_date, category_id);
CREATE INDEX IF NOT EXISTS idx_afr_city_date ON analytics_fact_requests (city_id, request_date);
CREATE INDEX IF NOT EXISTS idx_afr_hour ON analytics_fact_requests (request_date, created_at);

CREATE TABLE IF NOT EXISTS analytics_fact_jobs (
  job_id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  job_date date NOT NULL REFERENCES analytics_dim_time(date),
  city_id uuid REFERENCES analytics_dim_city(city_id),
  zone_id uuid REFERENCES analytics_dim_zone(zone_id),
  category_id uuid REFERENCES analytics_dim_category(category_id),
  provider_id uuid NOT NULL,
  provider_tier smallint REFERENCES analytics_dim_provider_tier(tier),
  state varchar(28) NOT NULL,
  agreed_price_pkr numeric(12,2) NOT NULL,
  final_price_pkr numeric(12,2),
  commission_pkr numeric(12,2),
  commission_rate numeric(5,4) NOT NULL,
  payment_method varchar(12) NOT NULL,
  payment_status varchar(14) NOT NULL,
  is_completed boolean NOT NULL DEFAULT false,
  is_rated boolean NOT NULL DEFAULT false,
  stars smallint,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  etl_loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_afj_date_city ON analytics_fact_jobs (job_date, city_id);
CREATE INDEX IF NOT EXISTS idx_afj_date_cat ON analytics_fact_jobs (job_date, category_id);
CREATE INDEX IF NOT EXISTS idx_afj_provider ON analytics_fact_jobs (provider_id, job_date);

CREATE TABLE IF NOT EXISTS analytics_fact_payments (
  payment_id uuid PRIMARY KEY,
  payment_date date NOT NULL REFERENCES analytics_dim_time(date),
  job_id uuid NOT NULL,
  method varchar(12) NOT NULL,
  provider_name varchar(30) NOT NULL,
  amount_pkr numeric(12,2) NOT NULL,
  status varchar(14) NOT NULL,
  created_at timestamptz NOT NULL,
  etl_loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_afp_date ON analytics_fact_payments (payment_date);

-- Daily provider snapshot: one row per provider per ETL date, so
-- supply-vs-demand can be read for any past day.
CREATE TABLE IF NOT EXISTS analytics_fact_providers (
  provider_id uuid NOT NULL,
  snapshot_date date NOT NULL REFERENCES analytics_dim_time(date),
  city_id uuid REFERENCES analytics_dim_city(city_id),
  tier smallint REFERENCES analytics_dim_provider_tier(tier),
  rating_avg numeric(3,2) NOT NULL DEFAULT 0,
  jobs_completed int NOT NULL DEFAULT 0,
  completion_rate numeric(4,3),
  is_online boolean NOT NULL DEFAULT false,
  etl_loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_afprov_date_city ON analytics_fact_providers (snapshot_date, city_id);

-- ---- ETL run log ------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_etl_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date date NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status varchar(16) NOT NULL DEFAULT 'running',
  triggered_by varchar(20) NOT NULL DEFAULT 'manual',
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciliation jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);
CREATE INDEX IF NOT EXISTS idx_aer_run_date ON analytics_etl_runs (run_date DESC, started_at DESC);
