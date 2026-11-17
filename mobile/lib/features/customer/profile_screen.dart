import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../l10n/app_localizations.dart';

/// My Profile — the logged-in user's own record. The record is created
/// once, at registration (OTP verify); this screen only READS it (GET /me)
/// and edits the name + language (PATCH /me). It never creates a second
/// profile. History and Wallet live here now that they left the footer.
class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key});

  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  AppUser? _user;
  bool _loading = true;
  String? _error;
  bool _saving = false;
  final _nameCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final u = await ref.read(apiClientProvider).getMe();
      if (!mounted) return;
      setState(() {
        _user = u;
        _nameCtrl.text = u.fullName ?? '';
        _loading = false;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = 'Could not load your profile. Check your connection and try again.';
        });
      }
    }
  }

  Future<void> _saveName() async {
    final name = _nameCtrl.text.trim();
    if (name.isEmpty || name == (_user?.fullName ?? '')) return;
    setState(() => _saving = true);
    try {
      final u = await ref.read(apiClientProvider).patchMe({'full_name': name});
      if (!mounted) return;
      setState(() {
        _user = u;
        _saving = false;
      });
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Name saved.')));
    } catch (_) {
      if (mounted) {
        setState(() => _saving = false);
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not save the name. Try again.')));
      }
    }
  }

  Future<void> _changeLanguage(String lang) async {
    ref.read(localeProvider.notifier).state = lang;
    await persistLocale(lang);
    try {
      final u = await ref.read(apiClientProvider).patchMe({'language': lang});
      if (mounted) setState(() => _user = u);
    } catch (_) {
      // Language applies locally regardless; the server sync is best-effort.
    }
  }

  @override
  Widget build(BuildContext context) {
    final locale = ref.watch(localeProvider);
    final user = _user;
    return Scaffold(
      appBar: AppBar(title: const Text('My Profile')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!),
                        const SizedBox(height: 12),
                        FilledButton(onPressed: _load, child: const Text('Retry')),
                      ],
                    ),
                  ),
                )
              : user == null
                  ? const SizedBox.shrink()
                  : _buildBody(context, user, locale),
    );
  }

  Widget _buildBody(BuildContext context, AppUser user, String locale) {
    final name = user.fullName ?? '';
    final initial = name.isNotEmpty ? name[0].toUpperCase() : 'N';
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        CircleAvatar(
          radius: 36,
          child: Text(initial, style: const TextStyle(fontSize: 28)),
        ),
        const SizedBox(height: 12),
        Center(
          child: Text(user.phone,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        ),
        if (user.createdAt != null)
          Center(
            child: Text(
              'Member since ${DateFormat('d MMM yyyy').format(user.createdAt!)}',
              style: const TextStyle(color: Colors.grey),
            ),
          ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          alignment: WrapAlignment.center,
          children: user.roles.map((r) => Chip(label: Text(r))).toList(),
        ),
        const SizedBox(height: 16),
        const Text('Display name', style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        TextField(
          controller: _nameCtrl,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            hintText: 'Your name',
          ),
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _saveName(),
        ),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerRight,
          child: FilledButton(
            onPressed: _saving ? null : _saveName,
            child: _saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Save name'),
          ),
        ),
        const Divider(height: 32),
        const Text('Language', style: TextStyle(fontWeight: FontWeight.w700)),
        ...[
          ('ur', 'اردو — Urdu'),
          ('en', 'English'),
          ('ur-roman', 'Roman Urdu'),
        ].map((o) => RadioListTile<String>(
              title: Text(o.$2),
              value: o.$1,
              groupValue: locale,
              onChanged: (v) {
                if (v != null) _changeLanguage(v);
              },
            )),
        const Divider(height: 32),
        ListTile(
          leading: const Icon(Icons.history),
          title: const Text('My jobs & history'),
          onTap: () => context.push('/customer/history'),
        ),
        ListTile(
          leading: const Icon(Icons.account_balance_wallet),
          title: const Text('Wallet'),
          onTap: () => context.push('/customer/wallet'),
        ),
        ListTile(
          leading: const Icon(Icons.settings),
          title: const Text('Settings'),
          onTap: () => context.push('/customer/settings'),
        ),
      ],
    );
  }
}
