// Verification service (Phase 3, items 6–7): automated face-match +
// liveness + OCR assist.
//
// WHAT THIS MODULE DOES — and what it deliberately does NOT do:
//  * Face-match: advisory score from the local heuristic provider
//    (face-match.ts). Stored in `face_match_results` AND mirrored onto
//    the reserved `provider_documents.face_match_score` column from
//    0001_init.sql. The score NEVER approves or rejects anything.
//  * Liveness: challenge/response records in `liveness_challenges`.
//    A passed challenge is supporting evidence only.
//  * OCR assist: pre-fill templates + manual transcription in
//    `ocr_extractions`, for the officer review queue. No OCR runs here.
//  * Officer override: a verification officer may accept or reject a
//    face-match result regardless of the score; the override is stored
//    and audited, the score is never rewritten.
//  * MANUAL APPROVAL IS PRESERVED: this module never changes
//    `provider_profiles.tier` and never touches
//    `provider_documents.review_status`. Tier upgrades still happen ONLY
//    through AdminService.decideVerification (POST
//    /api/v1/admin/verifications/:id/decide) — see
//    INTEGRATION POINT in README.md. The integrator wires that call to
//    read the face-match / liveness / OCR rows as supporting evidence.
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import {
  FaceMatchProvider,
  LocalHeuristicFaceMatchProvider,
  decodeBase64Image,
} from './face-match';
import {
  LivenessAction,
  LivenessStatus,
  checkLivenessResponse,
  generateChallengeActions,
  validateObservedActions,
  LIVENESS_MAX_ATTEMPTS,
  LIVENESS_TTL_SECONDS,
} from './liveness';
import { buildOcrPrefill, CnicFields, CnicSide, validateCnicFields } from './ocr';

type Row = Record<string, unknown>;

export interface FaceMatchView {
  id: unknown; provider_id: unknown; selfie_storage_key: unknown; cnic_photo_storage_key: unknown;
  face_match_score: number | null; verdict: unknown; duplicate_submission: unknown; engine: unknown;
  is_real_biometric: unknown; recommendation: 'officer_decides'; officer_decision: unknown;
  officer_note: unknown; reviewed_by: unknown; created_at: unknown;
  detail?: Record<string, unknown>;
}

export interface LivenessStartView {
  challenge_id: unknown; provider_id: unknown; actions: LivenessAction[]; status: unknown;
  attempts_allowed: number; attempts_used: number; expires_at: string;
}

export interface LivenessResponseView {
  challenge_id: unknown; provider_id: unknown; status: unknown; passed: boolean;
  reason: string; attempts_used: number; attempts_allowed: number; expires_at: unknown;
}

export interface OcrExtractionView {
  id: unknown; document_id: unknown; provider_id: unknown; side: unknown; engine: unknown;
  extracted_fields: Record<string, { value: string; source: string }>;
  corrected_fields: Record<string, string> | null;
  missing_fields: string[]; enhancement_suggestions: string[];
  ocr_confidence: number | null; status: unknown; reviewed_by: unknown; created_at: unknown;
}

function toNumber(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

@Injectable()
export class VerificationService {
  /** Default provider is the local heuristic (no vendor). Swap it with
   *  setFaceMatchProvider() — e.g. a real vendor implementation — without
   *  touching the controller or any other method. Kept out of the
   *  constructor so Nest can instantiate this service with only the
   *  DatabaseService (interfaces have no DI token). */
  private faceMatch: FaceMatchProvider = new LocalHeuristicFaceMatchProvider();

  constructor(private db: DatabaseService) {}

  setFaceMatchProvider(provider: FaceMatchProvider): void {
    this.faceMatch = provider;
  }

  private async providerIdForUser(userId: string): Promise<string> {
    const row = (await this.db.query<{ id: string }>(
      `SELECT id FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`,
      [userId],
    )).rows[0];
    if (!row) throw Errors.notFound('Provider profile');
    return row.id;
  }

  /** A storage_key counts as the provider's only when a provider_documents
   *  row for this provider carries it — a hand-typed or foreign key is
   *  rejected (same rule as TrustService.addEvidence, FIX 14c). */
  private async assertStorageKeyBelongsToProvider(providerId: string, storageKey: string, docType: string): Promise<void> {
    const row = (await this.db.query(
      `SELECT id FROM provider_documents WHERE provider_id=$1 AND storage_key=$2 AND doc_type=$3`,
      [providerId, storageKey, docType],
    )).rows[0];
    if (!row) {
      throw Errors.unprocessable('INVALID_STORAGE_KEY', `storage_key is not a ${docType} document for this provider`);
    }
  }

  // ---- (a) Face-match ----

  async submitFaceMatch(userId: string, dto: {
    selfie_image_base64: string;
    cnic_photo_image_base64: string;
    selfie_storage_key?: string;
    cnic_photo_storage_key?: string;
  }): Promise<FaceMatchView> {
    const providerId = await this.providerIdForUser(userId);
    if (dto.selfie_storage_key) await this.assertStorageKeyBelongsToProvider(providerId, dto.selfie_storage_key, 'selfie');
    if (dto.cnic_photo_storage_key) await this.assertStorageKeyBelongsToProvider(providerId, dto.cnic_photo_storage_key, 'cnic_front');
    const selfie = decodeBase64Image(dto.selfie_image_base64, 'selfie_image_base64');
    const cnicPhoto = decodeBase64Image(dto.cnic_photo_image_base64, 'cnic_photo_image_base64');
    const result = await this.faceMatch.compare({ selfie, cnicPhoto });
    const row = (await this.db.query(
      `INSERT INTO face_match_results
         (provider_id, selfie_storage_key, cnic_photo_storage_key, selfie_sha256, cnic_photo_sha256,
          face_match_score, verdict, duplicate_submission, engine, is_real_biometric)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [providerId, dto.selfie_storage_key ?? null, dto.cnic_photo_storage_key ?? null,
       result.selfie_sha256, result.cnic_photo_sha256, result.face_match_score,
       result.verdict, result.duplicate_submission, result.provider_name, result.is_real_biometric],
    )).rows[0] as Row;
    // Mirror the advisory score onto the reserved 0001 column so the
    // existing officer view (AdminService.verificationDetail) sees it.
    // This updates a column value only — review_status is untouched.
    if (dto.selfie_storage_key) {
      await this.db.query(
        `UPDATE provider_documents SET face_match_score=$2 WHERE provider_id=$1 AND storage_key=$3`,
        [providerId, result.face_match_score, dto.selfie_storage_key],
      );
    }
    return this.presentFaceMatch(row, result.detail);
  }

  async getFaceMatch(userId: string, id: string, roles: string[]): Promise<FaceMatchView> {
    const row = (await this.db.query(`SELECT * FROM face_match_results WHERE id=$1`, [id])).rows[0] as Row | undefined;
    if (!row) throw Errors.notFound('Face-match result');
    const isOfficer = roles.includes('super_admin') || roles.includes('verification_officer');
    if (!isOfficer) {
      const providerId = await this.providerIdForUser(userId);
      if (row.provider_id !== providerId) throw Errors.forbidden('Not your face-match result');
    }
    return this.presentFaceMatch(row);
  }

  async latestFaceMatchForProvider(providerId: string): Promise<FaceMatchView | null> {
    const row = (await this.db.query(
      `SELECT * FROM face_match_results WHERE provider_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [providerId],
    )).rows[0] as Row | undefined;
    return row ? this.presentFaceMatch(row) : null;
  }

  /** Officer override: the officer's decision is recorded and audited and
   *  it stands even when it contradicts the score. The score is NEVER
   *  rewritten — an override that silently changed the score would destroy
   *  the audit trail. */
  async overrideFaceMatch(officerId: string, id: string, decision: 'accept_as_match' | 'reject_as_no_match', note?: string): Promise<FaceMatchView> {
    const before = (await this.db.query(`SELECT * FROM face_match_results WHERE id=$1`, [id])).rows[0] as Row | undefined;
    if (!before) throw Errors.notFound('Face-match result');
    if (before.officer_decision) {
      throw Errors.conflict('FACE_MATCH_ALREADY_OVERRIDDEN', 'This face-match result already has an officer decision');
    }
    const updated = (await this.db.query(
      `UPDATE face_match_results SET officer_decision=$2, officer_note=$3, reviewed_by=$4, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, decision, note ?? null, officerId],
    )).rows[0] as Row;
    await this.db.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,'face_match_results',$3,$4,$5)`,
      [officerId, `verification.face_match.override:${decision}`, id,
       JSON.stringify({ officer_decision: before.officer_decision ?? null }),
       JSON.stringify({ officer_decision: decision, note: note ?? null })],
    );
    return this.presentFaceMatch(updated);
  }

  private presentFaceMatch(row: Row, detail?: Record<string, unknown>): FaceMatchView {
    return {
      id: row.id,
      provider_id: row.provider_id,
      selfie_storage_key: row.selfie_storage_key,
      cnic_photo_storage_key: row.cnic_photo_storage_key,
      face_match_score: toNumber(row.face_match_score),
      verdict: row.verdict,
      duplicate_submission: row.duplicate_submission,
      engine: row.engine,
      is_real_biometric: row.is_real_biometric,
      recommendation: 'officer_decides',
      officer_decision: row.officer_decision ?? null,
      officer_note: row.officer_note ?? null,
      reviewed_by: row.reviewed_by ?? null,
      created_at: row.created_at,
      ...(detail ? { detail } : {}),
    };
  }

  // ---- (a) Liveness ----

  async startLiveness(userId: string): Promise<LivenessStartView> {
    const providerId = await this.providerIdForUser(userId);
    const actions = generateChallengeActions();
    const row = (await this.db.query(
      `INSERT INTO liveness_challenges (provider_id, actions, status, attempts_allowed, expires_at)
       VALUES ($1,$2::jsonb,'pending',$3, now() + ($4 || ' seconds')::interval) RETURNING *`,
      [providerId, JSON.stringify(actions), LIVENESS_MAX_ATTEMPTS, String(LIVENESS_TTL_SECONDS)],
    )).rows[0] as Row;
    return {
      challenge_id: row.id,
      provider_id: row.provider_id,
      actions: row.actions as LivenessAction[],
      status: row.status,
      attempts_allowed: Number(row.attempts_allowed),
      attempts_used: 0,
      expires_at: String(row.expires_at),
    };
  }

  async respondLiveness(userId: string, challengeId: string, observedRaw: unknown): Promise<LivenessResponseView> {
    const observed = validateObservedActions(observedRaw);
    const providerId = await this.providerIdForUser(userId);
    const row = (await this.db.query(`SELECT * FROM liveness_challenges WHERE id=$1`, [challengeId])).rows[0] as Row | undefined;
    if (!row) throw Errors.notFound('Liveness challenge');
    if (row.provider_id !== providerId) throw Errors.forbidden('Not your liveness challenge');
    if (row.status !== 'pending') {
      throw Errors.conflict('LIVENESS_CHALLENGE_CLOSED', `Challenge is already ${String(row.status)}`);
    }
    const outcome = checkLivenessResponse({
      required: row.actions as LivenessAction[],
      observed,
      attemptsUsed: Number(row.attempts_used),
      expiresAt: new Date(String(row.expires_at)),
    });
    const attemptsUsed = Number(row.attempts_used) + 1;
    let status: LivenessStatus;
    if (outcome.passed) status = 'passed';
    else if (outcome.reason === 'expired') status = 'expired';
    else if (attemptsUsed >= LIVENESS_MAX_ATTEMPTS) status = 'failed';
    else status = 'pending';
    const updated = (await this.db.query(
      `UPDATE liveness_challenges SET observed_actions=$2::jsonb, attempts_used=$3, status=$4, completed_at=CASE WHEN $4::varchar IN ('passed','failed','expired') THEN now() ELSE completed_at END WHERE id=$1 RETURNING *`,
      [challengeId, JSON.stringify(observed), attemptsUsed, status],
    )).rows[0] as Row;
    return {
      challenge_id: updated.id,
      provider_id: updated.provider_id,
      status: updated.status,
      passed: updated.status === 'passed',
      reason: outcome.reason,
      attempts_used: Number(updated.attempts_used),
      attempts_allowed: Number(updated.attempts_allowed),
      expires_at: updated.expires_at,
    };
  }

  async getLiveness(userId: string, challengeId: string, roles: string[]) {
    const row = (await this.db.query(`SELECT * FROM liveness_challenges WHERE id=$1`, [challengeId])).rows[0] as Row | undefined;
    if (!row) throw Errors.notFound('Liveness challenge');
    const isOfficer = roles.includes('super_admin') || roles.includes('verification_officer');
    if (!isOfficer) {
      const providerId = await this.providerIdForUser(userId);
      if (row.provider_id !== providerId) throw Errors.forbidden('Not your liveness challenge');
    }
    return {
      challenge_id: row.id,
      provider_id: row.provider_id,
      actions: row.actions,
      observed_actions: row.observed_actions ?? null,
      status: row.status,
      attempts_used: Number(row.attempts_used),
      attempts_allowed: Number(row.attempts_allowed),
      expires_at: row.expires_at,
      completed_at: row.completed_at ?? null,
    };
  }

  async latestLivenessForProvider(providerId: string) {
    const row = (await this.db.query(
      `SELECT * FROM liveness_challenges WHERE provider_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [providerId],
    )).rows[0] as Row | undefined;
    if (!row) return null;
    return {
      challenge_id: row.id,
      status: row.status,
      attempts_used: Number(row.attempts_used),
      expires_at: row.expires_at,
      completed_at: row.completed_at ?? null,
    };
  }

  // ---- (b) OCR assist ----

  async extractOcr(officerId: string, dto: {
    document_id: string; side: CnicSide;
    cnic_number?: string; full_name?: string; father_name?: string;
    date_of_birth?: string; date_of_issue?: string; date_of_expiry?: string; gender?: string;
  }): Promise<OcrExtractionView> {
    const doc = (await this.db.query<{ id: string; provider_id: string; doc_type: string }>(
      `SELECT id, provider_id, doc_type FROM provider_documents WHERE id=$1`, [dto.document_id],
    )).rows[0];
    if (!doc) throw Errors.notFound('Document');
    const expectedDocType = dto.side === 'front' ? 'cnic_front' : 'cnic_back';
    if (doc.doc_type !== expectedDocType) {
      throw Errors.unprocessable('VALIDATION_FAILED', `side '${dto.side}' needs a ${expectedDocType} document, got ${doc.doc_type}`);
    }
    const transcribed: CnicFields = {};
    for (const f of ['cnic_number', 'full_name', 'father_name', 'date_of_birth', 'date_of_issue', 'date_of_expiry', 'gender'] as const) {
      if (dto[f] !== undefined) transcribed[f] = dto[f];
    }
    // buildOcrPrefill validates the transcription and throws 422 naming
    // the bad field; nothing is stored when it throws.
    const prefill = buildOcrPrefill(dto.side, transcribed);
    const row = (await this.db.query(
      `INSERT INTO ocr_extractions (document_id, provider_id, side, engine, extracted_fields, missing_fields, enhancement_suggestions, ocr_confidence, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'needs_officer_review') RETURNING *`,
      [dto.document_id, doc.provider_id, dto.side, prefill.engine, JSON.stringify(prefill.extracted_fields),
       prefill.missing_fields, prefill.enhancement_suggestions, null],
    )).rows[0] as Row;
    void officerId; // extraction is an assist record; the decision is logged on confirm.
    return this.presentOcr(row);
  }

  /** Officer confirms / corrects / rejects the transcription. The
   *  corrected fields are stored separately from the original extraction
   *  so the officer's changes are auditable; the original is never edited
   *  in place. */
  async confirmOcr(officerId: string, extractionId: string, dto: {
    decision: 'confirmed' | 'corrected' | 'rejected'; note?: string;
    cnic_number?: string; full_name?: string; father_name?: string;
    date_of_birth?: string; date_of_issue?: string; date_of_expiry?: string; gender?: string;
  }): Promise<OcrExtractionView> {
    const before = (await this.db.query(`SELECT * FROM ocr_extractions WHERE id=$1`, [extractionId])).rows[0] as Row | undefined;
    if (!before) throw Errors.notFound('OCR extraction');
    if (before.status !== 'needs_officer_review') {
      throw Errors.conflict('OCR_ALREADY_DECIDED', `OCR extraction is already ${String(before.status)}`);
    }
    const corrected: CnicFields = {};
    for (const f of ['cnic_number', 'full_name', 'father_name', 'date_of_birth', 'date_of_issue', 'date_of_expiry', 'gender'] as const) {
      if (dto[f] !== undefined) corrected[f] = dto[f];
    }
    const errors = validateCnicFields(corrected);
    if (errors.length) {
      throw Errors.unprocessable('VALIDATION_FAILED', 'Corrected CNIC fields failed validation', {
        fields: Object.fromEntries(errors.map((e) => [e.field, [e.message]])),
      });
    }
    if (dto.decision === 'corrected' && Object.keys(corrected).length === 0) {
      throw Errors.unprocessable('VALIDATION_FAILED', "decision 'corrected' needs at least one corrected field");
    }
    const updated = (await this.db.query(
      `UPDATE ocr_extractions SET corrected_fields=$2::jsonb, status=$3, reviewed_by=$4, updated_at=now() WHERE id=$1 RETURNING *`,
      [extractionId, JSON.stringify(corrected), dto.decision, officerId],
    )).rows[0] as Row;
    await this.db.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,'ocr_extractions',$3,$4,$5)`,
      [officerId, `verification.ocr.${dto.decision}`, extractionId,
       JSON.stringify({ status: before.status }),
       JSON.stringify({ status: dto.decision, note: dto.note ?? null })],
    );
    return this.presentOcr(updated);
  }

  async latestOcrForProvider(providerId: string) {
    const rows = (await this.db.query(
      `SELECT * FROM ocr_extractions WHERE provider_id=$1 ORDER BY created_at DESC, id DESC LIMIT 10`,
      [providerId],
    )).rows as Row[];
    return rows.map((r) => this.presentOcr(r));
  }

  private presentOcr(row: Row): OcrExtractionView {
    return {
      id: row.id,
      document_id: row.document_id,
      provider_id: row.provider_id,
      side: row.side,
      engine: row.engine,
      extracted_fields: (row.extracted_fields ?? {}) as Record<string, { value: string; source: string }>,
      corrected_fields: (row.corrected_fields ?? null) as Record<string, string> | null,
      missing_fields: (row.missing_fields ?? []) as string[],
      enhancement_suggestions: (row.enhancement_suggestions ?? []) as string[],
      ocr_confidence: row.ocr_confidence === null || row.ocr_confidence === undefined ? null : Number(row.ocr_confidence),
      status: row.status,
      reviewed_by: row.reviewed_by ?? null,
      created_at: row.created_at,
    };
  }

  // ---- Officer review queue (pre-filled) ----

  /** One queue item per pending provider document, pre-filled with the
   *  latest face-match score, the latest liveness outcome and the latest
   *  OCR pre-fill for that provider — so the officer sees the assists
   *  next to the documents, in one call. It does NOT decide anything:
   *  the officer still decides via AdminService.decideVerification. */
  async reviewQueue(cursor?: string, limit = 20) {
    const lim = Math.min(Math.max(limit || 20, 1), 100);
    const rows = (await this.db.query(
      `SELECT d.id AS document_id, d.provider_id, d.doc_type, d.storage_key, d.face_match_score, d.review_status, d.created_at,
              p.display_name, p.provider_type, p.tier, u.phone, u.full_name
       FROM provider_documents d JOIN provider_profiles p ON p.id=d.provider_id JOIN users u ON u.id=p.user_id
       WHERE d.review_status='pending'
         AND ($1::text IS NULL OR (d.created_at, d.id) < (SELECT created_at, id FROM provider_documents WHERE id=$1::uuid))
       ORDER BY d.created_at DESC, d.id DESC LIMIT $2`,
      [cursor ?? null, lim + 1],
    )).rows as Row[];
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    const items = [];
    for (const doc of page) {
      const providerId = String(doc.provider_id);
      items.push({
        document_id: doc.document_id,
        provider_id: providerId,
        doc_type: doc.doc_type,
        storage_key: doc.storage_key,
        face_match_score_on_document: toNumber(doc.face_match_score),
        review_status: doc.review_status,
        display_name: doc.display_name,
        provider_type: doc.provider_type,
        tier: Number(doc.tier),
        phone: doc.phone,
        full_name: doc.full_name,
        created_at: doc.created_at,
        face_match: await this.latestFaceMatchForProvider(providerId),
        liveness: await this.latestLivenessForProvider(providerId),
        ocr_extractions: await this.latestOcrForProvider(providerId),
      });
    }
    return { items, next_cursor: hasMore ? String(page[page.length - 1].document_id) : null };
  }

  /** Evidence summary the integrator reads when wiring
   *  AdminService.decideVerification: all three assists for one provider,
   *  with the explicit rule that none of them approves anything. */
  async evidenceForProvider(providerId: string) {
    return {
      provider_id: providerId,
      face_match: await this.latestFaceMatchForProvider(providerId),
      liveness: await this.latestLivenessForProvider(providerId),
      ocr_extractions: await this.latestOcrForProvider(providerId),
      rule: 'Advisory only. Tier changes happen ONLY via AdminService.decideVerification by a human officer.',
    };
  }
}
