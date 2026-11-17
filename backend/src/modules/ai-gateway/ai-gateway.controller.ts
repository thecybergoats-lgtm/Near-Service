import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { AiGatewayService } from './ai-gateway.service';
import { Public } from '../../common/guards/public.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { ParseIntentDto, PhotoSearchDto, VoiceSearchDto, FairPriceQueryDto, SetTranslationPrefDto, TranslateMessageDto } from './ai-gateway.dto';

// Phase 3 AI Gateway routes. Public read-style endpoints mirror the
// existing public search / fair-range endpoints; voice + chat
// translation require an authenticated participant.

@Controller('ai')
export class AiGatewayController {
  constructor(private svc: AiGatewayService) {}

  @Public() @Get('health')
  health() { return { provider: this.svc.providerName, capabilities: this.svc.capabilities }; }

  @Public() @Post('intent')
  parseIntent(@Body() dto: ParseIntentDto, @CurrentUser() u?: AuthUser) {
    // Public endpoint: CurrentUser is undefined for anonymous callers
    // (JwtAuthGuard passes public routes through without a user).
    return this.svc.parseIntent(dto.text, u?.id);
  }

  @Public() @Post('photo-search')
  photoSearch(@Body() dto: PhotoSearchDto) { return this.svc.suggestFromPhoto(dto); }

  @Post('voice-search')
  voiceSearch(@Body() dto: VoiceSearchDto) { return this.svc.voiceSearch(dto); }

  @Public() @Get('fair-price')
  fairPrice(@Query() q: FairPriceQueryDto) {
    return this.svc.fairPrice(q.category_id, q.category_slug, q.city_id, q.quantity ?? null);
  }

  @Get('chats/:id/translation')
  getPref(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getTranslationPref(id, u.id);
  }

  @Put('chats/:id/translation')
  setPref(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: SetTranslationPrefDto) {
    return this.svc.setTranslationPref(id, u.id, dto.target_lang ?? null, dto.auto_translate);
  }

  @Post('chats/:id/messages/:messageId/translate')
  translateMessage(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string,
    @Param('messageId', uuidParamPipe) messageId: string, @Body() dto: TranslateMessageDto) {
    return this.svc.translateMessage(id, messageId, u.id, dto.target_lang);
  }
}
