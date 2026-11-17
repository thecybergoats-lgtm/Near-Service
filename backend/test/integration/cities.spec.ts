// Multi-city ops — integration tests (Phase 4, item 3).
// REAL Postgres 16 + PostGIS 3. Run with:
//   DATABASE_URL=postgresql://root@/nearservice_p4_cities?host=/var/run/postgresql
//   NODE_ENV=test npx jest --config test/jest.config.js --runInBand test/integration/cities.spec.ts
// (No Redis needed: this module never touches Redis.)
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0015 + 0018. Only ever point it at the
// dedicated test DB nearservice_p4_cities.
// Skipped entirely when DATABASE_URL is not set.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { Client } from 'pg';
import request from 'supertest';
import { CitiesModule } from '../../src/modules/cities/cities.module';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { createValidationPipe } from '../../src/common/validation/validation-pipe';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { env } from '../../src/config/env';

jest.setTimeout(60000);

const hasDb = !!process.env.DATABASE_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
const QUETTA_ID = '00000000-0000-4000-8000-0000aaaa0001';
const KARACHI_ID = '00000000-0000-4000-8000-0000aaaa0002';
const AC_REPAIR_ID = '00000000-0000-4000-8000-0000b0000002';
const BOOK_BINDING_ID = '00000000-0000-4000-8000-0000b0000001';
const QUETTA_COOL_AIR_ID = '20000000-0104-4000-8000-000000000004';
const QUETTA_COOL_AIR_USER = '10000000-0104-4000-8000-000000000004';
const CUSTOMER_ID = '10000000-0001-4000-8000-000000000001'; // Ahmed Khan (seed)

const MIGRATIONS = [
  '0001_init.sql', '0002_requests_jobs.sql', '0003_money_trust.sql',
  '0004_seed.sql', '0005_phase2_payments.sql', '0006_phase2_ops.sql',
  '0007_revoke_refresh_families.sql', '0008_ledger_balance_guard.sql',
  '0009_stage3_fixes.sql', '0010_ai_gateway.sql', '0011_risk_engine.sql',
  '0012_subscriptions_teams.sql', '0013_tenders.sql', '0014_verification.sql',
  '0015_escrow_payouts.sql', '0018_multi_city.sql',
];

maybeDescribe('multi-city ops (real DB)', () => {
  let app: INestApplication;
  let admin: Client;
  let superAdminId: string;
  let quettaManagerId: string;
  let karachiManagerId: string;
  let unassignedManagerId: string;

  const tokenFor = (userId: string, roles: string[]) =>
    jwt.sign({ sub: userId, phone: `+92301${RUN}`, roles }, env.jwtAccessSecret, { expiresIn: 600 });
  const superToken = () => tokenFor(superAdminId, ['super_admin']);
  const quettaToken = () => tokenFor(quettaManagerId, ['city_manager']);
  const karachiToken = () => tokenFor(karachiManagerId, ['city_manager']);
  const api = () => request(app.getHttpServer());

  async function makeUser(phone: string): Promise<string> {
    return (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Cities Test','ur') RETURNING id`,
      [phone],
    )).rows[0].id as string;
  }
  async function grantRole(userId: string, roleName: string, cityId: string | null = null): Promise<void> {
    const role = (await admin.query(`SELECT id FROM roles WHERE name=$1`, [roleName])).rows[0];
    await admin.query(
      `INSERT INTO user_roles (user_id, role_id, city_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, role.id, cityId],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    for (const file of MIGRATIONS) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }

    // Actors: a global super_admin + one City Manager per city + one
    // City Manager with no assignment (must get 403 everywhere).
    superAdminId = await makeUser(`+92309${RUN}01`);
    await grantRole(superAdminId, 'super_admin');
    quettaManagerId = await makeUser(`+92309${RUN}02`);
    await grantRole(quettaManagerId, 'city_manager', QUETTA_ID);
    karachiManagerId = await makeUser(`+92309${RUN}03`);
    await grantRole(karachiManagerId, 'city_manager', KARACHI_ID);
    unassignedManagerId = await makeUser(`+92309${RUN}04`);
    await grantRole(unassignedManagerId, 'city_manager');
    await admin.query(`UPDATE cities SET manager_id=$2 WHERE id=$1`, [QUETTA_ID, quettaManagerId]);
    await admin.query(`UPDATE cities SET manager_id=$2 WHERE id=$1`, [KARACHI_ID, karachiManagerId]);

    // Two real reviews for Quetta Cool Air, on two real completed jobs, so
    // the SEO pages render genuine review summaries (not fixtures).
    const mkJob = async (): Promise<string> => {
      const reqId = (await admin.query(
        `INSERT INTO service_requests (customer_id, category_id, fulfillment, location, status)
         VALUES ($1,$2,'onsite', ST_SetSRID(ST_MakePoint(66.985,30.195),4326)::geography, 'ACCEPTED') RETURNING id`,
        [CUSTOMER_ID, AC_REPAIR_ID],
      )).rows[0].id as string;
      const offerId = (await admin.query(
        `INSERT INTO offers (request_id, provider_id, offered_by, round, price, expires_at)
         VALUES ($1,$2,'provider',1,2500, now() + interval '1 day') RETURNING id`,
        [reqId, QUETTA_COOL_AIR_ID],
      )).rows[0].id as string;
      return (await admin.query(
        `INSERT INTO jobs (request_id, offer_id, customer_id, provider_id, agreed_price, final_price, commission_rate, state, payment_status)
         VALUES ($1,$2,$3,$4,2500,2500,0.1,'PAYMENT_SETTLED','settled') RETURNING id`,
        [reqId, offerId, CUSTOMER_ID, QUETTA_COOL_AIR_ID],
      )).rows[0].id as string;
    };
    await admin.query(
      `INSERT INTO reviews (job_id, reviewer_id, reviewee_id, stars, comment) VALUES ($1,$2,$3,5,'AC fixed the same day, great work.')`,
      [await mkJob(), CUSTOMER_ID, QUETTA_COOL_AIR_USER],
    );
    await admin.query(
      `INSERT INTO reviews (job_id, reviewer_id, reviewee_id, stars, comment) VALUES ($1,$2,$3,4,'Good service, fair price.')`,
      [await mkJob(), CUSTOMER_ID, QUETTA_COOL_AIR_USER],
    );

    const mod = await Test.createTestingModule({ imports: [CitiesModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()));
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (admin) await admin.end();
  });

  it('seed: Quetta is the live pilot city, Karachi is in_preparation', async () => {
    const res = await api().get('/api/v1/admin/cities').set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(200);
    const bySlug = Object.fromEntries(res.body.map((c: { slug: string }) => [c.slug, c]));
    expect(bySlug.quetta.status).toBe('live');
    expect(bySlug.quetta.is_launched).toBe(true);
    expect(bySlug.karachi.status).toBe('in_preparation');
    expect(bySlug.karachi.is_launched).toBe(false);
    expect(bySlug.karachi.supply_target_providers).toBe(10);
  });

  it('Karachi gate evaluation honestly FAILS on the seeded supply', async () => {
    const res = await api().post(`/api/v1/admin/cities/${KARACHI_ID}/gate-evaluations`)
      .set('Authorization', `Bearer ${superToken()}`).send({ notes: 'Seeded Karachi check' });
    expect(res.status).toBe(201);
    expect(res.body.passed).toBe(false);
    // 3 seed providers < 10 target; ~0.02 per 100k < 0.8; no requests yet.
    expect(res.body.metrics.providerCount).toBe(3);
    expect(res.body.metrics.supplyDensityPer100k).toBeCloseTo(0.019, 3);
    expect(res.body.metrics.fillRate).toBeNull();
    expect(res.body.metrics.timeToFirstOfferSeconds).toBeNull();
    expect(res.body.results.provider_count.passed).toBe(false);
    expect(res.body.results.supply_density.passed).toBe(false);
    expect(res.body.results.fill_rate).toMatchObject({ passed: false, reason: 'no_data' });
    expect(res.body.results.time_to_first_offer).toMatchObject({ passed: false, reason: 'no_data' });
    // The evaluation is persisted + audited.
    const saved = (await admin.query(
      `SELECT passed FROM city_gate_evaluations WHERE city_id=$1 ORDER BY evaluated_at DESC LIMIT 1`, [KARACHI_ID],
    )).rows[0];
    expect(saved.passed).toBe(false);
    const audit = (await admin.query(
      `SELECT COUNT(*)::int AS c FROM audit_logs WHERE action='city.gate_evaluate' AND entity_id=$1`, [res.body.id],
    )).rows[0];
    expect(audit.c).toBe(1);
  });

  it('Karachi checklist is seeded with 7 pending items; Quetta is all done', async () => {
    const khi = await api().get(`/api/v1/admin/cities/${KARACHI_ID}/checklist`).set('Authorization', `Bearer ${superToken()}`);
    expect(khi.status).toBe(200);
    expect(khi.body.items).toHaveLength(7);
    expect(khi.body.items.every((i: { done: boolean }) => i.done === false)).toBe(true);
    expect(khi.body.items.map((i: { item_key: string }) => i.item_key)).toContain('gate_evaluation_pass');
    const qta = await api().get(`/api/v1/admin/cities/${QUETTA_ID}/checklist`).set('Authorization', `Bearer ${superToken()}`);
    expect(qta.body.items.every((i: { done: boolean }) => i.done === true)).toBe(true);
  });

  it('going live is blocked while the gate fails, and skips are illegal', async () => {
    // in_preparation -> live is not even a legal transition.
    const skip = await api().post(`/api/v1/admin/cities/${KARACHI_ID}/status`)
      .set('Authorization', `Bearer ${superToken()}`).send({ to: 'live' });
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe('ILLEGAL_CITY_TRANSITION');
    // in_preparation -> gate_review is legal, but live from there needs a pass.
    const review = await api().post(`/api/v1/admin/cities/${KARACHI_ID}/status`)
      .set('Authorization', `Bearer ${superToken()}`).send({ to: 'gate_review' });
    expect(review.status).toBe(201);
    expect(review.body.status).toBe('gate_review');
    const live = await api().post(`/api/v1/admin/cities/${KARACHI_ID}/status`)
      .set('Authorization', `Bearer ${superToken()}`).send({ to: 'live' });
    expect(live.status).toBe(409);
    expect(live.body.error.code).toBe('GATE_NOT_PASSED');
    // Back to in_preparation so later tests see the seeded state.
    const back = await api().post(`/api/v1/admin/cities/${KARACHI_ID}/status`)
      .set('Authorization', `Bearer ${superToken()}`).send({ to: 'in_preparation' });
    expect(back.status).toBe(201);
  });

  it('City Manager scoping: Quetta manager gets 403 on Karachi, 200 on Quetta', async () => {
    const forbidden = await api().patch(`/api/v1/admin/cities/${KARACHI_ID}/targets`)
      .set('Authorization', `Bearer ${quettaToken()}`).send({ supply_target_providers: 99 });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
    const allowed = await api().patch(`/api/v1/admin/cities/${QUETTA_ID}/targets`)
      .set('Authorization', `Bearer ${quettaToken()}`).send({ supply_target_providers: 12 });
    expect(allowed.status).toBe(200);
    expect(allowed.body.supply_target_providers).toBe(12);
    // Restore the seeded target.
    await api().patch(`/api/v1/admin/cities/${QUETTA_ID}/targets`)
      .set('Authorization', `Bearer ${superToken()}`).send({ supply_target_providers: 10 });
    // The Karachi manager sees only Karachi in the list; the unassigned
    // manager sees nothing (403); no token at all is 401.
    const khiList = await api().get('/api/v1/admin/cities').set('Authorization', `Bearer ${karachiToken()}`);
    expect(khiList.status).toBe(200);
    expect(khiList.body.map((c: { slug: string }) => c.slug)).toEqual(['karachi']);
    const none = await api().get('/api/v1/admin/cities').set('Authorization', `Bearer ${tokenFor(unassignedManagerId, ['city_manager'])}`);
    expect(none.status).toBe(403);
    const anon = await api().get('/api/v1/admin/cities');
    expect(anon.status).toBe(401);
    // Karachi manager can run a gate evaluation for Karachi, not Quetta.
    const ok = await api().post(`/api/v1/admin/cities/${KARACHI_ID}/gate-evaluations`)
      .set('Authorization', `Bearer ${karachiToken()}`).send({});
    expect(ok.status).toBe(201);
    expect(ok.body.passed).toBe(false);
    const no = await api().post(`/api/v1/admin/cities/${QUETTA_ID}/gate-evaluations`)
      .set('Authorization', `Bearer ${karachiToken()}`).send({});
    expect(no.status).toBe(403);
  });

  it('per-city commission override beats the global rule; city+category beats category', async () => {
    // Global rule is 10% (seed). City-only Karachi rule 12%.
    const cityRule = await api().post(`/api/v1/admin/cities/${KARACHI_ID}/commission-rules`)
      .set('Authorization', `Bearer ${superToken()}`).send({ rate: 0.12 });
    expect(cityRule.status).toBe(201);
    const cityOnly = await api().get(`/api/v1/admin/cities/${KARACHI_ID}/effective-commission`)
      .set('Authorization', `Bearer ${superToken()}`);
    expect(cityOnly.status).toBe(200);
    expect(cityOnly.body).toMatchObject({ rate: 0.12, source: 'city' });
    // A global category rule (8% for AC repair) outranks the city-only
    // rule by specificity — the engine order is category(4) > city(3).
    await admin.query(
      `INSERT INTO commission_rules (category_id, city_id, tier, rate, valid_from, is_promo)
       VALUES ($1,NULL,NULL,0.08,CURRENT_DATE,false)`, [AC_REPAIR_ID],
    );
    const catWins = await api().get(`/api/v1/admin/cities/${KARACHI_ID}/effective-commission?category_id=${AC_REPAIR_ID}`)
      .set('Authorization', `Bearer ${superToken()}`);
    expect(catWins.body).toMatchObject({ rate: 0.08, source: 'category' });
    // A city+category rule (13%) beats both.
    const both = await api().post(`/api/v1/admin/cities/${KARACHI_ID}/commission-rules`)
      .set('Authorization', `Bearer ${superToken()}`).send({ category_id: AC_REPAIR_ID, rate: 0.13 });
    expect(both.status).toBe(201);
    const best = await api().get(`/api/v1/admin/cities/${KARACHI_ID}/effective-commission?category_id=${AC_REPAIR_ID}`)
      .set('Authorization', `Bearer ${superToken()}`);
    expect(best.body).toMatchObject({ rate: 0.13, source: 'city+category' });
    // Out-of-band rates are rejected (the 5–15% band).
    const bad = await api().post(`/api/v1/admin/cities/${KARACHI_ID}/commission-rules`)
      .set('Authorization', `Bearer ${superToken()}`).send({ rate: 0.2 });
    expect(bad.status).toBe(422);
  });

  it('per-city fair price beats the global fallback', async () => {
    await admin.query(
      `INSERT INTO fair_price_seed (category_id, city_id, min_price, typical_price, max_price, sample_size)
       VALUES ($1,NULL,1200,2000,3600,100) ON CONFLICT (category_id, city_id) DO NOTHING`,
      [AC_REPAIR_ID],
    );
    // Karachi has a seeded city row (typical 3000) — it wins.
    const khi = await api().get(`/api/v1/admin/cities/${KARACHI_ID}/fair-price?category_id=${AC_REPAIR_ID}`)
      .set('Authorization', `Bearer ${superToken()}`);
    expect(khi.status).toBe(200);
    expect(khi.body).toMatchObject({ typicalPrice: 3000, source: 'city' });
    // Quetta also has a city row (typical 2500).
    const qta = await api().get(`/api/v1/admin/cities/${QUETTA_ID}/fair-price?category_id=${AC_REPAIR_ID}`)
      .set('Authorization', `Bearer ${superToken()}`);
    expect(qta.body).toMatchObject({ typicalPrice: 2500, source: 'city' });
  });

  it('per-city categories: Karachi launch categories are disabled until enabled', async () => {
    const res = await api().get(`/api/v1/admin/cities/${KARACHI_ID}/categories`)
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.items.every((i: { is_enabled: boolean }) => i.is_enabled === false)).toBe(true);
    // The Karachi manager enables AC repair for Karachi only.
    const enable = await api().patch(`/api/v1/admin/cities/${KARACHI_ID}/categories/${AC_REPAIR_ID}`)
      .set('Authorization', `Bearer ${karachiToken()}`).send({ is_enabled: true });
    expect(enable.status).toBe(200);
    expect(enable.body.is_enabled).toBe(true);
    // …but the Quetta manager cannot touch Karachi categories.
    const no = await api().patch(`/api/v1/admin/cities/${KARACHI_ID}/categories/${BOOK_BINDING_ID}`)
      .set('Authorization', `Bearer ${quettaToken()}`).send({ is_enabled: true });
    expect(no.status).toBe(403);
  });

  it('a scratch city can pass its gate and go live (positive path)', async () => {
    const created = await api().post('/api/v1/admin/cities')
      .set('Authorization', `Bearer ${superToken()}`)
      .send({ name: 'Testabad', slug: 'testabad', lat: 33.6844, lng: 73.0479, default_radius_km: 5, population_estimate: 500000, supply_target_providers: 10 });
    expect(created.status).toBe(201);
    const cityId = created.body.id as string;
    // 10 providers at the city centre.
    for (let i = 0; i < 10; i++) {
      const uid = await makeUser(`+92309${RUN}1${i}`);
      const pid = (await admin.query(
        `INSERT INTO provider_profiles (user_id, provider_type, display_name, base_point, tier, is_online)
         VALUES ($1,'individual',$2, ST_SetSRID(ST_MakePoint(73.0479,33.6844),4326)::geography, 1, true) RETURNING id`,
        [uid, `Testabad Provider ${i}`],
      )).rows[0].id as string;
      await admin.query(
        `INSERT INTO provider_services (provider_id, category_id, starting_price) VALUES ($1,$2,1500)`,
        [pid, AC_REPAIR_ID],
      );
    }
    // 2 requests with offers inside the radius, first offer 10 min in.
    for (let i = 0; i < 2; i++) {
      const reqId = (await admin.query(
        `INSERT INTO service_requests (customer_id, category_id, fulfillment, location, status, created_at)
         VALUES ($1,$2,'onsite', ST_SetSRID(ST_MakePoint(73.0479,33.6844),4326)::geography, 'ACCEPTED', now() - interval '1 hour') RETURNING id`,
        [CUSTOMER_ID, AC_REPAIR_ID],
      )).rows[0].id as string;
      const provId = (await admin.query(
        `SELECT id FROM provider_profiles ORDER BY created_at DESC LIMIT 1`,
      )).rows[0].id as string;
      await admin.query(
        `INSERT INTO offers (request_id, provider_id, offered_by, round, price, expires_at, created_at)
         VALUES ($1,$2,'provider',1,1500, now() + interval '1 day', now() - interval '50 minutes')`,
        [reqId, provId],
      );
    }
    const toPrep = await api().post(`/api/v1/admin/cities/${cityId}/status`)
      .set('Authorization', `Bearer ${superToken()}`).send({ to: 'in_preparation' });
    expect(toPrep.status).toBe(201);
    const toReview = await api().post(`/api/v1/admin/cities/${cityId}/status`)
      .set('Authorization', `Bearer ${superToken()}`).send({ to: 'gate_review' });
    expect(toReview.status).toBe(201);
    const evalRes = await api().post(`/api/v1/admin/cities/${cityId}/gate-evaluations`)
      .set('Authorization', `Bearer ${superToken()}`).send({});
    expect(evalRes.status).toBe(201);
    expect(evalRes.body.passed).toBe(true);
    expect(evalRes.body.metrics.providerCount).toBe(10);
    expect(evalRes.body.metrics.fillRate).toBe(1);
    expect(evalRes.body.metrics.timeToFirstOfferSeconds).toBeCloseTo(600, 0);
    const live = await api().post(`/api/v1/admin/cities/${cityId}/status`)
      .set('Authorization', `Bearer ${superToken()}`).send({ to: 'live' });
    expect(live.status).toBe(201);
    expect(live.body.status).toBe('live');
    expect(live.body.is_launched).toBe(true);
    expect(live.body.launched_at).not.toBeNull();
    // Pause it again — the lifecycle is reversible.
    const paused = await api().post(`/api/v1/admin/cities/${cityId}/status`)
      .set('Authorization', `Bearer ${superToken()}`).send({ to: 'paused' });
    expect(paused.status).toBe(201);
    expect(paused.body.is_launched).toBe(false);
  });

  it('SEO landing page renders with real data + meta tags (public, no auth)', async () => {
    const res = await api().get('/api/v1/services/ac-repair/satellite-town-quetta');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<title>AC Repair in Satellite Town, Quetta | Near Service</title>');
    expect(res.text).toContain('<meta name="description" content="Find trusted ac repair providers in Satellite Town, Quetta on Near Service. 2 verified providers with real customer reviews — typical price PKR 2500."');
    expect(res.text).toContain('<h1>AC Repair in Satellite Town, Quetta</h1>');
    expect(res.text).toContain('Quetta Cool Air');
    expect(res.text).toContain('Freeze Point AC');
    // Bilal AC Services sits 5,140 m from Satellite Town centre — just
    // outside Quetta's 5 km radius, so it honestly does NOT appear here.
    expect(res.text).not.toContain('Bilal AC Services');
    expect(res.text).toContain('Fair price in Quetta: PKR 1500 – 4500 (typical PKR 2500, based on 38 quotes).');
    // Real review summaries, not fixtures.
    expect(res.text).toContain('Average rating 4.5 out of 5 from 2 verified reviews');
    expect(res.text).toContain('AC fixed the same day, great work.');
    expect(res.text).toContain('Good service, fair price.');
    expect(res.text).toContain('application/ld+json');
  });

  it('SEO shop page shows the real review summary (public, no auth)', async () => {
    const res = await api().get(`/api/v1/shops/${QUETTA_COOL_AIR_ID}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Quetta Cool Air — Quetta | Near Service</title>');
    expect(res.text).toContain('178 jobs completed');
    expect(res.text).toContain('Average rating 4.5 out of 5 from 2 verified reviews');
    expect(res.text).toContain('AC fixed the same day, great work.');
    expect(res.text).toContain('AC Repair — from PKR 2500');
  });

  it('SEO index lists enabled landing pages only; unknown areas are 404', async () => {
    const index = await api().get('/api/v1/services');
    expect(index.status).toBe(200);
    expect(index.text).toContain('<a href="/services/ac-repair/satellite-town-quetta">AC Repair in Satellite Town, Quetta</a> (2 providers)');
    // Karachi categories are still disabled (except ac-repair, enabled
    // by the categories test above) — no Karachi book-binding page.
    expect(index.text).not.toContain('/services/book-binding/gulshan-e-iqbal-karachi');
    expect(index.text).not.toContain('Book Binding in Gulshan-e-Iqbal, Karachi');
    expect(index.text).toContain('/services/ac-repair/gulshan-e-iqbal-karachi');
    const missing = await api().get('/api/v1/services/ac-repair/nowhere-town');
    expect(missing.status).toBe(404);
    // The SEO routes serve text/html, so supertest leaves .body empty and
    // the shared JSON error shape is in .text — parse it.
    expect(JSON.parse(missing.text).error.code).toBe('NOT_FOUND');
    const badSlug = await api().get('/api/v1/services/AC-REPAIR/satellite-town-quetta');
    expect(badSlug.status).toBe(400);
  });
});
