import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { PromotionsService } from './promotions.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { CursorQueryDto, IsMoney } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export class ValidatePromoDto {
  @IsString() @IsNotEmpty() @MaxLength(40) code!: string;
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsMoney() amount_pkr?: number;
}
export class ClaimReferralDto { @IsString() @IsNotEmpty() @MaxLength(40) code!: string; }
export class CreatePromoDto {
  @IsString() @IsNotEmpty() @MaxLength(40) code!: string;
  @IsEnum(['percent', 'fixed']) kind!: 'percent' | 'fixed';
  // percent: 0 < value <= 100; fixed: PKR money. The service validates the
  // kind-specific bound; the DTO enforces the shared money bound.
  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() @Max(10000000) value!: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000000) max_uses?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(1000) per_user_limit?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) per_device_limit?: number;
  @IsOptional() @IsUUID() category_id?: string | null;
  @IsOptional() @IsUUID() city_id?: string | null;
  @IsOptional() @IsBoolean() first_job_only?: boolean;
  @IsOptional() @IsDateString() valid_from?: string | null;
  @IsOptional() @IsDateString() valid_to?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
export class UpdatePromoDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() @Max(10000000) value?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000000) max_uses?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(1000) per_user_limit?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) per_device_limit?: number;
  @IsOptional() @IsDateString() valid_to?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsBoolean() first_job_only?: boolean;
}

@Controller()
export class PromotionsController {
  constructor(private svc: PromotionsService) {}

  // Validation is side-effect free — no redemption is recorded here.
  @Post('promos/validate') @HttpCode(200) validate(
    @CurrentUser() u: AuthUser,
    @Body() dto: ValidatePromoDto,
    @Headers('x-device-fingerprint') device?: string,
  ) {
    return this.svc.validatePromo({ code: dto.code, categoryId: dto.category_id, amountPkr: dto.amount_pkr, userId: u.id, deviceFingerprint: device });
  }

  @Get('referrals/me') referralMe(@CurrentUser() u: AuthUser) { return this.svc.getReferralInfo(u.id); }

  @Post('referrals/claim') @HttpCode(200) claimReferral(@CurrentUser() u: AuthUser, @Body() dto: ClaimReferralDto) {
    return this.svc.claimReferral(u.id, dto.code);
  }

  @Roles('super_admin', 'marketing') @Get('admin/promos') listPromos(@Query() q: CursorQueryDto) { return this.svc.listPromos(q.cursor, q.limit ?? 20); }
  @Roles('super_admin', 'marketing') @Post('admin/promos') @HttpCode(201) createPromo(@Body() dto: CreatePromoDto) { return this.svc.createPromo(dto); }
  @Roles('super_admin', 'marketing') @Patch('admin/promos/:id') updatePromo(@Param('id', uuidParamPipe) id: string, @Body() dto: UpdatePromoDto) { return this.svc.updatePromo(id, dto); }
}
