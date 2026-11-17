import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/constants.dart';

/// Role select (PRD p.27): customer / provider / both.
/// One account can hold both profiles and switch instantly (PRD p.5).
class RoleScreen extends ConsumerWidget {
  const RoleScreen({super.key});

  Future<void> _pick(BuildContext context, WidgetRef ref, String role) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(StorageKeys.role, role);
    ref.read(roleProvider.notifier).state = role;
    if (context.mounted) {
      context.go(role == 'provider' ? '/provider/onboarding' : '/customer/home');
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('How will you use Near Service?')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          children: [
            _roleCard(
              context, ref, 'customer', Icons.person_search,
              'I need a service', 'Find a karigar, post a request, negotiate.',
            ),
            const SizedBox(height: 12),
            _roleCard(
              context, ref, 'provider', Icons.build,
              'I provide services', 'Get nearby jobs, accept or counter offers.',
            ),
            const SizedBox(height: 12),
            _roleCard(
              context, ref, 'both', Icons.swap_horiz,
              'Both', 'One account, two profiles — switch anytime.',
            ),
          ],
        ),
      ),
    );
  }

  Widget _roleCard(BuildContext context, WidgetRef ref, String role,
      IconData icon, String title, String subtitle) {
    return Card(
      child: InkWell(
        onTap: () => _pick(context, ref, role),
        borderRadius: BorderRadius.circular(18),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Row(
            children: [
              Icon(icon, size: 36, color: Theme.of(context).colorScheme.primary),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                    Text(subtitle, style: const TextStyle(color: Colors.grey)),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    );
  }
}

/// Current role, persisted in SharedPreferences.
final roleProvider = StateProvider<String>((ref) => 'customer');
