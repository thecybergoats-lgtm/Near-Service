import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { PartnersService } from './partners.service';
import {
  CancelPartnerOrderDto,
  CatalogQueryDto,
  CreatePartnerOrderDto,
} from './dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

// NOTE (integrator): this module is NOT wired into AppModule yet and its
// routes are NOT in backend/openapi.yaml — see docs/phase4-partners.md
// for the exact wiring (one import line + the route list below).
@Controller('partners')
export class PartnersController {
  constructor(private svc: PartnersService) {}

  /** Parts catalog: search/list by category, stock status, partner. */
  @Get('catalog')
  catalog(@Query() q: CatalogQueryDto) {
    return this.svc.listCatalogItems({
      q: q.q,
      category: q.category,
      partner_id: q.partner_id,
      in_stock_only: q.in_stock_only ?? false,
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
    });
  }

  @Get('catalog/:id')
  catalogItem(@Param('id', uuidParamPipe) id: string) {
    return this.svc.getCatalogItem(id);
  }

  /** Provider orders parts for one of their jobs. Prices come from the
   *  catalog — the client only sends item ids + quantities (+ optional
   *  price checks, which must match the catalog). */
  @Roles('provider')
  @Post('orders')
  createOrder(@CurrentUser() u: AuthUser, @Body() dto: CreatePartnerOrderDto, @Headers('idempotency-key') key?: string) {
    return this.svc.createOrder(u.id, dto, key);
  }

  @Roles('provider')
  @Get('orders')
  listMyOrders(@CurrentUser() u: AuthUser, @Query('limit') limit?: string) {
    return this.svc.listMyOrders(u.id, limit ? Number(limit) : 20);
  }

  @Get('orders/:id')
  getOrder(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getOrder(id, u.id);
  }

  /** Supplier confirmed the order — the affiliate fee is recorded now. */
  @Roles('provider')
  @Post('orders/:id/confirm')
  @HttpCode(200)
  confirmOrder(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Headers('idempotency-key') key?: string) {
    return this.svc.confirmOrder(id, u.id, false, key);
  }

  @Roles('provider')
  @Post('orders/:id/deliver')
  @HttpCode(200)
  deliverOrder(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Headers('idempotency-key') key?: string) {
    return this.svc.deliverOrder(id, u.id, false, key);
  }

  @Roles('provider')
  @Post('orders/:id/cancel')
  @HttpCode(200)
  cancelOrder(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Body() dto: CancelPartnerOrderDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.svc.cancelOrder(id, u.id, dto, false, key);
  }

  /** Job partner-orders view — the disclosure surface. Customer and
   *  provider of the job see the same orders and the same disclosure. */
  @Get('jobs/:jobId/orders')
  jobOrders(@CurrentUser() u: AuthUser, @Param('jobId', uuidParamPipe) jobId: string) {
    return this.svc.getJobPartnerOrders(jobId, u.id);
  }
}
