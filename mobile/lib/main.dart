import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/theme.dart';
import 'l10n/app_localizations.dart';
import 'router.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final locale = await loadPersistedLocale();
  runApp(ProviderScope(
    overrides: [localeProvider.overrideWith((ref) => locale)],
    child: const NearServiceApp(),
  ));
}

class NearServiceApp extends ConsumerWidget {
  const NearServiceApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final localeCode = ref.watch(localeProvider);
    final isUrdu = localeCode == 'ur';
    return MaterialApp.router(
      title: 'Near Service',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(isUrdu: isUrdu),
      routerConfig: buildRouter(),
      locale: isUrdu
          ? const Locale('ur', 'PK')
          : localeCode == 'ur-roman'
              ? const Locale('en', 'PK')
              : const Locale('en'),
      supportedLocales: const [Locale('en'), Locale('ur', 'PK')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
    );
  }
}
