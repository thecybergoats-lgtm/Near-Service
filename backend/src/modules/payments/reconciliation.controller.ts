import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { Roles } from '../../common/guards/roles.decorator';

/** Ledger reconciliation (Stage 2, FIX 8b).
 *  POST /admin/reconciliation/run — run the job on demand (also the
 *  endpoint an external nightly scheduler calls; see
 *  reconciliation.service.ts header for the cron line).
 *  GET /admin/reconciliation — latest report (admin-visible record). */
@Controller('admin')
export class ReconciliationAdminController {
  constructor(private svc: ReconciliationService) {}

  @Roles('super_admin', 'finance') @Post('reconciliation/run') @HttpCode(200)
  run() { return this.svc.run('manual'); }

  @Roles('super_admin', 'finance') @Get('reconciliation')
  latest() { return this.svc.latest(); }
}
