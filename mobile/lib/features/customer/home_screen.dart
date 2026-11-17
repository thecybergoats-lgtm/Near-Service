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
import '../../l10n/app_localizations.dart';
import '../common/widgets.dart';

/// Customer home (PRD p.22): full-screen map, search bar, category chips,
/// popular rows, Post-a-request FAB. Falls back to demo providers offline.
class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  LatLng _center = const LatLng(AppConstants.quettaLat, AppConstants.quettaLng);
  List<Provider> _providers = [];
  List<Category> _categories = DemoData.categories;
  bool _loading = true;
  bool _offline = false;
  String? _selectedCategory;

  @override
  void initState() {
    super.initState();
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
    if (mounted) setState(() => _loading = false);
  }

  bool _matchesCategory(Provider p) => true; // demo list is unfiltered

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
                        color: Colors.white,
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
                            onPressed: () => context.push('/customer/search'),
                            tooltip: 'Voice search (Phase 3)',
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                SizedBox(
                  height: 40,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    itemCount: _categories.length,
                    separatorBuilder: (_, __) => const SizedBox(width: 8),
                    itemBuilder: (_, i) {
                      final c = _categories[i];
                      final selected = _selectedCategory == c.id;
                      return ChoiceChip(
                        label: Text(c.displayName(locale)),
                        selected: selected,
                        onSelected: (_) {
                          setState(() {
                            _selectedCategory = selected ? null : c.id;
                          });
                          _load();
                        },
                      );
                    },
                  ),
                ),
                const Spacer(),
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
              context.push('/customer/history');
            case 3:
              context.push('/customer/wallet');
          }
        },
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.map), label: 'Home'),
          BottomNavigationBarItem(icon: Icon(Icons.people), label: 'Providers'),
          BottomNavigationBarItem(icon: Icon(Icons.history), label: 'History'),
          BottomNavigationBarItem(icon: Icon(Icons.account_balance_wallet), label: 'Wallet'),
        ],
      ),
    );
  }
}
