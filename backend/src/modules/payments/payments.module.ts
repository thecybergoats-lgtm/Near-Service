import { Module } from '@nestjs/common';
import { RealtimeModule } from '../../realtime/realtime.module';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { PromotionsService } from './promotions.service';
import { PromotionsController } from './promotions.controller';
import { CommissionAdminController } from './commission-admin.controller';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationAdminController } from './reconciliation.controller';
import { assertGatewayConfig } from './gateway-sandbox';
import { WarrantyModule } from '../warranty/warranty.module';

/** Phase 2 payments: wallet, JazzCash/Easypaisa sandbox gateways,
 *  commission engine, promos + referrals.
 *  The module constructor fails loudly at boot when
 *  PAYMENT_GATEWAY_MODE=live without live credentials — the app never
 *  silently falls back to sandbox in production. */
@Module({
  imports: [RealtimeModule, WarrantyModule],
  controllers: [WalletController, PromotionsController, CommissionAdminController, ReconciliationAdminController],
  providers: [WalletService, PromotionsService, ReconciliationService],
  exports: [WalletService, PromotionsService, ReconciliationService],
})
export class PaymentsModule {
  constructor() {
    assertGatewayConfig();
  }
}
