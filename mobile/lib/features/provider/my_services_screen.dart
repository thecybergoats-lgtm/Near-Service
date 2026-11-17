import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/money.dart';

/// Provider "My services" (FIX 10): which launch categories the
/// provider offers, each with a starting price (GET + PUT
/// /providers/me/services). PUT replaces the whole list; a category
/// left unticked is deactivated server-side.
class MyServicesScreen extends ConsumerStatefulWidget {
  const MyServicesScreen({super.key});

  @override
  ConsumerState<MyServicesScreen> createState() => _MyServicesScreenState();
}

class _MyServicesScreenState extends ConsumerState<MyServicesScreen> {
  List<Category> _categories = [];
  // Keyed by category slug: the editable row state.
  final Map<String, _ServiceRow> _rows = {};
  bool _loading = true;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final categories = await api.getCategories();
      final mine = await api.getMyServices();
      final bySlug = {for (final s in mine) s.slug: s};
      final byId = {for (final s in mine) s.categoryId: s};
      _categories = categories;
      _rows.clear();
      for (final c in categories) {
        final saved = bySlug[c.slug] ?? byId[c.id];
        _rows[c.slug] = _ServiceRow(
          category: c,
          offered: saved?.isActive ?? false,
          price: saved?.startingPrice,
        );
      }
      // Services the backend returns for categories not in the launch
      // list (e.g. sub-categories) are kept as extra rows so PUT does
      // not silently drop them.
      for (final s in mine) {
        if (!_rows.containsKey(s.slug) && s.slug.isNotEmpty) {
          _rows[s.slug] = _ServiceRow(
            category: Category(
                id: s.categoryId, slug: s.slug, nameEn: s.nameEn),
            offered: s.isActive,
            price: s.startingPrice,
          );
        }
      }
    } on ApiException catch (e) {
      _error = e.userMessage;
    } catch (_) {
      _error = 'Could not load your services. Check your connection.';
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _save() async {
    final services = <ProviderService>[];
    for (final row in _rows.values) {
      if (!row.offered) continue;
      if (row.price == null || row.price! <= 0) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text(
                  'Enter a starting price above PKR 0 for ${row.category.nameEn}.')),
        );
        return;
      }
      services.add(ProviderService(
        categoryId: row.category.id,
        slug: row.category.slug,
        nameEn: row.category.nameEn,
        startingPrice: row.price,
        isActive: true,
      ));
    }
    setState(() => _saving = true);
    try {
      await ref.read(apiClientProvider).updateMyServices(services);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Your services were saved.')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('My services')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!, textAlign: TextAlign.center),
                        const SizedBox(height: 16),
                        ElevatedButton(
                            onPressed: _load, child: const Text('Try again')),
                      ],
                    ),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    const Text(
                      'Tick the services you offer and set a starting price for each. Unticked services are hidden from customers.',
                      style: TextStyle(color: Colors.grey, fontSize: 13),
                    ),
                    const SizedBox(height: 12),
                    ..._rows.values.map((row) {
                      final controller = TextEditingController(
                          text: row.price == null ? '' : row.price.toString());
                      return Card(
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Column(
                            children: [
                              SwitchListTile(
                                title: Text(row.category.nameEn,
                                    style: const TextStyle(
                                        fontWeight: FontWeight.w700)),
                                subtitle: Text(row.category.slug),
                                value: row.offered,
                                onChanged: (v) =>
                                    setState(() => row.offered = v),
                              ),
                              if (row.offered)
                                TextField(
                                  controller: controller,
                                  keyboardType: TextInputType.number,
                                  decoration: const InputDecoration(
                                    labelText: 'Starting price (PKR)',
                                    hintText: 'e.g. 500',
                                    prefixText: 'PKR ',
                                  ),
                                  onChanged: (v) => row.price =
                                      Money.tryParse(v),
                                ),
                            ],
                          ),
                        ),
                      );
                    }),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        onPressed: _saving ? null : _save,
                        child: Text(_saving ? 'Saving…' : 'Save services'),
                      ),
                    ),
                  ],
                ),
    );
  }
}

class _ServiceRow {
  _ServiceRow({
    required this.category,
    this.offered = false,
    this.price,
  });

  final Category category;
  bool offered;
  int? price;
}
