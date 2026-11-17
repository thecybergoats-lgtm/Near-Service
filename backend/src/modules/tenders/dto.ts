import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsMoney as IsMoneyVal, CursorQueryDto } from '../../common/validation/validators';

export const ORGANIZATION_TYPES = ['SCHOOL', 'OFFICE', 'SHOP', 'OTHER'] as const;
export const TENDER_STATUSES = ['OPEN', 'QUOTES_RECEIVED', 'AWARDED', 'CANCELLED', 'EXPIRED'] as const;

export class TenderItemDto {
  @IsString() @MaxLength(200) label!: string;
  @IsInt() @Min(1) @Max(100000) quantity!: number;
  @IsMoneyVal() unit_price!: number; // PKR
  @IsMoneyVal() line_total!: number; // PKR, must equal quantity * unit_price
}

export class CreateTenderDto {
  @IsUUID() request_id!: string;
  @IsString() @MaxLength(200) organization_name!: string;
  @IsEnum([...ORGANIZATION_TYPES]) organization_type!: string;
  @IsString() @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  /** Must be in the future; the service rejects a past deadline with 422. */
  @IsDateString() delivery_deadline!: string;
}

export class SubmitQuoteDto {
  @ValidateNested({ each: true })
  @Type(() => TenderItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  items!: TenderItemDto[];
  /** Must equal the sum of items[].line_total (service checks, 422). */
  @IsMoneyVal() total_price!: number; // PKR
  @IsOptional() @IsInt() @Min(1) @Max(365) eta_days?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsInt() @Min(1) @Max(90) validity_days?: number;
}

export class ListTendersQueryDto extends CursorQueryDto {
  @IsOptional() @IsEnum([...TENDER_STATUSES]) status?: string;
}
