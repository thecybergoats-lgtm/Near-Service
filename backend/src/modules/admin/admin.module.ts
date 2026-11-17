import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { RealtimeModule } from '../../realtime/realtime.module';
import { ProvidersModule } from '../providers/providers.module';
import { VerificationModule } from '../verification/verification.module';
import { SearchModule } from '../search/search.module';
@Module({ imports: [RealtimeModule, ProvidersModule, VerificationModule, SearchModule], controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}
