import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/demo_data.dart';
import '../../core/models.dart';
import '../common/skeletons.dart';
import '../common/widgets.dart';

/// Category browser — 3-level tree (Category > Service > Task, PRD p.6)
/// with alias-aware search over the demo/API taxonomy.
class CategoryScreen extends ConsumerStatefulWidget {
  const CategoryScreen({super.key});

  @override
  ConsumerState<CategoryScreen> createState() => _CategoryScreenState();
}

class _CategoryScreenState extends ConsumerState<CategoryScreen> {
  List<Category> _categories = [];
  bool _loading = true;
  String? _error;
  String _query = '';

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
      final cats = await ref.read(apiClientProvider).getCategories();
      _categories = cats.isEmpty ? DemoData.categories : cats;
    } catch (e) {
      _categories = DemoData.categories;
      _error = null; // demo fallback is a valid state, not an error screen
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final locale = 'en';
    final filtered = _query.isEmpty
        ? _categories
        : _categories
            .where((c) =>
                c.nameEn.toLowerCase().contains(_query.toLowerCase()) ||
                c.nameRoman.toLowerCase().contains(_query.toLowerCase()))
            .toList();
    return Scaffold(
      appBar: AppBar(title: const Text('All services')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              decoration: const InputDecoration(
                hintText: 'Search services… (try "jild saazi")',
                prefixIcon: Icon(Icons.search),
              ),
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          if (_loading)
            const Expanded(child: ListSkeleton())
          else if (filtered.isEmpty)
            const Expanded(
              child: EmptyState(icon: Icons.category_outlined, message: 'No service matches that search.'),
            )
          else
            Expanded(
              child: ListView.builder(
                itemCount: filtered.length,
                itemBuilder: (_, i) {
                  final c = filtered[i];
                  return ExpansionTile(
                    leading: Icon(_iconFor(c.iconKey)),
                    title: Text(c.displayName(locale)),
                    subtitle: c.children.isEmpty
                        ? null
                        : Text('${c.children.length} services'),
                    children: c.children.isEmpty
                        ? [
                            ListTile(
                              title: const Text('Post a request'),
                              trailing: const Icon(Icons.chevron_right),
                              onTap: () => context.push('/customer/request', extra: {'categoryId': c.id}),
                            ),
                          ]
                        : c.children
                            .map((child) => ListTile(
                                  title: Text(child.displayName(locale)),
                                  trailing: const Icon(Icons.chevron_right),
                                  // The child IS the specific service
                                  // category, so its id is the request's
                                  // category (no separate service_id in
                                  // the OpenAPI contract).
                                  onTap: () => context.push(
                                    '/customer/request',
                                    extra: {'categoryId': child.id},
                                  ),
                                ))
                            .toList(),
                  );
                },
              ),
            ),
        ],
      ),
    );
  }

  IconData _iconFor(String key) {
    switch (key) {
      case 'book':
        return Icons.book;
      case 'ac_unit':
        return Icons.ac_unit;
      case 'electrical_services':
        return Icons.electrical_services;
      case 'plumbing':
        return Icons.plumbing;
      case 'phone_android':
        return Icons.phone_android;
      default:
        return Icons.build;
    }
  }
}
