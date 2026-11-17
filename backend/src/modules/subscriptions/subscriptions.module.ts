import { Module } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';

/** Phase 3 subscriptions: Free / Pro / Business plans, wallet billing,
 *  plan-discounted commission (see service header for the integration
 *  point), featured ("Sponsored") placement and provider analytics.
 *  NOTE: the integrator wires this module into AppModule; this file only
 *  declares the module itself. */
@Module({ controllers: [SubscriptionsController], providers: [SubscriptionsService], exports: [SubscriptionsService] })
export class SubscriptionsModule {}
