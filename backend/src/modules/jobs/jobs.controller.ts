import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { JobsService } from './jobs.service';
import { JobsQueryService } from './jobs-query.service';
import { SchedulingService, RecurringJobInput } from './scheduling.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { JobState } from '../../common/utils/job-state-machine';
import { AtLeastOneCategory, CursorQueryDto, IsLat, IsLng, IsMoney } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export const JOB_STATE_VALUES = ['DRAFT', 'BROADCASTING', 'OFFERS_RECEIVED', 'ACCEPTED', 'PROVIDER_EN_ROUTE', 'CUSTOMER_EN_ROUTE', 'ITEM_PICKED_UP', 'ARRIVED', 'IN_PROGRESS', 'PRICE_ADJUSTMENT_PENDING', 'COMPLETED', 'PAYMENT_SETTLED', 'RATED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PROVIDER', 'EXPIRED', 'DISPUTED', 'REFUNDED'] as const;

export class TransitionDto {
  @IsEnum([...JOB_STATE_VALUES]) to_state!: JobState;
  @IsOptional() @IsLat() lat?: number;
  @IsOptional() @IsLng() lng?: number;
}

export class AdjustmentItemDto {
  @IsString() @IsNotEmpty() @MaxLength(200) label!: string;
  @IsMoney() amount!: number;
  @IsOptional() @IsString() @MaxLength(500) photo_key?: string;
}

export class AdjustmentDto {
  @IsArray() @ArrayMaxSize(50)
  @ValidateNested({ each: true }) @Type(() => AdjustmentItemDto)
  items!: AdjustmentItemDto[];
  @IsString() @IsNotEmpty() @MaxLength(2000) reason!: string;
}
export class DecideDto { @IsBoolean() approve!: boolean; }
export class ReviewDto {
  @IsInt() @Min(1) @Max(5) stars!: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}
export class RescheduleDto {
  @IsDateString() scheduled_at!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsBoolean() scope_changed?: boolean;
}
@AtLeastOneCategory()
export class RecurringJobDto {
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsString() @MaxLength(100) category_slug?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsObject() specs?: Record<string, unknown>;
  @IsEnum(['VISIT_SHOP', 'PROVIDER_COMES', 'PICKUP_DELIVERY']) fulfillment!: string;
  @IsLat() lat!: number;
  @IsLng() lng!: number;
  @IsOptional() @IsUUID() address_id?: string;
  @IsOptional() @IsMoney() customer_offer?: number;
  @IsEnum(['weekly', 'monthly']) frequency!: 'weekly' | 'monthly';
  @IsOptional() @IsInt() @Min(0) @Max(6) day_of_week?: number;
  @IsOptional() @IsInt() @Min(1) @Max(31) day_of_month?: number;
  @IsDateString() starts_at!: string;
  @IsOptional() @IsDateString() ends_at?: string;
}
export class RecurringPatchDto { @IsEnum(['active', 'paused', 'cancelled']) status!: 'active' | 'paused' | 'cancelled'; }

export class ListJobsQueryDto extends CursorQueryDto {
  @IsOptional() @IsEnum(['customer', 'provider']) role?: string;
  @IsOptional() @IsEnum([...JOB_STATE_VALUES]) state?: string;
}
export class ListRecurringQueryDto extends CursorQueryDto {}

@Controller()
export class JobsController {
  constructor(private svc: JobsService, private query: JobsQueryService, private scheduling: SchedulingService) {}
  @Post('jobs/:id/transition') @HttpCode(200) transition(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: TransitionDto, @Headers('idempotency-key') key?: string) { return this.svc.transitionIdempotent(id, u.id, dto.to_state, dto.lat, dto.lng, key); }
  @Post('jobs/:id/adjustments') adjustments(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: AdjustmentDto, @Headers('idempotency-key') key?: string) { return this.svc.createAdjustment(id, u.id, dto.items, dto.reason, key); }
  @Post('adjustments/:id/decide') @HttpCode(200) decide(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: DecideDto) { return this.svc.decideAdjustment(id, u.id, dto.approve); }
  @Post('jobs/:id/complete') @HttpCode(200) complete(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) { return this.svc.complete(id, u.id); }
  @Post('jobs/:id/confirm-payment') @HttpCode(200) confirmPayment(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Headers('idempotency-key') key?: string) { return this.svc.confirmPayment(id, u.id, key); }
  @Post('jobs/:id/reviews') review(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: ReviewDto) { return this.svc.review(id, u.id, dto.stars, dto.tags, dto.comment); }
  // ---- Phase 2: job queries, reschedule, tracking, recurring jobs ----
  @Get('jobs') listJobs(@CurrentUser() u: AuthUser, @Query() q: ListJobsQueryDto) {
    return this.query.listJobs(u.id, q.role, q.state, q.cursor, q.limit ?? 20);
  }
  @Get('jobs/:id') getJob(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) { return this.query.getJob(id, u.id); }
  @Get('jobs/:id/tracking') tracking(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) { return this.query.getTracking(id, u.id); }
  @Post('jobs/:id/reschedule') @HttpCode(200) reschedule(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: RescheduleDto, @Headers('idempotency-key') key?: string) {
    return this.scheduling.reschedule(id, u.id, dto, key);
  }
  @Post('recurring-jobs') createRecurring(@CurrentUser() u: AuthUser, @Body() dto: RecurringJobDto) {
    return this.scheduling.createRecurring(u.id, dto as RecurringJobInput);
  }
  @Get('recurring-jobs') listRecurring(@CurrentUser() u: AuthUser, @Query() q: ListRecurringQueryDto) {
    return this.scheduling.listRecurring(u.id, q.cursor, q.limit ?? 20);
  }
  @Patch('recurring-jobs/:id') patchRecurring(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: RecurringPatchDto) {
    return this.scheduling.patchRecurring(id, u.id, dto.status);
  }
  @Post('recurring-jobs/:id/skip-next') @HttpCode(200) skipNext(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.scheduling.skipNext(id, u.id);
  }
  /** Cron entry point: generate due recurring instances. No cron infra lives
   *  in this repo — an external scheduler must call this endpoint. */
  @Roles('super_admin', 'city_manager') @Post('admin/recurring-jobs/run-due') @HttpCode(200) runDue() {
    return this.scheduling.generateDueInstances(new Date());
  }
  /** Cron entry point (Fix B): close elapsed review windows — every
   *  PAYMENT_SETTLED job older than the review window (feature_flags
   *  `review_window_days`, default 7) moves to RATED. No cron infra lives
   *  in this repo — an external scheduler must call this endpoint nightly,
   *  same pattern as run-due above. Idempotent: a re-run closes nothing. */
  @Roles('super_admin', 'city_manager') @Post('admin/jobs/close-review-windows') @HttpCode(200) closeReviewWindows() {
    return this.svc.closeReviewWindows(new Date());
  }
}
