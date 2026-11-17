// Warranty Product (Phase 4, item 4).
// INTEGRATOR NOTE: this module is NOT yet wired into AppModule —
// backend/src/app.module.ts is owned by the integrator (do not edit it
// from this piece). To wire it up, add:
//   import { WarrantyModule } from './modules/warranty/warranty.module';
// and add WarrantyModule to the imports array, then add the routes in
// docs/phase4-warranty.md to backend/openapi.yaml (the route-diff
// contract test enforces spec == code, so both land together).
// DatabaseModule is @Global, so DatabaseService/RedisService resolve
// without an explicit import here.
import { Module } from '@nestjs/common';
import { RealtimeModule } from '../../realtime/realtime.module';
import { WarrantyService } from './warranty.service';
import { WarrantyController } from './warranty.controller';
import { WarrantyAdminController } from './warranty-admin.controller';

@Module({
  imports: [RealtimeModule],
  controllers: [WarrantyController, WarrantyAdminController],
  providers: [WarrantyService],
  exports: [WarrantyService],
})
export class WarrantyModule {}
