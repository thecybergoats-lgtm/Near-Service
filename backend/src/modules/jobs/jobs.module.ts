import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobsQueryService } from './jobs-query.service';
import { SchedulingService } from './scheduling.service';
import { JobsController } from './jobs.controller';
import { RealtimeModule } from '../../realtime/realtime.module';
import { RequestsModule } from '../requests/requests.module';
import { WarrantyModule } from '../warranty/warranty.module';
import { NotificationsModule } from '../notifications/notifications.module';
@Module({
  imports: [RealtimeModule, RequestsModule, WarrantyModule, NotificationsModule],
  controllers: [JobsController],
  providers: [JobsService, JobsQueryService, SchedulingService],
  exports: [JobsService, JobsQueryService, SchedulingService],
})
export class JobsModule {}
