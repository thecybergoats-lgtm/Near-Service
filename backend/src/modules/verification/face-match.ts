// Face-match provider interface + LOCAL heuristic implementation
// (Phase 3, verification items 6–7).
//
// HONESTY: there is NO real biometric vendor in this environment and none
// is invented here. `LocalHeuristicFaceMatchProvider` is NOT face
// recognition: it compares two image byte streams with a deterministic
// histogram / size / brightness heuristic and returns an ADVISORY score.
// It can tell "these two files look alike at the byte level" and "these
// two files are byte-identical" — it cannot tell "these are the same
// person". Every result is labelled `is_real_biometric: false` and
// `recommendation: 'officer_decides'`; a human verification officer must
// always make the decision (see VerificationService + README.md).
// A production-grade provider (AWS Rekognition CompareFaces, or an
// equivalent) is a drop-in behind the `FaceMatchProvider` interface:
// implement `compare()` against the vendor SDK and register it in
// VerificationModule — no controller or service change is needed.

import * as crypto from 'crypto';
import { Errors } from '../../common/errors/api-error';

export type FaceMatchVerdict = 'likely_match' | 'uncertain' | 'likely_no_match';

export interface FaceMatchInput {
  /** Raw image bytes of the live selfie. */
  selfie: Buffer;
  /** Raw image bytes of the CNIC photo (cropped face from cnic_front). */
  cnicPhoto: Buffer;
}

export interface FaceMatchResult {
  provider_name: string;
  /** True only for a real biometric vendor. False for the local heuristic. */
  is_real_biometric: boolean;
  /** Advisory similarity, 0..1 (3 decimals). NOT a biometric confidence. */
  face_match_score: number;
  verdict: FaceMatchVerdict;
  /** True when both inputs are byte-identical: the same file was submitted
   *  twice, which proves nothing about identity and must go to an officer. */
  duplicate_submission: boolean;
  /** Always 'officer_decides' for the local heuristic. */
  recommendation: 'officer_decides';
  selfie_sha256: string;
  cnic_photo_sha256: string;
  detail: { histogram_cosine: number; size_similarity: number; brightness_similarity: number };
}

export interface FaceMatchProvider {
  readonly providerName: string;
  readonly isRealBiometric: boolean;
  compare(input: FaceMatchInput): Promise<FaceMatchResult>;
}

export const FACE_MATCH_THRESHOLDS = { likelyMatch: 0.8, uncertain: 0.6 } as const;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MIN_IMAGE_BYTES = 1024;

const IMAGE_MAGIC: { format: string; test: (b: Buffer) => boolean }[] = [
  { format: 'jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { format: 'png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { format: 'gif', test: (b) => b.length >= 6 && b.toString('ascii', 0, 6).startsWith('GIF8') },
  {
    format: 'webp',
    test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
];

/** Decode + validate one base64 image. 422 VALIDATION_FAILED on bad base64,
 *  non-image bytes, or a size outside 1 KiB..2 MiB. Never logs the bytes. */
export function decodeBase64Image(base64: string, field: string): Buffer {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/=_-]+$/.test(base64.replace(/\s/g, ''))) {
    throw Errors.unprocessable('VALIDATION_FAILED', `${field} must be base64 image data`);
  }
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < MIN_IMAGE_BYTES) {
    throw Errors.unprocessable('VALIDATION_FAILED', `${field} is too small to be a photo (minimum ${MIN_IMAGE_BYTES} bytes)`);
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    throw Errors.unprocessable('VALIDATION_FAILED', `${field} exceeds the 2 MiB photo limit`);
  }
  if (!IMAGE_MAGIC.some((m) => m.test(buf))) {
    throw Errors.unprocessable('VALIDATION_FAILED', `${field} is not a JPEG, PNG, GIF or WebP image`);
  }
  return buf;
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export interface ImageFingerprint {
  sha256: string;
  byteLength: number;
  /** Normalised 256-bucket byte histogram (sums to 1). */
  histogram: number[];
  mean: number;
}

export function fingerprintImage(buf: Buffer): ImageFingerprint {
  const histogram = new Array<number>(256).fill(0);
  let sum = 0;
  for (const byte of buf) {
    histogram[byte] += 1;
    sum += byte;
  }
  const n = buf.length;
  return { sha256: sha256Hex(buf), byteLength: n, histogram: histogram.map((c) => c / n), mean: sum / n };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function verdictForScore(score: number): FaceMatchVerdict {
  if (score >= FACE_MATCH_THRESHOLDS.likelyMatch) return 'likely_match';
  if (score >= FACE_MATCH_THRESHOLDS.uncertain) return 'uncertain';
  return 'likely_no_match';
}

/** Deterministic comparison of two fingerprints. Pure function — the unit
 *  tests exercise exactly this, with no DB and no network. */
export function compareFingerprints(a: ImageFingerprint, b: ImageFingerprint): Omit<FaceMatchResult, 'provider_name' | 'is_real_biometric' | 'recommendation'> {
  const histogramCosine = cosineSimilarity(a.histogram, b.histogram);
  const sizeSimilarity = Math.min(a.byteLength, b.byteLength) / Math.max(a.byteLength, b.byteLength);
  const brightnessSimilarity = 1 - Math.abs(a.mean - b.mean) / 255;
  const duplicate = a.sha256 === b.sha256;
  const raw = 0.65 * histogramCosine + 0.2 * sizeSimilarity + 0.15 * brightnessSimilarity;
  const score = duplicate ? 1 : Number(raw.toFixed(3));
  return {
    face_match_score: score,
    verdict: duplicate ? 'uncertain' : verdictForScore(score),
    duplicate_submission: duplicate,
    selfie_sha256: a.sha256,
    cnic_photo_sha256: b.sha256,
    detail: {
      histogram_cosine: Number(histogramCosine.toFixed(4)),
      size_similarity: Number(sizeSimilarity.toFixed(4)),
      brightness_similarity: Number(brightnessSimilarity.toFixed(4)),
    },
  };
}

export class LocalHeuristicFaceMatchProvider implements FaceMatchProvider {
  readonly providerName = 'local-heuristic';
  readonly isRealBiometric = false;

  async compare(input: FaceMatchInput): Promise<FaceMatchResult> {
    const selfie = fingerprintImage(input.selfie);
    const cnicPhoto = fingerprintImage(input.cnicPhoto);
    return {
      provider_name: this.providerName,
      is_real_biometric: false,
      recommendation: 'officer_decides',
      ...compareFingerprints(selfie, cnicPhoto),
    };
  }
}
