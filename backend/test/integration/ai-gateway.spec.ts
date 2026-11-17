// Integration tests — REAL Postgres 16 + PostGIS 3 and REAL Redis. Run with:
//   DATABASE_URL=<redacted>
//   REDIS_URL=redis://127.0.0.1:6379
//   NODE_ENV=test npm test -- ai-gateway
// DESTRUCTIVE to the target database: beforeAll drops the public schema and
// re-applies migrations 0001–0010. Only ever point it at a dedicated test DB
// (nearservice_p3_ai). Skipped entirely when DATABASE_URL or REDIS_URL is not set.
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { DatabaseService } from '../../src/database/database.service';
import { AiGatewayService } from '../../src/modules/ai-gateway/ai-gateway.service';

jest.setTimeout(30000);

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

maybeDescribe('AI Gateway (real DB)', () => {
  let dbSvc: DatabaseService;
  let svc: AiGatewayService;
  let admin: Client;
  let userId: string;
  let chatId: string;
  let messageId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    const files = fs.readdirSync(dbDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    dbSvc = new DatabaseService();
    svc = new AiGatewayService(dbSvc);
    // Minimal chat fixture: customer + provider user, provider profile, chat, message.
    userId = (await admin.query(`INSERT INTO users (phone, full_name, language) VALUES ('+923001112233','AI Test','ur') RETURNING id`)).rows[0].id;
    const providerUser = (await admin.query(`INSERT INTO users (phone, full_name, language) VALUES ('+923004445566','AI Provider','ur') RETURNING id`)).rows[0].id;
    const providerId = (await admin.query(
      `INSERT INTO provider_profiles (user_id, display_name, provider_type, tier, base_point) VALUES ($1,'AI Provider','individual',1,ST_SetSRID(ST_MakePoint(66.9750,30.1798),4326)::geography) RETURNING id`, [providerUser])).rows[0].id;
    chatId = (await admin.query(
      `INSERT INTO chats (customer_id, provider_id) VALUES ($1,$2) RETURNING id`, [userId, providerId])).rows[0].id;
    messageId = (await admin.query(
      `INSERT INTO messages (chat_id, sender_id, kind, body) VALUES ($1,$2,'text','thank you') RETURNING id`, [chatId, providerUser])).rows[0].id;
  });

  afterAll(async () => {
    await dbSvc.onModuleDestroy();
    await admin.end();
  });

  it('migration 0010 tables exist', async () => {
    const rows = (await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('ai_intent_logs','fair_price_snapshots','chat_translation_prefs','message_translations')`)).rows;
    expect(rows.map((r) => r.table_name).sort()).toEqual(['ai_intent_logs', 'chat_translation_prefs', 'fair_price_snapshots', 'message_translations']);
  });

  it('parseIntent against the live taxonomy logs a redacted row', async () => {
    const out = await svc.parseIntent('meri kitabon ki jild banwani hai 20 kitabein, cnic 35202-1234567-1', userId);
    expect(out.service!.category_slug).toBe('book-binding');
    expect(out.quantity).toBe(20);
    const logged = (await admin.query(`SELECT input_text FROM ai_intent_logs ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(logged.input_text).toContain('[REDACTED_CNIC]');
    expect(logged.input_text).not.toContain('35202');
  });

  it('fairPrice falls back to percentiles on the seed (no completed jobs)', async () => {
    const est = await svc.fairPrice(undefined, 'book-binding', undefined, 20);
    expect(est.source).toBe('percentile');
    expect(est.sample_size).toBe(0);
    const snap = (await admin.query(`SELECT source FROM fair_price_snapshots ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(snap.source).toBe('percentile');
  });

  it('chat translation toggle round-trips and translates a known phrase, original preserved', async () => {
    const pref = await svc.setTranslationPref(chatId, userId, 'ur', true);
    expect(pref.auto_translate).toBe(true);
    expect(pref.target_lang).toBe('ur');
    expect((await svc.getTranslationPref(chatId, userId)).target_lang).toBe('ur');
    const t = await svc.translateMessage(chatId, messageId, userId, 'ur');
    expect(t.original).toBe('thank you');
    expect(t.translated).toBe('شکریہ');
    expect(t.translated_by_provider).toBe(true);
    const stored = (await admin.query(`SELECT body FROM messages WHERE id=$1`, [messageId])).rows[0];
    expect(stored.body).toBe('thank you'); // original never overwritten
  });

  it('non-participant cannot translate', async () => {
    const stranger = (await admin.query(`INSERT INTO users (phone, full_name, language) VALUES ('+923007778899','Stranger','ur') RETURNING id`)).rows[0].id;
    await expect(svc.translateMessage(chatId, messageId, stranger, 'ur')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
