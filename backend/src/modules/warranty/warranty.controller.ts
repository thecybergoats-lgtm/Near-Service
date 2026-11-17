// Warranty — user-facing routes (Phase 4, item 4).
// All routes live under the global /api/v1 prefix (see main.ts).
// Validation failures are 422 VALIDATION_FAILED via the global pipe.
// The published rules endpoint is public; everything else needs auth.
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { WarrantyService } from './warranty.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/guards/public.decorator';
import { CursorQueryDto, IsMoney } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export class FileClaimDto {
  @IsString() @MaxLength(60) reason!: string;
  @IsString() @MaxLength(2000) description!: string;
}

export class ClaimNoteDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class QuoteQueryDto {
  @IsMoney() @IsNumber() job_price_pkr!: number;
}

export class ClaimsQueryDto extends CursorQueryDto {}

@Controller()
export class WarrantyController {
  constructor(private svc: WarrantyService) {}

  /** Published warranty rules — public, so a customer can read them
   *  before opting in. Served from the DB-seeded, admin-editable text. */
  @Public() @Get('warranty/rules') rules() {
    return this.svc.getRules();
  }

  /** Fee quote for a job price, before opting in. */
  @Get('warranty/quote') quote(@Query() q: QuoteQueryDto) {
    return this.svc.quoteFee(q.job_price_pkr);
  }

  /** Opt in at booking. Tier 3 (Trusted Pro) only — any other tier is
   *  rejected with 422 WARRANTY_TIER_NOT_ELIGIBLE. No money moves here;
   *  the fee is collected at payment via collect-fee. */
  @Post('jobs/:id/warranty/opt-in') @HttpCode(201) optIn(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.svc.optIn(id, u.id, key);
  }

  /** Collect the warranty fee at payment time (job COMPLETED or
   *  PAYMENT_SETTLED). Balanced ledger: D wallet / C warranty_fee_rev. */
  @Post('jobs/:id/warranty/collect-fee') @HttpCode(200) collectFee(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.svc.collectFee(id, u.id, key);
  }

  @Get('jobs/:id/warranty') warranty(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getWarranty(id, u.id, u.roles);
  }

  /** Job receipt: job price, warranty fee, coverage window, claim status. */
  @Get('jobs/:id/warranty/receipt') receipt(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getReceipt(id, u.id, u.roles);
  }

  /** Warranty badge for a provider card: Tier 3 shows WARRANTY_7_DAY. */
  @Get('providers/:id/warranty-badge') badge(@Param('id', uuidParamPipe) id: string) {
    return this.svc.providerBadge(id);
  }

  /** File a claim within 7 days of completion. Late claims are rejected
   *  with 422 WARRANTY_CLAIM_WINDOW_CLOSED. */
  @Post('jobs/:id/warranty/claims') @HttpCode(201) fileClaim(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Body() dto: FileClaimDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.svc.fileClaim(id, u.id, dto, new Date(), key);
  }

  @Get('warranty/claims/:id') getClaim(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getClaim(id, u.id, u.roles);
  }

  @Get('warranty/claims') listClaims(@CurrentUser() u: AuthUser, @Query() q: ClaimsQueryDto) {
    return this.svc.listClaimsForUser(u.id, q.limit ?? 20);
  }

  /** Customer/provider reports the rework is done (rework_offered ->
   *  rework_done). The customer then closes the claim. */
  @Post('warranty/claims/:id/rework-done') @HttpCode(200) reworkDone(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Body() dto: ClaimNoteDto,
  ) {
    const role = u.profile === 'provider' ? 'provider' : 'customer';
    return this.svc.reportReworkDone(id, u.id, role, dto.note);
  }

  /** Customer/provider reports rework failed or refused
   *  (rework_offered -> rework_failed). Only then can admin refund. */
  @Post('warranty/claims/:id/rework-failed') @HttpCode(200) reworkFailed(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Body() dto: ClaimNoteDto,
  ) {
    const role = u.profile === 'provider' ? 'provider' : 'customer';
    return this.svc.reportReworkFailed(id, u.id, role, dto.note);
  }

  /** Customer closes a claim after successful rework
   *  (rework_done -> closed). */
  @Post('warranty/claims/:id/close') @HttpCode(200) close(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Body() dto: ClaimNoteDto,
  ) {
    return this.svc.closeClaim(id, u.id, 'customer', dto.note);
  }
}
