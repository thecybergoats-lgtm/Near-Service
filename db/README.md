# Near Service — Database (PRD v1.1)

PostgreSQL 15 + PostGIS + pg_trgm. Migrations are numbered SQL files, applied in order.

| File | Contents |
|---|---|
| `0001_init.sql` | Extensions, users/devices/roles/user_roles (v1.1 surrogate PK + two partial unique indexes), refresh-token families, provider profiles/documents/tiers/service areas/availability, categories/keywords/form schemas, provider services, addresses, fair-price seed |
| `0002_requests_jobs.sql` | service_requests, request_media, offers, jobs, job_events, job_price_adjustments, chats, messages, calls, reviews |
| `0003_money_trust.sql` | wallet_accounts (exactly one per user, v1.1), ledger_entries, payments, payouts, commission_rules, promos, referrals, disputes, reports/blocks, notifications, campaigns, fraud_signals, risk_scores, cities, zones, waitlist, audit_logs, feature_flags |
| `0004_seed.sql` | Quetta (launched), 13-category taxonomy (3 levels for the 5 launch categories), Roman Urdu/Urdu keyword aliases, form schemas, roles, tiers 0–3, 10% commission rule, 12 Quetta providers, 3 demo users, sample requests/offers/jobs, fair-price seed data |
| `0005_phase2_payments.sql` | Promo scope/abuse columns, FIRSTJOB10 seed, commission block-threshold flag |
| `0006_phase2_ops.sql` | recurring_jobs, provider_locations, trusted_contacts, waitlist cells, form-schema re-assert |
| `0007_revoke_refresh_families.sql` | Stage 1 FIX 2: revokes all pre-existing refresh-token families (bcrypt hashes cannot be migrated to SHA-256); pre-launch, users just log in again |
| `0008_ledger_balance_guard.sql` | Stage 2 FIX 8: ledger_entries append-only (UPDATE/DELETE rejected) + DEFERRABLE INITIALLY DEFERRED constraint trigger checking SUM(D)=SUM(C) per txn_id at COMMIT; reconciliation_reports run log for the nightly job (POST /admin/reconciliation/run) |
| `0009_stage3_fixes.sql` | Stage 3 fixes (incl. FIX 14b: refunds write a `payments` row with status `refunded` / `partially_refunded` — the old varchar(14) was widened) |
| `0010_ai_gateway.sql` | Phase 3 AI Gateway: `ai_intent_logs`, `fair_price_snapshots`, `chat_translation_prefs`, `message_translations` |
| `0011_risk_engine.sql` | Phase 3 risk engine: `risk_scores` (adds columns), `risk_events`, `risk_settings` (seeded thresholds) |
| `0012_subscriptions_teams.sql` | Phase 3 subscriptions + teams: `subscription_plans` (seeded free / pro / business), `subscriptions`, `teams`, `team_members`, `team_job_assignments` |
| `0013_tenders.sql` | Phase 3 B2B tenders: `tenders`, `tender_quotes`, `tender_audit` |
| `0014_verification.sql` | Phase 3 verification: `face_match_results`, `liveness_challenges`, `ocr_extractions` |
| `0015_escrow_payouts.sql` | Phase 3 escrow + payouts: `escrow_holds`, `payouts` (adds amount/fee/tax/net/kind/method columns, `escrow_hold_id`, `job_id`), escrow config seeded in `feature_flags` (auto-release 48h, min PKR 5,000) |
| `0016_search_scaleout.sql` | Phase 4 search scale-out: full-text vectors on categories / `category_keywords`, raw search events + daily rollup tables, gate config seed |
| `0017_analytics_warehouse.sql` | Phase 4 analytics warehouse: `analytics_*` warehouse facts + `analytics_etl_runs` (status, counts, reconciliation) |
| `0018_multi_city.sql` | Phase 4 multi-city ops: `cities` lifecycle + gate tables, per-city category overrides + commission rules, Karachi seed (3 providers; Quetta `live`, Karachi `in_preparation`, gate FAILs — 3 vs 10 needed) |
| `0019_warranty.sql` | Phase 4 warranty product: `job_warranties`, `warranty_claims`, `warranty_config` (+ two columns on `jobs`) |
| `0020_partners.sql` | Phase 4 partner integrations: `partners`, `partner_catalog_items`, `partner_orders`, `partner_order_items`, affiliate fee ledger wiring |
| `0021_fix_seed_uuids.sql` | Fix A: rewrites the 35 seeded version-0 category/city ids (0004/0018) to RFC-4122 v4 UUIDs and every reference to them (FKs dropped + re-added with original definitions, all uuid columns swept); idempotent no-op on a fresh DB, which seeds the v4 ids directly |
| `0022_fix_rated_state.sql` | Fix B: `review_window_days` flag (default 7 days) + partial index for the review-window closing sweep; see docs/phase4-api-addendum.md §10 |


**Timeline (v1.1): 16–20 weeks to the Quetta pilot for 1 Flutter + 1 backend dev**
(13–15 weeks to feature-complete, plus 3–5 weeks of pilot hardening).

## Run (machine with Docker / Postgres)
```bash
# with the NestJS runner (from backend/):
DATABASE_URL=postgres://nearservice:nearservice@localhost:5432/nearservice npm run migrate
DATABASE_URL=postgres://nearservice:nearservice@localhost:5432/nearservice npm run seed

# or plain psql:
psql "$DATABASE_URL" -f 0001_init.sql
psql "$DATABASE_URL" -f 0002_requests_jobs.sql
psql "$DATABASE_URL" -f 0003_money_trust.sql
psql "$DATABASE_URL" -f 0004_seed.sql
```
The runner records applied files in `schema_migrations` and skips them on re-run.
`0004_seed.sql` is idempotent (ON CONFLICT guards).

## UUID guard (Stage 1, FIX 1; v4 since Fix A)
`node db/check-uuids.js` scans every `db/*.sql` file, every `backend/test`
fixture/spec and every `backend/src` file for UUID-looking literals and
fails if any is not a strict RFC-4122 version-4 UUID (version nibble 4,
variant 8/9/a/b). Run it before committing SQL
(`npm run check:uuids` from `backend/`) — CI runs it on every push, and the
CI `migrate` job applies all migrations to a fresh Postgres 16 + PostGIS 3
database and asserts 15 provider_profiles (12 Quetta + 3 Karachi from
0018) and 33 categories. The only exemption is the old→new mapping in
`0021_fix_seed_uuids.sql`, whose lines carry the `-- fix-a:legacy-id`
marker; any non-v4 literal anywhere else fails.

## Demo accounts (OTP dev mode — no passwords)
- Customer: `+923001234567` (Ahmed Khan)
- Provider: `+923007654321` (Bilal Ahmed)
- Admin (super_admin): `+923001111111`

## v1.1 rules enforced here
- `users.phone` has **no inline UNIQUE constraint** — uniqueness is the partial
  index `uq_users_phone_live ON users(phone) WHERE deleted_at IS NULL`, so a
  soft-deleted number can be re-registered.
- `user_roles` has a surrogate PK (`id BIGINT GENERATED ALWAYS AS IDENTITY`)
  plus two partial unique indexes (`uq_user_roles_global` where `city_id IS
  NULL`, `uq_user_roles_city` where `city_id IS NOT NULL`). No nullable column
  is in any PK.
- `cnic_hmac` is HMAC-SHA256 keyed with `CNIC_PEPPER` from the secrets manager
  (never a plain hash, never logged, never stored in the DB).
- Phase 1 verification is **MANUAL review only**: `provider_documents` keeps two
  reserved columns that stay NULL in Phase 1 — OCR assist arrives in Phase 2,
  face-match + liveness in Phase 3. Nothing in Phase 1 populates them.
- Exactly **one wallet per user**: `wallet_accounts.user_id` is UNIQUE.
  Customer/provider are profile-level views over that one wallet.

## Notes
- Migrations 0001–0020 were all applied in sequence to a fresh Postgres 16
  + PostGIS 3 database by the Phase 4 integrator (2026-11-17, `npm run
  migrate`, exit 0) — `schema_migrations` count 20, 15 provider_profiles
  (12 Quetta + 3 Karachi), Phase 4 tables present. The older "not executed
  in this VM" note no longer applies; Postgres 16 + PostGIS 3 + Redis are
  installed and running in this VM. **Note:** the CI `migrate` job's seed
  assertion was updated 12 → 15 providers when 0018 added the Karachi
  seed; if a future migration adds providers, update
  `.github/workflows/ci.yml` to match.
