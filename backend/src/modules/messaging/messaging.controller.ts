import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CursorQueryDto } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { RateLimit } from '../../common/guards/rate-limit.guard';

export class SendMessageDto {
  @IsOptional() @IsString() @MaxLength(2000) body?: string;
  @IsOptional() @IsEnum(['text', 'image', 'voice', 'quick_reply']) kind?: string;
  @IsOptional() @IsString() @MaxLength(500) media_key?: string;
}
export class ListMessagesQueryDto extends CursorQueryDto {}
export class ListChatsQueryDto extends CursorQueryDto {
  @IsOptional() @IsUUID() job_id?: string;
}

@Controller('chats')
export class MessagingController {
  constructor(private svc: MessagingService) {}
  /** FIX 14(d) (Stage 3): GET /chats moved here from JobsQueryService —
   *  the messaging module owns all chat reads and writes now. Route,
   *  query params and response shape are unchanged (OpenAPI listChats). */
  @Get() listChats(@CurrentUser() u: AuthUser, @Query() q: ListChatsQueryDto) { return this.svc.listChats(u.id, q.job_id, q.cursor, q.limit ?? 20); }
  @Get(':id/messages') list(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Query() q: ListMessagesQueryDto) { return this.svc.listMessages(id, u.id, q.limit ?? 20, q.cursor); }
  @RateLimit('messages')
  @Post(':id/messages') send(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: SendMessageDto, @Headers('idempotency-key') key?: string) { return this.svc.sendMessage(id, u.id, dto.body ?? null, dto.kind ?? 'text', dto.media_key, key); }
}
