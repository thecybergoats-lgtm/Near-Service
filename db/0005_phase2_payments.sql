-- Near Service — 0005_phase2_payments.sql (Phase 2: wallet top-ups,
-- promos/referrals, commission engine)
-- ADDITIVE ONLY: no Phase 1 table/column is dropped or renamed. The single
-- relaxation is payments.job_id becoming nullable so gateway top-ups
-- (which have no job) can be recorded as payments rows with method='gateway'.
-- Run after 0001–0004. NOT verified against a live DB in this workspace
-- (no Docker/Postgres here) — run `npm run migrate` on a machine with one.

-- 1. Promos: scope + abuse-limit columns (0003 created promos without them).
ALTER TABLE promos ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES categories(id);
ALTER TABLE promos ADD COLUMN IF NOT EXISTS city_id uuid REFERENCES cities(id);
ALTER TABLE promos ADD COLUMN IF NOT EXISTS per_device_limit int NOT NULL DEFAULT 1;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS first_job_only boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_device ON promo_redemptions (promo_id, device_fingerprint);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions (promo_id, user_id);

-- 2. Gateway top-ups are payments rows with no job.
ALTER TABLE payments ALTER COLUMN job_id DROP NOT NULL;

-- 3. Commission engine: scope index for the resolver query.
CREATE INDEX IF NOT EXISTS idx_commission_rules_scope ON commission_rules (category_id, city_id, tier);

-- 4. Commission block threshold (default -PKR 5,000 = -500000 paisa).
--    A provider whose wallet falls below this cannot create new offers
--    until they top up. Admins change it by updating this flag's config.
INSERT INTO feature_flags (key, enabled, config)
VALUES ('commission_block_threshold_paisa', true, '{"value_paisa": -500000}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 5. First-job discount: 10% off, first job only, max 1 per user.
INSERT INTO promos (code, kind, value, max_uses, per_user_limit, per_device_limit,
                    valid_from, valid_to, is_active, first_job_only)
VALUES ('FIRSTJOB10', 'percent', 10, NULL, 1, 1, now(), NULL, true, true)
ON CONFLICT (code) DO NOTHING;

-- 6. Ledger lookup index for wallet transaction history.
CREATE INDEX IF NOT EXISTS idx_ledger_wallet_created ON ledger_entries (wallet_id, id DESC);
