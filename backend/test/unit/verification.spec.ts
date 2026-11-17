// Verification unit tests — face-match score behaviour, liveness
// challenge flow, OCR pre-fill, officer override preserved.
// Runs against an in-memory FakeDb that interprets exactly the SQL the
// service emits (no live Postgres here), plus the pure functions
// directly. Run with --runInBand.
import { randomUUID } from 'crypto';
import { VerificationService } from '../../src/modules/verification/verification.service';
import {
  LocalHeuristicFaceMatchProvider,
  decodeBase64Image,
  fingerprintImage,
  compareFingerprints,
  verdictForScore,
} from '../../src/modules/verification/face-match';
import {
  generateChallengeActions,
  actionsMatchInOrder,
  checkLivenessResponse,
  validateObservedActions,
  LIVENESS_ACTIONS,
} from '../../src/modules/verification/liveness';
import { buildOcrPrefill, validateCnicFields, enhancementSuggestions } from '../../src/modules/verification/ocr';
import { ApiError } from '../../src/common/errors/api-error';
import { DatabaseService } from '../../src/database/database.service';

/* ------------------------------------------------------------------ */
/* Test image bytes: minimal JPEGs built from a deterministic PRNG, so  */
/* two images from the same seed are near-identical and two from       */
/* different seeds differ. Never real photos.                          */
/* ------------------------------------------------------------------ */
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
/** A flat image: every payload byte the same value (very different histogram). */
function makeFlatJpeg(value: number, size = 2048): Buffer {
  const buf = Buffer.alloc(size, value);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
  return buf;
}
/** A near-identical variant: same image with ~1% of payload bytes flipped. */
function makeJpegVariant(seed: number, size = 2048): Buffer {
  const buf = makeJpeg(seed, size);
  for (let i = 100; i < size; i += 97) buf[i] = (buf[i] + 1) & 0xff;
  return buf;
}
const b64 = (b: Buffer) => b.toString('base64');

/* ------------------------------------------------------------------ */
/* FakeDb                                                              */
/* ------------------------------------------------------------------ */
type Row = Record<string, any>;
class FakeDb {
  profiles: Row[] = [];
  documents: Row[] = [];
  faceMatches: Row[] = [];
  liveness: Row[] = [];
  ocr: Row[] = [];
  audit: Row[] = [];
  private seq = 0;

  async query(text: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    const p = params as any[];
    const has = (s: string) => text.includes(s);
    if (has('SELECT id FROM provider_profiles WHERE user_id=$1')) {
      const r = this.profiles.find((x) => x.user_id === p[0] && !x.deleted_at);
      return { rows: r ? [{ id: r.id }] : [] };
    }
    if (has('SELECT id FROM provider_documents WHERE provider_id=$1 AND storage_key=$2')) {
      const r = this.documents.find((x) => x.provider_id === p[0] && x.storage_key === p[1] && x.doc_type === p[2]);
      return { rows: r ? [{ id: r.id }] : [] };
    }
    if (has('INSERT INTO face_match_results')) {
      const row: Row = {
        id: randomUUID(), provider_id: p[0], selfie_storage_key: p[1], cnic_photo_storage_key: p[2],
        selfie_sha256: p[3], cnic_photo_sha256: p[4], face_match_score: p[5], verdict: p[6],
        duplicate_submission: p[7], engine: p[8], is_real_biometric: p[9],
        officer_decision: null, officer_note: null, reviewed_by: null,
        created_at: new Date(Date.now() + this.seq++).toISOString(),
      };
      this.faceMatches.push(row);
      return { rows: [row] };
    }
    if (has('UPDATE provider_documents SET face_match_score')) {
      const d = this.documents.find((x) => x.provider_id === p[0] && x.storage_key === p[2]);
      if (d) d.face_match_score = p[1];
      return { rows: [] };
    }
    if (has('SELECT * FROM face_match_results WHERE id=$1')) {
      const r = this.faceMatches.find((x) => x.id === p[0]);
      return { rows: r ? [r] : [] };
    }
    if (has('SELECT * FROM face_match_results WHERE provider_id=$1')) {
      const rows = [...this.faceMatches].filter((x) => x.provider_id === p[0]).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { rows: rows.slice(0, 1) };
    }
    if (has('UPDATE face_match_results SET officer_decision')) {
      const r = this.faceMatches.find((x) => x.id === p[0]);
      if (r) { r.officer_decision = p[1]; r.officer_note = p[2]; r.reviewed_by = p[3]; }
      return { rows: r ? [r] : [] };
    }
    if (has('INSERT INTO audit_logs')) { this.audit.push({ actor: p[0], action: p[1] }); return { rows: [] }; }
    if (has('INSERT INTO liveness_challenges')) {
      const row: Row = {
        id: randomUUID(), provider_id: p[0], actions: JSON.parse(p[1]), observed_actions: null,
        status: 'pending', attempts_used: 0, attempts_allowed: p[2],
        expires_at: new Date(Date.now() + Number(p[3]) * 1000).toISOString(),
        created_at: new Date(Date.now() + this.seq++).toISOString(), completed_at: null,
      };
      this.liveness.push(row);
      return { rows: [row] };
    }
    if (has('SELECT * FROM liveness_challenges WHERE id=$1')) {
      const r = this.liveness.find((x) => x.id === p[0]);
      return { rows: r ? [r] : [] };
    }
    if (has('UPDATE liveness_challenges SET observed_actions')) {
      const r = this.liveness.find((x) => x.id === p[0]);
      if (r) {
        r.observed_actions = JSON.parse(p[1]); r.attempts_used = p[2]; r.status = p[3];
        if (['passed', 'failed', 'expired'].includes(p[3])) r.completed_at = new Date().toISOString();
      }
      return { rows: r ? [r] : [] };
    }
    if (has('SELECT * FROM liveness_challenges WHERE provider_id=$1')) {
      const rows = [...this.liveness].filter((x) => x.provider_id === p[0]).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { rows: rows.slice(0, 1) };
    }
    if (has('SELECT id, provider_id, doc_type FROM provider_documents WHERE id=$1')) {
      const r = this.documents.find((x) => x.id === p[0]);
      return { rows: r ? [{ id: r.id, provider_id: r.provider_id, doc_type: r.doc_type }] : [] };
    }
    if (has('INSERT INTO ocr_extractions')) {
      const row: Row = {
        id: randomUUID(), document_id: p[0], provider_id: p[1], side: p[2], engine: p[3],
        extracted_fields: JSON.parse(p[4]), missing_fields: p[5], enhancement_suggestions: p[6],
        ocr_confidence: p[7], status: 'needs_officer_review', corrected_fields: null, reviewed_by: null,
        created_at: new Date(Date.now() + this.seq++).toISOString(),
      };
      this.ocr.push(row);
      return { rows: [row] };
    }
    if (has('SELECT * FROM ocr_extractions WHERE id=$1')) {
      const r = this.ocr.find((x) => x.id === p[0]);
      return { rows: r ? [r] : [] };
    }
    if (has('UPDATE ocr_extractions SET corrected_fields')) {
      const r = this.ocr.find((x) => x.id === p[0]);
      if (r) { r.corrected_fields = JSON.parse(p[1]); r.status = p[2]; r.reviewed_by = p[3]; }
      return { rows: r ? [r] : [] };
    }
    if (has('SELECT * FROM ocr_extractions WHERE provider_id=$1')) {
      return { rows: [...this.ocr].filter((x) => x.provider_id === p[0]).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10) };
    }
    if (has('FROM provider_documents d JOIN provider_profiles')) {
      const rows = this.documents.filter((d) => d.review_status === 'pending').map((d) => ({
        document_id: d.id, provider_id: d.provider_id, doc_type: d.doc_type, storage_key: d.storage_key,
        face_match_score: d.face_match_score ?? null, review_status: d.review_status, created_at: d.created_at,
        display_name: d.display_name, provider_type: d.provider_type, tier: d.tier, phone: d.phone, full_name: d.full_name,
      }));
      return { rows };
    }
    throw new Error(`FakeDb: unhandled SQL: ${text.slice(0, 120)}`);
  }
}

const PROVIDER_USER = 'c0010001-4000-4000-8000-000000000001';
const PROVIDER_ID = 'c0010002-4000-4000-8000-000000000002';
const OFFICER_ID = 'c0010003-4000-4000-8000-000000000003';
const OTHER_USER = 'c0010004-4000-4000-8000-000000000004';

async function expectApiError(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { return e as ApiError; }
  throw new Error('expected promise to reject with an ApiError');
}

function makeSvc(db: FakeDb): VerificationService {
  return new VerificationService(db as unknown as DatabaseService);
}

function seedProvider(db: FakeDb, withDocs = true) {
  db.profiles.push({ id: PROVIDER_ID, user_id: PROVIDER_USER, deleted_at: null });
  if (withDocs) {
    db.documents.push(
      { id: randomUUID(), provider_id: PROVIDER_ID, doc_type: 'selfie', storage_key: 'providers/selfie-1', review_status: 'pending', display_name: 'Test Provider', provider_type: 'INDIVIDUAL', tier: 0, phone: '+923001234567', full_name: 'Test Provider', created_at: new Date().toISOString(), face_match_score: null },
      { id: randomUUID(), provider_id: PROVIDER_ID, doc_type: 'cnic_front', storage_key: 'providers/cnic-front-1', review_status: 'pending', display_name: 'Test Provider', provider_type: 'INDIVIDUAL', tier: 0, phone: '+923001234567', full_name: 'Test Provider', created_at: new Date().toISOString(), face_match_score: null },
      { id: randomUUID(), provider_id: PROVIDER_ID, doc_type: 'cnic_back', storage_key: 'providers/cnic-back-1', review_status: 'pending', display_name: 'Test Provider', provider_type: 'INDIVIDUAL', tier: 0, phone: '+923001234567', full_name: 'Test Provider', created_at: new Date().toISOString(), face_match_score: null },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Pure face-match heuristic                                           */
/* ------------------------------------------------------------------ */
describe('face-match heuristic (pure)', () => {
  it('identical images score 1.0 but are flagged duplicate + uncertain, never a match', async () => {
    const img = makeJpeg(42);
    const provider = new LocalHeuristicFaceMatchProvider();
    const r = await provider.compare({ selfie: img, cnicPhoto: img });
    expect(r.face_match_score).toBe(1);
    expect(r.duplicate_submission).toBe(true);
    expect(r.verdict).toBe('uncertain');
    expect(r.is_real_biometric).toBe(false);
    expect(r.recommendation).toBe('officer_decides');
    expect(r.selfie_sha256).toBe(r.cnic_photo_sha256);
  });

  it('same-seed images score high (likely_match); different images score lower', async () => {
    const provider = new LocalHeuristicFaceMatchProvider();
    const same = await provider.compare({ selfie: makeJpeg(7), cnicPhoto: makeJpegVariant(7) });
    expect(same.face_match_score).toBeGreaterThanOrEqual(0.8);
    expect(same.verdict).toBe('likely_match');
    const diff = await provider.compare({ selfie: makeJpeg(7), cnicPhoto: makeFlatJpeg(0) });
    expect(diff.face_match_score).toBeLessThan(same.face_match_score);
    expect(diff.verdict).toBe('likely_no_match');
    expect(diff.duplicate_submission).toBe(false);
  });

  it('score is deterministic and symmetric', async () => {
    const provider = new LocalHeuristicFaceMatchProvider();
    const a = makeJpeg(11);
    const b = makeJpeg(12);
    const r1 = await provider.compare({ selfie: a, cnicPhoto: b });
    const r2 = await provider.compare({ selfie: a, cnicPhoto: b });
    const r3 = await provider.compare({ selfie: b, cnicPhoto: a });
    expect(r1.face_match_score).toBe(r2.face_match_score);
    expect(r1.face_match_score).toBe(r3.face_match_score);
  });

  it('verdict thresholds: >=0.80 likely_match, 0.60..0.80 uncertain, <0.60 likely_no_match', () => {
    expect(verdictForScore(0.8)).toBe('likely_match');
    expect(verdictForScore(0.95)).toBe('likely_match');
    expect(verdictForScore(0.6)).toBe('uncertain');
    expect(verdictForScore(0.79)).toBe('uncertain');
    expect(verdictForScore(0.59)).toBe('likely_no_match');
    expect(verdictForScore(0)).toBe('likely_no_match');
  });

  it('decodeBase64Image rejects non-images, tiny input and oversize input (422)', () => {
    expect(() => decodeBase64Image(Buffer.from('hello world, not an image at all, padding padding').toString('base64'), 'selfie_image_base64'))
      .toThrow(expect.objectContaining({ status: 422, code: 'VALIDATION_FAILED' }));
    expect(() => decodeBase64Image('!!!not-base64!!!', 'selfie_image_base64'))
      .toThrow(expect.objectContaining({ status: 422 }));
    expect(() => decodeBase64Image(b64(makeJpeg(1, 512)), 'selfie_image_base64'))
      .toThrow(expect.objectContaining({ status: 422 }));
    expect(decodeBase64Image(b64(makeJpeg(1)), 'selfie_image_base64')).toBeInstanceOf(Buffer);
    const fp = fingerprintImage(makeJpeg(1));
    expect(compareFingerprints(fp, fp).face_match_score).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Pure liveness helpers                                               */
/* ------------------------------------------------------------------ */
describe('liveness challenge (pure)', () => {
  it('generates 3 distinct known actions', () => {
    for (let i = 0; i < 20; i += 1) {
      const actions = generateChallengeActions();
      expect(actions).toHaveLength(3);
      expect(new Set(actions).size).toBe(3);
      for (const a of actions) expect(LIVENESS_ACTIONS).toContain(a);
    }
  });

  it('actionsMatchInOrder accepts the sequence with extra actions in between, rejects wrong order', () => {
    expect(actionsMatchInOrder(['blink', 'smile', 'nod'], ['blink', 'turn_head_left', 'smile', 'nod'])).toBe(true);
    expect(actionsMatchInOrder(['blink', 'smile', 'nod'], ['smile', 'blink', 'nod'])).toBe(false);
    expect(actionsMatchInOrder(['blink', 'smile', 'nod'], ['blink', 'smile'])).toBe(false);
    expect(actionsMatchInOrder(['blink', 'smile', 'nod'], [])).toBe(false);
  });

  it('checkLivenessResponse: pass, missing actions, expired, too many attempts', () => {
    const base = { required: ['blink', 'smile', 'nod'] as never[], observed: ['blink', 'smile', 'nod'], attemptsUsed: 0, expiresAt: new Date(Date.now() + 60000) };
    expect(checkLivenessResponse(base).passed).toBe(true);
    expect(checkLivenessResponse({ ...base, observed: ['blink', 'nod'] }).passed).toBe(false);
    expect(checkLivenessResponse({ ...base, expiresAt: new Date(Date.now() - 1000) })).toMatchObject({ passed: false, reason: 'expired' });
    expect(checkLivenessResponse({ ...base, attemptsUsed: 3 })).toMatchObject({ passed: false, reason: 'too_many_attempts' });
  });

  it('validateObservedActions rejects empty, oversize and unknown actions (422)', () => {
    expect(() => validateObservedActions([])).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => validateObservedActions(['blink', 'teleport'])).toThrow(expect.objectContaining({ status: 422 }));
    expect(validateObservedActions(['blink', 'smile'])).toEqual(['blink', 'smile']);
  });
});

/* ------------------------------------------------------------------ */
/* Pure OCR assist                                                     */
/* ------------------------------------------------------------------ */
describe('OCR assist (pure)', () => {
  it('buildOcrPrefill with no transcription lists every expected field as missing and confidence null', () => {
    const pre = buildOcrPrefill('front');
    expect(pre.engine).toBe('local-manual-assist');
    expect(pre.ocr_confidence).toBeNull();
    expect(pre.missing_fields).toEqual(['cnic_number', 'full_name', 'father_name', 'date_of_birth', 'gender']);
    expect(pre.extracted_fields).toEqual({});
    expect(pre.enhancement_suggestions.length).toBeGreaterThan(0);
    const back = buildOcrPrefill('back');
    expect(back.missing_fields).toEqual(['cnic_number', 'date_of_issue', 'date_of_expiry']);
  });

  it('transcribed fields are stored as manual_transcription and removed from missing', () => {
    const pre = buildOcrPrefill('front', { cnic_number: '35202-1234567-1', full_name: 'Ali Khan' });
    expect(pre.extracted_fields.cnic_number).toEqual({ value: '35202-1234567-1', source: 'manual_transcription' });
    expect(pre.missing_fields).toEqual(['father_name', 'date_of_birth', 'gender']);
  });

  it('validateCnicFields catches bad CNIC, future DOB, expiry before issue, bad gender', () => {
    const errs = validateCnicFields({ cnic_number: '123', date_of_birth: '2999-01-01', date_of_issue: '2020-01-01', date_of_expiry: '2019-01-01', gender: 'x' });
    const fields = errs.map((e) => e.field);
    expect(fields).toContain('cnic_number');
    expect(fields).toContain('date_of_birth');
    expect(fields).toContain('date_of_expiry');
    expect(fields).toContain('gender');
    expect(validateCnicFields({ cnic_number: '35202-1234567-1', date_of_birth: '1990-05-01', date_of_issue: '2020-01-01', date_of_expiry: '2030-01-01', gender: 'male' })).toEqual([]);
  });

  it('buildOcrPrefill throws 422 naming the bad field', () => {
    expect(() => buildOcrPrefill('front', { cnic_number: 'bad' })).toThrow(expect.objectContaining({ status: 422, code: 'VALIDATION_FAILED' }));
  });

  it('enhancement suggestions differ front vs back', () => {
    expect(enhancementSuggestions('front').join(' ')).toContain('face');
    expect(enhancementSuggestions('back').join(' ')).toContain('issue/expiry');
  });
});

/* ------------------------------------------------------------------ */
/* Service against FakeDb                                              */
/* ------------------------------------------------------------------ */
describe('VerificationService (FakeDb)', () => {
  it('face-match stores the result, mirrors the score onto the selfie document, never claims biometrics', async () => {
    const db = new FakeDb();
    seedProvider(db);
    const svc = makeSvc(db);
    const res = await svc.submitFaceMatch(PROVIDER_USER, {
      selfie_image_base64: b64(makeJpeg(7)),
      cnic_photo_image_base64: b64(makeJpegVariant(7)),
      selfie_storage_key: 'providers/selfie-1',
      cnic_photo_storage_key: 'providers/cnic-front-1',
    });
    expect(res.face_match_score).toBeGreaterThanOrEqual(0.8);
    expect(res.verdict).toBe('likely_match');
    expect(res.is_real_biometric).toBe(false);
    expect(res.recommendation).toBe('officer_decides');
    expect(res.officer_decision).toBeNull();
    expect(db.faceMatches).toHaveLength(1);
    const selfieDoc = db.documents.find((d) => d.doc_type === 'selfie');
    expect(selfieDoc?.face_match_score).toBe(res.face_match_score);
    // review_status untouched by the assist
    expect(selfieDoc?.review_status).toBe('pending');
  });

  it('face-match rejects a storage_key that is not this provider’s document (422)', async () => {
    const db = new FakeDb();
    seedProvider(db);
    const svc = makeSvc(db);
    const err = await expectApiError(svc.submitFaceMatch(PROVIDER_USER, {
      selfie_image_base64: b64(makeJpeg(7)),
      cnic_photo_image_base64: b64(makeJpeg(7)),
      selfie_storage_key: 'providers/someone-elses-selfie',
    }));
    expect(err.status).toBe(422);
    expect(err.code).toBe('INVALID_STORAGE_KEY');
    expect(db.faceMatches).toHaveLength(0);
  });

  it('face-match with no provider profile is 404', async () => {
    const db = new FakeDb();
    const svc = makeSvc(db);
    const err = await expectApiError(svc.submitFaceMatch(OTHER_USER, {
      selfie_image_base64: b64(makeJpeg(7)), cnic_photo_image_base64: b64(makeJpeg(7)),
    }));
    expect(err.status).toBe(404);
  });

  it('officer override is preserved even when it contradicts the score, and the score is never rewritten', async () => {
    const db = new FakeDb();
    seedProvider(db);
    const svc = makeSvc(db);
    const res = await svc.submitFaceMatch(PROVIDER_USER, {
      selfie_image_base64: b64(makeJpeg(7)), cnic_photo_image_base64: b64(makeJpegVariant(7)),
    });
    expect(res.face_match_score).toBeGreaterThanOrEqual(0.8); // high score...
    const overridden = await svc.overrideFaceMatch(OFFICER_ID, String(res.id), 'reject_as_no_match', 'Photo looks like a different person');
    expect(overridden.officer_decision).toBe('reject_as_no_match'); // ...yet the officer rejects it
    expect(overridden.face_match_score).toBe(res.face_match_score); // score untouched
    expect(overridden.officer_note).toBe('Photo looks like a different person');
    expect(db.audit.some((a) => a.action === 'verification.face_match.override:reject_as_no_match')).toBe(true);
    const again = await expectApiError(svc.overrideFaceMatch(OFFICER_ID, String(res.id), 'accept_as_match'));
    expect(again.status).toBe(409);
    expect(again.code).toBe('FACE_MATCH_ALREADY_OVERRIDDEN');
    const kept = await svc.getFaceMatch(PROVIDER_USER, String(res.id), ['provider']);
    expect(kept.officer_decision).toBe('reject_as_no_match');
  });

  it('a provider cannot read another provider’s face-match result (403)', async () => {
    const db = new FakeDb();
    seedProvider(db);
    db.profiles.push({ id: 'c0010005-4000-4000-8000-000000000005', user_id: OTHER_USER, deleted_at: null });
    const svc = makeSvc(db);
    const res = await svc.submitFaceMatch(PROVIDER_USER, {
      selfie_image_base64: b64(makeJpeg(7)), cnic_photo_image_base64: b64(makeJpeg(7)),
    });
    const err = await expectApiError(svc.getFaceMatch(OTHER_USER, String(res.id), ['provider']));
    expect(err.status).toBe(403);
    const officerView = await svc.getFaceMatch(OTHER_USER, String(res.id), ['verification_officer']);
    expect(officerView.id).toBe(res.id);
  });

  it('liveness: start issues 3 actions with 5-min expiry; correct response passes; wrong order stays pending then fails on 3rd attempt', async () => {
    const db = new FakeDb();
    seedProvider(db);
    const svc = makeSvc(db);
    const started = await svc.startLiveness(PROVIDER_USER);
    expect(started.actions).toHaveLength(3);
    expect(started.status).toBe('pending');
    expect(started.attempts_allowed).toBe(3);
    expect(new Date(started.expires_at).getTime() - Date.now()).toBeGreaterThan(240000);

    const wrong = [...started.actions].reverse();
    const attempt1 = await svc.respondLiveness(PROVIDER_USER, String(started.challenge_id), wrong);
    expect(attempt1.passed).toBe(false);
    expect(attempt1.status).toBe('pending');
    expect(attempt1.attempts_used).toBe(1);
    const attempt2 = await svc.respondLiveness(PROVIDER_USER, String(started.challenge_id), wrong);
    expect(attempt2.status).toBe('pending');
    expect(attempt2.attempts_used).toBe(2);
    const attempt3 = await svc.respondLiveness(PROVIDER_USER, String(started.challenge_id), wrong);
    expect(attempt3.passed).toBe(false);
    expect(attempt3.status).toBe('failed');
    expect(attempt3.attempts_used).toBe(3);
    const closed = await expectApiError(svc.respondLiveness(PROVIDER_USER, String(started.challenge_id), started.actions));
    expect(closed.status).toBe(409);
    expect(closed.code).toBe('LIVENESS_CHALLENGE_CLOSED');

    const started2 = await svc.startLiveness(PROVIDER_USER);
    const ok = await svc.respondLiveness(PROVIDER_USER, String(started2.challenge_id), [...started2.actions, 'blink']);
    expect(ok.passed).toBe(true);
    expect(ok.status).toBe('passed');
    expect(ok.reason).toBe('all_actions_observed_in_order');
  });

  it('liveness: expired challenge is marked expired and never passes', async () => {
    const db = new FakeDb();
    seedProvider(db);
    const svc = makeSvc(db);
    const started = await svc.startLiveness(PROVIDER_USER);
    const row = db.liveness.find((x) => x.id === started.challenge_id);
    if (row) row.expires_at = new Date(Date.now() - 1000).toISOString();
    const res = await svc.respondLiveness(PROVIDER_USER, String(started.challenge_id), started.actions);
    expect(res.passed).toBe(false);
    expect(res.status).toBe('expired');
    expect(res.reason).toBe('expired');
  });

  it('OCR extract: wrong side for the document is 422; valid extract pre-fills with confidence null; confirm stores corrections separately', async () => {
    const db = new FakeDb();
    seedProvider(db);
    const svc = makeSvc(db);
    const frontDoc = db.documents.find((d) => d.doc_type === 'cnic_front');
    const wrong = await expectApiError(svc.extractOcr(OFFICER_ID, { document_id: String(frontDoc?.id), side: 'back' }));
    expect(wrong.status).toBe(422);
    const ext = await svc.extractOcr(OFFICER_ID, {
      document_id: String(frontDoc?.id), side: 'front',
      cnic_number: '35202-1234567-1', full_name: 'Ali Khan',
    });
    expect(ext.engine).toBe('local-manual-assist');
    expect(ext.ocr_confidence).toBeNull();
    expect(ext.status).toBe('needs_officer_review');
    expect(ext.extracted_fields.cnic_number).toEqual({ value: '35202-1234567-1', source: 'manual_transcription' });
    expect(ext.missing_fields).toEqual(['father_name', 'date_of_birth', 'gender']);
    expect(ext.enhancement_suggestions.length).toBeGreaterThan(0);
    const confirmed = await svc.confirmOcr(OFFICER_ID, String(ext.id), {
      decision: 'corrected', father_name: 'Ahmed Khan', date_of_birth: '1990-05-01', note: 'Added from photo',
    });
    expect(confirmed.status).toBe('corrected');
    expect(confirmed.corrected_fields?.father_name).toBe('Ahmed Khan');
    // original extraction is not edited in place: corrected fields live apart
    expect(confirmed.extracted_fields.father_name).toBeUndefined();
    const twice = await expectApiError(svc.confirmOcr(OFFICER_ID, String(ext.id), { decision: 'confirmed' }));
    expect(twice.status).toBe(409);
    expect(twice.code).toBe('OCR_ALREADY_DECIDED');
  });

  it('OCR confirm with an invalid corrected field is 422 naming the field, and nothing is stored', async () => {
    const db = new FakeDb();
    seedProvider(db);
    const svc = makeSvc(db);
    const frontDoc = db.documents.find((d) => d.doc_type === 'cnic_front');
    const ext = await svc.extractOcr(OFFICER_ID, { document_id: String(frontDoc?.id), side: 'front' });
    const err = await expectApiError(svc.confirmOcr(OFFICER_ID, String(ext.id), { decision: 'corrected', cnic_number: 'bad' }));
    expect(err.status).toBe(422);
    expect(err.code).toBe('VALIDATION_FAILED');
    const kept = await svc.latestOcrForProvider(PROVIDER_ID);
    expect(kept[0].status).toBe('needs_officer_review');
  });

  it('review queue pre-fills each pending document with face-match, liveness and OCR; evidence summary states the manual-only rule', async () => {
    const db = new FakeDb();
    seedProvider(db);
    const svc = makeSvc(db);
    await svc.submitFaceMatch(PROVIDER_USER, {
      selfie_image_base64: b64(makeJpeg(7)), cnic_photo_image_base64: b64(makeJpegVariant(7)),
      selfie_storage_key: 'providers/selfie-1',
    });
    const challenge = await svc.startLiveness(PROVIDER_USER);
    await svc.respondLiveness(PROVIDER_USER, String(challenge.challenge_id), challenge.actions);
    const frontDoc = db.documents.find((d) => d.doc_type === 'cnic_front');
    await svc.extractOcr(OFFICER_ID, { document_id: String(frontDoc?.id), side: 'front', full_name: 'Ali Khan' });
    const queue = await svc.reviewQueue();
    expect(queue.items).toHaveLength(3);
    const selfieItem = queue.items.find((i) => i.doc_type === 'selfie');
    expect(selfieItem?.face_match?.verdict).toBe('likely_match');
    expect(selfieItem?.face_match?.is_real_biometric).toBe(false);
    expect(selfieItem?.liveness?.status).toBe('passed');
    expect(selfieItem?.ocr_extractions).toHaveLength(1);
    expect(selfieItem?.ocr_extractions[0].ocr_confidence).toBeNull();
    // tier is untouched by every assist in this module
    expect(selfieItem?.tier).toBe(0);
    const evidence = await svc.evidenceForProvider(PROVIDER_ID);
    expect(evidence.rule).toContain('AdminService.decideVerification');
    expect(evidence.face_match).not.toBeNull();
  });
});
