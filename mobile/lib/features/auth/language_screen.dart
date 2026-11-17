import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme.dart';
import '../../l10n/app_localizations.dart';

/// First-launch language select: Urdu / English / Roman Urdu (PRD p.27).
class LanguageScreen extends ConsumerWidget {
  const LanguageScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    const options = [
      ('ur', 'اردو', 'Urdu'),
      ('en', 'English', 'English'),
      ('ur-roman', 'Roman Urdu', 'Roman Urdu'),
    ];
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 32),
              const Text('Near Service',
                  style: TextStyle(fontSize: 32, fontWeight: FontWeight.w800, color: AppColors.primaryDark)),
              const SizedBox(height: 8),
              const Text('Apni zaban chunein / Choose your language',
                  style: TextStyle(color: AppColors.secondaryText)),
              const SizedBox(height: 32),
              ...options.map((o) => Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: SizedBox(
                      width: double.infinity,
                      child: OutlinedButton(
                        onPressed: () async {
                          ref.read(localeProvider.notifier).state = o.$1;
                          await persistLocale(o.$1);
                          if (context.mounted) context.go('/onboarding');
                        },
                        child: Text('${o.$2}  ·  ${o.$3}',
                            style: const TextStyle(fontSize: 18)),
                      ),
                    ),
                  )),
            ],
          ),
        ),
      ),
    );
  }
}
