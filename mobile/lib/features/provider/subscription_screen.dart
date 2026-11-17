import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/errors.dart';
import '../../core/phase3_models.dart';

/// Phase 3 — Subscriptions (provider): plans, my plan, analytics.
/// Paid plans bill from the wallet; a plan multiplies the commission
/// rate (clamped 0.05–0.15) and Business enables featured ("Sponsored")
/// placement. Analytics needs Pro or Business.
class SubscriptionScreen extends ConsumerStatefulWidget {
  const SubscriptionScreen({super.key});

  @override
  ConsumerState<SubscriptionScreen> createState() =>
      _SubscriptionScreenState();
}

class _SubscriptionScreenState extends ConsumerState<SubscriptionScreen> {
  List<SubscriptionPlan> _plans = [];
  SubscriptionView? _mine;
  ProviderAnalytics? _analytics;
  bool _loading = true;
  String? _error;
  String? _msg;

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
      _plans = await ref.read(apiClientProvider).listSubscriptionPlans();
      _mine = await ref.read(apiClientProvider).getMySubscription();
      _analytics = null;
      if (_mine!.planCode != 'free') {
        try {
          _analytics = await ref
              .read(apiClientProvider)
              .getSubscriptionAnalytics();
        } on ApiException {
          _analytics = null;
        }
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not load subscriptions.');
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _act(Future<SubscriptionView> Function() fn, String done) async {
    try {
      _mine = await fn();
      setState(() => _msg = done);
      await _load();
    } on ApiException catch (e) {
      setState(() => _msg = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Subscription')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (_msg != null) ...[
                      Text(_msg!),
                      const SizedBox(height: 12),
                    ],
                    Card(
                      child: ListTile(
                        title: Text('My plan: ${_mine!.planName}'),
                        subtitle: Text(
                            'PKR ${_mine!.pricePkr.round()} · commission ×${_mine!.commissionMultiplier} · ${_mine!.status}'),
                        trailing: _mine!.planCode == 'free'
                            ? null
                            : TextButton(
                                onPressed: () => _act(
                                  () => ref
                                      .read(apiClientProvider)
                                      .cancelSubscription(),
                                  'Cancelled — stays active until period end.',
                                ),
                                child: const Text('Cancel'),
                              ),
                      ),
                    ),
                    if (_analytics != null) ...[
                      const SizedBox(height: 12),
                      const Text('Analytics (30 days)',
                          style: TextStyle(fontWeight: FontWeight.bold)),
                      ListTile(
                        title: Text(
                            '${_analytics!.jobsSettled} of ${_analytics!.jobsTotal} jobs settled'),
                        subtitle: Text(
                            'Gross PKR ${_analytics!.grossPkr.round()} · commission PKR ${_analytics!.commissionPkr.round()} · net PKR ${_analytics!.netEarningsPkr.round()} · ★ ${_analytics!.avgStars} (${_analytics!.reviewCount} reviews)'),
                      ),
                    ],
                    const SizedBox(height: 12),
                    const Text('Plans',
                        style: TextStyle(fontWeight: FontWeight.bold)),
                    ..._plans.map((p) => Card(
                          child: ListTile(
                            title: Text(
                                '${p.name} — PKR ${p.pricePkr.round()}'),
                            subtitle: Text(
                                'Commission ×${p.commissionMultiplier} · ${p.maxStaffAccounts} staff seats${p.featured ? ' · Sponsored placement' : ''}${p.analyticsEnabled ? ' · Analytics' : ''}'),
                            trailing: p.code == _mine!.planCode
                                ? const Text('Current')
                                : ElevatedButton(
                                    onPressed: () => _act(
                                      () => _mine!.status == 'none'
                                          ? ref
                                              .read(apiClientProvider)
                                              .subscribe(p.code)
                                          : ref
                                              .read(apiClientProvider)
                                              .changePlan(p.code),
                                      'Switched to ${p.name}.',
                                    ),
                                    child: Text(_mine!.status == 'none'
                                        ? 'Subscribe'
                                        : 'Switch'),
                                  ),
                          ),
                        )),
                    const SizedBox(height: 12),
                    const Text(
                      'Paid plans are charged from your wallet. Upgrades apply immediately; downgrades at period end.',
                      style: TextStyle(fontSize: 12, color: Colors.grey),
                    ),
                  ],
                ),
    );
  }
}
