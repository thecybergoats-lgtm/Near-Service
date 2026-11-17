import { Body, Controller, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { OffersService } from './offers.service';
import { CreateOfferDto, CounterOfferDto, DeclineDto } from '../requests/dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { RateLimit } from '../../common/guards/rate-limit.guard';

@Controller()
export class OffersController {
  constructor(private svc: OffersService) {}
  @Roles('provider') @RateLimit('offers') @Post('requests/:id/offers') create(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: CreateOfferDto, @Headers('idempotency-key') key?: string) {
    return this.svc.createOffer(id, u.id, dto.price, dto.eta_minutes, dto.note, dto.breakdown, key);
  }
  @RateLimit('offers') @Post('offers/:id/accept') accept(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Headers('idempotency-key') key?: string) { return this.svc.acceptOffer(id, u.id, key); }
  @RateLimit('offers') @Post('offers/:id/counter') counter(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: CounterOfferDto, @Headers('idempotency-key') key?: string) { return this.svc.counterOffer(id, u.id, dto.price, dto.note); }
  @Roles('provider') @RateLimit('offers') @Post('offers/:id/decline') @HttpCode(200) decline(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: DeclineDto) { return this.svc.declineOffer(id, u.id, dto.reason_code); }
}
