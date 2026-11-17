import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api_client.dart';
import '../../core/category_resolver.dart';
import '../../core/constants.dart';
import '../../core/demo_data.dart';
import '../../core/models.dart';
import '../../core/theme.dart';
import '../../l10n/app_localizations.dart';
import '../common/widgets.dart';
import 'favorites_screen.dart';

/// Customer home (PRD p.22): full-screen map, search bar, category chips,
/// popular rows, Post-a-request FAB. Falls back to demo providers offline.
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
  /// Active promotions from GET /promotions/active (Batch 2). The
  /// banner shows ONLY these — never hardcoded promo text. Empty or
  /// failed load hides the banner entirely.
  List<PromoItem> _promos = [];

  @override
  void initState() {
    super.initState();
    loadFavoriteIds(ref);
    _load();
  }

  Future<void> _load() async {
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
      default:
        return Icons.build;
    }
  }

  /// Real-shop discovery for the selected category (OpenStreetMap, free).
  /// Runs only with a category selected; resolves the category slug from
  /// the loaded list (the id is a UUID from the API, a slug in demo data).
  /// Any failure leaves [_places] empty and marks the lookup degraded —
  /// the provider list is unaffected.
  Future<void> _loadPlaces() async {
    _places = [];
    _placesDegraded = false;
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
    } catch (_) {
      _places = [];
      _placesDegraded = true;
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
  /// that opens Google Maps (free intent URL, no API key).
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
              const Text(
                'Real shop from OpenStreetMap — not a registered Near Service provider. Call or visit directly.',
                style: TextStyle(color: Colors.grey),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: () => _openDirections(s),
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

  Future<void> _openDirections(PlaceShop s) async {
    final uri = Uri.parse(
        'https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}');
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text('Could not open Maps — is Google Maps installed?')),
        );
      }
    }
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
    return Scaffold(
      body: Stack(
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
                ],
              ),
            ],
          ),
          SafeArea(
            child: Column(
              children: [
                if (_offline) const OfflineBanner(isDemo: true),
                Padding(
                  padding: const EdgeInsets.all(12),
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
                          const Icon(Icons.search, color: Colors.grey),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(l.t('search_hint'),
                                style: const TextStyle(color: Colors.grey)),
                          ),
                          IconButton(
                            icon: const Icon(Icons.mic_none),
                            onPressed: () => context.push('/customer/search',
                                extra: {'autoListen': true}),
                            tooltip: l.t('voice_search_hint'),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                // Batch 2 — promo/deals banner: ONLY real active promos
                // from GET /promotions/active. Hidden when there are none.
                if (_promos.isNotEmpty)
                  TweenAnimationBuilder<double>(
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
                // Batch 2 — category grid for the 5 launch categories.
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
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
                const Spacer(),
                // Real-shop status line, shown only with a category
                // selected: OSM attribution when pins are visible, else a
                // plain "none found" note. Providers still show either way.
                if (_selectedCategory != null && !_loading)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Text(
                      _places.isNotEmpty
                          ? AppConstants.osmAttribution
                          : _placesDegraded
                              ? 'Real-shop lookup is unavailable right now — showing app providers.'
                              : 'No real shops found nearby for this service — showing app providers.',
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 11, color: Colors.grey),
                    ),
                  ),
                if (_loading)
                  const Padding(
                    padding: EdgeInsets.all(16),
                    child: CircularProgressIndicator(),
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
                  SizedBox(
                    height: 120,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      itemCount: _providers.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 8),
                      itemBuilder: (_, i) {
                        final p = _providers[i];
                        return SizedBox(
                          width: 260,
                          child: ProviderCard(
                            provider: p,
                            isFavorite: favIds.contains(p.id),
                            onFavoriteToggle: () =>
                                toggleFavorite(ref, p.id),
                            onTap: () => context.push('/customer/provider/${p.id}', extra: p),
                            onRequestQuote: () => context.push(
                              '/customer/request',
                              extra: _requestExtra(),
                            ),
                          ),
                        );
                      },
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/customer/request',
            extra: _requestExtra()),
        backgroundColor: const Color(0xFF0F766E),
        icon: const Icon(Icons.add, color: Colors.white),
        label: Text(l.t('post_request'), style: const TextStyle(color: Colors.white)),
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
