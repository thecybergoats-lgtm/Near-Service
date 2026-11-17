import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { withIdempotency } from '../../common/utils/idempotency';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Errors } from '../../common/errors/api-error';
import { CursorQueryDto, IsLat, IsLng } from '../../common/validation/validators';
import { pageFromRows } from '../../common/utils/pagination';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export class CreateAddressDto {
  @IsEnum(['home', 'work', 'other']) label!: string;
  @IsOptional() @IsString() @MaxLength(500) address_text?: string;
  @IsLat() lat!: number;
  @IsLng() lng!: number;
}
export class PatchAddressDto {
  @IsOptional() @IsEnum(['home', 'work', 'other']) label?: string;
  @IsOptional() @IsString() @MaxLength(500) address_text?: string;
  @IsOptional() @IsLat() lat?: number;
  @IsOptional() @IsLng() lng?: number;
}
@Controller('me/addresses')
export class AddressesController {
  constructor(private db: DatabaseService, private redis: RedisService) {}
  /** Saved addresses (OpenAPI listAddresses). v1.2 AddressPage envelope;
   *  cursor is an address id, oldest first. */
  @Get() async list(@CurrentUser() u: AuthUser, @Query() q: CursorQueryDto) {
    const lim = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const rows = (await this.db.query(
      `SELECT id, label, address_text, ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng FROM addresses WHERE user_id=$1 AND deleted_at IS NULL
         AND ($2::text IS NULL OR (created_at, id) > (SELECT created_at, id FROM addresses WHERE id=$2::uuid))
       ORDER BY created_at ASC, id ASC LIMIT $3`,
      [u.id, q.cursor ?? null, lim + 1])).rows;
    return pageFromRows(rows, lim);
  }
  @Post() async create(@CurrentUser() u: AuthUser, @Body() dto: CreateAddressDto, @Headers('idempotency-key') key?: string) {
    return withIdempotency(this.redis, 'address', key, async () => {
      const rows = (await this.db.query(
        `INSERT INTO addresses (user_id, label, address_text, point) VALUES ($1,$2,$3, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography)
         RETURNING id, label, address_text, ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng`,
        [u.id, dto.label, dto.address_text ?? null, dto.lng, dto.lat])).rows;
      return rows[0];
    });
  }
  @Patch(':id') async update(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: PatchAddressDto) {
    const rows = (await this.db.query(
      `UPDATE addresses SET label=COALESCE($3,label), address_text=COALESCE($4,address_text),
        point=CASE WHEN $5::float IS NOT NULL AND $6::float IS NOT NULL THEN ST_SetSRID(ST_MakePoint($6,$5),4326)::geography ELSE point END
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
       RETURNING id, label, address_text, ST_Y(point::geometry) AS lat, ST_X(point::geometry) AS lng`,
      [id, u.id, dto.label ?? null, dto.address_text ?? null, dto.lat ?? null, dto.lng ?? null])).rows;
    if (!rows[0]) throw Errors.notFound('Address');
    return rows[0];
  }
}
