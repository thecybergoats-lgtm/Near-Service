import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/constants.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/money.dart';
import '../../core/socket_service.dart';
import '../common/widgets.dart';

/// Provider dashboard (PRD p.13): online/offline toggle, earnings
/// today/week/month, performance rates, incoming-request feed.
/// Incoming requests arrive over socket `request.new` and as a sheet.
class ProviderDashboardScreen extends ConsumerStatefulWidget {
  const ProviderDashboardScreen({super.key});

  @override
  ConsumerState<ProviderDashboardScreen> createState() => _ProviderDashboardScreenState();
}

class _ProviderDashboardScreenState extends ConsumerState<ProviderDashboardScreen> {
  bool _online = false;
  bool _toggling = false;
  Map<String, dynamic>? _incoming;
  WalletInfo? _wallet;

  @override
  void initState() {
    super.initState();
    _loadWallet();
    final socket = ref.read(socketServiceProvider);
    socket.connect();
    socket.on('request.new', (data) {
      if (data is Map<String, dynamic> && mounted) {
        setState(() => _incoming = data);
        _showIncomingSheet(data);
      }
    });
  }

  /// Phase 2: wallet summary for the provider view (single shared
  /// wallet — same balance the customer profile sees). Failures are
  /// silent here; the full wallet lives on the earnings screen.
  Future<void> _loadWallet() async {
    try {
      final wallet = await ref.read(apiClientProvider).getWallet();
      if (mounted) setState(() => _wallet = wallet);
    } catch (_) {}
  }

  Future<void> _toggleOnline(bool value) async {
    setState(() => _toggling = true);
    double lat = AppConstants.quettaLat, lng = AppConstants.quettaLng;
    try {
      final pos = await Geolocator.getCurrentPosition();
      lat = pos.latitude;
      lng = pos.longitude;
    } catch (_) {}
    try {
      await ref.read(apiClientProvider).setOnline(value, lat, lng);
      setState(() => _online = value);
      if (value) {
        ref.read(socketServiceProvider).sendHeartbeat(lat, lng);
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    } finally {
      if (mounted) setState(() => _toggling = false);
    }
  }

  void _showIncomingSheet(Map<String, dynamic> request) {
    showModalBottomSheet<void>(
      context: context,
      isDismissible: false,
      builder: (ctx) => IncomingRequestSheet(
        request: request,
        onAccept: () {
          Navigator.pop(ctx);
          context.push('/provider/active-job/demo-job');
        },
        onDecline: () {
          Navigator.pop(ctx);
          setState(() => _incoming = null);
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Provider dashboard'),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => context.push('/customer/settings'),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: SwitchListTile(
              title: Text(_online ? 'You are ONLINE' : 'You are OFFLINE',
                  style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text(_online
                  ? 'You will receive nearby requests.'
                  : 'Go online to receive requests.'),
              value: _online,
              onChanged: _toggling ? null : _toggleOnline,
            ),
          ),
          const SizedBox(height: 16),
          if (_wallet != null)
            Card(
              child: ListTile(
                leading: const Icon(Icons.account_balance_wallet_outlined),
                title: Text('Wallet: ${Money.pkr(_wallet!.balancePkr)}'),
                subtitle: Text(
                    'Commission owed: ${Money.pkr(_wallet!.commissionOwedPkr)} · same balance as your customer profile'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push('/provider/earnings'),
              ),
            ),
          if (_wallet != null) const SizedBox(height: 16),
          const Text('Earnings', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
          const SizedBox(height: 8),
          Row(
            children: [
              _earningCard('Today', 0),
              const SizedBox(width: 8),
              _earningCard('This week', 0),
              const SizedBox(width: 8),
              _earningCard('This month', 0),
            ],
          ),
          const SizedBox(height: 16),
          const Text('Performance', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
          const SizedBox(height: 8),
          const Card(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Column(
                children: [
                  _RateRow(label: 'Completion rate', value: '—'),
                  _RateRow(label: 'Acceptance rate', value: '—'),
                  _RateRow(label: 'Cancellation rate', value: '—'),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Rates appear after your first jobs. Tip: respond fast — response speed is 13% of your ranking (PRD p.6).',
            style: TextStyle(color: Colors.grey, fontSize: 13),
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: () => context.push('/provider/earnings'),
              child: const Text('Earnings & wallet'),
            ),
          ),
          const SizedBox(height: 8),
          // FIX 10 — provider "me" settings.
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: () => context.push('/provider/services'),
              child: const Text('My services & starting prices'),
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: () => context.push('/provider/service-area'),
              child: const Text('Service area'),
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: () => context.push('/provider/availability'),
              child: const Text('Working hours'),
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: () {
                // Demo incoming request so the sheet can be shown offline.
                _showIncomingSheet({
                  'id': 'demo-req-1',
                  'category_slug': 'book-binding',
                  'description': '20 books, hard binding',
                  'customer_offer': 2400,
                  'distance_km': 1.2,
                  'expires_at': DateTime.now().add(const Duration(minutes: 9)).toIso8601String(),
                });
              },
              child: const Text('Preview incoming request sheet (demo)'),
            ),
          ),
          if (_incoming != null) ...[
            const SizedBox(height: 16),
            const Text('Latest incoming request', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Card(
              child: ListTile(
                title: Text((_incoming!['description'] ?? 'New request').toString()),
                subtitle: Text('Offer: ${Money.pkr((_incoming!['customer_offer'] as num?)?.toInt() ?? 0)}'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => _showIncomingSheet(_incoming!),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _earningCard(String label, int amount) => Expanded(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              children: [
                Text(label, style: const TextStyle(color: Colors.grey, fontSize: 12)),
                const SizedBox(height: 4),
                Text(Money.pkr(amount), style: const TextStyle(fontWeight: FontWeight.w800)),
              ],
            ),
          ),
        ),
      );
}

class _RateRow extends StatelessWidget {
  const _RateRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [Text(label), Text(value, style: const TextStyle(fontWeight: FontWeight.w700))],
      ),
    );
  }
}

/// Incoming request sheet with countdown + Accept / Counter / Decline.
class IncomingRequestSheet extends StatelessWidget {
  const IncomingRequestSheet({
    super.key,
    required this.request,
    required this.onAccept,
    required this.onDecline,
  });

  final Map<String, dynamic> request;
  final VoidCallback onAccept;
  final VoidCallback onDecline;

  @override
  Widget build(BuildContext context) {
    final expires = DateTime.tryParse(request['expires_at']?.toString() ?? '') ??
        DateTime.now().add(const Duration(minutes: 10));
    final offer = (request['customer_offer'] as num?)?.toInt();
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              CountdownRing(expiresAt: expires),
              const SizedBox(width: 12),
              const Expanded(
                child: Text('New request near you',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text((request['description'] ?? '').toString(),
              style: const TextStyle(fontSize: 16)),
          Text('Distance: ${(request['distance_km'] ?? '—')} km'),
          if (offer != null)
            Text('Customer offer: ${Money.pkr(offer)}',
                style: const TextStyle(fontWeight: FontWeight.w700, color: Color(0xFFD97706))),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: ElevatedButton(onPressed: onAccept, child: const Text('Accept')),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: () => showModalBottomSheet<void>(
                    context: context,
                    builder: (_) => CounterOfferComposer(
                      requestId: (request['id'] ?? '').toString(),
                      customerOffer: offer ?? 0,
                    ),
                  ),
                  child: const Text('Counter'),
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton(onPressed: onDecline, child: const Text('Decline')),
            ],
          ),
        ],
      ),
    );
  }
}

/// Counter-offer composer: price, ETA, itemised breakdown
/// (labour + parts + visit fee).
class CounterOfferComposer extends ConsumerStatefulWidget {
  const CounterOfferComposer({super.key, required this.requestId, required this.customerOffer});

  final String requestId;
  final int customerOffer;

  @override
  ConsumerState<CounterOfferComposer> createState() => _CounterOfferComposerState();
}

class _CounterOfferComposerState extends ConsumerState<CounterOfferComposer> {
  final _priceController = TextEditingController();
  final _etaController = TextEditingController(text: '30');
  final _labourController = TextEditingController();
  final _partsController = TextEditingController(text: '0');
  final _visitController = TextEditingController(text: '200');
  final _noteController = TextEditingController();
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _priceController.text = widget.customerOffer.toString();
    _labourController.text = (widget.customerOffer - 200).clamp(0, 100000000).toString();
  }

  Future<void> _send() async {
    final price = Money.tryParse(_priceController.text);
    if (price == null) return;
    setState(() => _sending = true);
    try {
      await ref.read(apiClientProvider).submitOffer(
            widget.requestId,
            price: price,
            etaMinutes: int.tryParse(_etaController.text),
            note: _noteController.text.trim().isEmpty ? null : _noteController.text.trim(),
            breakdown: {
              'labour': Money.tryParse(_labourController.text) ?? 0,
              'parts': Money.tryParse(_partsController.text) ?? 0,
              'visit_fee': Money.tryParse(_visitController.text) ?? 0,
            },
          );
      if (mounted) {
        Navigator.pop(context);
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Counter-offer sent.')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: ListView(
        shrinkWrap: true,
        children: [
          const Text('Counter-offer', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          Text('Customer offered ${Money.pkr(widget.customerOffer)}',
              style: const TextStyle(color: Colors.grey)),
          const SizedBox(height: 16),
          TextField(controller: _priceController, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Your price (PKR)')),
          const SizedBox(height: 12),
          TextField(controller: _etaController, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'ETA (minutes)')),
          const SizedBox(height: 12),
          const Text('Breakdown', style: TextStyle(fontWeight: FontWeight.w700)),
          TextField(controller: _labourController, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Labour (PKR)')),
          TextField(controller: _partsController, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Parts (PKR)')),
          TextField(controller: _visitController, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Visit fee (PKR)')),
          const SizedBox(height: 12),
          TextField(controller: _noteController,
              decoration: const InputDecoration(labelText: 'Note to customer (optional)')),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _sending ? null : _send,
              child: const Text('Send counter-offer'),
            ),
          ),
        ],
      ),
    );
  }
}
