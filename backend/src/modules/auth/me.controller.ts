import { Body, Controller, Get, Patch } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { DatabaseService } from '../../database/database.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Errors } from '../../common/errors/api-error';
import { LANGUAGE_VALUES } from './dto';

export class PatchMeDto {
  @IsOptional() @IsString() @MaxLength(100) full_name?: string;
  @IsOptional() @IsString() @IsIn([...LANGUAGE_VALUES]) language?: string;
  @IsOptional() @IsString() @MaxLength(2048) photo_url?: string;
}

@Controller('me')
export class MeController {
  constructor(private db: DatabaseService) {}
  @Get() async me(@CurrentUser() u: AuthUser) {
    const rows = (await this.db.query(
      `SELECT u.id, u.phone, u.full_name, u.language, u.status, u.created_at,
              COALESCE((SELECT json_agg(r.name) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '[]'::json) AS roles
       FROM users u WHERE u.id = $1`,
      [u.id],
    )).rows;
    if (!rows[0]) throw Errors.notFound('User');
    return rows[0];
  }
  @Patch() async patchMe(@CurrentUser() u: AuthUser, @Body() dto: PatchMeDto) {
    const rows = (await this.db.query(
      `UPDATE users SET full_name=COALESCE($2,full_name), language=COALESCE($3,language), photo_url=COALESCE($4,photo_url), updated_at=now() WHERE id=$1 RETURNING id, phone, full_name, language, status`,
      [u.id, dto.full_name ?? null, dto.language ?? null, dto.photo_url ?? null])).rows;
    return rows[0];
  }
}
