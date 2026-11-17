import { Body, Controller, Get, Inject, Logger, Optional, Param, Patch, Post, Query } from '@nestjs/common';
import { AdminService, DisputeOutcome } from './admin.service';
import { Roles } from '../../common/guards/roles.decorator';
import { SearchCacheService } from '../search/search-cache.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { CursorQueryDto, IsMoney } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export class DecideDto {
  @IsEnum(['approved', 'rejected']) decision!: 'approved' | 'rejected';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class SuspendDto { @IsBoolean() suspended!: boolean; }
export class CreateCategoryDto {
  @IsString() @IsNotEmpty() @MaxLength(100) @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lowercase letters, digits and hyphens' }) slug!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) name_en!: string;
  @IsOptional() @IsString() @MaxLength(100) name_ur?: string;
  @IsOptional() @IsString() @MaxLength(100) name_roman?: string;
  @IsOptional() @IsUUID() parent_id?: string;
  @IsInt() @Min(1) @Max(5) level!: number;
  @IsOptional() @IsString() @MaxLength(100) icon_key?: string;
}
export class PatchCategoryDto {
  @IsOptional() @IsString() @MaxLength(100) name_en?: string;
  @IsOptional() @IsString() @MaxLength(100) name_ur?: string;
  @IsOptional() @IsString() @MaxLength(100) name_roman?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() sort_order?: number;
}
export class ResolveDisputeDto {
  @IsEnum(['refund', 'partial_refund', 'compensation', 'no_action']) outcome!: DisputeOutcome;
  @IsOptional() @IsMoney() amount_pkr?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class AssignDisputeDto { @IsUUID() assigned_to!: string; }

export class AdminLimitQueryDto extends CursorQueryDto {}
export class AdminRequestsQueryDto extends CursorQueryDto {
  @IsOptional() @IsString() @MaxLength(40) status?: string;
}
export class AdminDisputesQueryDto extends CursorQueryDto {
  @IsOptional() @IsString() @MaxLength(40) status?: string;
}

@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);
  constructor(
    private svc: AdminService,
    @Optional() @Inject(SearchCacheService) private searchCache?: SearchCacheService,
  ) {}

  /** Phase 4, item 1 (search scale-out): cached search results can be at
   *  most TTL-seconds stale after a category write. Best-effort — a cache
   *  failure must never fail the admin write. */
  private async invalidateSearchCategory(categoryId: string): Promise<void> {
    if (!this.searchCache) return;
    try {
      await this.searchCache.invalidateCategory(categoryId);
    } catch (e) {
      this.logger.warn(`search cache invalidation failed for category ${categoryId}: ${(e as Error).message}`);
    }
  }
  @Roles('super_admin', 'verification_officer') @Get('verifications') verifications(@Query() q: AdminLimitQueryDto) { return this.svc.verifications(q.cursor, q.limit ?? 50); }
  @Roles('super_admin', 'verification_officer') @Get('verifications/:id') verificationDetail(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) { return this.svc.verificationDetail(u.id, id); }
  @Roles('super_admin', 'verification_officer') @Post('verifications/:id/decide') decide(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: DecideDto) { return this.svc.decideVerification(u.id, id, dto.decision, dto.note); }
  @Roles('super_admin', 'support_agent') @Get('users') users(@Query() q: AdminLimitQueryDto) { return this.svc.listUsers(q.cursor, q.limit ?? 50); }
  @Roles('super_admin', 'marketing') @Get('categories') categories(@Query() q: AdminLimitQueryDto) { return this.svc.listCategories(q.cursor, q.limit ?? 50); }
  @Roles('super_admin', 'finance') @Get('jobs') jobs(@Query() q: AdminLimitQueryDto) { return this.svc.listJobs(q.cursor, q.limit ?? 50); }
  @Roles('super_admin') @Get('audit-logs') auditLogs(@Query() q: AdminLimitQueryDto) { return this.svc.listAuditLogs(q.limit ?? 50, q.cursor); }
  // ---- Phase 2 ----
  @Roles('super_admin', 'finance', 'city_manager') @Get('kpis') kpis() { return this.svc.kpis(); }
  @Roles('super_admin', 'support_agent', 'city_manager') @Get('requests') requests(@Query() q: AdminRequestsQueryDto) {
    return this.svc.listRequests({ status: q.status, cursor: q.cursor, limit: q.limit ?? 20 });
  }
  @Roles('super_admin', 'support_agent') @Patch('users/:id/suspend') suspend(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: SuspendDto) {
    return this.svc.suspendUser(u.id, id, dto.suspended);
  }
  @Roles('super_admin', 'marketing') @Post('categories') async createCategory(@CurrentUser() u: AuthUser, @Body() dto: CreateCategoryDto) {
    const row = await this.svc.createCategory(u.id, dto);
    await this.invalidateSearchCategory(String((row as Record<string, unknown>).id));
    return row;
  }
  @Roles('super_admin', 'marketing') @Patch('categories/:id') async updateCategory(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: PatchCategoryDto) {
    const row = await this.svc.updateCategory(u.id, id, dto);
    await this.invalidateSearchCategory(id);
    return row;
  }
  @Roles('super_admin', 'support_agent') @Get('disputes') disputes(@Query() q: AdminDisputesQueryDto) {
    return this.svc.listDisputes({ status: q.status, cursor: q.cursor, limit: q.limit ?? 20 });
  }
  @Roles('super_admin', 'support_agent') @Get('disputes/sla-breaches') slaBreaches() { return this.svc.slaBreaches(); }
  @Roles('super_admin', 'support_agent') @Post('disputes/:id/assign') assignDispute(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: AssignDisputeDto) {
    return this.svc.assignDispute(u.id, id, dto.assigned_to);
  }
  @Roles('super_admin', 'support_agent') @Post('disputes/:id/resolve') resolveDispute(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: ResolveDisputeDto) {
    return this.svc.resolveDispute(u.id, id, dto);
  }
}
