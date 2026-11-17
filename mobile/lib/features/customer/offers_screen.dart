import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/demo_data.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/money.dart';
import '../../core/socket_service.dart';
import '../common/widgets.dart';

/// Live offers screen (PRD p.22): offer cards with countdown rings,
/// sort (best match / price / distance / rating / ETA), counter composer,
/// chat entry. Listens to socket offer.received / offer.updated /
/// offer.closed and polls every 15 s as a fallback.
class OffersScreen extends ConsumerStatefulWidget {
  const OffersScreen({super.key, required this.requestId});

  final String requestId;

  @override
  ConsumerState<OffersScreen> createState() => _OffersScreenState();
}

class _OffersScreenState extends ConsumerState<OffersScreen> {
  List<Offer> _offers = [];
  bool _loading = true;
  bool _offline = false;
  String _sort = 'best';
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    _load();
    _pollTimer = Timer.periodic(const Duration(seconds: 15), (_) => _load(silent: true));
    final socket = ref.read(socketServiceProvider);
    socket.connect();
    socket.joinRoom('request:${widget.requestId}');
    socket.on('offer.received', (_) => _load(silent: true));
    socket.on('offer.updated', (_) => _load(silent: true));
    socket.on('offer.closed', (_) => _load(silent: true));
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    ref.read(socketServiceProvider).leaveRoom('request:${widget.requestId}');
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) setState(() => _loading = true);
    try {
      _offers = await ref.read(apiClientProvider).getOffers(widget.requestId);
      _offline = false;
    } catch (_) {
      if (_offers.isEmpty) _offers = DemoData.demoOffers(widget.requestId);
      _offline = true;
    }
    if (mounted) setState(() => _loading = false);
  }

  List<Offer> get _sorted {
    final list = List<Offer>.from(_offers);
    switch (_sort) {
      case 'price':
        list.sort((a, b) => a.price.compareTo(b.price));
      case 'distance':
        list.sort((a, b) => a.providerDistanceKm.compareTo(b.providerDistanceKm));
      case 'rating':
        list.sort((a, b) => b.providerRating.compareTo(a.providerRating));
      case 'eta':
        list.sort((a, b) => (a.etaMinutes ?? 999).compareTo(b.etaMinutes ?? 999));
      default: // best match: rating first, then price
        list.sort((a, b) {
          final r = b.providerRating.compareTo(a.providerRating);
          return r != 0 ? r : a.price.compareTo(b.price);
        });
    }
    return list;
  }

  /// Batch 2 (J3): accepting an offer must include the pickup-time
  /// commitment — today/tomorrow + time, sent as `scheduled_at`.
  /// The customer can still accept without a time, but the picker is
  /// always shown first.
  Future<void> _accept(Offer offer) async {
    DateTime day = DateTime.now().add(const Duration(days: 1));
    TimeOfDay time = const TimeOfDay(hour: 10, minute: 0);
    var dayLabel = 'Tomorrow';
    final picked = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) => Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('When should ${offer.providerName} come?',
                  style: const TextStyle(
                      fontWeight: FontWeight.w700, fontSize: 16)),
              const SizedBox(height: 4),
              const Text(
                'Pick a day and time — this is the provider’s committed arrival time and it shows on the job tracking screen.',
                style: TextStyle(color: Colors.grey, fontSize: 13),
              ),
              const SizedBox(height: 16),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'today', label: Text('Today')),
                  ButtonSegment(value: 'tomorrow', label: Text('Tomorrow')),
                ],
                selected: {dayLabel.toLowerCase()},
                onSelectionChanged: (s) => setSheetState(() {
                  dayLabel = s.first == 'today' ? 'Today' : 'Tomorrow';
                  final now = DateTime.now();
                  day = s.first == 'today'
                      ? DateTime(now.year, now.month, now.day)
                      : DateTime(now.year, now.month, now.day + 1);
                }),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: () async {
                  final t = await showTimePicker(
                      context: ctx, initialTime: time);
                  if (t != null) setSheetState(() => time = t);
                },
                icon: const Icon(Icons.access_time),
                label: Text('Time: ${time.format(ctx)}'),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: Text('Confirm $dayLabel, ${time.format(ctx)} & accept'),
                ),
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: TextButton(
                  onPressed: () => Navigator.pop(ctx, false),
                  child: const Text('Accept without a time'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (picked == null) return; // dismissed — do not accept.
    final scheduledAt = picked
        ? DateTime(day.year, day.month, day.day, time.hour, time.minute)
        : null;
    try {
      final job = await ref.read(apiClientProvider).acceptOffer(
            offer.id,
            scheduledAt: scheduledAt,
          );
      if (mounted) context.push('/customer/job/${job.id}', extra: job);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
      _load(silent: true);
    }
  }

  Future<void> _counter(Offer offer) async {
    final controller = TextEditingController(text: offer.price.toString());
    final price = await showModalBottomSheet<int>(
      context: context,
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Counter-offer to ${offer.providerName}',
                style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
            const SizedBox(height: 4),
            Text('Round ${offer.round} of 3 — after round 3 the offer closes.',
                style: const TextStyle(color: Colors.grey, fontSize: 13)),
            const SizedBox(height: 16),
            TextField(
              controller: controller,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Your price (PKR)'),
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: () => Navigator.pop(ctx, Money.tryParse(controller.text)),
                child: const Text('Send counter-offer'),
              ),
            ),
          ],
        ),
      ),
    );
    if (price == null) return;
    try {
      await ref.read(apiClientProvider).counterOffer(offer.id, price);
      _load(silent: true);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Live offers'),
        actions: [
          PopupMenuButton<String>(
            icon: const Icon(Icons.sort),
            onSelected: (v) => setState(() => _sort = v),
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'best', child: Text('Best match')),
              PopupMenuItem(value: 'price', child: Text('Lowest price')),
              PopupMenuItem(value: 'distance', child: Text('Nearest')),
              PopupMenuItem(value: 'rating', child: Text('Highest rating')),
              PopupMenuItem(value: 'eta', child: Text('Fastest ETA')),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          if (_offline) const OfflineBanner(isDemo: true),
          if (_loading)
            const Expanded(child: Center(child: CircularProgressIndicator()))
          else if (_offers.isEmpty)
            Expanded(
              child: EmptyState(
                icon: Icons.hourglass_empty,
                message: 'Waiting for offers… nearby providers are being notified in waves. First offer usually in under 60 seconds.',
                action: OutlinedButton(
                  onPressed: () async {
                    try {
                      await ref.read(apiClientProvider).cancelRequest(widget.requestId);
                      if (mounted) context.pop();
                    } on ApiException catch (e) {
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.userMessage)));
                      }
                    }
                  },
                  child: const Text('Cancel request'),
                ),
              ),
            )
          else
            Expanded(
              child: RefreshIndicator(
                onRefresh: () => _load(),
                child: ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: _sorted.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 12),
                  itemBuilder: (_, i) {
                    final offer = _sorted[i];
                    return OfferCard(
                      offer: offer,
                      onAccept: () => _accept(offer),
                      onCounter: () => _counter(offer),
                      onDecline: () async {
                        await ref.read(apiClientProvider).declineOffer(offer.id, 'price_too_high');
                        _load(silent: true);
                      },
                      onChat: () => context.push('/customer/chat/${offer.requestId}',
                          extra: {'peerName': offer.providerName}),
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
