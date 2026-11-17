import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsDateString, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { WalletService } from './wallet.service';
import { Roles } from '../../common/guards/roles.decorator';
import { CursorQueryDto } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export class CreateRuleDto {
  @IsOptional() @IsUUID() category_id?: string | null;
  @IsOptional() @IsUUID() city_id?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(3) tier?: number | null;
  // Commission rate is a fraction; the service enforces the 0.05–0.15 band.
  @IsNumber() @Min(0.05) @Max(0.15) rate!: number;
  @IsDateString() valid_from!: string;
  @IsOptional() @IsDateString() valid_to?: string | null;
  @IsOptional() @IsBoolean() is_promo?: boolean;
}
export class UpdateRuleDto {
  @IsOptional() @IsNumber() @Min(0.05) @Max(0.15) rate?: number;
  @IsOptional() @IsDateString() valid_to?: string | null;
  @IsOptional() @IsBoolean() is_promo?: boolean;
}

@Controller('admin')
export class CommissionAdminController {
  constructor(private svc: WalletService) {}

  @Roles('super_admin', 'finance') @Get('commission-rules') list(@Query() q: CursorQueryDto) { return this.svc.listCommissionRules(q.cursor, q.limit ?? 20); }
  @Roles('super_admin', 'finance') @Post('commission-rules') @HttpCode(201) create(@Body() dto: CreateRuleDto) { return this.svc.createCommissionRule(dto); }
  @Roles('super_admin', 'finance') @Patch('commission-rules/:id') update(@Param('id', uuidParamPipe) id: string, @Body() dto: UpdateRuleDto) { return this.svc.updateCommissionRule(id, dto); }
}
