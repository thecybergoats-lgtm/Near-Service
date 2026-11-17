-- Near Service — 0013_tenders.sql (Phase 3, item 5: B2B tenders)
--
-- Schools / offices / shops post bulk jobs (e.g. bind 500 books) in tender
-- mode: providers submit formal ITEMIZED quotes, exactly one quote is
-- accepted, and every step is written to a full audit trail.
--
-- Lead-fee choice (documented): a FLAT lead fee of PKR 500 (50,000 paisa)
-- is debited from the WINNING provider's wallet at acceptance, as a
-- balanced double-entry ledger pair (D wallet / C tender_lead_fee_rev,
-- same txn_id, same job) in the same transaction that creates the job.
-- Losers pay nothing. The normal commission engine still applies to the
-- job itself (commission_rate resolved at acceptance, as for offers).
-- No higher commission rate is used on tender jobs.
--
-- Reuse, not duplication: accepting a tender quote materialises a normal
-- `offers` row (status 'accepted', breakdown = the itemized quote) and a
-- normal `jobs` row in state ACCEPTED, so the job then flows through the
-- existing job state machine, payment settlement, reviews and chats
-- unchanged. jobs.tender_id (nullable, additive) links the job back.
--
-- Exactly-one-accepted is enforced at THREE layers:
--   1. partial unique index uq_tender_quotes_one_accepted
--      (one 'accepted' quote per tender, DB level),
--   2. tenders.accepted_quote_id / job_id set once inside the accept
--      transaction (SELECT ... FOR UPDATE on tender + quote),
--   3. the shared AtomicOfferAcceptor serialiser (offers module) in the
--      service, so concurrent accepts can never create two jobs.
-- Additive only: three new tables, one nullable column on jobs.

CREATE TABLE tenders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES service_requests(id),
  customer_id uuid NOT NULL REFERENCES users(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  organization_name varchar(200) NOT NULL,
  organization_type varchar(16) NOT NULL CHECK (organization_type IN ('SCHOOL', 'OFFICE', 'SHOP', 'OTHER')),
  title varchar(200) NOT NULL,
  description text,
  delivery_deadline timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'QUOTES_RECEIVED', 'AWARDED', 'CANCELLED', 'EXPIRED')),
  accepted_quote_id uuid,
  job_id uuid REFERENCES jobs(id),
  lead_fee_paisa bigint NOT NULL DEFAULT 50000 CHECK (lead_fee_paisa >= 0),
  lead_fee_charged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX idx_tenders_customer ON tenders (customer_id, created_at DESC);
CREATE INDEX idx_tenders_open ON tenders (status, delivery_deadline) WHERE status IN ('OPEN', 'QUOTES_RECEIVED');
CREATE INDEX idx_tenders_category ON tenders (category_id, created_at DESC);

CREATE TABLE tender_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES tenders(id),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  -- Itemized formal quote: [{label, quantity, unit_price, line_total}].
  -- line_total must equal quantity * unit_price and the sum of line_totals
  -- must equal total_price (enforced by the service; see tender-math.ts).
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0),
  total_price numeric(12,2) NOT NULL CHECK (total_price > 0),
  eta_days int CHECK (eta_days IS NULL OR eta_days BETWEEN 1 AND 365),
  note text,
  validity_days int CHECK (validity_days IS NULL OR validity_days BETWEEN 1 AND 90),
  status varchar(12) NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'withdrawn', 'accepted', 'rejected', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tender_quotes_tender ON tender_quotes (tender_id, created_at);
CREATE INDEX idx_tender_quotes_provider ON tender_quotes (provider_id, status);
-- One live (submitted) quote per provider per tender: a provider may
-- withdraw and re-quote, but never hold two live quotes on one tender.
CREATE UNIQUE INDEX uq_tender_quotes_one_live ON tender_quotes (tender_id, provider_id) WHERE status = 'submitted';
-- Exactly one accepted quote per tender (DB-level backstop).
CREATE UNIQUE INDEX uq_tender_quotes_one_accepted ON tender_quotes (tender_id) WHERE status = 'accepted';

CREATE TABLE tender_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES tenders(id),
  quote_id uuid REFERENCES tender_quotes(id),
  actor_user_id uuid REFERENCES users(id),
  actor_role varchar(20),
  action varchar(32) NOT NULL CHECK (action IN (
    'TENDER_CREATED', 'QUOTE_SUBMITTED', 'QUOTE_WITHDRAWN', 'QUOTE_ACCEPTED',
    'QUOTE_REJECTED', 'TENDER_CANCELLED', 'TENDER_EXPIRED',
    'LEAD_FEE_CHARGED', 'JOB_CREATED'
  )),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tender_audit_tender ON tender_audit (tender_id, created_at, id);

-- Circular reference (tenders.accepted_quote_id -> tender_quotes.id) is
-- added after both tables exist.
ALTER TABLE tenders ADD CONSTRAINT fk_tenders_accepted_quote
  FOREIGN KEY (accepted_quote_id) REFERENCES tender_quotes(id);

-- Link the materialised job back to its tender (nullable: normal jobs
-- created from offers have no tender).
ALTER TABLE jobs ADD COLUMN tender_id uuid REFERENCES tenders(id);
CREATE INDEX idx_jobs_tender ON jobs (tender_id) WHERE tender_id IS NOT NULL;
