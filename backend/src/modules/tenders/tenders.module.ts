import { Module } from '@nestjs/common';
import { TendersService } from './tenders.service';
import { TendersController } from './tenders.controller';
import { TendersAdminController } from './tenders-admin.controller';
import { RealtimeModule } from '../../realtime/realtime.module';

// INTEGRATOR: add TendersModule to AppModule imports and add the routes
// in tenders.controller.ts to backend/openapi.yaml (route list is in the
// Phase 3 handoff report). No other module is touched by this piece.
@Module({
  imports: [RealtimeModule],
  controllers: [TendersController, TendersAdminController],
  providers: [TendersService],
  exports: [TendersService],
})
export class TendersModule {}
