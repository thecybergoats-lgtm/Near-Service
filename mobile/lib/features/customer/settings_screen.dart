import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/api_client.dart';
import '../../core/constants.dart';
import '../../core/models.dart';
import '../../core/theme.dart';
import '../../l10n/app_localizations.dart';
import 'wallet_screen.dart';

/// Settings: language, appearance (dark mode), notifications, privacy
/// (export/delete), help & dispute centre entry, Live Support, logout.
/// Phase 2: promo & referral section (own code, referred count,
/// credit, claim-a-code) and a real dispute-centre entry.
/// Batch 2: dark-mode toggle (persisted, applied app-wide via
/// themeModeProvider) and the notifications toggle now ALSO syncs to
/// PATCH /users/me/notification-preferences — local persistence stays
/// as the fallback when the call fails. Real push delivery still
/// needs Firebase (docs/push-notifications-setup.md); this toggle
/// only records the preference.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  ReferralInfo? _referral;
  bool _referralFailed = false;
  bool _notificationsEnabled = true;
  bool _syncingNotifications = false;

  @override
  void initState() {
    super.initState();
    _loadReferral();
    _loadNotifications();
  }

  Future<void> _loadNotifications() async {
    final prefs = await SharedPreferences.getInstance();
    if (mounted) {
      setState(() {
        _notificationsEnabled =
            prefs.getBool(StorageKeys.notificationsEnabled) ?? true;
      });
    }
  }

  Future<void> _setNotifications(bool value) async {
    setState(() {
      _notificationsEnabled = value;
      _syncingNotifications = true;
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(StorageKeys.notificationsEnabled, value);
    try {
      await ref
          .read(apiClientProvider)
          .updateNotificationPreferences(pushEnabled: value);
    } catch (_) {
      // Local preference is kept; the server sync is retried on the
      // next toggle. The user is told only if they are offline —
      // the toggle itself already reflects their choice.
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text(
                  'Saved on this phone — will sync to the server when you are back online.')),
        );
      }
    } finally {
      if (mounted) setState(() => _syncingNotifications = false);
    }
  }

  Future<void> _loadReferral() async {
    try {
      final referral = await ref.read(apiClientProvider).getReferral();
      if (mounted) setState(() => _referral = referral);
    } catch (_) {
      if (mounted) setState(() => _referralFailed = true);
    }
  }

  Future<void> _changeLanguage(String lang) async {
    ref.read(localeProvider.notifier).state = lang;
    await persistLocale(lang);
    try {
      await ref.read(apiClientProvider).patchMe({'language': lang});
    } catch (_) {
      // Language applies locally regardless; server sync best-effort.
    }
  }

  @override
  Widget build(BuildContext context) {
    final locale = ref.watch(localeProvider);
    final l = L.of(locale);
    final themeMode = ref.watch(themeModeProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(l.t('language'),
              style: const TextStyle(fontWeight: FontWeight.w700)),
          ...[
            ('en', 'English'),
            ('ur-roman', 'Roman Urdu'),
            ('ur', 'اردو — Urdu'),
          ].map((o) => RadioListTile<String>(
                title: Text(o.$2),
                value: o.$1,
                groupValue: locale,
                onChanged: (v) {
                  if (v != null) _changeLanguage(v);
                },
              )),
          const Divider(),
          Text(l.t('appearance'),
              style: const TextStyle(fontWeight: FontWeight.w700)),
          ...[
            (ThemeMode.system, l.t('system_default')),
            (ThemeMode.light, l.t('light')),
            (ThemeMode.dark, l.t('dark')),
          ].map((o) => RadioListTile<ThemeMode>(
                title: Text(o.$2),
                value: o.$1,
                groupValue: themeMode,
                onChanged: (v) async {
                  if (v == null) return;
                  ref.read(themeModeProvider.notifier).state = v;
                  await persistThemeMode(v);
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
            title: Text(l.t('favourites')),
            onTap: () => context.push('/customer/favorites'),
          ),
          ListTile(
            leading: const Icon(Icons.headset_mic_outlined),
            title: Text(l.t('live_support')),
            subtitle: Text(l.t('support_will_reply')),
            onTap: () => context.push('/customer/support'),
          ),
          ListTile(
            leading: const Icon(Icons.contacts_outlined),
            title: const Text('Trusted contacts'),
            subtitle: const Text('SOS alerts go to these people — add at least one'),
            onTap: () => context.push('/customer/trusted-contacts'),
          ),
          SwitchListTile(
            secondary: const Icon(Icons.notifications_outlined),
            title: const Text('Notifications'),
            subtitle: Text(_syncingNotifications
                ? 'Syncing preference…'
                : 'Offers, job updates, critical SMS'),
            value: _notificationsEnabled,
            onChanged: _syncingNotifications ? null : _setNotifications,
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
          const Text('About', style: TextStyle(fontWeight: FontWeight.w700)),
          const ListTile(
            leading: Icon(Icons.info_outline),
            title: Text('Near Service'),
            subtitle: Text(
                'Version ${AppConstants.appVersion} — local services marketplace, Quetta launch.\n${AppConstants.osmAttribution}.'),
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
