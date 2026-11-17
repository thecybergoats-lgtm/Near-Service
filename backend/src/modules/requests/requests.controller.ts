import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { RequestsService } from './requests.service';
import { CreateRequestDto } from './dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AtLeastOneCategory, CursorQueryDto, IsLat, IsLng } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { RateLimit } from '../../common/guards/rate-limit.guard';

export class ListOffersQueryDto extends CursorQueryDto {}

@AtLeastOneCategory()
export class WaitlistDto {
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsString() @MaxLength(100) category_slug?: string;
  @IsLat() lat!: number;
  @IsLng() lng!: number;
}
@Controller('requests')
export class RequestsController {
  constructor(private svc: RequestsService) {}
  @RateLimit('create-request')
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateRequestDto, @Headers('idempotency-key') key?: string) { return this.svc.create(u.id, dto, key); }
  @Get(':id') getById(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) { return this.svc.getById(id, u.id); }
  @Get(':id/offers') listOffers(@Param('id', uuidParamPipe) id: string, @Query() q: ListOffersQueryDto) { return this.svc.listOffers(id, q.cursor, q.limit ?? 20); }
  @Get(':id/chat') getRequestChat(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) { return this.svc.getRequestChat(id, u.id); }
  @Post(':id/cancel') @HttpCode(200) cancel(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Headers('idempotency-key') key?: string) { return this.svc.cancel(id, u.id, key); }
}
/** POST /waitlist lives in this file (not under /requests) because the
 *  RequestsController prefix is 'requests'. Same service, same module. */
@Controller('waitlist')
export class WaitlistController {
  constructor(private svc: RequestsService) {}
  @Post() join(@CurrentUser() u: AuthUser, @Body() dto: WaitlistDto, @Headers('idempotency-key') key?: string) {
    return this.svc.joinWaitlist(u.id, dto, key);
  }
}
