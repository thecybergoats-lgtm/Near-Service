import { Module } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { ProvidersController, UploadsController } from './providers.controller';
import { RiskModule } from '../risk/risk.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SearchModule } from '../search/search.module';
@Module({ imports: [RiskModule, SubscriptionsModule, SearchModule], controllers: [ProvidersController, UploadsController], providers: [ProvidersService], exports: [ProvidersService] })
export class ProvidersModule {}
