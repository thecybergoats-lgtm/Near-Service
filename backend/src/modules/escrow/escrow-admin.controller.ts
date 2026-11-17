// Escrow + payouts — finance/admin routes (Phase 3, item 8).
// Roles: super_admin / finance (same as commission rules + reconciliation).
//
// ADMIN INTEGRATION POINT (for the integrator — admin/ is NOT edited here):
// the admin Next.js app must call these endpoints for the finance queue:
//   GET    /api/v1/admin/payouts?status=requested   — payouts awaiting approval
//   POST   /api/v1/admin/payouts/:id/approve        — approve; instant payouts
//          execute immediately (sandbox), scheduled ones become 'approved'
//   POST   /api/v1/admin/payouts/:id/reject         — reject (no money moves)
//   GET    /api/v1/admin/escrow/holds?status=held   — open escrow holds
//   POST   /api/v1/admin/escrow/holds/:id/release   — finance release override
//   POST   /api/v1/admin/escrow/auto-release        — sweep due holds (schedule hourly)
//   POST   /api/v1/admin/payouts/run-due             — execute due scheduled payouts
//          (schedule every 15 minutes)
//   GET    /api/v1/admin/escrow/config
//   PATCH  /api/v1/admin/escrow/config              — auto-release hours,
//          min escrow amount, payout fee + tax
// Every payout response carries sandbox: true until a live gateway lands;
// the admin UI must show that and never present a sandbox payout as real.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { EscrowService } from './escrow.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { CursorQueryDto } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export class UpdateEscrowConfigDto {
  @IsOptional() @IsInt() @Min(1) @Max(720) auto_release_hours?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) min_amount_pkr?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000) payout_fee_flat_pkr?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(0.5) payout_fee_rate?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(0.5) payout_tax_rate?: number;
}

export class RejectPayoutDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class AdminEscrowQueryDto extends CursorQueryDto {
  @IsOptional() @IsString() @MaxLength(20) status?: string;
}

@Controller('admin')
export class EscrowAdminController {
  constructor(private svc: EscrowService) {}

  @Roles('super_admin', 'finance') @Get('escrow/config') config() {
    return this.svc.getConfig();
  }

  @Roles('super_admin', 'finance') @Patch('escrow/config') updateConfig(
    @CurrentUser() u: AuthUser,
    @Body() dto: UpdateEscrowConfigDto,
  ) {
    // DTO carries PKR for the min amount / flat fee; the service stores
    // paisa — convert here so the service API stays in paisa.
    const patch: Record<string, number> = {};
    if (dto.auto_release_hours !== undefined) patch.auto_release_hours = dto.auto_release_hours;
    if (dto.min_amount_pkr !== undefined) patch.min_amount_paisa = Math.round(dto.min_amount_pkr * 100);
    if (dto.payout_fee_flat_pkr !== undefined) patch.payout_fee_flat_paisa = Math.round(dto.payout_fee_flat_pkr * 100);
    if (dto.payout_fee_rate !== undefined) patch.payout_fee_rate = dto.payout_fee_rate;
    if (dto.payout_tax_rate !== undefined) patch.payout_tax_rate = dto.payout_tax_rate;
    return this.svc.updateConfig(u.id, patch);
  }

  @Roles('super_admin', 'finance') @Get('escrow/holds') holds(@Query() q: AdminEscrowQueryDto) {
    return this.svc.listAdminHolds(q.status, q.limit ?? 50);
  }

  @Roles('super_admin', 'finance') @Get('payouts') payouts(@Query() q: AdminEscrowQueryDto) {
    return this.svc.listAdminPayouts(q.status, q.limit ?? 50);
  }

  @Roles('super_admin', 'finance') @Post('payouts/:id/approve') @HttpCode(200) approve(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
  ) {
    return this.svc.approvePayout(id, u.id);
  }

  @Roles('super_admin', 'finance') @Post('payouts/:id/reject') @HttpCode(200) reject(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Body() dto: RejectPayoutDto,
  ) {
    return this.svc.rejectPayout(id, u.id, dto.reason);
  }

  @Roles('super_admin', 'finance') @Post('escrow/holds/:id/release') @HttpCode(200) releaseHold(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
  ) {
    return this.svc.releaseHoldAsAdmin(id, u.id);
  }

  /** Auto-release sweep. Call on a schedule (e.g. hourly). Releases every
   *  held hold past its deadline with no open dispute; holds with an open
   *  dispute are reported under skipped_dispute and left held. */
  @Roles('super_admin', 'finance') @Post('escrow/auto-release') @HttpCode(200) autoRelease() {
    return this.svc.releaseDueHolds();
  }

  /** Execute due scheduled payouts (approved + scheduled_for passed).
   *  Call on a schedule (e.g. every 15 minutes). */
  @Roles('super_admin', 'finance') @Post('payouts/run-due') @HttpCode(200) runDue() {
    return this.svc.executeDuePayouts();
  }
}
