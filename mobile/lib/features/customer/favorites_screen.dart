import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/demo_data.dart';
import '../../core/models.dart';
import '../common/widgets.dart';

/// Favorites: saved providers, persisted locally by id.
/// Tapping a favorite opens the profile; the list can be re-fetched
/// from the API once a favorites endpoint exists.
final favoriteIdsProvider = StateProvider<Set<String>>((ref) => {});

Future<void> toggleFavorite(WidgetRef ref, String providerId) async {
  final current = Set<String>.from(ref.read(favoriteIdsProvider));
  if (current.contains(providerId)) {
    current.remove(providerId);
  } else {
    current.add(providerId);
  }
  ref.read(favoriteIdsProvider.notifier).state = current;
  final prefs = await SharedPreferences.getInstance();
  await prefs.setStringList('ns_favorites', current.toList());
}

class FavoritesScreen extends ConsumerWidget {
  const FavoritesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ids = ref.watch(favoriteIdsProvider);
    final favs = DemoData.providers.where((p) => ids.contains(p.id)).toList();
    return Scaffold(
      appBar: AppBar(title: const Text('Favorites')),
      body: favs.isEmpty
          ? const EmptyState(
              icon: Icons.favorite_border,
              message: 'No favorites yet. Tap the heart on a provider to save them here.',
            )
          : ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: favs.length,
              separatorBuilder: (_, __) => const SizedBox(height: 12),
              itemBuilder: (_, i) {
                final ServiceProvider p = favs[i];
                return ProviderCard(
                  provider: p,
                  onTap: () => context.push('/customer/provider/${p.id}', extra: p),
                );
              },
            ),
    );
  }
}
