import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/api_client.dart';
import '../../core/demo_data.dart';
import '../../core/models.dart';
import '../common/widgets.dart';

/// Favourites: saved providers.
/// Batch 2 — server-backed: POST/DELETE /providers/:id/favourite and
/// GET /favourites. The local id set (SharedPreferences) is kept as
/// the offline fallback and as the heart state while the server list
/// loads, so a failed API call never empties the list.
final favoriteIdsProvider = StateProvider<Set<String>>((ref) => {});

Future<void> loadFavoriteIds(WidgetRef ref) async {
  final prefs = await SharedPreferences.getInstance();
  ref.read(favoriteIdsProvider.notifier).state =
      (prefs.getStringList('ns_favorites') ?? []).toSet();
}

Future<void> toggleFavorite(WidgetRef ref, String providerId) async {
  final current = Set<String>.from(ref.read(favoriteIdsProvider));
  final adding = !current.contains(providerId);
  if (adding) {
    current.add(providerId);
  } else {
    current.remove(providerId);
  }
  ref.read(favoriteIdsProvider.notifier).state = current;
  final prefs = await SharedPreferences.getInstance();
  await prefs.setStringList('ns_favorites', current.toList());
  // Best-effort server sync; the local state stays either way.
  try {
    final api = ref.read(apiClientProvider);
    if (adding) {
      await api.addFavourite(providerId);
    } else {
      await api.removeFavourite(providerId);
    }
  } catch (_) {
    // Offline: local favourite stands; it syncs on the next toggle.
  }
}

class FavoritesScreen extends ConsumerStatefulWidget {
  const FavoritesScreen({super.key});

  @override
  ConsumerState<FavoritesScreen> createState() => _FavoritesScreenState();
}

class _FavoritesScreenState extends ConsumerState<FavoritesScreen> {
  List<ServiceProvider>? _serverFavs;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    await loadFavoriteIds(ref);
    setState(() => _loading = true);
    try {
      final page = await ref.read(apiClientProvider).listFavourites();
      if (mounted) {
        setState(() {
          _serverFavs = page.items;
          _loading = false;
        });
      }
    } catch (e) {
      // Server list unavailable (endpoint not live yet / offline):
      // fall back to the locally saved ids + demo providers.
      if (mounted) {
        setState(() {
          _serverFavs = null;
          _error = 'Could not load favourites from the server — showing saved ones.';
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final ids = ref.watch(favoriteIdsProvider);
    final favs = _serverFavs ??
        DemoData.providers.where((p) => ids.contains(p.id)).toList();
    return Scaffold(
      appBar: AppBar(title: const Text('Favorites')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : favs.isEmpty
              ? const EmptyState(
                  icon: Icons.favorite_border,
                  message:
                      'No favorites yet. Tap the heart on a provider to save them here.',
                )
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView.separated(
                    padding: const EdgeInsets.all(16),
                    itemCount: favs.length + (_error != null ? 1 : 0),
                    separatorBuilder: (_, __) => const SizedBox(height: 12),
                    itemBuilder: (_, i) {
                      if (_error != null && i == 0) {
                        return Text(_error!,
                            style: const TextStyle(
                                color: Colors.grey, fontSize: 13));
                      }
                      final p = favs[_error != null ? i - 1 : i];
                      return ProviderCard(
                        provider: p,
                        isFavorite: ids.contains(p.id),
                        onFavoriteToggle: () =>
                            toggleFavorite(ref, p.id),
                        onTap: () =>
                            context.push('/customer/provider/${p.id}', extra: p),
                      );
                    },
                  ),
                ),
    );
  }
}
