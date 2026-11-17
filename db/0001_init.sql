-- Near Service — 0001_init.sql
-- PostgreSQL 15 + PostGIS + pg_trgm. Run first; later migrations additive only.
-- Aligned to PRD v1.0 SQL schema (pp.16-18) + v1.1 corrections:
--   (1) user_roles has a surrogate PK id + unique index (city_id nullable)
--   (2) cnic_hmac is an HMAC-SHA256 with a secret pepper (see src/common/utils/cnic.ts),
--       NOT a plain hash — column stores the HMAC hex only, never the plaintext
--   (4) users.phone is unique only where deleted_at IS NULL (partial unique index)
--   (5) Phase 1 verification is MANUAL review only: provider_documents has two
--       reserved columns that stay NULL in Phase 1 (see db/README.md);
--       review_status is set by a human verification officer only.
--   (6) One wallet per user: wallet_accounts.user_id UNIQUE (profile-level views
--       are derived from jobs/reviews, not separate wallets).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone varchar(20) NOT NULL,
  full_name text, photo_url text,
  language varchar(10) NOT NULL DEFAULT 'ur',
  google_sub text UNIQUE, apple_sub text UNIQUE,
  status varchar(20) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz);
-- v1.1 (4): a soft-deleted phone can be re-registered; active phones unique.
CREATE UNIQUE INDEX uq_users_phone_live
   ON users (phone) WHERE deleted_at IS NULL;

CREATE TABLE user_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  device_fingerprint text NOT NULL,
  platform varchar(10) NOT NULL, fcm_token text,
  integrity_verdict jsonb, last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_fingerprint));

CREATE TABLE roles (
  id smallserial PRIMARY KEY, name varchar(40) UNIQUE NOT NULL);

-- v1.1 (1): surrogate PK + unique index; city_id nullable (global roles have NULL city).
CREATE TABLE user_roles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  role_id smallint NOT NULL REFERENCES roles(id),
  city_id uuid,
  created_at timestamptz NOT NULL DEFAULT now());
-- A composite PK cannot include the nullable city_id, so uniqueness
-- is enforced by two partial unique indexes instead (v1.1):
CREATE UNIQUE INDEX uq_user_roles_global
   ON user_roles (user_id, role_id) WHERE city_id IS NULL;
CREATE UNIQUE INDEX uq_user_roles_city
   ON user_roles (user_id, role_id, city_id) WHERE city_id IS NOT NULL;
CREATE INDEX idx_user_roles_user ON user_roles (user_id);

-- Refresh-token families for rotation + reuse detection (PRD p.19).
CREATE TABLE refresh_token_families (
  family_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_refresh_family_user ON refresh_token_families (user_id);

CREATE TABLE provider_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  provider_type varchar(12) NOT NULL,
  display_name text NOT NULL, shop_name text,
  cnic_encrypted text, cnic_hmac char(64) UNIQUE, -- v1.1 HMAC-SHA256 (CNIC, CNIC_PEPPER); pepper never stored in the DB
  bio text, experience_years int, languages text[],
  base_point geography(Point,4326) NOT NULL,
  tier smallint NOT NULL DEFAULT 0,
  rating_avg numeric(3,2) NOT NULL DEFAULT 0,
  rating_bayes numeric(4,3) NOT NULL DEFAULT 3.800,
  jobs_completed int NOT NULL DEFAULT 0,
  completion_rate numeric(4,3), response_seconds_avg int,
  reliability_score numeric(5,2) NOT NULL DEFAULT 100,
  payout_method varchar(12),
  payout_account_encrypted text,
  subscription_plan varchar(12) NOT NULL DEFAULT 'free',
  is_online boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
CREATE INDEX idx_provider_geo ON provider_profiles USING gist (base_point);
CREATE INDEX idx_provider_tier ON provider_profiles (tier, is_online);

CREATE TABLE provider_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  doc_type varchar(20) NOT NULL,
  storage_key text NOT NULL, ocr_data jsonb, face_match_score numeric(4,3),
  review_status varchar(12) NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES users(id), review_note text,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE provider_tiers (
  tier smallint PRIMARY KEY, name text NOT NULL,
  min_rating numeric(3,2), min_jobs int, requires_address_check boolean,
  requires_background_check boolean, ranking_boost numeric(3,2) NOT NULL);

CREATE TABLE provider_service_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  center geography(Point,4326), radius_km numeric(5,2),
  polygon geography(Polygon,4326),
  CHECK (radius_km IS NOT NULL OR polygon IS NOT NULL));
CREATE INDEX idx_area_geo ON provider_service_areas USING gist (center);
CREATE INDEX idx_area_poly ON provider_service_areas USING gist (polygon);

CREATE TABLE provider_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  weekday smallint NOT NULL, opens time, closes time, is_day_off boolean NOT NULL DEFAULT false,
  UNIQUE (provider_id, weekday));

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES categories(id),
  level smallint NOT NULL,
  slug varchar(80) NOT NULL UNIQUE, name_en text NOT NULL,
  name_ur text, name_roman text, icon_key varchar(40),
  is_active boolean NOT NULL DEFAULT true, sort_order int DEFAULT 0);
CREATE INDEX idx_cat_name_trgm ON categories USING gin (name_en gin_trgm_ops);

CREATE TABLE category_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id),
  keyword text NOT NULL, locale varchar(10) NOT NULL,
  kind varchar(12) NOT NULL DEFAULT 'synonym');
CREATE INDEX idx_kw_trgm ON category_keywords USING gin (keyword gin_trgm_ops);
CREATE INDEX idx_kw_cat ON category_keywords (category_id);

CREATE TABLE category_form_schemas (
  category_id uuid PRIMARY KEY REFERENCES categories(id),
  schema jsonb NOT NULL,
  updated_by uuid REFERENCES users(id), updated_at timestamptz DEFAULT now());

CREATE TABLE provider_services (
  provider_id uuid REFERENCES provider_profiles(id),
  category_id uuid REFERENCES categories(id),
  starting_price numeric(12,2), is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (provider_id, category_id));

CREATE TABLE addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  label varchar(12) NOT NULL,
  address_text text, point geography(Point,4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
CREATE INDEX idx_addr_geo ON addresses USING gist (point);

-- Seed fair-price data (used by GET /pricing/fair-range until enough
-- completed jobs exist; PRD p.7 percentile rules).
CREATE TABLE fair_price_seed (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id),
  city_id uuid, -- references cities(id), defined in 0003; FK omitted to avoid a forward reference
  min_price numeric(12,2) NOT NULL, typical_price numeric(12,2) NOT NULL,
  max_price numeric(12,2) NOT NULL, sample_size int NOT NULL DEFAULT 0,
  UNIQUE (category_id, city_id));
