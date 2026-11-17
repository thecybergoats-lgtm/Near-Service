import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Phase 4 (item 5) — Partner parts ordering (provider): browse the local
/// parts catalog (AC parts, hardware), order parts for a job, and track
/// the order placed -> confirmed -> delivered (or cancelled).
///
/// WIRING NOTE (integrator — this file is new, but it is NOT wired yet):
///   * Add the six typed methods below to mobile/lib/core/api_client.dart
///     (shared — this piece does not edit it), mirroring the existing
///     escrow methods (same _send/_u helpers, same ApiException errors):
///       Future<List<PartnerCatalogItem>> listPartnerCatalog({String? q, String? category, bool inStockOnly = false});
///       Future<PartnerOrder> createPartnerOrder({required String jobId, required List<Map<String, dynamic>> items});
///       Future<List<PartnerOrder>> listMyPartnerOrders();
///       Future<PartnerOrder> getPartnerOrder(String id);
///       Future<PartnerOrder> transitionPartnerOrder(String id, String action); // confirm | deliver | cancel
///       Future<JobPartnerOrders> getJobPartnerOrders(String jobId);
///     Then construct this screen with api: ref.read(apiClientProvider)
///     (typed as PartnerApi) and add a router entry, e.g.
///     GoRoute(path: '/provider/parts', builder: (_, s) => PartsOrderScreen(jobId: s.uri.queryParameters['jobId']!)).
///   * Until then the screen runs against UnimplementedPartnerApi, which
///     shows a plain "not wired yet" message instead of fake data.
///   * Every order view shows the partner disclosure: parts come from a
///     partner supplier, Near Service may earn an affiliate fee (default
///     5%), charged to the provider — never to the customer.
///
/// Prices are ALWAYS server-priced from the catalog: the app sends item
/// ids + quantities only; the totals shown after placing an order come
/// from the API response, never from a client-side sum.
abstract class PartnerApi {
  Future<List<PartnerCatalogItem>> listPartnerCatalog({String? q, String? category, bool inStockOnly = false});
  Future<PartnerOrder> createPartnerOrder({required String jobId, required List<Map<String, dynamic>> items});
  Future<List<PartnerOrder>> listMyPartnerOrders();
  Future<PartnerOrder> transitionPartnerOrder(String id, String action);
  Future<JobPartnerOrders> getJobPartnerOrders(String jobId);
}

class UnimplementedPartnerApi implements PartnerApi {
  @override
  Future<List<PartnerCatalogItem>> listPartnerCatalog({String? q, String? category, bool inStockOnly = false}) =>
      throw UnimplementedError('Partner API is not wired yet — add the methods to api_client.dart (see file header).');
  @override
  Future<PartnerOrder> createPartnerOrder({required String jobId, required List<Map<String, dynamic>> items}) =>
      throw UnimplementedError('Partner API is not wired yet — add the methods to api_client.dart (see file header).');
  @override
  Future<List<PartnerOrder>> listMyPartnerOrders() =>
      throw UnimplementedError('Partner API is not wired yet — add the methods to api_client.dart (see file header).');
  @override
  Future<PartnerOrder> transitionPartnerOrder(String id, String action) =>
      throw UnimplementedError('Partner API is not wired yet — add the methods to api_client.dart (see file header).');
  @override
  Future<JobPartnerOrders> getJobPartnerOrders(String jobId) =>
      throw UnimplementedError('Partner API is not wired yet — add the methods to api_client.dart (see file header).');
}

class PartnerCatalogItem {
  final String id;
  final String partnerName;
  final String sku;
  final String name;
  final String category;
  final double unitPricePkr;
  final int stockQty;
  const PartnerCatalogItem({
    required this.id,
    required this.partnerName,
    required this.sku,
    required this.name,
    required this.category,
    required this.unitPricePkr,
    required this.stockQty,
  });
  factory PartnerCatalogItem.fromJson(Map<String, dynamic> j) => PartnerCatalogItem(
        id: j['id'] as String,
        partnerName: j['partner_name'] as String? ?? '',
        sku: j['sku'] as String? ?? '',
        name: j['name'] as String? ?? '',
        category: j['category'] as String? ?? '',
        unitPricePkr: (j['unit_price_pkr'] as num?)?.toDouble() ?? 0,
        stockQty: (j['stock_qty'] as num?)?.toInt() ?? 0,
      );
}

class PartnerOrder {
  final String id;
  final String status;
  final String partnerName;
  final double totalPkr;
  final double affiliateFeePkr;
  final String disclosureText;
  const PartnerOrder({
    required this.id,
    required this.status,
    required this.partnerName,
    required this.totalPkr,
    required this.affiliateFeePkr,
    required this.disclosureText,
  });
  factory PartnerOrder.fromJson(Map<String, dynamic> j) => PartnerOrder(
        id: j['id'] as String,
        status: j['status'] as String? ?? '',
        partnerName: j['partner_name'] as String? ?? '',
        totalPkr: (j['total_pkr'] as num?)?.toDouble() ?? 0,
        affiliateFeePkr: (j['affiliate_fee_pkr'] as num?)?.toDouble() ?? 0,
        disclosureText: (j['partner_disclosure'] as Map?)?['text'] as String? ?? '',
      );
}

class JobPartnerOrders {
  final String? disclosureText;
  final List<PartnerOrder> orders;
  const JobPartnerOrders({required this.disclosureText, required this.orders});
  factory JobPartnerOrders.fromJson(Map<String, dynamic> j) => JobPartnerOrders(
        disclosureText: j['disclosure_text'] as String?,
        orders: ((j['orders'] as List?) ?? []).map((o) => PartnerOrder.fromJson(o as Map<String, dynamic>)).toList(),
      );
}

class PartsOrderScreen extends ConsumerStatefulWidget {
  final String jobId;
  final PartnerApi api;
  const PartsOrderScreen({super.key, required this.jobId, required this.api});

  @override
  ConsumerState<PartsOrderScreen> createState() => _PartsOrderScreenState();
}

class _PartsOrderScreenState extends ConsumerState<PartsOrderScreen> {
  final _search = TextEditingController();
  List<PartnerCatalogItem> _items = [];
  final Map<String, int> _qty = {};
  List<PartnerOrder> _myOrders = [];
  String? _jobDisclosure;
  bool _loading = true;
  String? _error;
  String? _msg;
  String _category = '';

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
      _items = await widget.api.listPartnerCatalog(
        q: _search.text.trim().isEmpty ? null : _search.text.trim(),
        category: _category.isEmpty ? null : _category,
        inStockOnly: true,
      );
      _myOrders = await widget.api.listMyPartnerOrders();
      final job = await widget.api.getJobPartnerOrders(widget.jobId);
      _jobDisclosure = job.disclosureText;
    } catch (e) {
      setState(() => _error = e.toString());
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _placeOrder() async {
    final lines = _qty.entries
        .where((e) => e.value > 0)
        .map((e) => {'catalog_item_id': e.key, 'quantity': e.value})
        .toList();
    if (lines.isEmpty) {
      setState(() => _msg = 'Pick at least one part first.');
      return;
    }
    try {
      final order = await widget.api.createPartnerOrder(jobId: widget.jobId, items: lines);
      setState(() {
        _msg = 'Order placed (PKR ${order.totalPkr}). ${order.disclosureText}';
        _qty.clear();
      });
      await _load();
    } catch (e) {
      setState(() => _msg = e.toString());
    }
  }

  Future<void> _transition(PartnerOrder order, String action) async {
    try {
      await widget.api.transitionPartnerOrder(order.id, action);
      setState(() => _msg = 'Order $action.');
      await _load();
    } catch (e) {
      setState(() => _msg = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Order parts')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (_error != null)
                  Card(color: Colors.red.shade50, child: Padding(padding: const EdgeInsets.all(12), child: Text(_error!))),
                if (_jobDisclosure != null)
                  Card(
                    color: Colors.amber.shade50,
                    child: Padding(padding: const EdgeInsets.all(12), child: Text(_jobDisclosure!)),
                  ),
                TextField(
                  controller: _search,
                  decoration: const InputDecoration(labelText: 'Search parts (e.g. capacitor, gas, tape)', suffixIcon: Icon(Icons.search)),
                  onSubmitted: (_) => _load(),
                ),
                const SizedBox(height: 8),
                DropdownButton<String>(
                  value: _category,
                  isExpanded: true,
                  items: const [
                    DropdownMenuItem(value: '', child: Text('All categories')),
                    DropdownMenuItem(value: 'ac_parts', child: Text('AC parts')),
                    DropdownMenuItem(value: 'hardware', child: Text('Hardware')),
                    DropdownMenuItem(value: 'electrical', child: Text('Electrical')),
                    DropdownMenuItem(value: 'plumbing', child: Text('Plumbing')),
                  ],
                  onChanged: (v) {
                    setState(() => _category = v ?? '');
                    _load();
                  },
                ),
                const SizedBox(height: 8),
                ..._items.map((item) {
                  final q = _qty[item.id] ?? 0;
                  return Card(
                    child: ListTile(
                      title: Text('${item.name} (${item.sku})'),
                      subtitle: Text('${item.partnerName} · PKR ${item.unitPricePkr} · stock ${item.stockQty}'),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          IconButton(icon: const Icon(Icons.remove), onPressed: q > 0 ? () => setState(() => _qty[item.id] = q - 1) : null),
                          Text('$q'),
                          IconButton(
                            icon: const Icon(Icons.add),
                            onPressed: q < item.stockQty ? () => setState(() => _qty[item.id] = q + 1) : null,
                          ),
                        ],
                      ),
                    ),
                  );
                }),
                const SizedBox(height: 12),
                ElevatedButton(onPressed: _placeOrder, child: const Text('Place order for this job')),
                if (_msg != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_msg!)),
                const SizedBox(height: 16),
                const Text('My part orders', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                ..._myOrders.map((o) => Card(
                      child: ListTile(
                        title: Text('${o.partnerName} · PKR ${o.totalPkr} · ${o.status}'),
                        subtitle: Text(o.disclosureText),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (o.status == 'placed')
                              TextButton(onPressed: () => _transition(o, 'confirm'), child: const Text('Confirm')),
                            if (o.status == 'confirmed')
                              TextButton(onPressed: () => _transition(o, 'deliver'), child: const Text('Deliver')),
                            if (o.status == 'placed' || o.status == 'confirmed')
                              TextButton(onPressed: () => _transition(o, 'cancel'), child: const Text('Cancel')),
                          ],
                        ),
                      ),
                    )),
              ],
            ),
    );
  }
}
