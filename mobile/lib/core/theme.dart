import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'constants.dart';

/// Design tokens from PRD p.26 (Design system).
/// primary teal #0F766E, accent amber #D97706, radius 16–20, min touch 48.
class AppColors {
  static const Color primary = Color(0xFF0F766E);
  static const Color primaryDark = Color(0xFF134E4A);
  static const Color accent = Color(0xFFD97706);
  static const Color surface = Color(0xFFFFFFFF);
  static const Color ink = Color(0xFF1E293B);
  static const Color secondaryText = Color(0xFF64748B);
  static const Color fill = Color(0xFFF1F5F9);
  static const Color success = Color(0xFF15803D);
  static const Color danger = Color(0xFFDC2626);
  static const Color border = Color(0xFFE2E8F0);
  // Dark theme (Batch 2): near-black surfaces, gold accents stay.
  static const Color darkSurface = Color(0xFF111827);
  static const Color darkCard = Color(0xFF1F2937);
  static const Color darkFill = Color(0xFF1F2937);
  static const Color darkInk = Color(0xFFF1F5F9);
  static const Color darkSecondaryText = Color(0xFF9CA3AF);
  static const Color darkBorder = Color(0xFF374151);
  static const Color gold = Color(0xFFC9A227);
}

class AppRadius {
  static const double card = 18.0;
  static const double sheet = 20.0;
  static const double chip = 24.0;
}

class AppSpacing {
  static const double s4 = 4, s8 = 8, s12 = 12, s16 = 16, s24 = 24, s32 = 32;
}

const double kMinTouch = 48.0;

ThemeData buildTheme({bool isUrdu = false}) {
  const baseFont = 'Noto Sans Arabic';
  final colorScheme = ColorScheme.fromSeed(
    seedColor: AppColors.primary,
    primary: AppColors.primary,
    secondary: AppColors.accent,
    surface: AppColors.surface,
    error: AppColors.danger,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: colorScheme,
    brightness: Brightness.light,
    scaffoldBackgroundColor: AppColors.surface,
    fontFamily: isUrdu ? baseFont : null,
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.surface,
      foregroundColor: AppColors.ink,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        color: AppColors.ink,
        fontSize: 20,
        fontWeight: FontWeight.w700,
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(kMinTouch),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
        ),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(kMinTouch),
        side: const BorderSide(color: AppColors.primary),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
        ),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.fill,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: BorderSide.none,
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
    ),
    chipTheme: ChipThemeData(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.chip),
      ),
      selectedColor: AppColors.primary,
      backgroundColor: AppColors.fill,
    ),
    cardTheme: CardTheme(
      elevation: 0,
      color: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.card),
        side: const BorderSide(color: AppColors.border),
      ),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppRadius.sheet),
        ),
      ),
    ),
    textTheme: const TextTheme(
      bodyMedium: TextStyle(fontSize: 14, color: AppColors.ink),
      bodyLarge: TextStyle(fontSize: 16, color: AppColors.ink),
      titleLarge: TextStyle(
        fontSize: 22,
        fontWeight: FontWeight.w700,
        color: AppColors.primaryDark,
      ),
    ),
  );
}

/// Dark theme (Batch 2): same tokens, dark surfaces, gold accents.
/// Only the theme is swapped — screens keep their layout; the worst
/// hardcoded light backgrounds are fixed at the call site (home search
/// bar, chat bubbles) to use theme colours instead.
ThemeData buildDarkTheme({bool isUrdu = false}) {
  const baseFont = 'Noto Sans Arabic';
  final colorScheme = ColorScheme.fromSeed(
    seedColor: AppColors.primary,
    brightness: Brightness.dark,
    primary: const Color(0xFF2DD4BF),
    secondary: AppColors.accent,
    surface: AppColors.darkSurface,
    error: const Color(0xFFF87171),
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: colorScheme,
    brightness: Brightness.dark,
    scaffoldBackgroundColor: AppColors.darkSurface,
    fontFamily: isUrdu ? baseFont : null,
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.darkSurface,
      foregroundColor: AppColors.darkInk,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        color: AppColors.darkInk,
        fontSize: 20,
        fontWeight: FontWeight.w700,
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(kMinTouch),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
        ),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(kMinTouch),
        side: const BorderSide(color: Color(0xFF2DD4BF)),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
        ),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.darkFill,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: BorderSide.none,
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
    ),
    chipTheme: ChipThemeData(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.chip),
      ),
      selectedColor: AppColors.primary,
      backgroundColor: AppColors.darkFill,
    ),
    cardTheme: CardTheme(
      elevation: 0,
      color: AppColors.darkCard,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.card),
        side: const BorderSide(color: AppColors.darkBorder),
      ),
    ),
    bottomNavigationBarTheme: const BottomNavigationBarThemeData(
      backgroundColor: AppColors.darkSurface,
      selectedItemColor: Color(0xFF2DD4BF),
      unselectedItemColor: AppColors.darkSecondaryText,
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: AppColors.darkCard,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppRadius.sheet),
        ),
      ),
    ),
    dialogTheme: const DialogTheme(backgroundColor: AppColors.darkCard),
    textTheme: const TextTheme(
      bodyMedium: TextStyle(fontSize: 14, color: AppColors.darkInk),
      bodyLarge: TextStyle(fontSize: 16, color: AppColors.darkInk),
      titleLarge: TextStyle(
        fontSize: 22,
        fontWeight: FontWeight.w700,
        color: AppColors.darkInk,
      ),
    ),
  );
}

/// App-wide ThemeMode, persisted in SharedPreferences ('system' default).
final themeModeProvider = StateProvider<ThemeMode>((ref) => ThemeMode.system);

ThemeMode themeModeFromString(String? raw) {
  switch (raw) {
    case 'light':
      return ThemeMode.light;
    case 'dark':
      return ThemeMode.dark;
    default:
      return ThemeMode.system;
  }
}

String themeModeToString(ThemeMode mode) {
  switch (mode) {
    case ThemeMode.light:
      return 'light';
    case ThemeMode.dark:
      return 'dark';
    case ThemeMode.system:
      return 'system';
  }
}

Future<void> persistThemeMode(ThemeMode mode) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(StorageKeys.themeMode, themeModeToString(mode));
}

Future<ThemeMode> loadPersistedThemeMode() async {
  final prefs = await SharedPreferences.getInstance();
  return themeModeFromString(prefs.getString(StorageKeys.themeMode));
}
