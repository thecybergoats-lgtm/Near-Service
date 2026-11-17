import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { SubscriptionsService, PLAN_CODES } from './subscriptions.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { CursorQueryDto, IsMoney, ToNumber } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { Roles } from '../../common/guards/roles.decorator';

export class SubscribeDto {
  @IsEnum([...PLAN_CODES]) plan_code!: 'free' | 'pro' | 'business';
}
export class ChangePlanDto {
  @IsEnum([...PLAN_CODES]) plan_code!: 'free' | 'pro' | 'business';
}
export class AnalyticsQueryDto {
  @IsOptional() @ToNumber() @IsInt() @Min(1) @Max(365) days?: number;
}
export class CreatePlanDto {
  @IsString() @MaxLength(20) code!: string;
  @IsString() @MaxLength(100) name!: string;
  @IsMoney() price_pkr!: number;
  @IsNumber() @Min(0.01) @Max(1) commission_multiplier!: number;
  @IsInt() @Min(0) @Max(100) max_staff_accounts!: number;
  @IsBoolean() featured!: boolean;
  @IsBoolean() analytics_enabled!: boolean;
}
export class UpdatePlanDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsMoney() price_pkr?: number;
  @IsOptional() @IsNumber() @Min(0.01) @Max(1) commission_multiplier?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) max_staff_accounts?: number;
  @IsOptional() @IsBoolean() featured?: boolean;
  @IsOptional() @IsBoolean() analytics_enabled?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

@Controller()
export class SubscriptionsController {
  constructor(private svc: SubscriptionsService) {}

  @Get('subscription-plans') listPlans() { return this.svc.listPlans(); }

  @Get('subscriptions/me') mine(@CurrentUser() u: AuthUser) { return this.svc.getMySubscription(u.id); }

  @Post('subscriptions') @HttpCode(201) subscribe(@CurrentUser() u: AuthUser, @Body() dto: SubscribeDto) {
    return this.svc.subscribe(u.id, dto.plan_code);
  }

  @Post('subscriptions/change') @HttpCode(200) change(@CurrentUser() u: AuthUser, @Body() dto: ChangePlanDto) {
    return this.svc.changePlan(u.id, dto.plan_code);
  }

  @Post('subscriptions/cancel') @HttpCode(200) cancel(@CurrentUser() u: AuthUser) {
    return this.svc.cancel(u.id);
  }

  @Get('subscriptions/me/analytics') analytics(@CurrentUser() u: AuthUser, @Query() q: AnalyticsQueryDto) {
    return this.svc.getAnalytics(u.id, q.days ?? 30);
  }

  // ---- Admin plan management ----
  @Roles('super_admin', 'finance') @Post('admin/subscription-plans') @HttpCode(201)
  createPlan(@Body() dto: CreatePlanDto) { return this.svc.createPlan(dto); }

  @Roles('super_admin', 'finance') @Patch('admin/subscription-plans/:id')
  updatePlan(@Param('id', uuidParamPipe) id: string, @Body() dto: UpdatePlanDto) {
    return this.svc.updatePlan(id, dto);
  }

  @Roles('super_admin', 'finance') @Get('admin/subscriptions')
  listSubscriptions(@Query() q: CursorQueryDto) { return this.svc.listSubscriptionsAdmin(q.cursor, q.limit ?? 20); }

  @Roles('super_admin', 'finance') @Post('admin/subscriptions/expire') @HttpCode(200)
  expire() { return this.svc.expireEndedSubscriptions(); }
}
