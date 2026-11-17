import { Module } from '@nestjs/common';
import { PartnersService } from './partners.service';
import { PartnersController } from './partners.controller';
import { PartnersAdminController } from './partners-admin.controller';
import { RealtimeModule } from '../../realtime/realtime.module';

// INTEGRATOR: add PartnersModule to AppModule imports and add the routes
// in partners.controller.ts / partners-admin.controller.ts to
// backend/openapi.yaml — the full route list is in docs/phase4-partners.md.
// No other module is touched by this piece.
@Module({
  imports: [RealtimeModule],
  controllers: [PartnersController, PartnersAdminController],
  providers: [PartnersService],
  exports: [PartnersService],
})
export class PartnersModule {}
