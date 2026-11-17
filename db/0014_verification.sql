-- Near Service — 0014_verification.sql (Phase 3, verification items 6–7)
-- ADDITIVE ONLY: three new tables. No Phase 1/2 table or column is
-- dropped, renamed or altered. Run after 0001–0013.
--
-- Tables:
--   face_match_results  — one row per face-match submission (advisory
--     score from the local heuristic; NEVER a biometric verdict).
--   liveness_challenges — one row per liveness challenge issued, with
--     the required action sequence, attempts and outcome.
--   ocr_extractions     — one row per OCR-assist pre-fill for a CNIC
--     document (manual transcription; ocr_confidence stays NULL until a
--     real OCR vendor is wired in — see
--     backend/src/modules/verification/README.md).
-- Verification stays MANUAL: nothing here changes provider_profiles.tier
-- or provider_documents.review_status. Tier changes happen ONLY through
-- AdminService.decideVerification.

CREATE TABLE IF NOT EXISTS face_match_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  selfie_storage_key text,
  cnic_photo_storage_key text,
  selfie_sha256 char(64) NOT NULL,
  cnic_photo_sha256 char(64) NOT NULL,
  face_match_score numeric(4,3) NOT NULL CHECK (face_match_score >= 0 AND face_match_score <= 1),
  verdict varchar(20) NOT NULL CHECK (verdict IN ('likely_match', 'uncertain', 'likely_no_match')),
  duplicate_submission boolean NOT NULL DEFAULT false,
  engine varchar(40) NOT NULL DEFAULT 'local-heuristic',
  is_real_biometric boolean NOT NULL DEFAULT false,
  officer_decision varchar(20) CHECK (officer_decision IS NULL OR officer_decision IN ('accept_as_match', 'reject_as_no_match')),
  officer_note text,
  reviewed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_face_match_provider ON face_match_results (provider_id, created_at DESC);

CREATE TABLE IF NOT EXISTS liveness_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  actions jsonb NOT NULL,
  observed_actions jsonb,
  status varchar(12) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'passed', 'failed', 'expired')),
  attempts_used int NOT NULL DEFAULT 0 CHECK (attempts_used >= 0),
  attempts_allowed int NOT NULL DEFAULT 3 CHECK (attempts_allowed > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_liveness_provider ON liveness_challenges (provider_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ocr_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES provider_documents(id),
  provider_id uuid NOT NULL REFERENCES provider_profiles(id),
  side varchar(6) NOT NULL CHECK (side IN ('front', 'back')),
  engine varchar(40) NOT NULL DEFAULT 'local-manual-assist',
  extracted_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  corrected_fields jsonb,
  missing_fields text[] NOT NULL DEFAULT '{}',
  enhancement_suggestions text[] NOT NULL DEFAULT '{}',
  -- NULL locally: no OCR engine ran, so no OCR confidence exists. A real
  -- vendor fills this with its per-document confidence (0..1).
  ocr_confidence numeric(4,3) CHECK (ocr_confidence IS NULL OR (ocr_confidence >= 0 AND ocr_confidence <= 1)),
  status varchar(20) NOT NULL DEFAULT 'needs_officer_review'
    CHECK (status IN ('needs_officer_review', 'confirmed', 'corrected', 'rejected')),
  reviewed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ocr_provider ON ocr_extractions (provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ocr_document ON ocr_extractions (document_id, created_at DESC);
