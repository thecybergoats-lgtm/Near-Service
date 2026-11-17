import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AtLeastOneCategory, IsLat, IsLng, IsMoney, LatLngDto, ValidServiceArea } from '../../common/validation/validators';

export class OnboardingDto {
  @IsEnum(['identity', 'business', 'service_area', 'payout']) step!: string;
  @IsObject() data!: Record<string, unknown>;
  // Flat legacy fields are NOT accepted: the v1.1 contract is {step, data}.
}
export class DocumentUploadDto {
  @IsEnum(['cnic_front', 'cnic_back', 'selfie', 'shop_photo', 'certificate']) doc_type!: string;
}
export class OnlineDto {
  @IsBoolean() is_online!: boolean;
  @IsOptional() @IsLat() lat?: number;
  @IsOptional() @IsLng() lng?: number;
}
export class UploadReceiverDto {
  @IsOptional() @IsString() @MaxLength(120) content_type?: string;
}

export const PROVIDER_SERVICE_ITEM_MAX = 50; // service enforces <= 50

/** One entry of PUT /providers/me/services. At least one category ref. */
@AtLeastOneCategory()
export class ProviderServiceItemDto {
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsString() @MaxLength(100) category_slug?: string;
  @IsOptional() @IsMoney() starting_price?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class ServicesDto {
  @IsArray() @ArrayMaxSize(PROVIDER_SERVICE_ITEM_MAX)
  @ValidateNested({ each: true }) @Type(() => ProviderServiceItemDto)
  services!: ProviderServiceItemDto[];
}

// OpenAPI v1.2: exactly one of (center + radius_km) or polygon; both or
// neither is 422 VALIDATION_FAILED.
@ValidServiceArea()
export class ServiceAreaDto {
  @IsOptional() @ValidateNested() @Type(() => LatLngDto) center?: LatLngDto;
  @IsOptional() @IsNumber() @Min(0.5) @Max(100) radius_km?: number;
  @IsOptional() @IsObject() polygon?: Record<string, unknown>;
}

export class AvailabilitySlotDto {
  @IsInt() @Min(0) @Max(6) weekday!: number;
  @IsOptional() @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'opens must be HH:MM (24h)' }) opens?: string | null;
  @IsOptional() @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'closes must be HH:MM (24h)' }) closes?: string | null;
  @IsOptional() @IsBoolean() is_day_off?: boolean;
}

export class AvailabilityDto {
  @IsArray() @ArrayMaxSize(7) // service enforces <= 7 (one slot per weekday)
  @ValidateNested({ each: true }) @Type(() => AvailabilitySlotDto)
  slots!: AvailabilitySlotDto[];
}
