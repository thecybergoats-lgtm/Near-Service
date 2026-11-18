import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';

import '../../core/api_client.dart';
import '../../core/category_resolver.dart';
import '../../core/constants.dart';
import '../../core/demo_data.dart';
import '../../core/models.dart';
import '../../core/routing.dart';
import '../../core/theme.dart';
import '../../l10n/app_localizations.dart';
import '../common/widgets.dart';
import 'favorites_screen.dart';

/// Customer home (PRD p.22).
///
/// Batch 4 layout: the map is always visible — it takes the top ~45% of
/// the screen with the search bar overlaid on it. Promo banner, deals,
/// the category grid and the provider list live BELOW the map in a
/// scrollable section, so they never cover the map. The "Post a request"
/// button is an in-flow button at the top of that section (never floating
/// over provider cards). Falls back to demo providers offline.
class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  LatLng _center = const LatLng(AppConstants.quettaLat, AppConstants.quettaLng);
  List<ServiceProvider> _providers = [];
  List<Category> _categories = DemoData.categories;
  bool _loading = true;
  bool _offline = false;
  String? _selectedCategory;
  /// Real-world shops from OpenStreetMap (GET /places/nearby). Shown only
  /// when a category is selected, as amber pins — separate from the teal
  /// registered-provider pins. Empty when nothing was found or the lookup
  /// failed (providers still show).
  List<PlaceShop> _places = [];
  bool _placesDegraded = false;
  bool _placesEmpty = false;
  /// In-app driving route to a shop (OSRM, free) — drawn on this map as
  /// a polyline. Never opens an external Maps app (Batch 4).
  RouteResult? _route;
  PlaceShop? _routeShop;
  /// Active promotions from GET /promotions/active (Batch 2). The
  /// banner shows ONLY these — never hardcoded promo text. Empty or
  /// failed load hides the banner entirely.
  List<PromoItem> _promos = [];
  /// Deals of the day from GET /promotions/today (Batch 3) — same
  /// active promos, with validity info. Hidden when there are none.
  List<TodayDeal> _deals = [];

  @override
  void initState() {
    super.initState();
    loadFavoriteIds(ref);
    _load();
  }

  Future<void> _load() async {
    _route = null;
    _routeShop = null;
    setState(() => _loading = true);
    try {
      final pos = await _currentPosition();
      if (pos != null) _center = LatLng(pos.latitude, pos.longitude);
    } catch (_) {
      // Location permission denied — stay on Quetta centre.
    }
    try {
      final api = ref.read(apiClientProvider);
      final cats = await api.getCategories();
      if (cats.isNotEmpty) _categories = cats;
      _providers = await api.getNearbyProviders(
        lat: _center.latitude,
        lng: _center.longitude,
        categoryId: _selectedCategory,
        radiusKm: AppConstants.defaultRadiusKm,
      );
      _offline = false;
    } catch (_) {
      _providers = DemoData.providers
          .where((p) => _selectedCategory == null || _matchesCategory(p))
          .toList();
      _offline = true;
    }
    await _loadPlaces();
    await _loadPromos();
    await _loadDeals();
    if (mounted) setState(() => _loading = false);
  }

  /// Batch 2 promo banner data. Any failure leaves [_promos] empty
  /// and the banner hidden — a missing promo is never faked.
  Future<void> _loadPromos() async {
    try {
      _promos = await ref.read(apiClientProvider).getActivePromotions();
    } catch (_) {
      _promos = [];
    }
  }

  /// Batch 3 deals of the day. Same rule as promos: any failure leaves
  /// [_deals] empty and the section hidden — a deal is never invented.
  Future<void> _loadDeals() async {
    try {
      _deals = await ref.read(apiClientProvider).getDealsToday();
    } catch (_) {
      _deals = [];
    }
  }

  IconData _iconForCategory(Category c) {
    switch (c.slug) {
      case 'book-binding':
        return Icons.book;
      case 'ac-repair':
        return Icons.ac_unit;
      case 'electrician':
        return Icons.electrical_services;
      case 'plumber':
        return Icons.plumbing;
      case 'mobile-repair':
        return Icons.phone_android;
      case 'tailoring':
        return Icons.content_cut;
      case 'carpentry':
        return Icons.handyman;
      case 'painting':
        return Icons.format_paint;
      case 'cleaning':
        return Icons.cleaning_services;
      case 'tutoring':
        return Icons.school;
      case 'printing':
        return Icons.print;
      case 'car-mechanic':
        return Icons.car_repair;
      case 'appliance-repair':
        return Icons.kitchen;
      default:
        return Icons.build;
    }
  }

  /// Real-shop discovery for the selected category (OpenStreetMap, free).
  /// Runs only with a category selected; resolves the category slug from
  /// the loaded list (the id is a UUID from the API, a slug in demo data).
  /// Three states (Batch 4): shops found, empty (Overpass answered fine
  /// but nothing is mapped for this category), degraded (Overpass error /
  /// timeout). Providers are unaffected in all three.
  Future<void> _loadPlaces() async {
    _places = [];
    _placesDegraded = false;
    _placesEmpty = false;
    final slug = _selectedCategorySlug();
    if (slug == null) return;
    try {
      final api = ref.read(apiClientProvider);
      final res = await api.getNearbyPlaces(
        lat: _center.latitude,
        lng: _center.longitude,
        categorySlug: slug,
        radiusKm: AppConstants.placesRadiusKm,
      );
      _places = res.shops;
      _placesDegraded = res.degraded;
      _placesEmpty = res.empty;
    } catch (_) {
      _places = [];
      _placesDegraded = true;
      _placesEmpty = false;
    }
  }

  String? _selectedCategorySlug() {
    final sel = _selectedCategory;
    if (sel == null) return null;
    for (final c in _categories) {
      if (c.id == sel) return c.slug.isNotEmpty ? c.slug : null;
    }
    // Demo data / deep links may carry the slug itself as the id.
    if (AppConstants.launchCategorySlugs.contains(sel)) return sel;
    return null;
  }

  /// Shop pin bottom sheet: name, kind + distance, a note that this is a
  /// real map shop (not a registered provider), and a Directions button
  /// that draws the route on THIS map (in-app OSRM routing — Batch 4,
  /// never an external Maps app).
  Future<void> _showShopSheet(PlaceShop s) async {
    await showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(s.name,
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text('${s.kindLabel} · ${s.distanceKm.toStringAsFixed(1)} km away'),
              const SizedBox(height: 4),
              Text(
                'Real shop from OpenStreetMap — not a registered Near Service provider. Call or visit directly.',
                style: TextStyle(color: Theme.of(ctx).colorScheme.onSurfaceVariant),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: () => _routeToShop(s),
                  icon: const Icon(Icons.directions),
                  label: const Text('Directions'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// In-app directions (Batch 4): fetch a driving route from the user's
  /// position to the shop via the free OSRM demo server and draw it on
  /// this screen's own map. On failure the map stays usable and a short
  /// message is shown — no external app is ever launched.
  Future<void> _routeToShop(PlaceShop s) async {
    Navigator.of(context).pop();
    final result = await fetchDrivingRoute(_center, LatLng(s.lat, s.lng));
    if (!mounted) return;
    if (result == null) {
      final l = L.of(ref.read(localeProvider));
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l.t('route_failed'))),
      );
      return;
    }
    setState(() {
      _route = result;
      _routeShop = s;
    });
  }

  bool _matchesCategory(ServiceProvider p) => true; // demo list is unfiltered

  /// Extra map for the request form: a UUID goes as `categoryId`, a slug
  /// goes as `categorySlug` — a slug is never passed as `categoryId`
  /// (PRD v1.1 identifier rule). No category selected yet defaults to
  /// the Book Binding slug.
  Map<String, String> _requestExtra() {
    final selected = _selectedCategory;
    if (selected == null) return const {'categorySlug': 'book-binding'};
    if (CategoryResolver.isUuid(selected)) {
      return {'categoryId': selected};
    }
    return {'categorySlug': selected};
  }

  Future<Position?> _currentPosition() async {
    final serviceOn = await Geolocator.isLocationServiceEnabled();
    if (!serviceOn) return null;
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      return null;
    }
    return Geolocator.getCurrentPosition();
  }

  @override
  Widget build(BuildContext context) {
    final locale = ref.watch(localeProvider);
    final l = L.of(locale);
    final scheme = Theme.of(context).colorScheme;
    final favIds = ref.watch(favoriteIdsProvider);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    // Map keeps a proper visible area (~45% of the screen); everything
    // else scrolls below it and can never cover the map.
    final mapHeight = MediaQuery.of(context).size.height * 0.45;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            if (_offline) const OfflineBanner(isDemo: true),
            // ---- Map (top, always visible) ----
            SizedBox(
              height: mapHeight,
              child: Stack(
                children: [
                  FlutterMap(
                    options: MapOptions(
                      initialCenter: _center,
                      initialZoom: AppConstants.defaultZoom,
                      onTap: (_, __) {},
                    ),
                    children: [
                      TileLayer(
                        urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                        userAgentPackageName: AppConstants.packageName,
                      ),
                      if (_route != null)
                        PolylineLayer(
                          polylines: [
                            Polyline(
                              points: _route!.points,
                              color: AppColors.primary,
                              strokeWidth: 5,
                            ),
                          ],
                        ),
                      MarkerLayer(
                        markers: [
                          Marker(
                            point: _center,
                            width: 40,
                            height: 40,
                            child: const Icon(Icons.my_location, color: Colors.blue, size: 32),
                          ),
                          ..._providers.map((p) => Marker(
                                point: LatLng(p.lat, p.lng),
                                width: 44,
                                height: 44,
                                child: GestureDetector(
                                  onTap: () => context.push('/customer/provider/${p.id}', extra: p),
                                  child: const Icon(Icons.location_pin, color: Color(0xFF0F766E), size: 40),
                                ),
                              )),
                          // Real OpenStreetMap shops: amber store pins, distinct
                          // from the teal registered-provider pins.
                          ..._places.map((s) => Marker(
                                point: LatLng(s.lat, s.lng),
                                width: 44,
                                height: 44,
                                child: GestureDetector(
                                  onTap: () => _showShopSheet(s),
                                  child: const Icon(Icons.store, color: Color(0xFFD97706), size: 36),
                                ),
                              )),
                          if (_route != null && _routeShop != null)
                            Marker(
                              point: LatLng(_routeShop!.lat, _routeShop!.lng),
                              width: 44,
                              height: 44,
                              child: const Icon(Icons.location_on, color: Color(0xFFD97706), size: 40),
                            ),
                        ],
                      ),
                    ],
                  ),
                  // Search bar overlaid on the map.
                  Positioned(
                    top: 12,
                    left: 12,
                    right: 12,
                    child: GestureDetector(
                      onTap: () => context.push('/customer/search'),
                      child: Container(
                        height: kMinTouch,
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        decoration: BoxDecoration(
                          color: scheme.surface,
                          borderRadius: BorderRadius.circular(24),
                          boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 8)],
                        ),
                        child: Row(
                          children: [
                            Icon(Icons.search, color: scheme.onSurfaceVariant),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(l.t('search_hint'),
                                  style: TextStyle(color: scheme.onSurfaceVariant)),
                            ),
                            IconButton(
                              icon: const Icon(Icons.mic_none),
                              onPressed: () => context.push('/customer/search',
                                  extra: {'autoListen': true}),
                              tooltip: l.t('voice_search_hint'),
                            ),
                            IconButton(
                              icon: const Icon(Icons.qr_code_scanner),
                              onPressed: () => context.push('/customer/scan-qr'),
                              tooltip: l.t('scan_qr_code'),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  // Active route chip: distance + ETA + clear.
                  if (_route != null && _routeShop != null)
                    Positioned(
                      left: 12,
                      right: 12,
                      bottom: 12,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        decoration: BoxDecoration(
                          color: scheme.surface,
                          borderRadius: BorderRadius.circular(16),
                          boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 8)],
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.directions, color: AppColors.primary, size: 20),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                '${_routeShop!.name} · ${_route!.distanceKm.toStringAsFixed(1)} km · ~${_route!.durationMin} min',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
                              ),
                            ),
                            TextButton(
                              onPressed: () => setState(() {
                                _route = null;
                                _routeShop = null;
                              }),
                              child: Text(l.t('clear_route')),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ),
            // ---- Scrollable content below the map ----
            Expanded(
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Post a request — in-flow button, never floating over cards.
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                      child: SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          onPressed: () => context.push('/customer/request',
                              extra: _requestExtra()),
                          icon: const Icon(Icons.add),
                          label: Text(l.t('post_request')),
                        ),
                      ),
                    ),
                    // Batch 2 — promo/deals banner: ONLY real active promos
                    // from GET /promotions/active. Hidden when there are none.
                    if (_promos.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: TweenAnimationBuilder<double>(
                          tween: Tween(begin: 0, end: 1),
                          duration: const Duration(milliseconds: 400),
                          builder: (ctx, value, child) => Opacity(
                            opacity: value,
                            child: Transform.translate(
                              offset: Offset(0, (1 - value) * 8),
                              child: child,
                            ),
                          ),
                          child: SizedBox(
                            height: 64,
                            child: ListView.separated(
                              scrollDirection: Axis.horizontal,
                              padding: const EdgeInsets.symmetric(horizontal: 12),
                              itemCount: _promos.length,
                              separatorBuilder: (_, __) => const SizedBox(width: 8),
                              itemBuilder: (_, i) {
                                final promo = _promos[i];
                                return GestureDetector(
                                  onTap: () => context.push('/customer/request',
                                      extra: _requestExtra()),
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 14, vertical: 8),
                                    decoration: BoxDecoration(
                                      gradient: const LinearGradient(
                                        colors: [
                                          Color(0xFF0F766E),
                                          Color(0xFFC9A227),
                                        ],
                                      ),
                                      borderRadius: BorderRadius.circular(16),
                                    ),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        const Icon(Icons.local_offer,
                                            color: Colors.white, size: 20),
                                        const SizedBox(width: 8),
                                        Column(
                                          mainAxisSize: MainAxisSize.min,
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(promo.title,
                                                style: const TextStyle(
                                                    color: Colors.white,
                                                    fontWeight: FontWeight.w700,
                                                    fontSize: 13)),
                                            Text(
                                              promo.discountText.isNotEmpty
                                                  ? promo.discountText
                                                  : 'Code: ${promo.code}',
                                              style: const TextStyle(
                                                  color: Colors.white70,
                                                  fontSize: 11),
                                            ),
                                          ],
                                        ),
                                      ],
                                    ),
                                  ),
                                );
                              },
                            ),
                          ),
                        ),
                      ),
                    // Batch 3 — Deals of the day: ONLY real deals from
                    // GET /promotions/today. Hidden when there are none.
                    // Tapping a deal opens the request form with its promo
                    // code pre-filled (and validated there).
                    // Batch 4: the card is theme-aware — light text on a
                    // light card in dark mode made the code unreadable.
                    if (_deals.isNotEmpty) ...[
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                        child: Row(
                          children: [
                            const Icon(Icons.local_offer_outlined, size: 18),
                            const SizedBox(width: 6),
                            Text(l.t('deals_of_the_day'),
                                style: const TextStyle(
                                    fontWeight: FontWeight.w700, fontSize: 16)),
                          ],
                        ),
                      ),
                      SizedBox(
                        height: 76,
                        child: ListView.separated(
                          scrollDirection: Axis.horizontal,
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          itemCount: _deals.length,
                          separatorBuilder: (_, __) => const SizedBox(width: 8),
                          itemBuilder: (_, i) {
                            final deal = _deals[i];
                            return GestureDetector(
                              onTap: () => context.push('/customer/request',
                                  extra: {
                                    ..._requestExtra(),
                                    'initialPromoCode': deal.code,
                                  }),
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 14, vertical: 10),
                                decoration: BoxDecoration(
                                  color: isDark
                                      ? const Color(0xFF3A2E0A)
                                      : const Color(0xFFFFF7E6),
                                  border: Border.all(
                                      color: const Color(0xFFC9A227)),
                                  borderRadius: BorderRadius.circular(12),
                                ),
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(deal.code,
                                        style: TextStyle(
                                            fontWeight: FontWeight.w800,
                                            fontSize: 14,
                                            color: scheme.onSurface)),
                                    Text(
                                      deal.discountText.isNotEmpty
                                          ? deal.discountText
                                          : deal.title,
                                      style: TextStyle(
                                          fontSize: 12,
                                          color: scheme.onSurfaceVariant),
                                    ),
                                    if (deal.endsToday)
                                      Text(l.t('ends_today'),
                                          style: TextStyle(
                                              fontSize: 11,
                                              color: isDark
                                                  ? const Color(0xFFFBBF24)
                                                  : const Color(0xFFB45309),
                                              fontWeight: FontWeight.w700)),
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
                      ),
                    ],
                    // Category grid — all 13 categories.
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
                      child: GridView.builder(
                        shrinkWrap: true,
                        physics: const NeverScrollableScrollPhysics(),
                        gridDelegate:
                            const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 5,
                          mainAxisSpacing: 8,
                          crossAxisSpacing: 8,
                          childAspectRatio: 0.82,
                        ),
                        itemCount: _categories.length,
                        itemBuilder: (_, i) {
                          final c = _categories[i];
                          final selected = _selectedCategory == c.id;
                          return TweenAnimationBuilder<double>(
                            tween: Tween(begin: 0, end: 1),
                            duration: Duration(milliseconds: 250 + i * 60),
                            builder: (ctx, value, child) => Opacity(
                              opacity: value,
                              child: child,
                            ),
                            child: GestureDetector(
                              onTap: () {
                                setState(() {
                                  _selectedCategory = selected ? null : c.id;
                                });
                                _load();
                              },
                              child: Container(
                                decoration: BoxDecoration(
                                  color: selected
                                      ? AppColors.primary
                                      : scheme.surface,
                                  borderRadius: BorderRadius.circular(14),
                                  boxShadow: const [
                                    BoxShadow(
                                        color: Colors.black12, blurRadius: 6)
                                  ],
                                ),
                                child: Column(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    Icon(_iconForCategory(c),
                                        size: 22,
                                        color: selected
                                            ? Colors.white
                                            : AppColors.primary),
                                    const SizedBox(height: 4),
                                    Padding(
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 2),
                                      child: Text(
                                        c.displayName(locale),
                                        textAlign: TextAlign.center,
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                        style: TextStyle(
                                          fontSize: 10,
                                          fontWeight: FontWeight.w600,
                                          color: selected
                                              ? Colors.white
                                              : null,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                    // Real-shop status line, shown only with a category
                    // selected. Three states (Batch 4): shops found (OSM
                    // attribution), empty (nothing mapped for this
                    // category), degraded (lookup unavailable). Providers
                    // still show in all three.
                    if (_selectedCategory != null && !_loading)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                        child: Text(
                          _places.isNotEmpty
                              ? AppConstants.osmAttribution
                              : _placesDegraded
                                  ? l.t('places_degraded')
                                  : _placesEmpty
                                      ? l.t('places_empty_mapped')
                                      : AppConstants.osmAttribution,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                              fontSize: 11, color: scheme.onSurfaceVariant),
                        ),
                      ),
                    if (_loading)
                      const Padding(
                        padding: EdgeInsets.all(16),
                        child: Center(child: CircularProgressIndicator()),
                      )
                    else if (_providers.isEmpty)
                      Padding(
                        padding: const EdgeInsets.all(16),
                        child: Card(
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Text(l.t('no_providers')),
                          ),
                        ),
                      )
                    else
                      Padding(
                        padding: const EdgeInsets.only(top: 8, bottom: 16),
                        child: ListView.separated(
                          shrinkWrap: true,
                          physics: const NeverScrollableScrollPhysics(),
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          itemCount: _providers.length,
                          separatorBuilder: (_, __) =>
                              const SizedBox(height: 8),
                          itemBuilder: (_, i) {
                            final p = _providers[i];
                            return ProviderCard(
                              provider: p,
                              isFavorite: favIds.contains(p.id),
                              onFavoriteToggle: () =>
                                  toggleFavorite(ref, p.id),
                              onTap: () => context.push(
                                  '/customer/provider/${p.id}',
                                  extra: p),
                              onRequestQuote: () => context.push(
                                '/customer/request',
                                extra: _requestExtra(),
                              ),
                            );
                          },
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: 0,
        onTap: (i) {
          switch (i) {
            case 1:
              context.push('/customer/providers');
            case 2:
              context.push('/customer/profile');
            case 3:
              context.push('/customer/settings');
          }
        },
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.map), label: 'Home'),
          BottomNavigationBarItem(icon: Icon(Icons.people), label: 'Providers'),
          BottomNavigationBarItem(icon: Icon(Icons.person), label: 'Profile'),
          BottomNavigationBarItem(icon: Icon(Icons.settings), label: 'Settings'),
        ],
      ),
    );
  }
}
