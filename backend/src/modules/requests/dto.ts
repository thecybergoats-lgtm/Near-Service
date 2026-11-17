import { IsDateString, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { AtLeastOneCategory, IsLat, IsLng, IsMoney } from '../../common/validation/validators';

export const FULFILLMENT_VALUES = ['VISIT_SHOP', 'PROVIDER_COMES', 'PICKUP_DELIVERY'] as const;

@AtLeastOneCategory()
export class CreateRequestDto {
  // v1.1: provide category_id (UUID) OR category_slug; both must agree (422).
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsString() @MaxLength(100) category_slug?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsObject() specs?: Record<string, unknown>;
  @IsEnum([...FULFILLMENT_VALUES]) fulfillment!: string;
  @IsLat() lat!: number;
  @IsLng() lng!: number;
  @IsOptional() @IsUUID() address_id?: string;
  @IsOptional() @IsDateString() scheduled_at?: string;
  @IsOptional() @IsMoney() customer_offer?: number; // PKR; null = get quotes
}
export class CreateOfferDto {
  @IsMoney() price!: number; // PKR
  @IsOptional() @IsInt() @Min(1) @Max(10080) eta_minutes?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsObject() breakdown?: Record<string, unknown>;
}
export class CounterOfferDto {
  @IsMoney() price!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class DeclineDto { @IsOptional() @IsString() @MaxLength(100) reason_code?: string; }
