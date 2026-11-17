// Multi-city ops — admin endpoints (Phase 4, item 3).
// Route prefix: /admin/cities (under the global /api/v1 prefix).
// Roles: super_admin everywhere; city_manager where the service enforces
// per-city scope (any attempt on an unassigned city is 403 from the
// service, not just from this guard). Status transitions and manager
// assignment are super_admin only — a City Manager owns the checklist
// and the targets, not the launch decision itself.
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CitiesService, CityRow } from './cities.service';
import { CityStatus } from './gate';
import { Roles } from '../../common/guards/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import {
  IsBoolean, IsEnum, IsInt, IsLatitude, IsLongitude, IsNotEmpty, IsNumber,
  IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { cityUuidParamPipe as uuidParamPipe } from './uuid.pipe';

// Canonical-shape UUID (db/check-uuids.js enforces v4 since Fix A):
// seeded ids are v4 (db/0021_fix_seed_uuids.sql rewrote the old
// version-0 seeds), and every id field below accepts any canonical-shape
// UUID, v4 or otherwise.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IsCanonicalUuid = () => Matches(CANONICAL_UUID, { message: 'must be a UUID' });

export class CreateCityDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @IsString() @IsNotEmpty() @MaxLength(40) @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lowercase letters, digits and hyphens' }) slug!: string;
  @IsLatitude() lat!: number;
  @IsLongitude() lng!: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(100) default_radius_km?: number;
  @IsOptional() @IsInt() @Min(1) population_estimate?: number;
  @IsOptional() @IsInt() @Min(0) supply_target_providers?: number;
}
export class UpdateTargetsDto {
  @IsOptional() @IsInt() @Min(0) supply_target_providers?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(100) default_radius_km?: number;
  @IsOptional() @IsInt() @Min(1) population_estimate?: number;
}
export class UpdateGateConfigDto {
  @IsOptional() @IsInt() @Min(0) min_providers?: number;
  @IsOptional() @IsNumber() @Min(0) min_supply_density_per_100k?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) min_fill_rate?: number;
  @IsOptional() @IsInt() @Min(1) max_time_to_first_offer_seconds?: number;
}
export class EvaluateGateDto {
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}
export class TransitionStatusDto {
  @IsEnum(['planned', 'in_preparation', 'gate_review', 'live', 'paused']) to!: CityStatus;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class AssignManagerDto {
  @IsCanonicalUuid() manager_user_id!: string;
}
export class ChecklistItemDto {
  @IsBoolean() done!: boolean;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}
export class CategoryOverrideDto {
  @IsBoolean() is_enabled!: boolean;
  @IsOptional() @IsInt() sort_order?: number;
}
export class CreateCommissionRuleDto {
  @IsOptional() @IsCanonicalUuid() category_id?: string;
  @IsOptional() @IsInt() @Min(0) @Max(3) tier?: number;
  @IsNumber() @Min(0.05) @Max(0.15) rate!: number;
  @IsOptional() @IsString() @MaxLength(10) valid_from?: string;
  @IsOptional() @IsString() @MaxLength(10) valid_to?: string;
}
export class UpsertFairPriceDto {
  @IsCanonicalUuid() category_id!: string;
  @IsNumber() @Min(1) min_price!: number;
  @IsNumber() @Min(1) typical_price!: number;
  @IsNumber() @Min(1) max_price!: number;
  @IsOptional() @IsInt() @Min(0) sample_size?: number;
}
export class EffectiveCommissionQueryDto {
  @IsOptional() @IsCanonicalUuid() category_id?: string;
  @IsOptional() @IsInt() @Min(0) @Max(3) tier?: number;
}
export class FairPriceQueryDto {
  @IsCanonicalUuid() category_id!: string;
}

@Controller('admin/cities')
export class CitiesAdminController {
  constructor(private svc: CitiesService) {}

  @Roles('super_admin', 'city_manager') @Get() list(@CurrentUser() u: AuthUser): Promise<CityRow[]> {
    return this.svc.listCities(u);
  }
  @Roles('super_admin') @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateCityDto) {
    return this.svc.createCity(u.id, dto);
  }
  @Roles('super_admin', 'city_manager') @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getCity(u, id);
  }
  @Roles('super_admin', 'city_manager') @Patch(':id/targets') targets(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: UpdateTargetsDto,
  ) {
    return this.svc.updateTargets(u, id, dto);
  }
  @Roles('super_admin', 'city_manager') @Patch(':id/gate-config') gateConfig(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: UpdateGateConfigDto,
  ) {
    // DTO fields are snake_case (API style); the gate domain is camelCase.
    return this.svc.updateGateConfig(u, id, {
      minProviders: dto.min_providers,
      minSupplyDensityPer100k: dto.min_supply_density_per_100k,
      minFillRate: dto.min_fill_rate,
      maxTimeToFirstOfferSeconds: dto.max_time_to_first_offer_seconds,
    });
  }
  @Roles('super_admin', 'city_manager') @Post(':id/gate-evaluations') evaluate(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: EvaluateGateDto,
  ) {
    return this.svc.evaluateGateFor(u, id, dto.notes);
  }
  @Roles('super_admin', 'city_manager') @Get(':id/gate-evaluations') evaluations(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string,
  ) {
    return this.svc.listEvaluations(u, id);
  }
  @Roles('super_admin') @Post(':id/status') status(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: TransitionStatusDto,
  ) {
    return this.svc.transitionStatus(u.id, id, dto.to, dto.note);
  }
  @Roles('super_admin') @Post(':id/assign-manager') assignManager(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: AssignManagerDto,
  ) {
    return this.svc.assignManager(u.id, id, dto.manager_user_id);
  }
  @Roles('super_admin', 'city_manager') @Get(':id/checklist') checklist(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string,
  ) {
    return this.svc.getChecklist(u, id);
  }
  @Roles('super_admin', 'city_manager') @Patch(':id/checklist/:itemKey') checklistItem(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string,
    @Param('itemKey') itemKey: string, @Body() dto: ChecklistItemDto,
  ) {
    return this.svc.setChecklistItem(u, id, itemKey, dto.done, dto.notes);
  }
  @Roles('super_admin', 'city_manager') @Get(':id/categories') categories(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string,
  ) {
    return this.svc.listCategoryOverrides(u, id);
  }
  @Roles('super_admin', 'city_manager') @Patch(':id/categories/:categoryId') categoryOverride(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string,
    @Param('categoryId', uuidParamPipe) categoryId: string, @Body() dto: CategoryOverrideDto,
  ) {
    return this.svc.setCategoryOverride(u, id, categoryId, dto.is_enabled, dto.sort_order);
  }
  @Roles('super_admin', 'city_manager') @Get(':id/effective-commission') effectiveCommission(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Query() q: EffectiveCommissionQueryDto,
  ) {
    // Scoped read: a City Manager may only resolve rates for their cities.
    return this.svc.requireCityAccess(u, id).then(() => this.svc.resolveCommissionRate(id, q.category_id ?? null, q.tier ?? null));
  }
  @Roles('super_admin', 'city_manager') @Post(':id/commission-rules') commissionRule(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: CreateCommissionRuleDto,
  ) {
    return this.svc.createCommissionRule(u, id, dto);
  }
  @Roles('super_admin', 'city_manager') @Get(':id/fair-price') fairPrice(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Query() q: FairPriceQueryDto,
  ) {
    return this.svc.requireCityAccess(u, id).then(() => this.svc.resolveFairPrice(id, q.category_id));
  }
  @Roles('super_admin', 'city_manager') @Post(':id/fair-price') upsertFairPrice(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: UpsertFairPriceDto,
  ) {
    return this.svc.upsertFairPrice(u, id, dto);
  }
}
