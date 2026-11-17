-- Near Service — 0018_multi_city.sql (Phase 4, item 3: multi-city ops tooling)
--
-- ADDITIVE ONLY: no earlier table/column is dropped, renamed or widened.
-- Builds on what already exists:
--   * cities (0003) + Quetta seed (0004) — extended here with a status
--     lifecycle, a City Manager owner, supply targets and a population
--     estimate (needed for the supply-density gate metric).
--   * user_roles.city_id (0001) — City Manager scoping already exists in
--     the schema; this migration only SEEDS the assignments, the service
--     layer enforces them.
--   * commission_rules.city_id (0003) + pickCommissionRule specificity
--     (backend/src/common/utils/commission.ts) — per-city commission
--     overrides already resolve city > global; no new money table.
--   * fair_price_seed.city_id (0001) — per-city pricing overrides already
--     exist; no new pricing table.
-- New here: gate configs + evaluations, per-city category enablement,
-- city areas (SEO landing pages), the launch checklist, and the Karachi
-- launch seed (city row, 3 seed providers, checklist, gate config).
--
-- Run after 0001–0015.

-- ---- 1. cities: status lifecycle + manager + targets + population ------
ALTER TABLE cities ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'planned'
  CHECK (status IN ('planned', 'in_preparation', 'gate_review', 'live', 'paused'));
ALTER TABLE cities ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES users(id);
ALTER TABLE cities ADD COLUMN IF NOT EXISTS supply_target_providers int NOT NULL DEFAULT 10
  CHECK (supply_target_providers >= 0);
ALTER TABLE cities ADD COLUMN IF NOT EXISTS population_estimate int
  CHECK (population_estimate IS NULL OR population_estimate > 0);
ALTER TABLE cities ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE cities ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
-- The legacy is_launched flag must agree with the new lifecycle: a city
-- is 'live' exactly when it is launched. (Quetta is backfilled below.)
ALTER TABLE cities ADD CONSTRAINT chk_cities_live_flag
  CHECK (status <> 'live' OR is_launched);
CREATE INDEX IF NOT EXISTS idx_cities_status ON cities (status);

-- Backfill: the already-launched pilot city is 'live'; Quetta's
-- population is ~1.2M (2023 census metro estimate, used only for the
-- supply-density gate metric, not displayed to customers).
UPDATE cities SET status = 'live' WHERE is_launched = true;
UPDATE cities SET population_estimate = 1200000 WHERE slug = 'quetta' AND population_estimate IS NULL;

-- ---- 2. Karachi launch city (next city after Quetta) ---------------------
-- Status 'in_preparation': it is NOT live, and its gate evaluation below
-- honestly FAILS (3 seed providers vs a 10-provider target, ~0.02
-- providers per 100k vs a 0.8 threshold, no requests yet so no fill
-- rate / time-to-first-offer data). Population ~16M (Karachi metro).
-- Default radius 12 km: Karachi is a sprawling metro, so the pilot's
-- 5 km radius would exclude the Gulshan/Clifton seed supply from the
-- gate count; 12 km covers the seeded areas around Saddar centre.
INSERT INTO cities (id, name, slug, center, is_launched, default_radius_km, status, population_estimate, supply_target_providers)
VALUES ('00000000-0000-4000-8000-0000aaaa0002', 'Karachi', 'karachi',
        ST_SetSRID(ST_MakePoint(67.0011, 24.8607), 4326)::geography,
        false, 12, 'in_preparation', 16000000, 10)
ON CONFLICT (slug) DO NOTHING;

-- ---- 3. Go/no-go gate thresholds, configurable per city ------------------
-- Defaults mirror the Quetta pilot: 10 providers, 0.8 providers per
-- 100k people, 50% of requests getting at least one offer, first offer
-- within 15 minutes (900s). A City Manager edits these per city; the
-- evaluation below is always run against the stored config.
CREATE TABLE IF NOT EXISTS city_gate_configs (
  city_id uuid PRIMARY KEY REFERENCES cities(id),
  min_providers int NOT NULL DEFAULT 10 CHECK (min_providers >= 0),
  min_supply_density_per_100k numeric(6, 3) NOT NULL DEFAULT 0.8 CHECK (min_supply_density_per_100k >= 0),
  min_fill_rate numeric(4, 3) NOT NULL DEFAULT 0.5 CHECK (min_fill_rate >= 0 AND min_fill_rate <= 1),
  max_time_to_first_offer_seconds int NOT NULL DEFAULT 900 CHECK (max_time_to_first_offer_seconds > 0),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO city_gate_configs (city_id)
SELECT id FROM cities WHERE slug IN ('quetta', 'karachi')
ON CONFLICT (city_id) DO NOTHING;

-- ---- 4. Gate evaluations (every run is persisted + audited) --------------
CREATE TABLE IF NOT EXISTS city_gate_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES cities(id),
  evaluated_by uuid REFERENCES users(id),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  metrics jsonb NOT NULL DEFAULT '{}',
  results jsonb NOT NULL DEFAULT '{}',
  passed boolean NOT NULL,
  notes text);
CREATE INDEX IF NOT EXISTS idx_gate_evals_city ON city_gate_evaluations (city_id, evaluated_at DESC);

-- ---- 5. Per-city category enablement -------------------------------------
-- A category is available in a city only when its override row says so
-- (no row = not launched in that city; the global taxonomy is untouched).
CREATE TABLE IF NOT EXISTS city_category_overrides (
  city_id uuid NOT NULL REFERENCES cities(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  is_enabled boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, category_id));
-- Quetta: the 5 Phase 1 launch categories, enabled (as piloted).
INSERT INTO city_category_overrides (city_id, category_id, is_enabled, sort_order)
SELECT '00000000-0000-4000-8000-0000aaaa0001', id, true, sort_order FROM categories
WHERE slug IN ('book-binding', 'ac-repair', 'electrician', 'plumber', 'mobile-repair')
ON CONFLICT (city_id, category_id) DO NOTHING;
-- Karachi: same 5 categories, NOT yet enabled — enabling them is a
-- checklist item below, still pending.
INSERT INTO city_category_overrides (city_id, category_id, is_enabled, sort_order)
SELECT '00000000-0000-4000-8000-0000aaaa0002', id, false, sort_order FROM categories
WHERE slug IN ('book-binding', 'ac-repair', 'electrician', 'plumber', 'mobile-repair')
ON CONFLICT (city_id, category_id) DO NOTHING;

-- ---- 6. City areas (SEO landing pages: /services/<category>/<area>) -----
-- The slug carries the city (e.g. 'satellite-town-quetta') so the public
-- URL resolves from the area slug alone.
CREATE TABLE IF NOT EXISTS city_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES cities(id),
  name text NOT NULL,
  slug varchar(60) NOT NULL,
  center geography(Point, 4326),
  UNIQUE (city_id, slug));
CREATE INDEX IF NOT EXISTS idx_city_areas_city ON city_areas (city_id);
INSERT INTO city_areas (city_id, name, slug, center) VALUES
  ('00000000-0000-4000-8000-0000aaaa0001', 'Satellite Town', 'satellite-town-quetta', ST_SetSRID(ST_MakePoint(66.985, 30.195), 4326)::geography),
  ('00000000-0000-4000-8000-0000aaaa0001', 'Sariab Road', 'sariab-road-quetta', ST_SetSRID(ST_MakePoint(66.95, 30.16), 4326)::geography),
  ('00000000-0000-4000-8000-0000aaaa0001', 'Brewery Road', 'brewery-road-quetta', ST_SetSRID(ST_MakePoint(66.99, 30.21), 4326)::geography),
  ('00000000-0000-4000-8000-0000aaaa0001', 'Jinnah Town', 'jinnah-town-quetta', ST_SetSRID(ST_MakePoint(66.975, 30.1798), 4326)::geography),
  ('00000000-0000-4000-8000-0000aaaa0001', 'Samungli Road', 'samungli-road-quetta', ST_SetSRID(ST_MakePoint(66.96, 30.17), 4326)::geography),
  ('00000000-0000-4000-8000-0000aaaa0002', 'Gulshan-e-Iqbal', 'gulshan-e-iqbal-karachi', ST_SetSRID(ST_MakePoint(67.0792, 24.9268), 4326)::geography),
  ('00000000-0000-4000-8000-0000aaaa0002', 'Clifton', 'clifton-karachi', ST_SetSRID(ST_MakePoint(67.0356, 24.8138), 4326)::geography),
  ('00000000-0000-4000-8000-0000aaaa0002', 'DHA', 'dha-karachi', ST_SetSRID(ST_MakePoint(67.0822, 24.8008), 4326)::geography),
  ('00000000-0000-4000-8000-0000aaaa0002', 'Saddar', 'saddar-karachi', ST_SetSRID(ST_MakePoint(67.0099, 24.8615), 4326)::geography),
  ('00000000-0000-4000-8000-0000aaaa0002', 'North Nazimabad', 'north-nazimabad-karachi', ST_SetSRID(ST_MakePoint(67.0456, 24.9375), 4326)::geography)
ON CONFLICT (city_id, slug) DO NOTHING;

-- ---- 7. Launch checklist (owned by the City Manager, PRD) ---------------
CREATE TABLE IF NOT EXISTS city_launch_checklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES cities(id),
  item_key varchar(60) NOT NULL,
  label text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  done_by uuid REFERENCES users(id),
  done_at timestamptz,
  notes text,
  UNIQUE (city_id, item_key));
-- Karachi: all pending — this is the honest starting state.
INSERT INTO city_launch_checklist (city_id, item_key, label, done) VALUES
  ('00000000-0000-4000-8000-0000aaaa0002', 'assign_city_manager', 'Assign a City Manager for Karachi', false),
  ('00000000-0000-4000-8000-0000aaaa0002', 'onboard_supply', 'Onboard at least 10 verified providers (supply target)', false),
  ('00000000-0000-4000-8000-0000aaaa0002', 'enable_categories', 'Enable the 5 launch categories for Karachi', false),
  ('00000000-0000-4000-8000-0000aaaa0002', 'set_radius_rules', 'Set service radius rules (12 km for Karachi)', false),
  ('00000000-0000-4000-8000-0000aaaa0002', 'seed_fair_pricing', 'Seed fair-price ranges for launch categories', false),
  ('00000000-0000-4000-8000-0000aaaa0002', 'seo_pages', 'Publish SEO landing pages (service + area)', false),
  ('00000000-0000-4000-8000-0000aaaa0002', 'gate_evaluation_pass', 'Pass the go/no-go gate evaluation', false)
ON CONFLICT (city_id, item_key) DO NOTHING;
-- Quetta: the pilot already did all of these — recorded as done so the
-- checklist reads as history, not as pending work.
INSERT INTO city_launch_checklist (city_id, item_key, label, done, done_at) VALUES
  ('00000000-0000-4000-8000-0000aaaa0001', 'assign_city_manager', 'Assign a City Manager for Quetta', true, now()),
  ('00000000-0000-4000-8000-0000aaaa0001', 'onboard_supply', 'Onboard at least 10 verified providers (supply target)', true, now()),
  ('00000000-0000-4000-8000-0000aaaa0001', 'enable_categories', 'Enable the 5 launch categories for Quetta', true, now()),
  ('00000000-0000-4000-8000-0000aaaa0001', 'set_radius_rules', 'Set service radius rules (default 5 km)', true, now()),
  ('00000000-0000-4000-8000-0000aaaa0001', 'seed_fair_pricing', 'Seed fair-price ranges for launch categories', true, now()),
  ('00000000-0000-4000-8000-0000aaaa0001', 'seo_pages', 'Publish SEO landing pages (service + area)', true, now()),
  ('00000000-0000-4000-8000-0000aaaa0001', 'gate_evaluation_pass', 'Pass the go/no-go gate evaluation', true, now())
ON CONFLICT (city_id, item_key) DO NOTHING;

-- ---- 8. Karachi seed supply: 3 providers (deliberately BELOW the gate) --
-- 3 < 10 target, so the seeded gate evaluation FAILS — see the service
-- (evaluateGate) and test/integration/cities.spec.ts. Real onboarding
-- adds providers through the normal provider flow, not this seed.
INSERT INTO users (id, phone, full_name, language) VALUES
  ('10000000-0201-4000-8000-000000000001', '+923008121001', 'Karachi Cool Air', 'ur'),
  ('10000000-0202-4000-8000-000000000002', '+923008121002', 'Ustad Rashid Electrician', 'ur'),
  ('10000000-0203-4000-8000-000000000003', '+923008121003', 'Al-Rehman Plumbing Karachi', 'ur')
ON CONFLICT (phone) WHERE deleted_at IS NULL DO NOTHING;
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u, roles r WHERE u.id IN
  ('10000000-0201-4000-8000-000000000001', '10000000-0202-4000-8000-000000000002', '10000000-0203-4000-8000-000000000003')
  AND r.name = 'provider'
ON CONFLICT DO NOTHING;
INSERT INTO wallet_accounts (user_id) VALUES
  ('10000000-0201-4000-8000-000000000001'),
  ('10000000-0202-4000-8000-000000000002'),
  ('10000000-0203-4000-8000-000000000003')
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO provider_profiles (id, user_id, provider_type, display_name, shop_name, base_point, tier, rating_avg, jobs_completed, completion_rate, response_seconds_avg, is_online) VALUES
  ('20000000-0201-4000-8000-000000000001', '10000000-0201-4000-8000-000000000001', 'SHOP', 'Karachi Cool Air', 'Karachi Cool Air', ST_SetSRID(ST_MakePoint(67.0792, 24.9268), 4326)::geography, 1, 4.6, 41, 0.95, 300, true),
  ('20000000-0202-4000-8000-000000000002', '10000000-0202-4000-8000-000000000002', 'INDIVIDUAL', 'Ustad Rashid Electrician', NULL, ST_SetSRID(ST_MakePoint(67.0356, 24.8138), 4326)::geography, 1, 4.4, 28, 0.94, 360, true),
  ('20000000-0203-4000-8000-000000000003', '10000000-0203-4000-8000-000000000003', 'SHOP', 'Al-Rehman Plumbing Karachi', 'Al-Rehman Plumbing Karachi', ST_SetSRID(ST_MakePoint(67.0099, 24.8615), 4326)::geography, 1, 4.5, 35, 0.95, 300, true)
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO provider_service_areas (provider_id, center, radius_km)
SELECT id, base_point, 5 FROM provider_profiles WHERE id IN
  ('20000000-0201-4000-8000-000000000001', '20000000-0202-4000-8000-000000000002', '20000000-0203-4000-8000-000000000003')
  AND NOT EXISTS (SELECT 1 FROM provider_service_areas a WHERE a.provider_id = provider_profiles.id);
INSERT INTO provider_services (provider_id, category_id, starting_price) VALUES
  ('20000000-0201-4000-8000-000000000001', '00000000-0000-4000-8000-0000b0000002', 2800),
  ('20000000-0202-4000-8000-000000000002', '00000000-0000-4000-8000-0000b0000003', 1400),
  ('20000000-0203-4000-8000-000000000003', '00000000-0000-4000-8000-0000b0000004', 1300)
ON CONFLICT DO NOTHING;
INSERT INTO fair_price_seed (category_id, city_id, min_price, typical_price, max_price, sample_size) VALUES
  ('00000000-0000-4000-8000-0000b0000002', '00000000-0000-4000-8000-0000aaaa0002', 1800, 3000, 5200, 12),
  ('00000000-0000-4000-8000-0000b0000003', '00000000-0000-4000-8000-0000aaaa0002', 900, 1600, 3200, 9),
  ('00000000-0000-4000-8000-0000b0000004', '00000000-0000-4000-8000-0000aaaa0002', 800, 1400, 2800, 8)
ON CONFLICT (category_id, city_id) DO NOTHING;
