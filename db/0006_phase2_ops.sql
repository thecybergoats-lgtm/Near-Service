-- Near Service — 0006_phase2_ops.sql (Phase 2: dispute centre, scheduling, live tracking)
-- Additive only. Depends on 0001-0003 tables; does NOT touch 0005 (payments/wallet module).
BEGIN;

-- Recurring jobs (Phase 2 scheduling). Monthly AC servicing is the canonical example.
-- day_of_week uses Postgres DOW: 0=Sunday .. 6=Saturday (documented in SchedulingService).
-- day_of_month is capped at 28 so the day exists in every month.
CREATE TABLE IF NOT EXISTS recurring_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  specs jsonb NOT NULL DEFAULT '{}',
  fulfillment varchar(16) NOT NULL,
  location geography(Point,4326) NOT NULL,
  address_id uuid REFERENCES addresses(id),
  customer_offer numeric(12,2),
  frequency varchar(10) NOT NULL CHECK (frequency IN ('weekly','monthly')),
  day_of_week smallint CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 28),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  status varchar(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
  last_generated_at timestamptz,
  next_run_at timestamptz NOT NULL,
  skipped_count int NOT NULL DEFAULT 0,
  last_skipped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_jobs (status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_recurring_customer ON recurring_jobs (customer_id, created_at DESC);

-- Live tracking points. Retention rule (see JobsQueryService.getTracking):
-- the trail is only served for the 48h dispute window; older points are
-- evidence, not live state, and must be purged by a nightly job (not in this repo).
CREATE TABLE IF NOT EXISTS provider_locations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  point geography(Point,4326) NOT NULL,
  speed_kmh numeric(6,2),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_provider_loc_job ON provider_locations (job_id, created_at DESC);

-- Trusted contacts for SOS / job-status sharing (max 5 per user, enforced in the service).
CREATE TABLE IF NOT EXISTS trusted_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  phone varchar(20) NOT NULL,
  relation text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_trusted_contacts_user ON trusted_contacts (user_id, created_at);

-- Waitlist geo cells. The contract text says "~500 m cell"; the implementation
-- keys on 0.001 degrees ~ 110 m cells (documented honestly in
-- RequestsService.joinWaitlist). Status column serves the WaitlistEntry shape.
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS cell_lat numeric(8,3);
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS cell_lng numeric(9,3);
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS status varchar(12) NOT NULL DEFAULT 'waiting';
UPDATE waitlist SET cell_lat = ROUND(ST_Y(point::geometry)::numeric, 3), cell_lng = ROUND(ST_X(point::geometry)::numeric, 3)
  WHERE point IS NOT NULL AND cell_lat IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_waitlist_cell ON waitlist (user_id, category_id, cell_lat, cell_lng);

-- Re-assert the five seeded launch-category forms (first seeded in 0004).
-- Verified real and complete on 2026-11-17: Book Binding (books/size/binding),
-- AC Repair (ac_type/tonnage/issue), Electrician (work/rooms), Plumber
-- (work/urgency), Mobile Repair (brand/model/issue). This upsert completes
-- any of them that is missing or a stub.
INSERT INTO category_form_schemas (category_id, schema) VALUES
 ('00000000-0000-4000-8000-0000b0000001','{"type": "object", "properties": {"books": {"type": "integer", "title": "Number of books"}, "size": {"type": "string", "enum": ["A4", "A5", "Legal"], "title": "Size"}, "binding": {"type": "string", "enum": ["hard", "soft", "spiral"], "title": "Binding type"}}, "required": ["books", "binding"]}'::jsonb),
 ('00000000-0000-4000-8000-0000b0000002','{"type": "object", "properties": {"ac_type": {"type": "string", "enum": ["split", "window", "inverter"], "title": "AC type"}, "tonnage": {"type": "number", "enum": [1, 1.5, 2], "title": "Tonnage"}, "issue": {"type": "string", "enum": ["no_cooling", "gas_leak", "noise", "not_starting", "service"], "title": "Issue"}}, "required": ["ac_type", "issue"]}'::jsonb),
 ('00000000-0000-4000-8000-0000b0000003','{"type": "object", "properties": {"work": {"type": "string", "enum": ["wiring", "fan", "switch_board", "ups", "other"], "title": "Work type"}, "rooms": {"type": "integer", "title": "Rooms affected"}}, "required": ["work"]}'::jsonb),
 ('00000000-0000-4000-8000-0000b0000004','{"type": "object", "properties": {"work": {"type": "string", "enum": ["leakage", "tap", "motor", "drainage", "fitting"], "title": "Work type"}, "urgency": {"type": "string", "enum": ["now", "today", "scheduled"], "title": "Urgency"}}, "required": ["work"]}'::jsonb),
 ('00000000-0000-4000-8000-0000b0000005','{"type": "object", "properties": {"brand": {"type": "string", "title": "Phone brand"}, "model": {"type": "string", "title": "Model"}, "issue": {"type": "string", "enum": ["screen", "battery", "software", "charging_port", "water_damage"], "title": "Issue"}}, "required": ["brand", "issue"]}'::jsonb)
 ON CONFLICT (category_id) DO UPDATE SET schema=EXCLUDED.schema, updated_at=now();

COMMIT;
