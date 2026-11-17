-- 0021_fix_seed_uuids.sql — Fix A: seeded category/city ids were
-- version-0 UUIDs (the old book-binding seed id was version-0), which
-- class-validator's @IsUUID() rejects, so POST /requests (and every other
-- endpoint taking a category_id) 422'd on ids copied from GET /categories.
-- This migration rewrites all 35 seeded ids (33 categories + 2 cities) to
-- RFC-4122 v4 UUIDs (same suffix, version nibble 4, variant 8) and rewrites
-- every reference to them, in one transaction:
--   * every FK to categories(id)/cities(id) is dropped, then re-added with
--     its ORIGINAL definition (pg_get_constraintdef) after the rewrite, so
--     no constraint is left loosened or changed;
--   * every uuid column in the public schema is swept against the mapping,
--     which covers FK references AND non-FK uuid columns that store a
--     category/city id (e.g. search click target_id, analytics dims).
-- The seed files (0004, 0006, 0018) were fixed to emit the v4 ids directly,
-- so a FRESH database never contains the old ids; on such a database this
-- migration matches zero rows and is a no-op (idempotent). Re-running it
-- manually is safe for the same reason. It asserts at the end that no old
-- id remains in any uuid column and that every rewritten row still exists
-- under its new id; the re-added FKs additionally prove zero orphans
-- (Postgres refuses to re-add an FK with orphan rows).
-- NOTE for db/check-uuids.js: the old ids below are the mapping's source
-- data — the ONLY sanctioned non-v4 literals left in db/*.sql. Each such
-- line carries the `-- fix-a:legacy-id` marker, which check-uuids.js
-- exempts line-by-line; any non-v4 literal anywhere else still fails CI.
BEGIN;

CREATE TEMP TABLE _fixa_uuid_map (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO _fixa_uuid_map (old_id, new_id) VALUES
('00000000-0000-0000-0000-0000aaaa0001'::uuid, '00000000-0000-4000-8000-0000aaaa0001'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000aaaa0002'::uuid, '00000000-0000-4000-8000-0000aaaa0002'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b0000001'::uuid, '00000000-0000-4000-8000-0000b0000001'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b0000002'::uuid, '00000000-0000-4000-8000-0000b0000002'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b0000003'::uuid, '00000000-0000-4000-8000-0000b0000003'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b0000004'::uuid, '00000000-0000-4000-8000-0000b0000004'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b0000005'::uuid, '00000000-0000-4000-8000-0000b0000005'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b0000006'::uuid, '00000000-0000-4000-8000-0000b0000006'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b0000007'::uuid, '00000000-0000-4000-8000-0000b0000007'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b0000008'::uuid, '00000000-0000-4000-8000-0000b0000008'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b0000009'::uuid, '00000000-0000-4000-8000-0000b0000009'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b000000a'::uuid, '00000000-0000-4000-8000-0000b000000a'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b000000b'::uuid, '00000000-0000-4000-8000-0000b000000b'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b000000c'::uuid, '00000000-0000-4000-8000-0000b000000c'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000b000000d'::uuid, '00000000-0000-4000-8000-0000b000000d'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000001'::uuid, '00000000-0000-4000-8000-0000c0000001'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000002'::uuid, '00000000-0000-4000-8000-0000c0000002'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000003'::uuid, '00000000-0000-4000-8000-0000c0000003'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000004'::uuid, '00000000-0000-4000-8000-0000c0000004'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000005'::uuid, '00000000-0000-4000-8000-0000c0000005'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000006'::uuid, '00000000-0000-4000-8000-0000c0000006'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000007'::uuid, '00000000-0000-4000-8000-0000c0000007'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000008'::uuid, '00000000-0000-4000-8000-0000c0000008'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000009'::uuid, '00000000-0000-4000-8000-0000c0000009'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c000000a'::uuid, '00000000-0000-4000-8000-0000c000000a'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c000000b'::uuid, '00000000-0000-4000-8000-0000c000000b'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c000000c'::uuid, '00000000-0000-4000-8000-0000c000000c'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c000000d'::uuid, '00000000-0000-4000-8000-0000c000000d'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c000000e'::uuid, '00000000-0000-4000-8000-0000c000000e'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c000000f'::uuid, '00000000-0000-4000-8000-0000c000000f'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000010'::uuid, '00000000-0000-4000-8000-0000c0000010'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000011'::uuid, '00000000-0000-4000-8000-0000c0000011'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000012'::uuid, '00000000-0000-4000-8000-0000c0000012'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000013'::uuid, '00000000-0000-4000-8000-0000c0000013'::uuid), -- fix-a:legacy-id
  ('00000000-0000-0000-0000-0000c0000014'::uuid, '00000000-0000-4000-8000-0000c0000014'::uuid); -- fix-a:legacy-id

-- Which old ids actually exist, and in which home table (for the final assert).
CREATE TEMP TABLE _fixa_seen (old_id uuid PRIMARY KEY, new_id uuid NOT NULL, home_table text NOT NULL) ON COMMIT DROP;
INSERT INTO _fixa_seen (old_id, new_id, home_table)
SELECT m.old_id, m.new_id, 'categories' FROM _fixa_uuid_map m JOIN categories c ON c.id = m.old_id
UNION ALL
SELECT m.old_id, m.new_id, 'cities' FROM _fixa_uuid_map m JOIN cities c ON c.id = m.old_id;

-- FK definitions dropped for the rewrite (re-added verbatim afterwards).
CREATE TEMP TABLE _fixa_dropped_fks (tbl text NOT NULL, conname text NOT NULL, condef text NOT NULL) ON COMMIT DROP;

DO $$
DECLARE
  r record;
  n int;
BEGIN
  PERFORM set_config('search_path', 'public', true);

  -- 1. Record + drop every FK that references categories(id)/cities(id).
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname, pg_get_constraintdef(c.oid) AS condef
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid IN ('public.categories'::regclass, 'public.cities'::regclass)
  LOOP
    INSERT INTO _fixa_dropped_fks (tbl, conname, condef) VALUES (r.tbl, r.conname, r.condef);
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
  RAISE NOTICE 'fix-a: dropped % FK constraint(s) referencing categories/cities', (SELECT count(*) FROM _fixa_dropped_fks);

  -- 2. Sweep every uuid column of every base table in public against the map.
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.data_type = 'uuid'
    ORDER BY c.table_name, c.column_name
  LOOP
    EXECUTE format(
      'UPDATE %I SET %I = m.new_id FROM _fixa_uuid_map m WHERE %I = m.old_id',
      r.table_name, r.column_name, r.column_name);
  END LOOP;

  -- 3. Re-add the FKs with their ORIGINAL definitions (zero orphans: this
  -- fails if any referencing row was left pointing at a rewritten-away id).
  FOR r IN SELECT tbl, conname, condef FROM _fixa_dropped_fks LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.conname, r.condef);
  END LOOP;

  -- 4. Assertions: no old id anywhere in any uuid column; every seen old id
  -- still exists under its new id in its home table; home tables are v4-only.
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.data_type = 'uuid'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I IN (SELECT old_id FROM _fixa_uuid_map)',
                   r.table_name, r.column_name) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'fix-a: % old id(s) remain in %.%', n, r.table_name, r.column_name;
    END IF;
  END LOOP;

  SELECT count(*) INTO n FROM _fixa_seen s
  WHERE NOT EXISTS (
    SELECT 1 FROM categories c WHERE s.home_table = 'categories' AND c.id = s.new_id
    UNION ALL
    SELECT 1 FROM cities c WHERE s.home_table = 'cities' AND c.id = s.new_id);
  IF n > 0 THEN
    RAISE EXCEPTION 'fix-a: % rewritten row(s) missing under their new id', n;
  END IF;

  SELECT count(*) INTO n FROM categories
  WHERE id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  IF n > 0 THEN RAISE EXCEPTION 'fix-a: % non-v4 id(s) remain in categories', n; END IF;
  SELECT count(*) INTO n FROM cities
  WHERE id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  IF n > 0 THEN RAISE EXCEPTION 'fix-a: % non-v4 id(s) remain in cities', n; END IF;

  RAISE NOTICE 'fix-a: rewrote % seeded row(s) to v4 UUIDs', (SELECT count(*) FROM _fixa_seen);
END $$;

COMMIT;
