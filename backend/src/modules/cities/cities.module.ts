import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { CitiesService } from './cities.service';
import { SeoService } from './seo.service';
import { CitiesAdminController } from './cities-admin.controller';
import { SeoController } from './seo.controller';

// INTEGRATOR: add CitiesModule to AppModule imports and add the routes
// in cities-admin.controller.ts + seo.controller.ts to backend/openapi.yaml
// (the full route list is in docs/phase4-cities.md). No other module is
// touched by this piece. DatabaseModule is imported explicitly (not
// relied on via @Global) so the module also boots standalone in tests.
@Module({
  imports: [DatabaseModule],
  controllers: [CitiesAdminController, SeoController],
  providers: [CitiesService, SeoService],
  exports: [CitiesService, SeoService],
})
export class CitiesModule {}
