import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsMoney as IsMoneyVal, CursorQueryDto, ToBoolean } from '../../common/validation/validators';

export const PARTNER_ORDER_STATUSES = ['placed', 'confirmed', 'delivered', 'cancelled'] as const;
export const CATALOG_CATEGORIES = ['ac_parts', 'hardware', 'electrical', 'plumbing'] as const;

export class CatalogQueryDto extends CursorQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsString() @MaxLength(24) category?: string;
  @IsOptional() @IsUUID() partner_id?: string;
  @IsOptional() @ToBoolean() in_stock_only?: boolean;
  /** Offset pagination for the catalog (cursor is accepted but unused). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class PartnerOrderLineDto {
  @IsUUID() catalog_item_id!: string;
  @IsInt() @Min(1) @Max(100) quantity!: number;
  /** Optional client price check: when present it must equal the catalog
   *  price, else 422 PRICE_MISMATCH. The server always prices the order. */
  @IsOptional() @IsMoneyVal() unit_price_pkr?: number;
  @IsOptional() @IsMoneyVal() line_total_pkr?: number;
}

export class CreatePartnerOrderDto {
  @IsUUID() job_id!: string;
  @ValidateNested({ each: true })
  @Type(() => PartnerOrderLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  items!: PartnerOrderLineDto[];
  /** Optional client total check: when present it must equal the sum of
   *  catalog-priced lines, else 422 ORDER_TOTAL_MISMATCH. */
  @IsOptional() @IsMoneyVal() total_pkr?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class CancelPartnerOrderDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class CreatePartnerDto {
  @IsString() @MaxLength(200) name!: string;
  @IsString() @MaxLength(60) slug!: string;
  @IsOptional() @IsString() @MaxLength(24) kind?: string;
  @IsOptional() @IsString() @MaxLength(200) contact_name?: string;
  @IsOptional() @IsString() @MaxLength(20) contact_phone?: string;
  @IsOptional() @IsString() @MaxLength(500) website?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(0.99) affiliate_fee_rate?: number;
}

export class UpdatePartnerDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(24) kind?: string;
  @IsOptional() @IsString() @MaxLength(200) contact_name?: string;
  @IsOptional() @IsString() @MaxLength(20) contact_phone?: string;
  @IsOptional() @IsString() @MaxLength(500) website?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(0.99) affiliate_fee_rate?: number;
  @IsOptional() is_active?: boolean;
}

export class CreateCatalogItemDto {
  @IsUUID() partner_id!: string;
  @IsString() @MaxLength(60) sku!: string;
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(24) category?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsMoneyVal() unit_price_pkr!: number;
  @IsInt() @Min(0) @Max(100000) stock_qty!: number;
}

export class UpdateCatalogItemDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(24) category?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsMoneyVal() unit_price_pkr?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000) stock_qty?: number;
  @IsOptional() is_active?: boolean;
}

export class AdminOrdersQueryDto extends CursorQueryDto {
  @IsOptional() @IsString() @MaxLength(12) status?: string;
  @IsOptional() @IsUUID() partner_id?: string;
  @IsOptional() @IsUUID() job_id?: string;
  /** Offset pagination for the admin list (cursor is accepted but unused). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class AffiliateFeeReportQueryDto {
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsUUID() partner_id?: string;
}
