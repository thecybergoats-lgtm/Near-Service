// Escrow + payouts — user-facing routes (Phase 3, item 8).
// All routes live under the global /api/v1 prefix (see main.ts).
// Validation failures are 422 VALIDATION_FAILED via the global pipe.
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsDateString, IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { EscrowService } from './escrow.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { CursorQueryDto, IsMoney } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export class RequestPayoutDto {
  @IsMoney() amount_pkr!: number;
  @IsEnum(['jazzcash', 'easypaisa']) method!: 'jazzcash' | 'easypaisa';
  @IsString() @Matches(/^\+92\d{10}$/, { message: 'destination_phone must be +92 followed by 10 digits' }) destination_phone!: string;
  @IsEnum(['instant', 'scheduled']) kind!: 'instant' | 'scheduled';
  // Required when kind='scheduled' (enforced in the service as 422
  // PAYOUT_SCHEDULE_MISSING); must be a future time.
  @IsOptional() @IsDateString() scheduled_for?: string | null;
}

export class EscrowHoldsQueryDto extends CursorQueryDto {}
export class PayoutsQueryDto extends CursorQueryDto {}

@Controller()
export class EscrowController {
  constructor(private svc: EscrowService) {}

  /** Hold the job amount in escrow. Customer only, job must be COMPLETED
   *  and at/above the admin-set high-value threshold (default PKR 5,000).
   *  Funds leave the customer's spendable wallet balance immediately. */
  @Post('jobs/:id/escrow/hold') @HttpCode(201) hold(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.svc.createHold(id, u.id, key);
  }

  /** Customer confirms completion: release the hold to the provider
   *  (provider gets amount - commission). Blocked while a dispute is open. */
  @Post('escrow/holds/:id/release') @HttpCode(200) release(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.svc.releaseHold(id, u.id, key);
  }

  @Get('escrow/holds/:id') getHold(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getHold(id, u.id);
  }

  @Get('escrow/holds') listHolds(@CurrentUser() u: AuthUser, @Query() q: EscrowHoldsQueryDto) {
    return this.svc.listHolds(u.id, q.limit ?? 20);
  }

  /** Request a provider payout. Creates status 'requested' (instant) or
   *  'scheduled' (scheduled) — NOT executed: finance must approve first
   *  (POST /admin/payouts/:id/approve). No money moves at request time.
   *  Execution is SANDBOX ONLY (see escrow.service.ts header). */
  @Post('payouts') @HttpCode(201) requestPayout(
    @CurrentUser() u: AuthUser,
    @Body() dto: RequestPayoutDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.svc.requestPayout(u.id, dto, key);
  }

  @Get('payouts/:id') getPayout(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getPayout(id, u.id);
  }

  @Get('payouts') listPayouts(@CurrentUser() u: AuthUser, @Query() q: PayoutsQueryDto) {
    return this.svc.listPayouts(u.id, q.limit ?? 20);
  }
}
