import { Module } from '@nestjs/common';
import { OffersService } from './offers.service';
import { OffersController } from './offers.controller';
import { RealtimeModule } from '../../realtime/realtime.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
@Module({ imports: [RealtimeModule, SubscriptionsModule], controllers: [OffersController], providers: [OffersService], exports: [OffersService] })
export class OffersModule {}
