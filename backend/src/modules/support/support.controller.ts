import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { SupportService } from './support.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { CursorQueryDto } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { RateLimit } from '../../common/guards/rate-limit.guard';

export class CreateThreadDto {
  @IsString() @IsNotEmpty() @MaxLength(200) subject!: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) message!: string;
}
export class SendSupportMessageDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) body!: string;
}
export class ListAdminThreadsQueryDto extends CursorQueryDto {
  @IsOptional() @IsString() status?: string;
}

@Controller()
export class SupportController {
  constructor(private svc: SupportService) {}

  @RateLimit('messages') @Post('support/threads') @HttpCode(201) create(
    @CurrentUser() u: AuthUser, @Body() dto: CreateThreadDto) {
    return this.svc.createThread(u.id, dto.subject, dto.message);
  }

  @Get('support/threads') list(@CurrentUser() u: AuthUser, @Query() q: CursorQueryDto) {
    return this.svc.listThreads(u.id, q.cursor, q.limit ?? 20);
  }

  @Get('support/threads/:id/messages') listMessages(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Query() q: CursorQueryDto) {
    return this.svc.listMessages(id, u.id, q.cursor, q.limit ?? 20);
  }

  @RateLimit('messages') @Post('support/threads/:id/messages') @HttpCode(201) send(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: SendSupportMessageDto) {
    return this.svc.sendCustomerMessage(id, u.id, dto.body);
  }

  @Roles('super_admin', 'support_agent') @Get('admin/support/threads') listAdmin(
    @Query() q: ListAdminThreadsQueryDto) {
    return this.svc.listAdminThreads(q.status, q.cursor, q.limit ?? 20);
  }

  @Roles('super_admin', 'support_agent') @RateLimit('messages')
  @Post('admin/support/threads/:id/messages') @HttpCode(201) reply(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: SendSupportMessageDto) {
    return this.svc.sendAdminMessage(id, u.id, dto.body);
  }

  @Roles('super_admin', 'support_agent') @Post('admin/support/threads/:id/close') @HttpCode(200) close(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.closeThread(id, u.id);
  }
}
