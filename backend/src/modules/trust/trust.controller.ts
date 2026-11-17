import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { TrustService } from './trust.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CursorQueryDto, IsLat, IsLng } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { RateLimit } from '../../common/guards/rate-limit.guard';

export class DisputeDto {
  @IsOptional() @IsString() @MaxLength(100) reason_code?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}
export class EvidenceDto {
  @IsEnum(['photo', 'chat', 'gps']) kind!: 'photo' | 'chat' | 'gps';
  @IsOptional() @IsString() @MaxLength(500) storage_key?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class ReportDto {
  @IsOptional() @IsUUID() reported_id?: string;
  @IsOptional() @IsString() @MaxLength(100) context?: string;
  @IsOptional() @IsString() @MaxLength(100) reason_code?: string;
  @IsOptional() @IsString() @MaxLength(2000) detail?: string;
}
export class BlockDto { @IsUUID() blocked_id!: string; }
export class SosDto {
  @IsOptional() @IsUUID() job_id?: string;
  @IsOptional() @IsLat() lat?: number;
  @IsOptional() @IsLng() lng?: number;
}
export class ListDisputesQueryDto extends CursorQueryDto {
  @IsOptional() @IsEnum(['customer', 'provider']) role?: string;
  @IsOptional() @IsString() @MaxLength(40) status?: string;
}

@Controller()
export class TrustController {
  constructor(private svc: TrustService) {}
  @Post('jobs/:id/disputes') openDispute(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: DisputeDto) { return this.svc.openDispute(id, u.id, dto.reason_code, dto.description); }
  @Get('disputes/:id') getDispute(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) { return this.svc.getDispute(id, u.id); }
  @Get('disputes') listDisputes(@CurrentUser() u: AuthUser, @Query() q: ListDisputesQueryDto) {
    return this.svc.listDisputes(u.id, { role: q.role, status: q.status, cursor: q.cursor, limit: q.limit ?? 20 });
  }
  @Post('disputes/:id/evidence') addEvidence(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: EvidenceDto) { return this.svc.addEvidence(id, u.id, dto); }
  // FIX 14(c): signed-URL upload for photo evidence (same flow as documents).
  @Post('disputes/:id/evidence/upload-request') @HttpCode(200) requestEvidenceUpload(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) { return this.svc.requestEvidenceUpload(id, u.id); }
  @RateLimit('reports') @Post('reports') report(@CurrentUser() u: AuthUser, @Body() dto: ReportDto) { return this.svc.report(u.id, dto.reported_id ?? null, dto.context, dto.reason_code, dto.detail); }
  @RateLimit('blocks') @Post('blocks') block(@CurrentUser() u: AuthUser, @Body() dto: BlockDto) { return this.svc.block(u.id, dto.blocked_id); }
  // SOS: high limit (30/min) by design — throttled, never fully blocked.
  @RateLimit('sos') @Post('sos') @HttpCode(202) sos(@CurrentUser() u: AuthUser, @Body() dto: SosDto) { return this.svc.sos(u.id, dto.job_id ?? null, dto.lat, dto.lng); }
}
