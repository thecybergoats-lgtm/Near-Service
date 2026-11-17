-- Near Service — 0008_ledger_balance_guard.sql (Stage 2, FIX 8)
-- Database-level guarantee for the double-entry ledger (PRD p.18):
--   (a) ledger_entries is append-only (UPDATE/DELETE rejected);
--   (b) for every txn_id, SUM(debits) = SUM(credits), checked at COMMIT.
-- The check is a DEFERRABLE INITIALLY DEFERRED constraint trigger so a
-- transaction may insert the D leg and the C leg in separate statements
-- (as the app does) and is only judged once, at COMMIT. A row-level
-- trigger collects the txn_ids touched in this transaction into a
-- per-transaction temp table (ON COMMIT DELETE ROWS); the deferred
-- trigger then checks ONLY those txn_ids (a transaction may touch many),
-- summing over ALL legs of each txn_id (not just the new ones), so a
-- later unbalanced leg on an old txn_id is caught too.
-- Additive only: no earlier migration is touched, no existing rows change.

-- ---- (a) Append-only ----------------------------------------------------
CREATE OR REPLACE FUNCTION fn_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_append_only();

-- ---- (b) Per-txn balance at COMMIT --------------------------------------
CREATE OR REPLACE FUNCTION fn_ledger_track_txn() RETURNS trigger AS $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _ledger_txn_touched (
    txn_id uuid PRIMARY KEY
  ) ON COMMIT DELETE ROWS;
  INSERT INTO _ledger_txn_touched (txn_id) VALUES (NEW.txn_id)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_track_txn
  AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_track_txn();

CREATE OR REPLACE FUNCTION fn_ledger_check_balanced() RETURNS trigger AS $$
DECLARE
  bad_txn uuid;
  bad_diff bigint;
BEGIN
  -- No inserts in this transaction (or temp table gone): nothing to check.
  IF to_regclass('pg_temp._ledger_txn_touched') IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT t.txn_id,
         SUM(CASE WHEN le.direction = 'D' THEN le.amount_paisa ELSE -le.amount_paisa END)
    INTO bad_txn, bad_diff
    FROM _ledger_txn_touched t
    JOIN ledger_entries le ON le.txn_id = t.txn_id
   GROUP BY t.txn_id
  HAVING SUM(CASE WHEN le.direction = 'D' THEN le.amount_paisa ELSE -le.amount_paisa END) <> 0
   LIMIT 1;
  IF bad_txn IS NOT NULL THEN
    RAISE EXCEPTION 'ledger_entries unbalanced for txn_id %: sum(debits) - sum(credits) = % paisa',
      bad_txn, bad_diff;
  END IF;
  -- The trigger fires once per inserted row at COMMIT (constraint
  -- triggers are row-level only); the first firing checks every txn_id
  -- touched in this transaction, so clear the staging list to make the
  -- remaining firings no-ops.
  DELETE FROM _ledger_txn_touched;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_ledger_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_check_balanced();

-- ---- Reconciliation run log (FIX 8b) ------------------------------------
-- One row per run of the reconciliation job (manual or nightly). The
-- latest row is what GET /admin/reconciliation returns; mismatches is
-- the full detail (txn + wallet mismatches) so an admin can act on it.
CREATE TABLE reconciliation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  triggered_by varchar(20) NOT NULL DEFAULT 'manual',
  txn_checked int NOT NULL,
  txn_mismatches int NOT NULL,
  wallet_checked int NOT NULL,
  wallet_mismatches int NOT NULL,
  mismatches jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(12) NOT NULL CHECK (status IN ('clean', 'mismatch')),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_recon_reports_run ON reconciliation_reports (run_at DESC);
