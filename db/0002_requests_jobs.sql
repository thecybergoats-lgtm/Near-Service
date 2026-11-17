-- Near Service — 0002_requests_jobs.sql (PRD pp.17-18)
CREATE TABLE service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  description text, specs jsonb NOT NULL DEFAULT '{}',
  fulfillment varchar(16) NOT NULL,
  location geography(Point,4326) NOT NULL,
  address_id uuid REFERENCES addresses(id),
  scheduled_at timestamptz,
  customer_offer numeric(12,2),
  fair_min numeric(12,2), fair_typical numeric(12,2), fair_max numeric(12,2),
  status varchar(24) NOT NULL DEFAULT 'DRAFT',
  wave smallint NOT NULL DEFAULT 0, radius_km numeric(5,2) NOT NULL DEFAULT 3,
  expires_at timestamptz, idempotency_key varchar(80) UNIQUE,
  is_b2b boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
CREATE INDEX idx_req_geo ON service_requests USING gist (location);
CREATE INDEX idx_req_status ON service_requests (status, expires_at);
CREATE INDEX idx_req_customer ON service_requests (customer_id, created_at DESC);

CREATE TABLE request_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  media_type varchar(10) NOT NULL,
  storage_key text NOT NULL, duration_seconds int,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES service_requests(id),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  offered_by varchar(10) NOT NULL,
  round smallint NOT NULL DEFAULT 1,
  price numeric(12,2) NOT NULL,
  breakdown jsonb,
  eta_minutes int, note text,
  status varchar(14) NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL, idempotency_key varchar(80) UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, provider_id, round, offered_by));
CREATE INDEX idx_offers_request ON offers (request_id, created_at);
CREATE INDEX idx_offers_provider ON offers (provider_id, status);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES service_requests(id),
  offer_id uuid NOT NULL UNIQUE REFERENCES offers(id),
  customer_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  agreed_price numeric(12,2) NOT NULL,
  final_price numeric(12,2),
  commission_rate numeric(5,4) NOT NULL,
  commission_amount numeric(12,2),
  state varchar(28) NOT NULL DEFAULT 'ACCEPTED',
  payment_method varchar(12) NOT NULL DEFAULT 'cash',
  payment_status varchar(14) NOT NULL DEFAULT 'unpaid',
  customer_payment_confirmed_at timestamptz,
  provider_payment_confirmed_at timestamptz,
  started_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_jobs_state ON jobs (state, provider_id);
CREATE INDEX idx_jobs_customer ON jobs (customer_id, created_at DESC);

CREATE TABLE job_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  from_state varchar(28), to_state varchar(28) NOT NULL,
  actor_user_id uuid REFERENCES users(id), actor_role varchar(20),
  point geography(Point,4326), device_fingerprint text,
  payload jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_job_events_job ON job_events (job_id, created_at);

CREATE TABLE job_price_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  items jsonb NOT NULL,
  reason text NOT NULL, added_amount numeric(12,2) NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'pending',
  decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid UNIQUE REFERENCES jobs(id),
  request_id uuid UNIQUE REFERENCES service_requests(id),
  customer_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES chats(id),
  sender_id uuid NOT NULL REFERENCES users(id),
  kind varchar(10) NOT NULL DEFAULT 'text',
  body text, media_key text, is_flagged boolean NOT NULL DEFAULT false,
  read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_msg_chat ON messages (chat_id, created_at);

CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid REFERENCES chats(id), caller_id uuid REFERENCES users(id),
  masked_number text, provider_call_id text,
  started_at timestamptz, ended_at timestamptz, duration_seconds int,
  recording_key text, recording_consent boolean NOT NULL DEFAULT false);

CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  reviewer_id uuid NOT NULL REFERENCES users(id),
  reviewee_id uuid NOT NULL REFERENCES users(id),
  stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags text[], comment text, is_held boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, reviewer_id));
CREATE INDEX idx_reviews_reviewee ON reviews (reviewee_id, created_at DESC);
