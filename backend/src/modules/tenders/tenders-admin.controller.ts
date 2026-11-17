import { Controller, HttpCode, Post } from '@nestjs/common';
import { TendersService } from './tenders.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/guards/roles.decorator';

// Admin tender-expiry sweep (Phase 3 integrator addition).
//
// There is no in-process scheduler / cron library in this repo (no
// @nestjs/schedule dependency, by design — the deploy has no cron service
// to host one). Deadline expiry therefore runs as an explicit admin call:
// the operator (or an external scheduler) calls this endpoint hourly.
// It is idempotent and safe to call more often: tenders not yet due, and
// tenders already EXPIRED / AWARDED / CANCELLED, are left untouched.
// Lazy expiry on a late quote attempt (TendersService.submitQuote) still
// applies as a backstop, so a tender is never quotable past its deadline
// even if a sweep run is missed.
@Controller('admin/tenders')
export class TendersAdminController {
  constructor(private svc: TendersService) {}

  @Roles('super_admin', 'support_agent')
  @Post('expire-due')
  @HttpCode(200)
  expireDue(@CurrentUser() u: AuthUser) {
    return this.svc.expireDueTenders(u.id);
  }
}
