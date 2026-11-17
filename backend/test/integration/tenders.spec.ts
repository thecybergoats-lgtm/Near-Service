// B2B tenders — integration test (REAL Postgres 16 + PostGIS 3 + Redis).
// Run with (own database — never a shared test DB):
//   PGPASSFILE=~/.pgpass DATABASE_URL=postgres://nearservice@localhost:5432/nearservice_p3_tenders \
//   REDIS_URL=redis://localhost:6379 NODE_ENV=test npm test -- tenders --runInBand
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0013. Skipped entirely when DATABASE_URL or
// REDIS_URL is not set (same pattern as ledger-balance.spec.ts).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { DatabaseService } from '../../src/database/database.service';
import { RedisService } from '../../src/database/redis.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { TendersService, TENDER_LEAD_FEE_PAISA } from '../../src/modules/tenders/tenders.service';
import { ApiError } from '../../src/common/errors/api-error';

jest.setTimeout(60000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

const RUN = String(crypto.randomInt(100000, 999999));
const PHONE = (n: string) => `+92301${RUN}${n}`;
// Seeded by 0004_seed.sql.
const CATEGORY_ID = '00000000-0000-4000-8000-0000b0000001'; // Book Binding
const ITEMS = [
  { label: 'Hard binding x500', quantity: 500, unit_price: 120, line_total: 60000 },
  { label: 'Title printing x500', quantity: 500, unit_price: 15, line_total: 7500 },
];
const TOTAL = 67500;

maybeDescribe('tenders end-to-end (real DB + Redis)', () => {
  let dbSvc: DatabaseService;
  let redis: RedisService;
  let svc: TendersService;
  let admin: Client;
  let customerId: string;
  let providerUserId: string;
  let providerUserId2: string;
  let providerId: string;
  let providerId2: string;
  let requestId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    const files = fs.readdirSync(dbDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    redis = new RedisService();
    dbSvc = new DatabaseService();
    svc = new TendersService(dbSvc, redis, new RealtimeService());

    customerId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Tender School','ur') RETURNING id`, [PHONE('01')])).rows[0].id;
    providerUserId = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Tender Binder 1','ur') RETURNING id`, [PHONE('02')])).rows[0].id;
    providerUserId2 = (await admin.query(
      `INSERT INTO users (phone, full_name, language) VALUES ($1,'Tender Binder 2','ur') RETURNING id`, [PHONE('03')])).rows[0].id;
    for (const uid of [providerUserId, providerUserId2]) {
      await admin.query(`INSERT INTO wallet_accounts (user_id) VALUES ($1)`, [uid]);
    }
    providerId = (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, shop_name, base_point, tier, is_online)
       VALUES ($1,'SHOP','Tender Binder 1','Binder 1',ST_SetSRID(ST_MakePoint(66.985,30.195),4326)::geography,2,true) RETURNING id`,
      [providerUserId])).rows[0].id;
    providerId2 = (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, shop_name, base_point, tier, is_online)
       VALUES ($1,'SHOP','Tender Binder 2','Binder 2',ST_SetSRID(ST_MakePoint(66.986,30.196),4326)::geography,1,true) RETURNING id`,
      [providerUserId2])).rows[0].id;
    requestId = (await admin.query(
      `INSERT INTO service_requests (customer_id, category_id, description, fulfillment, location, status)
       VALUES ($1,$2,'Bind 500 school books','PICKUP_DELIVERY',ST_SetSRID(ST_MakePoint(66.985,30.195),4326)::geography,'BROADCASTING') RETURNING id`,
      [customerId, CATEGORY_ID])).rows[0].id;
  });

  afterAll(async () => {
    await redis.onModuleDestroy();
    await dbSvc.onModuleDestroy();
    await admin.end();
  });

  const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  let tenderId: string;
  let quoteId: string;
  let quoteId2: string;
  let jobId: string;

  it('creates a tender on the bulk request', async () => {
    const tender = await svc.createTender(customerId, {
      request_id: requestId,
      organization_name: 'Govt High School Quetta',
      organization_type: 'SCHOOL',
      title: 'Bind 500 books',
      description: 'Annual binding for the school library',
      delivery_deadline: FUTURE,
    } as never);
    tenderId = String(tender.id);
    expect(tender.status).toBe('OPEN');
    expect(tender.lead_fee_paisa).toBe(TENDER_LEAD_FEE_PAISA);
    const req = (await admin.query(`SELECT is_b2b FROM service_requests WHERE id=$1`, [requestId])).rows[0];
    expect(req.is_b2b).toBe(true);
  });

  it('accepts itemized quotes from two providers', async () => {
    const q1 = await svc.submitQuote(tenderId, providerUserId, { items: ITEMS, total_price: TOTAL, eta_days: 10 } as never);
    quoteId = String(q1.id);
    expect(q1.total_price).toBe(TOTAL);
    const q2 = await svc.submitQuote(tenderId, providerUserId2, {
      items: [{ label: 'Hard binding x500', quantity: 500, unit_price: 130, line_total: 65000 }],
      total_price: 65000, eta_days: 12,
    } as never);
    quoteId2 = String(q2.id);
    const tender = await svc.getTender(tenderId, customerId);
    expect(tender.status).toBe('QUOTES_RECEIVED');
    expect(tender.submitted_quote_count).toBe(2);
  });

  it('rejects an itemized quote whose lines do not add up', async () => {
    await expect(svc.submitQuote(tenderId, providerUserId2, {
      items: [{ label: 'x', quantity: 10, unit_price: 100, line_total: 999 }],
      total_price: 999,
    } as never)).rejects.toMatchObject({ status: 422, code: 'ITEM_LINE_MISMATCH' });
  });

  it('sealed bids: a provider sees only their own quote before award', async () => {
    const mine = await svc.listQuotes(tenderId, providerUserId);
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0].id).toBe(quoteId);
    expect(mine.sealed).toBe(true);
    const owner = await svc.listQuotes(tenderId, customerId);
    expect(owner.items).toHaveLength(2);
  });

  it('accepts exactly one quote: job ACCEPTED, lead fee debited, audit complete', async () => {
    const out = await svc.acceptQuote(quoteId, customerId);
    jobId = String(out.job.id);
    expect(out.job.state).toBe('ACCEPTED');
    expect(out.tender.status).toBe('AWARDED');
    expect(out.lead_fee_paisa).toBe(TENDER_LEAD_FEE_PAISA);
    expect(out.lead_fee_charged).toBe(true);
    // Exactly one accepted quote in the DB (partial unique index backstop).
    const accepted = (await admin.query(
      `SELECT COUNT(*)::int AS c FROM tender_quotes WHERE tender_id=$1 AND status='accepted'`, [tenderId])).rows[0].c;
    expect(accepted).toBe(1);
    const loser = (await admin.query(`SELECT status FROM tender_quotes WHERE id=$1`, [quoteId2])).rows[0];
    expect(loser.status).toBe('rejected');
    // The job is a normal job linked to the tender, via a normal offer.
    const job = (await admin.query(`SELECT state, tender_id, offer_id FROM jobs WHERE id=$1`, [jobId])).rows[0];
    expect(job.state).toBe('ACCEPTED');
    expect(job.tender_id).toBe(tenderId);
    const offer = (await admin.query(`SELECT status, price FROM offers WHERE id=$1`, [job.offer_id])).rows[0];
    expect(offer.status).toBe('accepted');
    expect(Number(offer.price)).toBe(TOTAL);
    // Lead fee: balanced ledger pair, wallet debited exactly PKR 500.
    const legs = (await admin.query(
      `SELECT account_code, direction, amount_paisa FROM ledger_entries WHERE job_id=$1 AND memo LIKE 'Tender lead fee%' ORDER BY id`,
      [jobId])).rows;
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ account_code: 'wallet', direction: 'D', amount_paisa: String(TENDER_LEAD_FEE_PAISA) });
    expect(legs[1]).toMatchObject({ account_code: 'tender_lead_fee_rev', direction: 'C', amount_paisa: String(TENDER_LEAD_FEE_PAISA) });
    const wallet = (await admin.query(`SELECT balance_paisa FROM wallet_accounts WHERE user_id=$1`, [providerUserId])).rows[0];
    expect(Number(wallet.balance_paisa)).toBe(-TENDER_LEAD_FEE_PAISA);
    // Full audit trail, in order.
    const audit = await svc.getAuditTrail(tenderId, customerId);
    expect(audit.items.map((a) => a.action)).toEqual([
      'TENDER_CREATED', 'QUOTE_SUBMITTED', 'QUOTE_SUBMITTED', 'QUOTE_ACCEPTED', 'LEAD_FEE_CHARGED', 'JOB_CREATED',
    ]);
  });

  it('a second accept is a 409 and creates no second job', async () => {
    await expect(svc.acceptQuote(quoteId2, customerId)).rejects.toMatchObject({ status: 409 } as Partial<ApiError>);
    const jobs = (await admin.query(`SELECT COUNT(*)::int AS c FROM jobs WHERE tender_id=$1`, [tenderId])).rows[0].c;
    expect(jobs).toBe(1);
  });

  it('an awarded tender cannot be cancelled', async () => {
    await expect(svc.cancelTender(tenderId, customerId)).rejects.toMatchObject({ status: 409 } as Partial<ApiError>);
  });
});
