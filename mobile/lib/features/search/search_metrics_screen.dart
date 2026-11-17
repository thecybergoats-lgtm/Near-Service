import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../core/constants.dart';

/// Search metrics + dedicated-tier gate (Phase 4, item 1) — admin view.
///
/// Read-only: shows the live search window (p50/p95 latency, zero-result
/// rate, cache-hit rate, CTR), the gate decision and its reasons, and the
/// daily rollup from GET /admin/search/metrics. The gate NEVER switches
/// anything by itself; switching is a backend config change
/// (SEARCH_SERVICE_URL / SEARCH_PROVIDER — see docs/phase4-search.md).
///
/// This file is standalone on purpose: it does NOT touch router.dart,
/// api_client.dart or any shared file. Wiring (a route + passing the
/// admin's auth token in) is the coordinator's step — see
/// docs/phase4-search.md. Until then, construct it directly with a token:
///
///   SearchMetricsScreen(token: <admin access token>)
///
/// No Flutter/Dart toolchain exists in this VM, so this file is NOT
/// compile-verified here — that is recorded honestly in docs/phase4-search.md.
class SearchMetricsScreen extends StatefulWidget {
  const SearchMetricsScreen({super.key, required this.token});

  /// Admin access token (Bearer <redacted> the /admin/search/* endpoints require
  /// the super_admin role; a customer token gets 403).
  final String token;

  @override
  State<SearchMetricsScreen> createState() => _SearchMetricsScreenState();
}

class _SearchMetricsScreenState extends State<SearchMetricsScreen> {
  Map<String, dynamic>? _view;
  String? _error;
  bool _loading = true;

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
      final res = await http.get(
        Uri.parse('${AppConstants.apiBaseUrl}/admin/search/metrics?window_hours=24&days=14'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode != 200) {
        throw Exception('Search metrics failed (${res.statusCode})');
      }
      setState(() => _view = jsonDecode(res.body) as Map<String, dynamic>);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final view = _view;
    final gate = view?['gate'] as Map<String, dynamic>?;
    final window = view?['window'] as Map<String, dynamic>?;
    final daily = view?['daily'] as List<dynamic>? ?? [];
    final decision = gate?['decision'] as String? ?? '';
    final switchOn = decision == 'switch_on_dedicated_tier';

    return Scaffold(
      appBar: AppBar(title: const Text('Search metrics')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(_error!, textAlign: TextAlign.center),
                      const SizedBox(height: 12),
                      ElevatedButton(onPressed: _load, child: const Text('Retry')),
                    ],
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      Card(
                        color: switchOn
                            ? Colors.red.shade50
                            : Colors.green.shade50,
                        child: ListTile(
                          title: Text(
                            switchOn
                                ? 'Gate: switch on dedicated tier'
                                : 'Gate: stay in-process',
                            style: const TextStyle(fontWeight: FontWeight.bold),
                          ),
                          subtitle: Text(
                            '${window?['queries'] ?? 0} queries in the last ${window?['window_hours'] ?? 24}h',
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      ...((gate?['reasons'] as List<dynamic>?) ?? [])
                          .map((r) => ListTile(
                                leading: const Icon(Icons.info_outline, size: 18),
                                title: Text(r.toString()),
                                dense: true,
                              )),
                      const SizedBox(height: 8),
                      _stat('p50 latency', _ms(window?['latency_p50_ms'])),
                      _stat('p95 latency', _ms(window?['latency_p95_ms'])),
                      _stat('Zero-result rate', _pct(window?['zero_result_rate'])),
                      _stat('Cache-hit rate', _pct(window?['cache_hit_rate'])),
                      _stat(
                        'Click-through rate',
                        window?['click_through_rate'] == null
                            ? 'no clicks recorded'
                            : _pct(window?['click_through_rate']),
                      ),
                      _stat('Queries / day',
                          '${(window?['queries_per_day'] as num?)?.round() ?? 0}'),
                      const SizedBox(height: 16),
                      const Text('Daily rollup',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                      ...daily.map((d) {
                        final row = d as Map<String, dynamic>;
                        return ListTile(
                          dense: true,
                          title: Text(
                              '${(row['day'] as String).substring(0, 10)} · ${row['provider']}'),
                          subtitle: Text(
                              '${row['queries']} queries · ${row['zero_result_queries']} zero-result · ${row['cache_hits']} cache hits'),
                          trailing: Text('p95 ${_ms(row['latency_p95_ms'])}'),
                        );
                      }),
                      if (daily.isEmpty)
                        const ListTile(
                          title: Text('No rolled-up days yet.'),
                        ),
                    ],
                  ),
                ),
    );
  }

  Widget _stat(String label, String value) => ListTile(
        dense: true,
        title: Text(label),
        trailing: Text(value, style: const TextStyle(fontWeight: FontWeight.bold)),
      );

  String _ms(dynamic v) => v == null ? '—' : '$v ms';

  String _pct(dynamic v) =>
      v == null ? '—' : '${((v as num) * 100).toStringAsFixed(1)}%';
}
