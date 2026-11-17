import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RiskService, RiskSettings } from './risk.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { IsEnum, IsInt, IsObject, IsOptional, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CursorQueryDto } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { RISK_SIGNALS, RiskSignal } from '../../common/utils/risk-scoring';

export class RecordRiskEventDto {
  @IsUUID() user_id!: string;
  @IsEnum(RISK_SIGNALS) signal!: RiskSignal;
  @IsOptional() @IsUUID() job_id?: string;
  @IsOptional() @IsObject() detail?: Record<string, unknown>;
}

export class RiskWeightsDto {
  @IsOptional() @IsInt() @Min(0) @Max(50) cancellation?: number;
  @IsOptional() @IsInt() @Min(0) @Max(50) no_show?: number;
  @IsOptional() @IsInt() @Min(0) @Max(50) upheld_dispute?: number;
  @IsOptional() @IsInt() @Min(0) @Max(50) device_change?: number;
  @IsOptional() @IsInt() @Min(0) @Max(50) sim_change?: number;
  @IsOptional() @IsInt() @Min(0) @Max(50) mock_location?: number;
  @IsOptional() @IsInt() @Min(0) @Max(50) teleport?: number;
  @IsOptional() @IsInt() @Min(0) @Max(50) duplicate_account?: number;
  @IsOptional() @IsInt() @Min(0) @Max(50) payout_account_reuse?: number;
  @IsOptional() @IsInt() @Min(0) @Max(50) velocity?: number;
  @IsOptional() @IsInt() @Min(0) @Max(50) report?: number;
  @IsOptional() @IsInt() @Min(0) @Max(50) ledger_anomaly?: number;
}

export class UpdateRiskSettingsDto {
  @IsOptional() @ValidateNested() @Type(() => RiskWeightsDto) weights?: RiskWeightsDto;
  @IsOptional() @IsInt() @Min(0) @Max(100) review_threshold?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) block_threshold?: number;
  @IsOptional() @IsInt() @Min(0) @Max(720) hold_hours?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) window_days?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) velocity_max_requests_per_hour?: number;
}

export class RiskEventsQueryDto extends CursorQueryDto {
  @IsOptional() @IsEnum(RISK_SIGNALS) signal?: RiskSignal;
}

@Controller()
export class RiskController {
  constructor(private svc: RiskService) {}

  /** Own risk score (any signed-in user). Never 404s for a real user:
   *  a never-scored user gets score 0 / level low. */
  @Get('risk/me') myScore(@CurrentUser() u: AuthUser) {
    return this.svc.getScore(u.id);
  }

  @Roles('super_admin', 'support_agent')
  @Get('risk/users/:id')
  userScore(@Param('id', uuidParamPipe) id: string) {
    return this.svc.getScore(id);
  }

  @Roles('super_admin', 'support_agent')
  @Post('risk/users/:id/recompute')
  recompute(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.recomputeScore(id, u.id);
  }

  @Roles('super_admin', 'support_agent')
  @Get('risk/users/:id/events')
  userEvents(@Param('id', uuidParamPipe) id: string, @Query() q: RiskEventsQueryDto) {
    return this.svc.listEvents(id, { signal: q.signal, cursor: q.cursor, limit: q.limit ?? 20 });
  }

  /** Record one signal occurrence for a user (operator-reported signals:
   *  no-show, SIM change, mock location, reports). The score is recomputed
   *  immediately and the change audited. */
  @Roles('super_admin', 'support_agent')
  @Post('risk/events')
  recordEvent(@CurrentUser() u: AuthUser, @Body() dto: RecordRiskEventDto) {
    return this.svc.recordEvent(u.id, {
      user_id: dto.user_id,
      signal: dto.signal,
      job_id: dto.job_id ?? null,
      detail: dto.detail ?? null,
    });
  }

  /** Stored-score ranking penalty for one user — the read the ranking
   *  integration calls (see risk.module.ts). Never recomputes. */
  @Roles('super_admin', 'support_agent')
  @Get('risk/users/:id/ranking-penalty')
  rankingPenalty(@Param('id', uuidParamPipe) id: string) {
    return this.svc.rankingPenaltyForUser(id);
  }

  /** Job-level risk roll-up for admin fraud review. */
  @Roles('super_admin', 'support_agent')
  @Get('risk/jobs/:id')
  jobScore(@Param('id', uuidParamPipe) id: string) {
    return this.svc.scoreJob(id);
  }

  @Roles('super_admin', 'support_agent')
  @Get('admin/risk/review-queue')
  reviewQueue(@Query() q: CursorQueryDto) {
    return this.svc.listReviewQueue({ cursor: q.cursor, limit: q.limit ?? 20 });
  }

  @Roles('super_admin', 'support_agent')
  @Get('admin/risk/settings')
  settings() {
    return this.svc.getSettings();
  }

  @Roles('super_admin', 'support_agent')
  @Patch('admin/risk/settings')
  updateSettings(@CurrentUser() u: AuthUser, @Body() dto: UpdateRiskSettingsDto) {
    const patch: Partial<RiskSettings> = {};
    if (dto.weights) patch.weights = dto.weights as RiskSettings['weights'];
    if (dto.review_threshold !== undefined) patch.review_threshold = dto.review_threshold;
    if (dto.block_threshold !== undefined) patch.block_threshold = dto.block_threshold;
    if (dto.hold_hours !== undefined) patch.hold_hours = dto.hold_hours;
    if (dto.window_days !== undefined) patch.window_days = dto.window_days;
    if (dto.velocity_max_requests_per_hour !== undefined) patch.velocity_max_requests_per_hour = dto.velocity_max_requests_per_hour;
    return this.svc.updateSettings(u.id, patch);
  }
}
