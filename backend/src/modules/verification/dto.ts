// DTOs for the verification module (Phase 3). Class-validator, following
// repo convention: invalid input is 422 VALIDATION_FAILED via the global
// ValidationPipe — never Nest's default 400.
import { IsArray, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ArrayMaxSize, ArrayMinSize } from 'class-validator';
import { LIVENESS_ACTIONS } from './liveness';

export class FaceMatchDto {
  /** Base64 JPEG/PNG/GIF/WebP of the live selfie (1 KiB..2 MiB decoded). */
  @IsString() @IsNotEmpty() @MaxLength(3_000_000) selfie_image_base64!: string;
  /** Base64 image of the CNIC photo (face cropped from cnic_front). */
  @IsString() @IsNotEmpty() @MaxLength(3_000_000) cnic_photo_image_base64!: string;
  /** Optional audit link: storage_key of the selfie document (must belong
   *  to this provider; issued by POST /providers/me/documents/upload-request). */
  @IsOptional() @IsString() @MaxLength(300) selfie_storage_key?: string;
  /** Optional audit link: storage_key of the cnic_front document. */
  @IsOptional() @IsString() @MaxLength(300) cnic_photo_storage_key?: string;
}

export class LivenessRespondDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12)
  @IsEnum(LIVENESS_ACTIONS as unknown as string[], { each: true })
  observed_actions!: string[];
}

export class OcrExtractDto {
  @IsUUID() document_id!: string;
  @IsEnum(['front', 'back']) side!: 'front' | 'back';
  /** Manual transcription typed by the officer so far (may be empty on
   *  first extract — the response then lists every field as missing). */
  @IsOptional() @IsString() @MaxLength(17) cnic_number?: string;
  @IsOptional() @IsString() @MaxLength(120) full_name?: string;
  @IsOptional() @IsString() @MaxLength(120) father_name?: string;
  @IsOptional() @IsString() @MaxLength(10) date_of_birth?: string;
  @IsOptional() @IsString() @MaxLength(10) date_of_issue?: string;
  @IsOptional() @IsString() @MaxLength(10) date_of_expiry?: string;
  @IsOptional() @IsString() @MaxLength(10) gender?: string;
}

export class OcrConfirmDto {
  /** Corrected / completed transcription. Every supplied field is
   *  re-validated; an invalid field is 422 naming that field. */
  @IsOptional() @IsString() @MaxLength(17) cnic_number?: string;
  @IsOptional() @IsString() @MaxLength(120) full_name?: string;
  @IsOptional() @IsString() @MaxLength(120) father_name?: string;
  @IsOptional() @IsString() @MaxLength(10) date_of_birth?: string;
  @IsOptional() @IsString() @MaxLength(10) date_of_issue?: string;
  @IsOptional() @IsString() @MaxLength(10) date_of_expiry?: string;
  @IsOptional() @IsString() @MaxLength(10) gender?: string;
  /** 'confirmed' = transcription accepted as-is; 'corrected' = the officer
   *  changed one or more fields; 'rejected' = the document is unreadable. */
  @IsEnum(['confirmed', 'corrected', 'rejected']) decision!: 'confirmed' | 'corrected' | 'rejected';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class FaceMatchOverrideDto {
  /** The officer's decision stands even when it contradicts the score:
   *  the score is advisory only. Stored on the result row and in
   *  audit_logs; the score itself is never rewritten. */
  @IsEnum(['accept_as_match', 'reject_as_no_match']) decision!: 'accept_as_match' | 'reject_as_no_match';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
