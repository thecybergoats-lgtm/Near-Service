// OCR assist for verification officers (Phase 3, verification item 7).
//
// HONESTY: there is NO OCR engine or vendor in this environment, so no
// text is ever extracted from an image here and no OCR confidence is ever
// claimed. `buildOcrPrefill` produces a PRE-FILL TEMPLATE for the officer
// review queue: the CNIC fields an officer must fill in (front/back),
// which fields are still missing, and image-enhancement suggestions that
// help the officer read a poor photo (grayscale, contrast, deskew, crop,
// retake). When the officer types the values in, they are stored as
// `source: 'manual_transcription'` with `ocr_confidence: null` — never
// dressed up as machine OCR. A production OCR vendor (Google Cloud
// Vision, AWS Textract, or NADRA-verified e-KYC) fills the same
// `extracted_fields` shape with real `ocr_confidence` values; see
// README.md. Officers decide; OCR only assists.

import { isValidCnic } from '../../common/utils/cnic';
import { Errors } from '../../common/errors/api-error';

export type CnicSide = 'front' | 'back';

export interface CnicFields {
  cnic_number?: string;
  full_name?: string;
  father_name?: string;
  date_of_birth?: string;
  date_of_issue?: string;
  date_of_expiry?: string;
  gender?: string;
}

export const CNIC_FRONT_FIELDS = ['cnic_number', 'full_name', 'father_name', 'date_of_birth', 'gender'] as const;
export const CNIC_BACK_FIELDS = ['cnic_number', 'date_of_issue', 'date_of_expiry'] as const;

export function expectedFieldsForSide(side: CnicSide): readonly string[] {
  return side === 'front' ? CNIC_FRONT_FIELDS : CNIC_BACK_FIELDS;
}

/** Image-enhancement suggestions for a hard-to-read CNIC photo. These are
 *  display hints for the officer / the mobile retake screen, not image
 *  processing — no image bytes are transformed server-side. */
export function enhancementSuggestions(side: CnicSide): string[] {
  const common = [
    'Convert to grayscale and raise contrast before reading',
    'Deskew: rotate so the card edges are horizontal',
    'Crop tightly to the card edges; remove background clutter',
    'Retake in daylight with no flash glare on the laminate',
  ];
  return side === 'front'
    ? [...common, 'Zoom the photo area: the face must not cover the printed name']
    : [...common, 'Zoom the issue/expiry dates: they sit in small print on the back'];
}

export interface FieldValidationError {
  field: string;
  message: string;
}

/** Validate manually transcribed CNIC fields. Returns every problem found
 *  (empty array = valid). Pure function; unit-tested directly. */
export function validateCnicFields(fields: CnicFields): FieldValidationError[] {
  const errors: FieldValidationError[] = [];
  if (fields.cnic_number !== undefined && !isValidCnic(fields.cnic_number)) {
    errors.push({ field: 'cnic_number', message: 'CNIC must be 13 digits (xxxxx-xxxxxxx-x)' });
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (const f of ['date_of_birth', 'date_of_issue', 'date_of_expiry'] as const) {
    const v = fields[f];
    if (v !== undefined && !dateRe.test(v)) {
      errors.push({ field: f, message: `${f} must be YYYY-MM-DD` });
    } else if (v !== undefined) {
      const d = new Date(`${v}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
        errors.push({ field: f, message: `${f} is not a real calendar date` });
      }
    }
  }
  if (fields.date_of_birth) {
    const dob = new Date(`${fields.date_of_birth}T00:00:00Z`);
    if (!Number.isNaN(dob.getTime()) && dob > new Date()) {
      errors.push({ field: 'date_of_birth', message: 'date_of_birth cannot be in the future' });
    }
  }
  if (fields.date_of_issue && fields.date_of_expiry) {
    if (fields.date_of_expiry <= fields.date_of_issue) {
      errors.push({ field: 'date_of_expiry', message: 'date_of_expiry must be after date_of_issue' });
    }
  }
  if (fields.gender !== undefined && !['male', 'female', 'other'].includes(fields.gender.toLowerCase())) {
    errors.push({ field: 'gender', message: "gender must be 'male', 'female' or 'other'" });
  }
  if (fields.full_name !== undefined && fields.full_name.trim().length < 2) {
    errors.push({ field: 'full_name', message: 'full_name is too short' });
  }
  if (fields.father_name !== undefined && fields.father_name.trim().length < 2) {
    errors.push({ field: 'father_name', message: 'father_name is too short' });
  }
  return errors;
}

export interface OcrPrefill {
  engine: 'local-manual-assist';
  /** Always null locally: no OCR ran, so no OCR confidence exists. */
  ocr_confidence: null;
  side: CnicSide;
  /** Fields the officer has supplied so far, each tagged with its source. */
  extracted_fields: Record<string, { value: string; source: 'manual_transcription' }>;
  /** Expected fields for this side that are still empty. */
  missing_fields: string[];
  enhancement_suggestions: string[];
}

/** Build the pre-fill for one CNIC side from whatever the officer has
 *  transcribed so far (possibly nothing). Throws 422 VALIDATION_FAILED
 *  when a supplied field fails validation — the error names the field. */
export function buildOcrPrefill(side: CnicSide, transcribed: CnicFields = {}): OcrPrefill {
  const errors = validateCnicFields(transcribed);
  if (errors.length) {
    throw Errors.unprocessable(
      'VALIDATION_FAILED',
      'Transcribed CNIC fields failed validation',
      { fields: Object.fromEntries(errors.map((e) => [e.field, [e.message]])) },
    );
  }
  const expected = expectedFieldsForSide(side);
  const extracted_fields: OcrPrefill['extracted_fields'] = {};
  for (const field of expected) {
    const value = (transcribed as Record<string, string | undefined>)[field];
    if (value !== undefined && value !== '') {
      extracted_fields[field] = { value, source: 'manual_transcription' };
    }
  }
  return {
    engine: 'local-manual-assist',
    ocr_confidence: null,
    side,
    extracted_fields,
    missing_fields: expected.filter((f) => !(f in extracted_fields)),
    enhancement_suggestions: enhancementSuggestions(side),
  };
}
