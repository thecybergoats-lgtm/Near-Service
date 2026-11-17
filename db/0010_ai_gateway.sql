-- Near Service — 0010_ai_gateway.sql (Phase 3, AI Gateway + chat translation)
-- Additive only. All tables IF NOT EXISTS so the migration is safe to
-- re-run. No existing table is altered.
BEGIN;

-- Intent-parse log (redacted input text only — never raw PII; the
-- service redacts before insert and logs best-effort).
CREATE TABLE IF NOT EXISTS ai_intent_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  input_text text NOT NULL,
  category_id uuid REFERENCES categories(id),
  confidence numeric(4,3) NOT NULL DEFAULT 0,
  fell_back_to_search boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_ai_intent_created ON ai_intent_logs (created_at DESC);

-- Learned fair-price snapshots: one row per estimate call, for audit
-- and for tracking how the model behaves over time.
CREATE TABLE IF NOT EXISTS fair_price_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id),
  city_id uuid REFERENCES cities(id),
  quantity int,
  source varchar(12) NOT NULL CHECK (source IN ('model', 'percentile')),
  min_price numeric(12,2) NOT NULL,
  typical_price numeric(12,2) NOT NULL,
  max_price numeric(12,2) NOT NULL,
  sample_size int NOT NULL DEFAULT 0,
  r_squared numeric(5,3),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_fair_snap_cat ON fair_price_snapshots (category_id, created_at DESC);

-- Per-user, per-chat auto-translation preference (Phase 3 item 9).
CREATE TABLE IF NOT EXISTS chat_translation_prefs (
  chat_id uuid NOT NULL REFERENCES chats(id),
  user_id uuid NOT NULL REFERENCES users(id),
  target_lang varchar(5) CHECK (target_lang IN ('ur', 'en')),
  auto_translate boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id));

-- Stored translations. messages.body is NEVER overwritten — the
-- original text is always preserved and shown alongside the translation.
CREATE TABLE IF NOT EXISTS message_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id),
  target_lang varchar(5) NOT NULL CHECK (target_lang IN ('ur', 'en')),
  translated_text text NOT NULL,
  provider varchar(24) NOT NULL DEFAULT 'local',
  translated_by_provider boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, target_lang));
CREATE INDEX IF NOT EXISTS idx_msg_trans_msg ON message_translations (message_id);

COMMIT;
