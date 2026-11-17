import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/category_resolver.dart';
import '../../core/constants.dart';
import '../../core/demo_data.dart';
import '../common/widgets.dart';

/// Search & suggestions (PRD p.22): recent, popular, taxonomy matches.
/// No-results -> waitlist join. Voice search is Phase 3 — button present
/// but honestly labelled, not faked.
class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key});

  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  final _controller = TextEditingController();
  List<Map<String, dynamic>> _results = [];
  bool _loading = false;
  bool _searched = false;
  bool _onWaitlist = false;

  Future<void> _search(String q) async {
    if (q.trim().isEmpty) return;
    setState(() {
      _loading = true;
      _searched = true;
    });
    try {
      _results = await ref.read(apiClientProvider).search(
            q,
            AppConstants.quettaLat,
            AppConstants.quettaLng,
          );
    } catch (_) {
      // Offline fallback: match demo taxonomy by name / alias.
      final query = q.toLowerCase();
      _results = DemoData.categories
          .where((c) =>
              c.nameEn.toLowerCase().contains(query) ||
              c.nameRoman.toLowerCase().contains(query) ||
              c.nameUr.contains(q))
          .map((c) => <String, dynamic>{
                'type': 'category',
                'id': c.id,
                'name': c.nameEn,
                'name_roman': c.nameRoman,
              })
          .toList();
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Search')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _controller,
              autofocus: true,
              decoration: InputDecoration(
                hintText: 'AC repair, book binding, plumber…',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: IconButton(
                  icon: const Icon(Icons.mic_none),
                  tooltip: 'Voice search — coming in Phase 3',
                  onPressed: () {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Voice search comes in Phase 3. Please type for now.')),
                    );
                  },
                ),
              ),
              onSubmitted: _search,
            ),
            const SizedBox(height: 16),
            if (!_searched) ...[
              const Text('Popular near you', style: TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: DemoData.categories
                    .map((c) => ActionChip(
                          label: Text(c.nameEn),
                          onPressed: () {
                            _controller.text = c.nameEn;
                            _search(c.nameEn);
                          },
                        ))
                    .toList(),
              ),
            ],
            if (_loading) const Expanded(child: Center(child: CircularProgressIndicator())),
            if (!_loading && _searched && _results.isEmpty)
              Expanded(
                child: EmptyState(
                  icon: Icons.search_off,
                  message: 'No one nearby yet for "${_controller.text}". Join the waitlist — we will tell you when a provider joins.',
                  action: ElevatedButton(
                    onPressed: () => setState(() => _onWaitlist = true),
                    child: Text(_onWaitlist ? 'You are on the waitlist ✓' : 'Join waitlist'),
                  ),
                ),
              ),
            if (!_loading && _results.isNotEmpty)
              Expanded(
                child: ListView.builder(
                  itemCount: _results.length,
                  itemBuilder: (_, i) {
                    final r = _results[i];
                    final name = (r['name_roman'] ?? r['name'] ?? '').toString();
                    return ListTile(
                      leading: const Icon(Icons.category),
                      title: Text(name),
                      subtitle: Text((r['type'] ?? 'service').toString()),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () {
                        // Provider hits open the provider profile;
                        // category hits open the request form. A UUID
                        // goes as `categoryId`, a slug as `categorySlug`
                        // — never a slug as `categoryId` (PRD v1.1).
                        if (r['type'] == 'provider') {
                          context.push(
                            '/customer/provider/${r['id']}',
                          );
                          return;
                        }
                        final id = (r['id'] ?? r['category_id'] ?? 'book-binding').toString();
                        context.push(
                          '/customer/request',
                          extra: CategoryResolver.isUuid(id)
                              ? {'categoryId': id}
                              : {'categorySlug': id},
                        );
                      },
                    );
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }
}
