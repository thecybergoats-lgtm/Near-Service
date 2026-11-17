import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Errors } from '../../common/errors/api-error';
import { bayesianRating } from '../../common/utils/ranking';
import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export class DeviceDto {
  @IsString() @IsNotEmpty() @MaxLength(128) device_fingerprint!: string;
  @IsEnum(['android', 'ios', 'web']) platform!: 'android' | 'ios' | 'web';
  @IsOptional() @IsString() @MaxLength(512) fcm_token?: string;
}
export class TrustedContactDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @IsString() @Matches(/^\+92\d{10}$/, { message: 'phone must be a Pakistani number like +923001234567' }) phone!: string;
  @IsOptional() @IsString() @MaxLength(40) relation?: string;
}
const MAX_TRUSTED_CONTACTS = 5;
@Controller('me')
export class UsersController {
  constructor(private db: DatabaseService) {}
  /** OpenAPI getMyProfiles: {customer: boolean, provider: ProviderCard|null}. */
  @Get('profiles') async profiles(@CurrentUser() u: AuthUser) {
    const p = (await this.db.query(
      `SELECT id, display_name, provider_type, tier, rating_avg, jobs_completed, is_online,
              (SELECT MIN(starting_price) FROM provider_services WHERE provider_id=provider_profiles.id AND is_active) AS starting_price
       FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`, [u.id])).rows[0];
    return {
      customer: true,
      provider: p ? {
        id: p.id, display_name: p.display_name, provider_type: p.provider_type, tier: p.tier,
        rating_bayes: bayesianRating(Number(p.rating_avg), p.jobs_completed), jobs_completed: p.jobs_completed,
        distance_km: null, eta_minutes: null, is_open_now: p.is_online,
        starting_price: p.starting_price ? Number(p.starting_price) : null, sponsored: false,
      } : null,
    };
  }
  // ---- Phase 2: devices + trusted contacts (OpenAPI registerDevice etc.) ----
  /** Register or update a device (upsert on user + fingerprint). The FCM
   *  token is stored for push; actual dispatch stays the Phase 1 FCM stub —
   *  no push is really sent from this repo. */
  @Post('devices') async registerDevice(@CurrentUser() u: AuthUser, @Body() dto: DeviceDto) {
    const row = (await this.db.query(
      `INSERT INTO user_devices (user_id, device_fingerprint, platform, fcm_token, last_seen_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (user_id, device_fingerprint) DO UPDATE SET platform=EXCLUDED.platform, fcm_token=EXCLUDED.fcm_token, last_seen_at=now()
       RETURNING id, device_fingerprint, platform, last_seen_at, created_at`,
      [u.id, dto.device_fingerprint, dto.platform, dto.fcm_token ?? null])).rows[0];
    return row;
  }
  @Delete('devices/:id') @HttpCode(204) async unregisterDevice(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    const deleted = (await this.db.query(`DELETE FROM user_devices WHERE id=$1 AND user_id=$2 RETURNING id`, [id, u.id])).rows[0];
    if (!deleted) throw Errors.notFound('Device');
  }
  @Get('trusted-contacts') async listTrustedContacts(@CurrentUser() u: AuthUser) {
    return (await this.db.query(
      `SELECT id, name, phone, relation, created_at FROM trusted_contacts WHERE user_id=$1 ORDER BY created_at`, [u.id])).rows;
  }
  @Post('trusted-contacts') async createTrustedContact(@CurrentUser() u: AuthUser, @Body() dto: TrustedContactDto) {
    const count = (await this.db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM trusted_contacts WHERE user_id=$1`, [u.id])).rows[0];
    if (Number(count?.c ?? 0) >= MAX_TRUSTED_CONTACTS) {
      throw Errors.conflict('TRUSTED_CONTACT_LIMIT', `At most ${MAX_TRUSTED_CONTACTS} trusted contacts per user`);
    }
    return (await this.db.query(
      `INSERT INTO trusted_contacts (user_id, name, phone, relation) VALUES ($1,$2,$3,$4) RETURNING id, name, phone, relation, created_at`,
      [u.id, dto.name, dto.phone, dto.relation ?? null])).rows[0];
  }
  @Delete('trusted-contacts/:id') @HttpCode(204) async deleteTrustedContact(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    const deleted = (await this.db.query(`DELETE FROM trusted_contacts WHERE id=$1 AND user_id=$2 RETURNING id`, [id, u.id])).rows[0];
    if (!deleted) throw Errors.notFound('Trusted contact');
  }
}
