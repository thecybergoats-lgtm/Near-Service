import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/demo_data.dart';
import '../../core/errors.dart';
import '../../core/models.dart';
import '../../core/money.dart';
import '../common/widgets.dart';
import '../warranty/warranty_widgets.dart';

/// Provider profile (PRD p.22): services + starting prices, reviews,
/// badges, Request quote / Call / Chat. Call is masked in production;
/// here it opens the chat until the masked-call vendor is wired.
class ProviderProfileScreen extends ConsumerStatefulWidget {
  const ProviderProfileScreen({super.key, required this.providerId, this.initial});

  final String providerId;
  final ServiceProvider? initial;

  @override
  ConsumerState<ProviderProfileScreen> createState() => _ProviderProfileScreenState();
}

class _ProviderProfileScreenState extends ConsumerState<ProviderProfileScreen> {
  ServiceProvider? _provider;
  bool _loading = true;
  // Phase 4 (item 4): 7-day warranty badge — Tier 3 only, hidden otherwise.
  bool _warrantyEligible = false;
  int _warrantyDays = 7;

  @override
  void initState() {
    super.initState();
    _provider = widget.initial;
    _load();
  }

  Future<void> _load() async {
    try {
      _provider = await ref.read(apiClientProvider).getProvider(widget.providerId);
    } catch (_) {
      _provider ??= DemoData.providers.firstWhere(
        (p) => p.id == widget.providerId,
        orElse: () => DemoData.providers.first,
      );
    }
    // Best-effort: a failed badge lookup hides the badge, never the profile.
    try {
      final badge = await ref.read(apiClientProvider).getWarrantyBadge(widget.providerId);
      _warrantyEligible = badge['warranty_eligible'] == true;
      _warrantyDays = (badge['coverage_days'] as num?)?.toInt() ?? 7;
    } catch (_) {
      _warrantyEligible = false;
    }
    if (mounted) setState(() => _loading = false);
  }

  /// FIX 10 — block / report this provider (POST /blocks, POST /reports).
  /// NOTE: the backend block() stores a USER id, but the provider
  /// profile endpoint does not expose the provider's user_id — the
  /// profile id is passed as the target id (see ApiClient.createBlock).
  /// If the backend rejects it, the provider card needs a user_id field.
  Future<void> _block() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Block this provider?'),
        content: const Text(
            'Blocking is immediate and mutual: you will not see each other’s requests, offers or chats any more.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Block', style: TextStyle(color: Colors.red))),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await ref.read(apiClientProvider).createBlock(widget.providerId);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Provider blocked.')),
        );
        context.pop();
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    }
  }

  Future<void> _report() async {
    final reason = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('Report this provider'),
        children: [
          for (final r in ['spam', 'fraud', 'abuse', 'off_platform', 'other'])
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, r),
              child: Text(r),
            ),
        ],
      ),
    );
    if (reason == null) return;
    try {
      await ref.read(apiClientProvider).reportUser(
            targetId: widget.providerId,
            targetType: 'provider',
            reasonCode: reason,
          );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text('Report sent — support will review it.')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.userMessage)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _provider;
    if (_loading && p == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final provider = p!;
    return Scaffold(
      appBar: AppBar(
        title: Text(provider.name),
        actions: [
          PopupMenuButton<String>(
            tooltip: 'More',
            onSelected: (v) {
              if (v == 'block') _block();
              if (v == 'report') _report();
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'report', child: Text('Report provider')),
              PopupMenuItem(
                  value: 'block',
                  child: Text('Block provider',
                      style: TextStyle(color: Colors.red))),
            ],
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 36,
                backgroundColor: const Color(0xFF0F766E).withOpacity(0.12),
                child: Text(provider.name.isNotEmpty ? provider.name[0] : '?',
                    style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(provider.name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                    Row(
                      children: [
                        const Icon(Icons.star, size: 16, color: Color(0xFFD97706)),
                        Text(' ${provider.rating.toStringAsFixed(1)} (${provider.ratingCount} reviews)'),
                      ],
                    ),
                    Text('${provider.jobsCompleted} jobs completed · ${provider.distanceKm.toStringAsFixed(1)} km away'),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              TierBadge(tier: provider.tier),
              const SizedBox(width: 8),
              Chip(label: Text(provider.isShop ? 'SHOP' : 'INDIVIDUAL')),
              const SizedBox(width: 8),
              Chip(label: Text(provider.isOpen ? 'Open now' : 'Closed')),
              if (_warrantyEligible) ...[
                const SizedBox(width: 8),
                WarrantyBadge(warrantyEligible: true, coverageDays: _warrantyDays),
              ],
            ],
          ),
          if (provider.bio != null) ...[
            const SizedBox(height: 16),
            Text(provider.bio!),
          ],
          const SizedBox(height: 16),
          const Text('Services & starting prices', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
          const SizedBox(height: 8),
          Card(
            child: ListTile(
              title: const Text('Standard service'),
              trailing: Text(Money.pkr(provider.startingPrice)),
              subtitle: const Text('Starting price — final price is negotiated per request.'),
            ),
          ),
          const SizedBox(height: 16),
          const Text('Languages', style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: provider.languages.map((l) => Chip(label: Text(l))).toList(),
          ),
          const SizedBox(height: 16),
          const Text('Reviews', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
          const SizedBox(height: 8),
          const Card(
            child: ListTile(
              leading: Icon(Icons.star, color: Color(0xFFD97706)),
              title: Text('Reviews appear here after completed, paid jobs.'),
              subtitle: Text('Only customers with a settled job can review.'),
            ),
          ),
          const SizedBox(height: 24),
          Row(
            children: [
              Expanded(
                child: ElevatedButton(
                  onPressed: () => context.push('/customer/request',
                      extra: const {'categorySlug': 'book-binding'}),
                  child: const Text('Request quote'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => context.push('/customer/chat/demo-chat',
                      extra: {'peerName': provider.name, 'peerId': provider.id}),
                  icon: const Icon(Icons.chat_bubble_outline),
                  label: const Text('Chat'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Masked calling is wired to the call vendor at Phase 1 kickoff — chat works now.')),
              );
            },
            icon: const Icon(Icons.call_outlined),
            label: const Text('Call (masked)'),
          ),
        ],
      ),
    );
  }
}
