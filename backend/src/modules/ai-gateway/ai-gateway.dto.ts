import { IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ToNumber } from '../../common/validation/validators';

export class ParseIntentDto {
  @IsString() @IsNotEmpty() @MaxLength(1000) text!: string;
}

export class PhotoSearchDto {
  @IsOptional() @IsString() @MaxLength(500) media_key?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(50, { each: true }) tags?: string[];
}

export class VoiceSearchDto {
  /** Transcript from on-device speech recognition (Urdu/Roman Urdu). */
  @IsOptional() @IsString() @MaxLength(1000) transcript?: string;
  /** Storage key of an audio clip — local provider cannot transcribe it. */
  @IsOptional() @IsString() @MaxLength(500) audio_key?: string;
  @IsOptional() @IsString() @IsIn(['ur', 'ur-roman', 'en']) language?: string;
}

export class FairPriceQueryDto {
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsString() @MaxLength(100) category_slug?: string;
  @IsOptional() @IsUUID() city_id?: string;
  @IsOptional() @ToNumber() @IsNumber() @IsInt() @Min(1) @Max(100000) quantity?: number;
}

export class SetTranslationPrefDto {
  @IsOptional() @IsEnum(['ur', 'en']) target_lang?: 'ur' | 'en' | null;
  @IsBoolean() auto_translate!: boolean;
}

export class TranslateMessageDto {
  @IsEnum(['ur', 'en']) target_lang!: 'ur' | 'en';
}
