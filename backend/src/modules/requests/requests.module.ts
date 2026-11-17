import { Module } from '@nestjs/common';
import { RequestsService } from './requests.service';
import { RequestsController, WaitlistController } from './requests.controller';
import { CatalogModule } from '../catalog/catalog.module';
import { RealtimeModule } from '../../realtime/realtime.module';
@Module({ imports: [CatalogModule, RealtimeModule], controllers: [RequestsController, WaitlistController], providers: [RequestsService], exports: [RequestsService] })
export class RequestsModule {}
