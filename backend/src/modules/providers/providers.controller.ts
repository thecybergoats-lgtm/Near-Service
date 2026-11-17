import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ProvidersService } from './providers.service';
import { OnboardingDto, OnlineDto, DocumentUploadDto, ServicesDto, ServiceAreaDto, AvailabilityDto } from './dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/guards/public.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { Errors } from '../../common/errors/api-error';
import { IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { CursorQueryDto, IsLat, IsLng, ToBoolean, ToNumber } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { RateLimit } from '../../common/guards/rate-limit.guard';

export class NearbyQueryDto extends CursorQueryDto {
  @IsLat() @ToNumber() lat!: number;
  @IsLng() @ToNumber() lng!: number;
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsString() @MaxLength(100) category_slug?: string;
  @IsOptional() @ToNumber() @IsNumber() @Min(0.5) @Max(100) radius_km?: number;
  @IsOptional() @ToBoolean() open_now?: boolean;
  @IsOptional() @ToBoolean() verified_only?: boolean;
}

export class ProviderReviewsQueryDto extends CursorQueryDto {}

@Controller('providers')
export class ProvidersController {
  constructor(private svc: ProvidersService) {}
  @Roles('provider') @Post('onboarding') @HttpCode(200) onboarding(@CurrentUser() u: AuthUser, @Body() dto: OnboardingDto) {
    return this.svc.onboarding(u.id, dto.step, dto.data ?? {});
  }
  @Roles('provider') @Post('me/documents') @HttpCode(200) documents(@CurrentUser() u: AuthUser, @Body() dto: DocumentUploadDto) {
    return this.svc.requestDocumentUpload(u.id, dto.doc_type);
  }
  @Public() @RateLimit('nearby') @Get('nearby') nearby(@Query() q: NearbyQueryDto) {
    return this.svc.nearby({ lat: q.lat, lng: q.lng, category_id: q.category_id, category_slug: q.category_slug, radius_km: q.radius_km, open_now: q.open_now ?? false, verified_only: q.verified_only ?? false, cursor: q.cursor, limit: q.limit });
  }
  // Batch 3: own profile (for the "My QR code" screen) and earnings
  // dashboard. Registered BEFORE ':id' so '/providers/me' is not
  // captured by the public :id route (uuidParamPipe would 422 'me').
  @Roles('provider') @Get('me') myProfile(@CurrentUser() u: AuthUser) { return this.svc.getMyProfile(u.id); }
  @Roles('provider') @Get('me/earnings') myEarnings(@CurrentUser() u: AuthUser) { return this.svc.getEarnings(u.id); }
  @Roles('provider') @Get('me/services') myServices(@CurrentUser() u: AuthUser) { return this.svc.getMyServices(u.id); }
  @Roles('provider') @Put('me/services') updateMyServices(@CurrentUser() u: AuthUser, @Body() dto: ServicesDto) { return this.svc.updateMyServices(u.id, dto.services); }
  @Roles('provider') @Put('me/service-area') updateServiceArea(@CurrentUser() u: AuthUser, @Body() dto: ServiceAreaDto) { return this.svc.updateServiceArea(u.id, dto); }
  @Roles('provider') @Put('me/availability') updateAvailability(@CurrentUser() u: AuthUser, @Body() dto: AvailabilityDto) { return this.svc.updateAvailability(u.id, dto.slots); }
  @Public() @Get(':id/reviews') listReviews(@Param('id', uuidParamPipe) id: string, @Query() q: ProviderReviewsQueryDto) {
    return this.svc.listReviews(id, q.cursor, q.limit ?? 20);
  }
  @Public() @Get(':id') getById(@Param('id', uuidParamPipe) id: string) { return this.svc.getById(id); }
  @Roles('provider') @Patch('me/online') setOnline(@CurrentUser() u: AuthUser, @Body() dto: OnlineDto) { return this.svc.setOnline(u.id, dto.is_online, dto.lat, dto.lng); }
}
/** Local dev upload receiver for document uploads when no object storage is
 *  configured (STORAGE_UPLOAD_BASE_URL unset). DEV ONLY — in production the
 *  upload URL points at the configured storage provider. */
@Controller('uploads')
export class UploadsController {
  @Public() @Post(':key') async upload(@Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    if (process.env.NODE_ENV === 'production' || process.env.STORAGE_UPLOAD_BASE_URL) throw Errors.badRequest('STORAGE_CONFIGURED', 'Uploads go to the configured storage provider');
    const safe = decodeURIComponent(key).replace(/\.\./g, '').replace(/^\/+/, '');
    const dir = path.resolve(__dirname, '../../../uploads');
    fs.mkdirSync(dir, { recursive: true });
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      fs.writeFileSync(path.join(dir, safe.replace(/\//g, '_')), Buffer.concat(chunks));
      res.status(200).json({ storage_key: safe, stored: 'local-dev-only' });
    });
  }
}
