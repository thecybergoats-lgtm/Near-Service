// Escrow release + provider payouts (Phase 3, item 8).
// INTEGRATOR NOTE: this module is NOT yet wired into AppModule —
// backend/src/app.module.ts is owned by the integrator (do not edit it
// from this piece). To wire it up, add:
//   import { EscrowModule } from './modules/escrow/escrow.module';
// and add EscrowModule to the imports array. The module constructor
// fails loudly in PAYMENT_GATEWAY_MODE=live without live credentials
// (via createGatewayProviders), exactly like PaymentsModule.
// DatabaseModule is @Global, so DatabaseService/RedisService resolve
// without an explicit import here.
import { Module } from '@nestjs/common';
import { RealtimeModule } from '../../realtime/realtime.module';
import { EscrowService } from './escrow.service';
import { EscrowController } from './escrow.controller';
import { EscrowAdminController } from './escrow-admin.controller';

@Module({
  imports: [RealtimeModule],
  controllers: [EscrowController, EscrowAdminController],
  providers: [EscrowService],
  exports: [EscrowService],
})
export class EscrowModule {}
