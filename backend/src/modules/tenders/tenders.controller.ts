import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { TendersService } from './tenders.service';
import { CreateTenderDto, ListTendersQueryDto, SubmitQuoteDto } from './dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { RateLimit } from '../../common/guards/rate-limit.guard';

// NOTE (integrator): this module is NOT wired into AppModule yet and its
// routes are NOT in backend/openapi.yaml (v1.4.0) — see the final report
// for the full route list to add. Rate limiting reuses the existing
// 'offers' preset (no new preset was added to the shared guard).
@Controller('tenders')
export class TendersController {
  constructor(private svc: TendersService) {}

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateTenderDto, @Headers('idempotency-key') key?: string) {
    return this.svc.createTender(u.id, dto, key);
  }

  @Get()
  listMine(@CurrentUser() u: AuthUser, @Query() q: ListTendersQueryDto) {
    return this.svc.listMyTenders(u.id, q.status, q.cursor, q.limit ?? 20);
  }

  @Roles('provider')
  @Get('open')
  listOpen(@Query() q: ListTendersQueryDto) {
    return this.svc.listOpenTenders(q.cursor, q.limit ?? 20);
  }

  @Get(':id')
  getById(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getTender(id, u.id);
  }

  @Roles('provider')
  @RateLimit('offers')
  @Post(':id/quotes')
  submitQuote(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Body() dto: SubmitQuoteDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.svc.submitQuote(id, u.id, dto, key);
  }

  @Get(':id/quotes')
  listQuotes(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.listQuotes(id, u.id);
  }

  @Get(':id/audit')
  getAudit(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getAuditTrail(id, u.id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Headers('idempotency-key') key?: string) {
    return this.svc.cancelTender(id, u.id, key);
  }

  @Roles('provider')
  @Post('quotes/:quoteId/withdraw')
  @HttpCode(200)
  withdraw(@CurrentUser() u: AuthUser, @Param('quoteId', uuidParamPipe) quoteId: string) {
    return this.svc.withdrawQuote(quoteId, u.id);
  }

  @RateLimit('offers')
  @Post('quotes/:quoteId/accept')
  accept(@CurrentUser() u: AuthUser, @Param('quoteId', uuidParamPipe) quoteId: string, @Headers('idempotency-key') key?: string) {
    return this.svc.acceptQuote(quoteId, u.id, key);
  }
}
