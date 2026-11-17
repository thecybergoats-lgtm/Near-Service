// Verification integration tests — REAL Postgres 16 + PostGIS.
// Own test database: nearservice_p3_verify (never the shared test DBs
// of other workers). Destructive to that DB only: beforeAll drops the
// public schema and re-applies migrations 0001–0014 in order, then
// seeds one provider with cnic_front / cnic_back / selfie documents.
// Skipped entirely when DATABASE_URL is not set. Run with --runInBand.
//
//   DATABASE_URL=postgres://<user>@localhost:5432/nearservice_p3_verify
//   NODE_ENV=test CNIC_PEPPER=<32+ chars> OTP_HASH_SECRET=<32+ chars>
//   FIELD_ENCRYPTION_KEY=<base64 of 32 bytes> JWT_ACCESS_SECRET=...
//   npm test -- verification (integration)
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { VerificationService } from '../../src/modules/verification/verification.service';
import { DatabaseService } from '../../src/database/database.service';
import { ApiError } from '../../src/common/errors/api-error';

jest.setTimeout(30000);

const hasDb = !!process.env.DATABASE_URL;
const maybeDescribe = hasDb ? describe : describe.skip;

function makeJpeg(seed: number, size = 2048): Buffer {
  const buf = Buffer.alloc(size);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
  let s = seed >>> 0;
  for (let i = 4; i < size; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (s >> 16) & 0xff;
  }
  return buf;
}
/** A near-identical variant: same image with ~1% of payload bytes flipped. */
function makeJpegVariant(seed: number, size = 2048): Buffer {
  const buf = makeJpeg(seed, size);
  for (let i = 100; i < size; i += 97) buf[i] = (buf[i] + 1) & 0xff;
  return buf;
}
const b64 = (b: Buffer) => b.toString('base64');

async function expectApiError(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { return e as ApiError; }
  throw new Error('expected promise to reject with an ApiError');
}

maybeDescribe('verification (real Postgres, db 0014)', () => {
  let svc: VerificationService;
  let dbSvc: DatabaseService;
  let admin: Client;
  let providerUserId: string;
  let providerId: string;
  let frontDocId: string;
  let backDocId: string;
  let officerId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dbDir = path.resolve(__dirname, '../../../db');
    const files = fs.readdirSync(dbDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    // 0014 must be present and applied last.
    expect(files).toContain('0014_verification.sql');
    for (const file of files) {
      await admin.query(fs.readFileSync(path.join(dbDir, file), 'utf8'));
    }
    dbSvc = new DatabaseService();
    svc = new VerificationService(dbSvc);
    const user = (await admin.query(
      `INSERT INTO users (phone, full_name) VALUES ('+923001234999', 'Test Provider') RETURNING id`,
    )).rows[0];
    providerUserId = user.id;
    // The officer id must be a real users row: reviewed_by has an FK to users(id).
    const officer = (await admin.query(
      `INSERT INTO users (phone, full_name) VALUES ('+923001234998', 'Test Officer') RETURNING id`,
    )).rows[0];
    officerId = officer.id;
    const prof = (await admin.query(
      `INSERT INTO provider_profiles (user_id, provider_type, display_name, base_point)
       VALUES ($1,'INDIVIDUAL','Test Provider', ST_SetSRID(ST_MakePoint(66.975,30.1798),4326)::geography) RETURNING id`,
      [providerUserId],
    )).rows[0];
    providerId = prof.id;
    const docs = (await admin.query(
      `INSERT INTO provider_documents (provider_id, doc_type, storage_key, review_status) VALUES
         ($1,'cnic_front','providers/cnic-front-1','pending'),
         ($1,'cnic_back','providers/cnic-back-1','pending'),
         ($1,'selfie','providers/selfie-1','pending') RETURNING id, doc_type`,
      [providerId],
    )).rows;
    frontDocId = docs.find((d: { doc_type: string }) => d.doc_type === 'cnic_front').id;
    backDocId = docs.find((d: { doc_type: string }) => d.doc_type === 'cnic_back').id;
  });

  afterAll(async () => {
    if (dbSvc) await dbSvc.onModuleDestroy();
    if (admin) await admin.end();
  });

  it('migration 0014 created the three tables with the expected checks', async () => {
    const tables = (await admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('face_match_results','liveness_challenges','ocr_extractions') ORDER BY 1`,
    )).rows.map((r: { table_name: string }) => r.table_name);
    expect(tables).toEqual(['face_match_results', 'liveness_challenges', 'ocr_extractions']);
  });

  it('end-to-end: face-match -> liveness pass -> OCR pre-fill -> officer override -> review queue; tier stays 0', async () => {
    const match = await svc.submitFaceMatch(providerUserId, {
      selfie_image_base64: b64(makeJpeg(7)),
      cnic_photo_image_base64: b64(makeJpegVariant(7)),
      selfie_storage_key: 'providers/selfie-1',
      cnic_photo_storage_key: 'providers/cnic-front-1',
    });
    expect(match.face_match_score).toBeGreaterThanOrEqual(0.8);
    expect(match.is_real_biometric).toBe(false);
    expect(match.recommendation).toBe('officer_decides');
    // Score mirrored onto the selfie document; review_status untouched.
    const doc = (await admin.query(`SELECT face_match_score, review_status FROM provider_documents WHERE doc_type='selfie' AND provider_id=$1`, [providerId])).rows[0];
    expect(Number(doc.face_match_score)).toBe(match.face_match_score);
    expect(doc.review_status).toBe('pending');

    const challenge = await svc.startLiveness(providerUserId);
    const response = await svc.respondLiveness(providerUserId, String(challenge.challenge_id), challenge.actions);
    expect(response.passed).toBe(true);
    expect(response.status).toBe('passed');

    const ext = await svc.extractOcr(officerId, {
      document_id: frontDocId, side: 'front', cnic_number: '35202-1234567-1', full_name: 'Ali Khan',
    });
    expect(ext.ocr_confidence).toBeNull();
    expect(ext.missing_fields).toContain('father_name');
    const confirmed = await svc.confirmOcr(officerId, String(ext.id), {
      decision: 'corrected', father_name: 'Ahmed Khan', date_of_birth: '1990-05-01',
    });
    expect(confirmed.status).toBe('corrected');

    const overridden = await svc.overrideFaceMatch(officerId, String(match.id), 'reject_as_no_match', 'Officer disagrees with the heuristic score');
    expect(overridden.officer_decision).toBe('reject_as_no_match');
    expect(overridden.face_match_score).toBe(match.face_match_score);

    const queue = await svc.reviewQueue();
    expect(queue.items.length).toBe(3);
    const selfieItem = queue.items.find((i) => i.doc_type === 'selfie');
    expect(selfieItem?.face_match?.officer_decision).toBe('reject_as_no_match');
    expect(selfieItem?.liveness?.status).toBe('passed');
    expect(selfieItem?.ocr_extractions.length).toBe(1);

    // The assist never approves: tier is still 0 and every document is pending.
    const prof = (await admin.query(`SELECT tier FROM provider_profiles WHERE id=$1`, [providerId])).rows[0];
    expect(Number(prof.tier)).toBe(0);
    const pending = (await admin.query(`SELECT COUNT(*)::int AS c FROM provider_documents WHERE provider_id=$1 AND review_status='pending'`, [providerId])).rows[0];
    expect(pending.c).toBe(3);
    void backDocId;
  });

  it('duplicate submission (same file twice) scores 1.0 but is flagged uncertain, not a match', async () => {
    const img = b64(makeJpeg(99));
    const match = await svc.submitFaceMatch(providerUserId, { selfie_image_base64: img, cnic_photo_image_base64: img });
    expect(match.face_match_score).toBe(1);
    expect(match.duplicate_submission).toBe(true);
    expect(match.verdict).toBe('uncertain');
  });

  it('liveness expiry: a challenge answered after its expiry is marked expired', async () => {
    const challenge = await svc.startLiveness(providerUserId);
    await admin.query(`UPDATE liveness_challenges SET expires_at = now() - interval '1 minute' WHERE id=$1`, [challenge.challenge_id]);
    const res = await svc.respondLiveness(providerUserId, String(challenge.challenge_id), challenge.actions);
    expect(res.status).toBe('expired');
    expect(res.passed).toBe(false);
  });

  it('OCR extract with an invalid transcribed CNIC is 422 and stores nothing', async () => {
    const before = (await admin.query(`SELECT COUNT(*)::int AS c FROM ocr_extractions`)).rows[0].c;
    const err = await expectApiError(svc.extractOcr(officerId, { document_id: frontDocId, side: 'front', cnic_number: 'bad' }));
    expect(err.status).toBe(422);
    const after = (await admin.query(`SELECT COUNT(*)::int AS c FROM ocr_extractions`)).rows[0].c;
    expect(after).toBe(before);
  });
});
