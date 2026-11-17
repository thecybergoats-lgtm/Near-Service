// Warranty — admin routes (Phase 4, item 4).
// Roles: super_admin / finance / support_agent (claim review + decisions
// are support/finance work; config + rules are finance/admin work).
//
// ADMIN INTEGRATION POINT (for the integrator — admin/ is NOT edited here):
// the admin Next.js app must call these endpoints (see
// docs/phase4-warranty.md and admin/src/app/warranty/page.tsx, which is
// a ready-made page awaiting a nav entry + lib wiring):
//   GET    /api/v1/admin/warranty/claims?status=filed — claims queue
//   POST   /api/v1/admin/warranty/claims/:id/review        — filed -> under_review
//   POST   /api/v1/admin/warranty/claims/:id/offer-rework  — under_review -> rework_offered
//   POST   /api/v1/admin/warranty/claims/:id/reject        — filed|under_review -> rejected (reason required)
//   POST   /api/v1/admin/warranty/claims/:id/approve-refund — rework_failed -> refunded (reason required; moves money)
//   GET    /api/v1/admin/warranty/config
//   PATCH  /api/v1/admin/warranty/config   — fee rate/flat/min/max (PKR in, paisa stored), claim window days
//   GET    /api/v1/admin/warranty/rules
//   PUT    /api/v1/admin/warranty/rules    — new versioned rules text
//   POST   /api/v1/admin/warranty/expire-due — sweep expired warranties (schedule daily)
// Every admin decision records a reason and an audit_logs row in the
// same transaction as the state change.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { WarrantyService } from './warranty.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { CursorQueryDto } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export class UpdateWarrantyConfigDto {
  @IsOptional() @IsNumber() @Min(0) @Max(0.5) fee_rate?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000) fee_flat_pkr?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000) fee_min_pkr?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000) fee_max_pkr?: number;
  @IsOptional() @IsInt() @Min(1) @Max(30) claim_window_days?: number;
}

export class ClaimDecisionDto {
  @IsString() @MaxLength(1000) reason!: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class UpdateRulesDto {
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(20000) body_md!: string;
}

export class AdminClaimsQueryDto extends CursorQueryDto {
  @IsOptional() @IsString() @MaxLength(20) status?: string;
}

const ADMIN_ROLES = ['super_admin', 'finance', 'support_agent'] as const;

@Controller('admin')
export class WarrantyAdminController {
  constructor(private svc: WarrantyService) {}

  @Roles(...ADMIN_ROLES) @Get('warranty/claims') claims(@Query() q: AdminClaimsQueryDto) {
    return this.svc.listAdminClaims(q.status, q.limit ?? 50);
  }

  @Roles(...ADMIN_ROLES) @Post('warranty/claims/:id/review') @HttpCode(200) review(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
  ) {
    return this.svc.reviewClaim(id, u.id);
  }

  @Roles(...ADMIN_ROLES) @Post('warranty/claims/:id/offer-rework') @HttpCode(200) offerRework(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Body() dto: ClaimDecisionDto,
  ) {
    return this.svc.offerRework(id, u.id, 'admin', dto.note ?? dto.reason);
  }

  @Roles(...ADMIN_ROLES) @Post('warranty/claims/:id/reject') @HttpCode(200) reject(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Body() dto: ClaimDecisionDto,
  ) {
    return this.svc.rejectClaim(id, u.id, dto.reason);
  }

  @Roles(...ADMIN_ROLES) @Post('warranty/claims/:id/approve-refund') @HttpCode(200) approveRefund(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Body() dto: ClaimDecisionDto,
  ) {
    return this.svc.approveRefund(id, u.id, dto.reason);
  }

  @Roles('super_admin', 'finance') @Get('warranty/config') config() {
    return this.svc.getConfig();
  }

  @Roles('super_admin', 'finance') @Patch('warranty/config') updateConfig(
    @CurrentUser() u: AuthUser,
    @Body() dto: UpdateWarrantyConfigDto,
  ) {
    const patch: Record<string, number> = {};
    if (dto.fee_rate !== undefined) patch.fee_rate = dto.fee_rate;
    if (dto.fee_flat_pkr !== undefined) patch.fee_flat_paisa = Math.round(dto.fee_flat_pkr * 100);
    if (dto.fee_min_pkr !== undefined) patch.fee_min_paisa = Math.round(dto.fee_min_pkr * 100);
    if (dto.fee_max_pkr !== undefined) patch.fee_max_paisa = Math.round(dto.fee_max_pkr * 100);
    if (dto.claim_window_days !== undefined) patch.claim_window_days = dto.claim_window_days;
    return this.svc.updateConfig(u.id, patch);
  }

  @Roles('super_admin', 'finance') @Get('warranty/rules') rules() {
    return this.svc.getRules();
  }

  @Roles('super_admin', 'finance') @Put('warranty/rules') @HttpCode(200) updateRules(
    @CurrentUser() u: AuthUser,
    @Body() dto: UpdateRulesDto,
  ) {
    return this.svc.updateRules(u.id, dto.title, dto.body_md);
  }

  /** Expire warranties whose 7-day window has passed. Call daily. */
  @Roles('super_admin', 'finance') @Post('warranty/expire-due') @HttpCode(200) expireDue() {
    return this.svc.expireWarranties();
  }
}
