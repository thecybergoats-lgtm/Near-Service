import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/api_client.dart';
import 'core/models.dart';
import 'features/auth/language_screen.dart';
import 'features/auth/onboarding_screen.dart';
import 'features/auth/otp_screen.dart';
import 'features/auth/phone_screen.dart';
import 'features/auth/role_screen.dart';
import 'features/customer/category_screen.dart';
import 'features/customer/ai_search_screen.dart';
import 'features/customer/tenders_screen.dart';
import 'features/customer/chat_screen.dart';
import 'features/customer/dispute_screen.dart';
import 'features/customer/favorites_screen.dart';
import 'features/customer/history_screen.dart';
import 'features/customer/home_screen.dart';
import 'features/customer/job_tracking_screen.dart';
import 'features/customer/offers_screen.dart';
import 'features/customer/payment_screen.dart';
import 'features/customer/provider_list_screen.dart';
import 'features/customer/provider_profile_screen.dart';
import 'features/customer/rating_screen.dart';
import 'features/customer/request_form_screen.dart';
import 'features/customer/search_screen.dart';
import 'features/customer/settings_screen.dart';
import 'features/customer/trusted_contacts_screen.dart';
import 'features/customer/wallet_screen.dart';
import 'features/search/search_metrics_screen.dart';
import 'features/provider/active_job_screen.dart';
import 'features/provider/adjustment_screen.dart';
import 'features/provider/availability_screen.dart';
import 'features/provider/dashboard_screen.dart';
import 'features/provider/earnings_screen.dart';
import 'features/provider/escrow_screen.dart';
import 'features/provider/parts_order_screen.dart';
import 'features/provider/subscription_screen.dart';
import 'features/provider/teams_screen.dart';
import 'features/provider/verification_screen.dart';
import 'features/provider/my_services_screen.dart';
import 'features/provider/onboarding_wizard.dart';
import 'features/provider/service_area_screen.dart';

GoRouter buildRouter() {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (_, __) => const LanguageScreen()),
      GoRoute(path: '/onboarding', builder: (_, __) => const OnboardingScreen()),
      GoRoute(path: '/auth/phone', builder: (_, __) => const PhoneScreen()),
      GoRoute(
        path: '/auth/otp',
        builder: (_, state) => OtpScreen(phone: (state.extra as String?) ?? ''),
      ),
      GoRoute(path: '/auth/role', builder: (_, __) => const RoleScreen()),
      // Customer
      GoRoute(path: '/customer/home', builder: (_, __) => const HomeScreen()),
      GoRoute(path: '/customer/search', builder: (_, __) => const SearchScreen()),
      GoRoute(path: '/customer/categories', builder: (_, __) => const CategoryScreen()),
      GoRoute(
        path: '/customer/providers',
        builder: (_, state) => ProviderListScreen(
          categoryId: (state.extra as Map?)?['categoryId'] as String?,
        ),
      ),
      GoRoute(
        path: '/customer/provider/:id',
        builder: (_, state) => ProviderProfileScreen(
          providerId: state.pathParameters['id'] ?? '',
          initial: state.extra is ServiceProvider ? state.extra as ServiceProvider : null,
        ),
      ),
      GoRoute(
        path: '/customer/request',
        builder: (_, state) {
          final extra = (state.extra as Map?) ?? {};
          return RequestFormScreen(
            categoryId: extra['categoryId'] as String?,
            categorySlug: extra['categorySlug'] as String?,
          );
        },
      ),
      GoRoute(
        path: '/customer/offers/:requestId',
        builder: (_, state) =>
            OffersScreen(requestId: state.pathParameters['requestId'] ?? ''),
      ),
      GoRoute(
        path: '/customer/job/:jobId',
        builder: (_, state) => JobTrackingScreen(
          jobId: state.pathParameters['jobId'] ?? '',
          initial: state.extra is Job ? state.extra as Job : null,
        ),
      ),
      GoRoute(
        path: '/customer/chat/:chatId',
        builder: (_, state) {
          final extra = (state.extra as Map?) ?? {};
          return ChatScreen(
            chatId: state.pathParameters['chatId'] ?? '',
            peerName: (extra['peerName'] as String?) ?? 'Provider',
            peerId: extra['peerId'] as String?,
          );
        },
      ),
      GoRoute(
        path: '/customer/payment/:jobId',
        builder: (_, state) => PaymentScreen(
          jobId: state.pathParameters['jobId'] ?? '',
          job: state.extra is Job ? state.extra as Job : null,
        ),
      ),
      GoRoute(
        path: '/customer/rating/:jobId',
        builder: (_, state) => RatingScreen(
          jobId: state.pathParameters['jobId'] ?? '',
          job: state.extra is Job ? state.extra as Job : null,
        ),
      ),
      GoRoute(path: '/customer/history', builder: (_, __) => const HistoryScreen()),
      GoRoute(path: '/customer/favorites', builder: (_, __) => const FavoritesScreen()),
      GoRoute(
        path: '/customer/wallet',
        builder: (_, state) => WalletScreen(
          startTopUp: state.extra is bool && (state.extra as bool),
        ),
      ),
      // Phase 2 — dispute centre: list, or open on one job.
      GoRoute(path: '/customer/disputes', builder: (_, __) => const DisputeScreen()),
      // Phase 3 — AI search (intent / photo / voice + fair price) and tenders.
      GoRoute(path: '/customer/ai-search', builder: (_, __) => const AiSearchScreen()),
      GoRoute(path: '/customer/tenders', builder: (_, __) => const TendersScreen()),
      GoRoute(
        path: '/customer/dispute/:jobId',
        builder: (_, state) => DisputeScreen(
          jobId: state.pathParameters['jobId'],
        ),
      ),
      GoRoute(path: '/customer/settings', builder: (_, __) => const SettingsScreen()),
      // FIX 10 — trusted contacts (SOS needs at least one).
      GoRoute(path: '/customer/trusted-contacts', builder: (_, __) => const TrustedContactsScreen()),
      // Provider
      GoRoute(path: '/provider/onboarding', builder: (_, __) => const ProviderOnboardingWizard()),
      GoRoute(path: '/provider/dashboard', builder: (_, __) => const ProviderDashboardScreen()),
      GoRoute(
        path: '/provider/active-job/:jobId',
        builder: (_, state) => ActiveJobScreen(jobId: state.pathParameters['jobId'] ?? ''),
      ),
      // Fix B — the provider rates the customer too; the second review
      // moves the job to RATED. Same screen as the customer flow, with
      // the provider's copy and return route.
      GoRoute(
        path: '/provider/rating/:jobId',
        builder: (_, state) => RatingScreen(
          jobId: state.pathParameters['jobId'] ?? '',
          job: state.extra is Job ? state.extra as Job : null,
          role: 'provider',
        ),
      ),
      // FIX 10 — provider "me" settings + extra-work adjustments.
      GoRoute(path: '/provider/services', builder: (_, __) => const MyServicesScreen()),
      GoRoute(path: '/provider/service-area', builder: (_, __) => const ServiceAreaScreen()),
      GoRoute(path: '/provider/availability', builder: (_, __) => const AvailabilityScreen()),
      GoRoute(
        path: '/provider/adjustment/:jobId',
        builder: (_, state) => AdjustmentScreen(jobId: state.pathParameters['jobId'] ?? ''),
      ),
      GoRoute(path: '/provider/earnings', builder: (_, __) => const EarningsScreen()),
      // Phase 3 — subscription, teams, verification, escrow & payouts.
      GoRoute(path: '/provider/subscription', builder: (_, __) => const SubscriptionScreen()),
      GoRoute(path: '/provider/teams', builder: (_, __) => const TeamsScreen()),
      GoRoute(path: '/provider/verification', builder: (_, __) => const VerificationScreen()),
      GoRoute(path: '/provider/escrow', builder: (_, __) => const EscrowScreen()),
      // Phase 4 (item 5) — partner parts ordering for one of my jobs:
      // push('/provider/parts?jobId=<job id>'). ApiClient implements
      // PartnerApi, so the screen gets it via ref.read(apiClientProvider).
      GoRoute(
        path: '/provider/parts',
        builder: (_, state) => Consumer(
          builder: (_, ref, __) => PartsOrderScreen(
            jobId: state.uri.queryParameters['jobId'] ?? '',
            api: ref.read(apiClientProvider),
          ),
        ),
      ),
      // Phase 4 (item 1) — search metrics, admin-only surface (the
      // backend endpoint requires super_admin; a customer/provider token
      // returns 403). The token must be passed by the navigating caller
      // as `extra`: push('/admin/search-metrics', extra: adminToken).
      // NOT compile-verified (no Flutter/Dart here).
      GoRoute(
        path: '/admin/search-metrics',
        builder: (_, state) => SearchMetricsScreen(
          token: state.extra is String ? state.extra as String : '',
        ),
      ),
    ],
    errorBuilder: (_, state) => Scaffold(
      appBar: AppBar(title: const Text('Near Service')),
      body: Center(child: Text('Page not found: ${state.uri}')),
    ),
  );
}
