import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { RealtimeModule } from './realtime/realtime.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { SearchModule } from './modules/search/search.module';
import { RequestsModule } from './modules/requests/requests.module';
import { OffersModule } from './modules/offers/offers.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { AdminModule } from './modules/admin/admin.module';
import { FavouritesModule } from './modules/favourites/favourites.module';
import { SupportModule } from './modules/support/support.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { TrustModule } from './modules/trust/trust.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { HealthModule } from './modules/health/health.module';
import { AiGatewayModule } from './modules/ai-gateway/ai-gateway.module';
import { RiskModule } from './modules/risk/risk.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { TeamsModule } from './modules/teams/teams.module';
import { TendersModule } from './modules/tenders/tenders.module';
import { VerificationModule } from './modules/verification/verification.module';
import { EscrowModule } from './modules/escrow/escrow.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { CitiesModule } from './modules/cities/cities.module';
import { WarrantyModule } from './modules/warranty/warranty.module';
import { PartnersModule } from './modules/partners/partners.module';
import { PlacesModule } from './modules/places/places.module';

@Module({
  imports: [DatabaseModule, RealtimeModule, AuthModule, UsersModule, ProvidersModule, CatalogModule, SearchModule, RequestsModule, OffersModule, JobsModule, MessagingModule, AdminModule, TrustModule, PaymentsModule, HealthModule, AiGatewayModule, RiskModule, SubscriptionsModule, TeamsModule, TendersModule, VerificationModule, EscrowModule, AnalyticsModule, CitiesModule, WarrantyModule, PartnersModule, PlacesModule, FavouritesModule, SupportModule, NotificationsModule],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // FIX 9: runs after auth, so req.user is set and limits key per-user
    // when authenticated, per-IP otherwise. Only handlers carrying
    // @RateLimit(...) metadata are limited.
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
