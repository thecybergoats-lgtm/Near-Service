import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../l10n/app_localizations.dart';
import 'wallet_screen.dart';

/// Settings: language, notifications, privacy (export/delete),
/// help & dispute centre entry, logout.
/// Phase 2: promo & referral section (own code, referred count,
/// credit, claim-a-code) and a real dispute-centre entry.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  ReferralInfo? _referral;
  bool _referralFailed = false;

  @override
  void initState() {
    super.initState();
    _loadReferral();
  }

  Future<void> _loadReferral() async {
    try {
      final referral = await ref.read(apiClientProvider).getReferral();
      if (mounted) setState(() => _referral = referral);
    } catch (_) {
      if (mounted) setState(() => _referralFailed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    // ConsumerState exposes `ref` as a property — no second parameter.
    final locale = ref.watch(localeProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('Language', style: TextStyle(fontWeight: FontWeight.w700)),
          ...[
            ('ur', 'اردو — Urdu'),
            ('en', 'English'),
            ('ur-roman', 'Roman Urdu'),
          ].map((o) => RadioListTile<String>(
                title: Text(o.$2),
                value: o.$1,
                groupValue: locale,
                onChanged: (v) async {
                  if (v == null) return;
                  ref.read(localeProvider.notifier).state = v;
                  await persistLocale(v);
                },
              )),
          const Divider(),
          const Text('Promo & referral',
              style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          if (_referralFailed)
            const Card(
              child: ListTile(
                title: Text('Referral details unavailable'),
                subtitle: Text(
                    'Check your connection — your code and credit will show here.'),
              ),
            )
          else
            ReferralCard(
                referral: _referral, onClaimed: _loadReferral),
          ListTile(
            leading: const Icon(Icons.local_offer_outlined),
            title: const Text('First job discount'),
            subtitle: const Text('Try code FIRSTJOB at payment.'),
            onTap: () => context.push('/customer/history'),
          ),
          const Divider(),
          ListTile(
            leading: const Icon(Icons.favorite_border),
            title: const Text('Favorites'),
            onTap: () => context.push('/customer/favorites'),
          ),
          ListTile(
            leading: const Icon(Icons.contacts_outlined),
            title: const Text('Trusted contacts'),
            subtitle: const Text('SOS alerts go to these people — add at least one'),
            onTap: () => context.push('/customer/trusted-contacts'),
          ),
          ListTile(
            leading: const Icon(Icons.notifications_outlined),
            title: const Text('Notifications'),
            subtitle: const Text('Offers, job updates, critical SMS'),
            onTap: () {},
          ),
          ListTile(
            leading: const Icon(Icons.help_outline),
            title: const Text('Help & dispute centre'),
            subtitle: const Text('Open a dispute with photo / chat / GPS evidence'),
            onTap: () => context.push('/customer/disputes'),
          ),
          ListTile(
            leading: const Icon(Icons.privacy_tip_outlined),
            title: const Text('Privacy — export / delete my data'),
            onTap: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Data export / deletion is handled by support in Phase 1.')),
              );
            },
          ),
          const Divider(),
          ListTile(
            leading: const Icon(Icons.logout, color: Colors.red),
            title: const Text('Log out', style: TextStyle(color: Colors.red)),
            onTap: () async {
              await ref.read(apiClientProvider).logout();
              if (context.mounted) context.go('/auth/phone');
            },
          ),
        ],
      ),
    );
  }
}
