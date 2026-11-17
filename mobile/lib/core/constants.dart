/// App-wide constants. Change [apiBaseUrl] to point at a deployed backend.
/// Default is the local NestJS dev server (same value the backend uses).
class AppConstants {
  static const String appName = 'Near Service';
  static const String packageName = 'com.nearservice.app';

  /// Base URL for the NestJS API (no trailing slash).
  /// Override at build time with: --dart-define=API_BASE_URL=https://api.example.com/api/v1
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://localhost:3000/api/v1',
  );

  /// Socket.IO URL — same origin as the API, without the /api/v1 suffix.
  static const String socketUrl = String.fromEnvironment(
    'SOCKET_URL',
    defaultValue: 'http://localhost:3000',
  );

  /// Quetta city centre (Satellite Town area) — default map centre.
  static const double quettaLat = 30.1798;
  static const double quettaLng = 66.9750;
  static const double defaultZoom = 13.0;

  static const int offerTtlSeconds = 600; // 10 min default (PRD p.7)
  static const int maxCounterRounds = 3;
  static const double defaultRadiusKm = 5.0;

  /// Default radius for real-shop discovery (GET /places/nearby).
  static const double placesRadiusKm = 20.0;

  /// App version (keep in sync with pubspec.yaml `version:`).
  static const String appVersion = '1.0.0+1';

  /// Shown under the map whenever real OpenStreetMap shop pins are visible.
  static const String osmAttribution = 'Map data © OpenStreetMap contributors';

  static const List<double> radiusOptions = [1, 3, 5, 10, 25];

  /// 5 launch categories (PRD p.2). Slugs match the backend seed.
  static const List<String> launchCategorySlugs = [
    'book-binding',
    'ac-repair',
    'electrician',
    'plumber',
    'mobile-repair',
  ];
}

/// Storage keys for flutter_secure_storage / SharedPreferences.
class StorageKeys {
  static const String accessToken = 'ns_access_token';
  static const String refreshToken = 'ns_refresh_token';
  static const String userJson = 'ns_user_json';
  static const String language = 'ns_language'; // 'ur' | 'en' | 'ur-roman'
  static const String role = 'ns_role'; // 'customer' | 'provider' | 'both'
  static const String deviceFingerprint = 'ns_device_fingerprint';
  static const String deviceId = 'ns_device_id'; // id returned by POST /me/devices
  static const String onboardingDone = 'ns_onboarding_done';
  static const String notificationsEnabled = 'ns_notifications_enabled'; // local only
}
