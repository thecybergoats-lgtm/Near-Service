import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/category_resolver.dart';
import '../../core/constants.dart';
import '../../core/demo_data.dart';
import '../../core/models.dart';
import '../common/skeletons.dart';
import '../common/widgets.dart';

/// Provider list / map (PRD p.22) with the filter sheet:
/// radius, open-now, verified-only, min rating, shop vs individual.
class ProviderListScreen extends ConsumerStatefulWidget {
  const ProviderListScreen({super.key, this.categoryId});

  final String? categoryId;

  @override
  ConsumerState<ProviderListScreen> createState() => _ProviderListScreenState();
}

class _ProviderListScreenState extends ConsumerState<ProviderListScreen> {
  List<ServiceProvider> _providers = [];
  bool _loading = true;
  bool _offline = false;
  double _radius = AppConstants.defaultRadiusKm;
  bool _openNow = false;
  bool _verifiedOnly = false;
  double _minRating = 0;
  String? _type; // SHOP | INDIVIDUAL

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      _providers = await ref.read(apiClientProvider).getNearbyProviders(
            lat: AppConstants.quettaLat,
            lng: AppConstants.quettaLng,
            categoryId: widget.categoryId,
            radiusKm: _radius,
            openNow: _openNow ? true : null,
            verifiedOnly: _verifiedOnly ? true : null,
            minRating: _minRating > 0 ? _minRating : null,
            providerType: _type,
          );
      _offline = false;
    } catch (_) {
      _providers = DemoData.providers.where(_demoFilter).toList();
      _offline = true;
    }
    if (mounted) setState(() => _loading = false);
  }

  bool _demoFilter(ServiceProvider p) {
    if (_openNow && !p.isOpen) return false;
    if (_verifiedOnly && p.tier < 1) return false;
    if (_minRating > 0 && p.rating < _minRating) return false;
    if (_type != null && p.type != _type) return false;
    if (p.distanceKm > _radius) return false;
    return true;
  }

  /// Extra map for the request form: UUID as `categoryId`, slug as
  /// `categorySlug` — never a slug as `categoryId` (PRD v1.1).
  Map<String, String> _requestExtra() {
    final selected = widget.categoryId;
    if (selected == null) return const {'categorySlug': 'book-binding'};
    if (CategoryResolver.isUuid(selected)) {
      return {'categoryId': selected};
    }
    return {'categorySlug': selected};
  }

  Future<void> _openFilters() async {
    await showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) => Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Filters', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              const SizedBox(height: 16),
              Text('Radius: ${_radius.toInt()} km'),
              Slider(
                value: _radius,
                min: 1,
                max: 25,
                divisions: 4,
                label: '${_radius.toInt()} km',
                onChanged: (v) => setSheet(() => _radius = v),
              ),
              SwitchListTile(
                title: const Text('Open now'),
                value: _openNow,
                onChanged: (v) => setSheet(() => _openNow = v),
              ),
              SwitchListTile(
                title: const Text('Verified only'),
                value: _verifiedOnly,
                onChanged: (v) => setSheet(() => _verifiedOnly = v),
              ),
              const Text('Minimum rating'),
              Row(
                children: [0.0, 3.0, 4.0, 4.5].map((r) => Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        label: Text(r == 0 ? 'Any' : '$r★'),
                        selected: _minRating == r,
                        onSelected: (_) => setSheet(() => _minRating = r),
                      ),
                    )).toList(),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  ChoiceChip(
                    label: const Text('Shop'),
                    selected: _type == 'SHOP',
                    onSelected: (_) => setSheet(() => _type = _type == 'SHOP' ? null : 'SHOP'),
                  ),
                  const SizedBox(width: 8),
                  ChoiceChip(
                    label: const Text('Individual'),
                    selected: _type == 'INDIVIDUAL',
                    onSelected: (_) => setSheet(() => _type = _type == 'INDIVIDUAL' ? null : 'INDIVIDUAL'),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () {
                    Navigator.pop(ctx);
                    _load();
                  },
                  child: const Text('Apply filters'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Providers near you'),
        actions: [
          IconButton(icon: const Icon(Icons.filter_list), onPressed: _openFilters),
        ],
      ),
      body: Column(
        children: [
          if (_offline) const OfflineBanner(isDemo: true),
          if (_loading)
            const Expanded(child: ListSkeleton())
          else if (_providers.isEmpty)
            const Expanded(
              child: EmptyState(
                icon: Icons.people_outline,
                message: 'No providers match these filters. Try a bigger radius.',
              ),
            )
          else
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: _providers.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 12),
                  itemBuilder: (_, i) {
                    final p = _providers[i];
                    return ProviderCard(
                      provider: p,
                      onTap: () => context.push('/customer/provider/${p.id}', extra: p),
                      onRequestQuote: () => context.push(
                        '/customer/request',
                        extra: _requestExtra(),
                      ),
                    );
                  },
                ),
              ),
            ),
        ],
      ),
    );
  }
}
