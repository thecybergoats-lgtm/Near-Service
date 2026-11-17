import { Module } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { MessagingController } from './messaging.controller';
import { RealtimeModule } from '../../realtime/realtime.module';
@Module({ imports: [RealtimeModule], controllers: [MessagingController], providers: [MessagingService] })
export class MessagingModule {}
