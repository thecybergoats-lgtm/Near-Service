import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/phase3_models.dart';

/// Phase 3 — Escrow + payouts (provider/customer): my holds, release,
/// my payouts, request a payout. Every payout carries sandbox: true —
/// payouts are SANDBOX ONLY until a live gateway lands. Escrow applies
/// to high-value jobs only (default minimum PKR 5,000).
class EscrowScreen extends ConsumerStatefulWidget {
  const EscrowScreen({super.key});

  @override
  ConsumerState<EscrowScreen> createState() => _EscrowScreenState();
}

class _EscrowScreenState extends ConsumerState<EscrowScreen> {
  final _amount = TextEditingController();
  final _phone = TextEditingController();
  List<EscrowHold> _holds = [];
  List<Payout> _payouts = [];
  bool _loading = true;
  String? _error;
  String? _msg;
  String _method = 'jazzcash';

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
      _holds = await ref.read(apiClientProvider).listEscrowHolds();
      _payouts = await ref.read(apiClientProvider).listPayouts();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not load escrow data.');
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _release(EscrowHold hold) async {
    try {
      await ref.read(apiClientProvider).releaseEscrowHold(hold.id);
      setState(() => _msg = 'Hold released to the provider.');
      await _load();
    } on ApiException catch (e) {
      setState(() => _msg = e.message);
    }
  }

  Future<void> _requestPayout() async {
    final amount = double.tryParse(_amount.text.trim());
    if (amount == null || amount <= 0 || _phone.text.trim().isEmpty) {
      setState(() => _msg = 'Enter an amount and a +92 destination phone.');
      return;
    }
    try {
      final p = await ref.read(apiClientProvider).requestPayout(
            amountPkr: amount,
            method: _method,
            destinationPhone: _phone.text.trim(),
            kind: 'instant',
          );
      setState(() => _msg =
          'Payout requested (${p.status}). Finance must approve it — sandbox only.');
      await _load();
    } on ApiException catch (e) {
      setState(() => _msg = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Escrow & payouts')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    const Card(
                      color: Color(0xFFFFF7ED),
                      child: ListTile(
                        title: Text('Sandbox only'),
                        subtitle: Text(
                            'Payouts do not move real money in this build. Finance approval is still required.'),
                      ),
                    ),
                    if (_msg != null) ...[
                      const SizedBox(height: 12),
                      Text(_msg!),
                    ],
                    const SizedBox(height: 12),
                    const Text('My escrow holds',
                        style: TextStyle(fontWeight: FontWeight.bold)),
                    if (_holds.isEmpty)
                      const Text('No escrow holds.'),
                    ..._holds.map((h) => Card(
                          child: ListTile(
                            title: Text(
                                'PKR ${h.amountPkr.round()} · ${h.status}'),
                            subtitle: Text(
                                'Auto-release: ${h.autoReleaseAt ?? '—'}'),
                            trailing: h.status == 'held'
                                ? TextButton(
                                    onPressed: () => _release(h),
                                    child: const Text('Release'),
                                  )
                                : null,
                          ),
                        )),
                    const SizedBox(height: 16),
                    const Text('Request payout',
                        style: TextStyle(fontWeight: FontWeight.bold)),
                    TextField(
                      controller: _amount,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'Amount (PKR)',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 8),
                    TextField(
                      controller: _phone,
                      keyboardType: TextInputType.phone,
                      decoration: const InputDecoration(
                        labelText: 'Destination phone (+92…)',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 8),
                    DropdownButton<String>(
                      value: _method,
                      isExpanded: true,
                      items: const [
                        DropdownMenuItem(
                            value: 'jazzcash', child: Text('JazzCash')),
                        DropdownMenuItem(
                            value: 'easypaisa', child: Text('Easypaisa')),
                      ],
                      onChanged: (v) =>
                          setState(() => _method = v ?? 'jazzcash'),
                    ),
                    ElevatedButton(
                        onPressed: _requestPayout,
                        child: const Text('Request payout')),
                    const SizedBox(height: 16),
                    const Text('My payouts',
                        style: TextStyle(fontWeight: FontWeight.bold)),
                    if (_payouts.isEmpty) const Text('No payouts yet.'),
                    ..._payouts.map((p) => ListTile(
                          title: Text(
                              'PKR ${p.amountPkr.round()} → net PKR ${p.netPkr.round()}'),
                          subtitle: Text(
                              '${p.kind} · ${p.status} · ${p.sandbox ? 'sandbox' : 'LIVE'}'),
                        )),
                  ],
                ),
    );
  }
}
