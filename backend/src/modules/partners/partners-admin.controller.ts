import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PartnersService } from './partners.service';
import {
  AdminOrdersQueryDto,
  AffiliateFeeReportQueryDto,
  CreateCatalogItemDto,
  CreatePartnerDto,
  UpdateCatalogItemDto,
  UpdatePartnerDto,
} from './dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/guards/roles.decorator';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

// Admin partner management (Phase 4, item 5). Integrator note: NOT wired
// into AppModule / openapi.yaml yet — see docs/phase4-partners.md.
@Controller('admin/partners')
@Roles('super_admin', 'finance', 'support_agent')
export class PartnersAdminController {
  constructor(private svc: PartnersService) {}

  @Get()
  listPartners() {
    return this.svc.listPartners(true);
  }

  @Post()
  createPartner(@Body() dto: CreatePartnerDto) {
    return this.svc.createPartner(dto);
  }

  @Patch(':id')
  updatePartner(@Param('id', uuidParamPipe) id: string, @Body() dto: UpdatePartnerDto) {
    return this.svc.updatePartner(id, dto);
  }

  @Post('catalog-items')
  createCatalogItem(@Body() dto: CreateCatalogItemDto) {
    return this.svc.createCatalogItem(dto);
  }

  @Patch('catalog-items/:id')
  updateCatalogItem(@Param('id', uuidParamPipe) id: string, @Body() dto: UpdateCatalogItemDto) {
    return this.svc.updateCatalogItem(id, dto);
  }

  @Get('orders')
  listOrders(@Query() q: AdminOrdersQueryDto) {
    return this.svc.listAdminOrders(q);
  }

  @Get('orders/:id')
  getOrder(@Param('id', uuidParamPipe) id: string) {
    return this.svc.getAdminOrder(id);
  }

  /** Admin order-state oversight: confirm / deliver / cancel any order. */
  @Post('orders/:id/confirm')
  @HttpCode(200)
  confirmOrder(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.adminTransitionOrder(id, 'confirmed', u.id);
  }

  @Post('orders/:id/deliver')
  @HttpCode(200)
  deliverOrder(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.adminTransitionOrder(id, 'delivered', u.id);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  cancelOrder(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: { reason?: string }) {
    return this.svc.adminTransitionOrder(id, 'cancelled', u.id, dto?.reason);
  }

  /** Affiliate fee reporting, with a ledger cross-check per fee txn. */
  @Get('affiliate-fees')
  affiliateFees(@Query() q: AffiliateFeeReportQueryDto) {
    return this.svc.affiliateFeeReport(q);
  }
}
