import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/phase3_models.dart';

/// Phase 3 — Tenders: open tenders to quote on (provider) and my
/// tenders (customer). Quotes are SEALED until award — a provider sees
/// only their own quote; after AWARDED every participant sees all.
/// Quoting is free; a flat PKR 500 lead fee is charged once to the
/// winning provider's wallet when a quote is awarded.
class TendersScreen extends ConsumerStatefulWidget {
  const TendersScreen({super.key});

  @override
  ConsumerState<TendersScreen> createState() => _TendersScreenState();
}

class _TendersScreenState extends ConsumerState<TendersScreen> {
  List<Tender> _open = [];
  List<Tender> _mine = [];
  bool _loading = true;
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
      _open = await ref.read(apiClientProvider).listOpenTenders();
      _mine = await ref.read(apiClientProvider).listMyTenders();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not load tenders.');
    }
    if (mounted) setState(() => _loading = false);
  }

  Widget _tile(Tender t) => Card(
        child: ListTile(
          title: Text(t.title),
          subtitle: Text(
              '${t.organizationName} (${t.organizationType}) · ${t.status}'
              '${t.deliveryDeadline != null ? ' · due ${t.deliveryDeadline!.substring(0, 10)}' : ''}'),
          onTap: () async {
            try {
              final quotes = await ref
                  .read(apiClientProvider)
                  .listTenderQuotes(t.id);
              if (!mounted) return;
              showDialog<void>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: Text(t.title),
                  content: Text(quotes.isEmpty
                      ? 'No quotes yet (sealed until award).'
                      : quotes
                          .map((q) =>
                              'PKR ${q.totalPrice.round()} — ${q.status}')
                          .join('\n')),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(ctx),
                        child: const Text('Close')),
                  ],
                ),
              );
            } on ApiException catch (e) {
              if (mounted) {
                ScaffoldMessenger.of(context)
                    .showSnackBar(SnackBar(content: Text(e.message)));
              }
            }
          },
        ),
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tenders')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      const Text('Open tenders',
                          style: TextStyle(fontWeight: FontWeight.bold)),
                      if (_open.isEmpty)
                        const Text('No open tenders right now.'),
                      ..._open.map(_tile),
                      const SizedBox(height: 16),
                      const Text('My tenders',
                          style: TextStyle(fontWeight: FontWeight.bold)),
                      if (_mine.isEmpty)
                        const Text('You have no tenders yet.'),
                      ..._mine.map(_tile),
                      const SizedBox(height: 12),
                      const Text(
                        'Quotes are sealed until award. A flat PKR 500 lead fee is charged once to the winning provider when a quote is awarded.',
                        style: TextStyle(fontSize: 12, color: Colors.grey),
                      ),
                    ],
                  ),
                ),
    );
  }
}
