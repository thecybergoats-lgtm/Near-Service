# Verification — face-match + liveness + OCR assist (Phase 3, items 6–7)

## Honesty statement — read this first

There is **no real biometric or OCR vendor in this environment, and none
is claimed**. Everything in this module is a local, deterministic assist:

| Feature | What actually runs | What it is NOT |
|---|---|---|
| Face-match | `LocalHeuristicFaceMatchProvider`: byte-histogram / size / brightness similarity of the two submitted image files | NOT face recognition, NOT a biometric match. It cannot tell whether two photos show the same person. |
| Liveness | Server-issued random 3-action challenge; the client's reported observations are checked for order and expiry | NOT on-device ML liveness. A passed challenge is supporting evidence only. |
| OCR | Manual-transcription pre-fill + image-enhancement suggestions. No text is extracted from any image; `ocr_confidence` is always `null` | NOT OCR. Nothing here reads a CNIC photo. |

Every face-match result carries `is_real_biometric: false` and
`recommendation: 'officer_decides'`. **Verification stays manual
approval**: this module never changes `provider_profiles.tier` and never
touches `provider_documents.review_status`. A human verification officer
decides, via the existing `AdminService.decideVerification`
(`POST /api/v1/admin/verifications/:id/decide`).

## Production vendor — what the user must create

To get a production-grade provider, the user must create **one** of
these accounts (pick one; the code change is the same shape either way):

### Recommended: AWS Rekognition — CompareFaces + FaceLiveness
- Account: an **AWS account** (aws.amazon.com) with billing enabled,
  then IAM credentials with only `rekognition:CompareFaces` and
  `rekognition:StartFaceLivenessSession / GetFaceLivenessSessionResults`.
- Cost estimate (us-east-1, Nov 2026 list prices — verify before
  committing): CompareFaces **$0.001 per comparison** after the free tier
  (first 5,000 face comparisons/month free for 12 months); FaceLiveness
  **$0.01 per liveness session** (no free tier). At 1,000 provider
  verifications/month: ~$1 CompareFaces (free-tier covered) + ~$10
  liveness ≈ **$10–11/month**. No monthly minimum.
- Code change: implement `FaceMatchProvider` (`face-match.ts`) with the
  AWS SDK `CompareFacesCommand` (similarity threshold 80, per AWS
  guidance) and a liveness service around `StartFaceLivenessSession`;
  register it with `VerificationService.setFaceMatchProvider()`. The
  local heuristic stays as the fallback when the vendor is unreachable —
  its results must still be labelled `is_real_biometric: false`.
- Also needed: an S3 bucket for the selfie / CNIC photos (the vendor
  reads from storage keys, not base64) and `STORAGE_UPLOAD_BASE_URL`
  pointed at presigned S3 uploads (already the repo's production upload
  design — see `ProvidersService.requestDocumentUpload`).

### Alternative: Google Cloud Vision (face detection is NOT a match)
Cloud Vision has no 1:1 face-match API, so it is **not** a drop-in for
face-match. It can do OCR (Document Text Detection, ~$1.50/1,000 pages
after 1,000 free pages/month) for the OCR-assist side only. If the team
picks Vision for OCR, keep AWS Rekognition (or a NADRA-verified e-KYC
vendor in Pakistan) for face-match/liveness.

### Alternative (Pakistan e-KYC): NADRA / bank-grade e-KYC vendor
For a CNIC-authoritative check, a NADRA-integrated e-KYC provider
(e.g. via a Pakistani fintech partner) is the only route that verifies
the CNIC number itself against NADRA. No such vendor is integrated
here; pricing is quoted per verification by the vendor and must be
confirmed commercially before promising it. This module's OCR assist
does **not** verify a CNIC against NADRA.

## Files

- `face-match.ts` — `FaceMatchProvider` interface + local heuristic
  (histogram cosine / size / brightness; identical bytes → score 1.0
  but verdict `uncertain` + `duplicate_submission: true`).
- `liveness.ts` — challenge generation, in-order action check, expiry /
  3-attempt rule (pure functions).
- `ocr.ts` — CNIC field validation, pre-fill builder, enhancement
  suggestions (pure functions).
- `verification.service.ts` — DB-backed flows (see below).
- `verification.controller.ts` — routes (see below).
- `dto.ts` — class-validator DTOs (invalid input → 422
  `VALIDATION_FAILED`, repo convention).
- `verification.module.ts` — Nest module (NOT yet imported by
  `AppModule` — integrator step).

## DB — `db/0014_verification.sql` (additive only)

- `face_match_results` — score, verdict, duplicate flag, engine,
  `is_real_biometric`, officer decision/note, `reviewed_by`.
- `liveness_challenges` — required `actions` (jsonb), observed actions,
  status `pending|passed|failed|expired`, attempts, expiry.
- `ocr_extractions` — `extracted_fields` (manual transcription),
  `corrected_fields`, `missing_fields`, `enhancement_suggestions`,
  `ocr_confidence` (NULL locally), status
  `needs_officer_review|confirmed|corrected|rejected`.
- The advisory score is also mirrored onto the reserved
  `provider_documents.face_match_score` column (0001) when a
  `selfie_storage_key` is supplied. `review_status` is never touched.

## Flow

1. Provider uploads `selfie` + `cnic_front` via the existing
   `POST /providers/me/documents/upload-request` (unchanged).
2. Provider posts both images (base64, ≤ 2 MiB each) to
   `POST /verification/face-match` → advisory score + verdict, stored.
3. Provider starts `POST /verification/liveness/start` (3 random
   actions, 5-min expiry, 3 attempts) and posts observed actions to
   `POST /verification/liveness/:id/respond`.
4. Officer opens `GET /verification/review-queue` — each pending
   document pre-filled with the latest face-match, liveness and OCR
   extraction for that provider — and runs OCR assist
   (`POST /verification/ocr/extract`, then `POST /verification/ocr/:id/confirm`
   with the typed transcription).
5. Officer may override a face-match result
   (`POST /verification/face-match/:id/override`): the decision is
   stored + audited, the score is never rewritten, and a second
   override is rejected (409 `FACE_MATCH_ALREADY_OVERRIDDEN`).
6. Officer decides the case in the EXISTING flow
   (`POST /api/v1/admin/verifications/:id/decide`) — the only place a
   tier change happens.

## Integration point (for the integrator)

- Add `VerificationModule` to `AppModule` imports (one line).
- Add the 10 routes below to `backend/openapi.yaml` (v1.5.0).
- Optional, later: in `AdminService.decideVerification`, call
  `VerificationService.evidenceForProvider(providerId)` and attach the
  result to the officer view / audit payload as supporting evidence.
  Do NOT let any of the three assists auto-approve: the tier upgrade
  must stay gated on the officer's explicit `approved` decision.
- `GET /verification/providers/:id/evidence` already returns that
  summary for the admin UI.

## Routes (base `/api/v1`; integrator: add all to openapi.yaml)

| Method | Path | Roles | Body / response |
|---|---|---|---|
| POST | `/verification/face-match` | provider | `FaceMatchDto` {selfie_image_base64, cnic_photo_image_base64, selfie_storage_key?, cnic_photo_storage_key?} → `FaceMatchResult` {id, provider_id, face_match_score, verdict, duplicate_submission, engine, is_real_biometric, recommendation:'officer_decides', officer_decision, detail{histogram_cosine, size_similarity, brightness_similarity}} |
| GET | `/verification/face-match/:id` | provider (own) / super_admin / verification_officer | `FaceMatchResult` |
| POST | `/verification/face-match/:id/override` | super_admin / verification_officer | `FaceMatchOverrideDto` {decision: accept_as_match \| reject_as_no_match, note?} → `FaceMatchResult` |
| POST | `/verification/liveness/start` | provider | → {challenge_id, provider_id, actions[3], status:'pending', attempts_allowed:3, attempts_used:0, expires_at} |
| POST | `/verification/liveness/:id/respond` | provider | `LivenessRespondDto` {observed_actions[]} → {challenge_id, status, passed, reason, attempts_used, attempts_allowed, expires_at} |
| GET | `/verification/liveness/:id` | provider (own) / super_admin / verification_officer | {challenge_id, provider_id, actions, observed_actions, status, attempts_used, attempts_allowed, expires_at, completed_at} |
| POST | `/verification/ocr/extract` | super_admin / verification_officer | `OcrExtractDto` {document_id, side: front\|back, transcribed fields?} → `OcrExtraction` {id, document_id, provider_id, side, engine:'local-manual-assist', extracted_fields, corrected_fields:null, missing_fields, enhancement_suggestions, ocr_confidence:null, status:'needs_officer_review'} |
| POST | `/verification/ocr/:id/confirm` | super_admin / verification_officer | `OcrConfirmDto` {decision: confirmed\|corrected\|rejected, corrected fields?, note?} → `OcrExtraction` |
| GET | `/verification/review-queue` | super_admin / verification_officer | {items[{document_id, provider_id, doc_type, storage_key, face_match_score_on_document, review_status, display_name, tier, phone, face_match, liveness, ocr_extractions}], next_cursor} — cursor pagination, limit 1..100 |
| GET | `/verification/providers/:id/evidence` | super_admin / verification_officer | {provider_id, face_match, liveness, ocr_extractions, rule} |

Error codes used: `VALIDATION_FAILED` (422), `NOT_FOUND` (404),
`FORBIDDEN` (403, another provider's result), `INVALID_STORAGE_KEY` (422),
`LIVENESS_CHALLENGE_CLOSED` (409), `FACE_MATCH_ALREADY_OVERRIDDEN`
(409), `OCR_ALREADY_DECIDED` (409). Liveness expiry inside a response
returns `status:'expired'` with `reason:'expired'` (no throw) and the
challenge row is marked expired.

## Privacy

Only SHA-256 hashes of the submitted images are stored
(`selfie_sha256`, `cnic_photo_sha256`); raw image bytes are never
written to the DB or to logs. Face-match / liveness / OCR rows are
verification evidence, not public data — reads are restricted to the
owning provider and to `super_admin` / `verification_officer`.

## Tests

- `backend/test/unit/verification.spec.ts` — pure functions + service
  against a FakeDb (no live DB): score behaviour, duplicate detection,
  liveness challenge flow (order, expiry, 3-attempt lockout),
  OCR pre-fill + validation, officer override preserved, tier/review
  untouched.
- `backend/test/integration/verification.spec.ts` — real Postgres
  (own DB `nearservice_p3_verify`): migration applies, end-to-end
  face-match → liveness → OCR → override → review queue. Skipped
  when `DATABASE_URL` is unset. Run with `--runInBand`.
