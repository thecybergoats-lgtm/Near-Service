// Provider QR code payload (Batch 3) — see docs/provider-qr-code.md.
//
// The QR encodes a stable deep-link-style string, NOT a screenshot-only
// image:
//   `near-service://provider/<provider-profile-uuid>`
//
// Scanning it opens the provider's profile in the app. A bare UUID is
// also accepted (manual code entry). Nothing else is a valid code —
// random QR codes must never open a profile.

/// The deep-link prefix for a provider QR code.
const String qrProviderPrefix = 'near-service://provider/';

/// Builds the QR payload for a provider profile id.
String buildProviderQrPayload(String providerId) => '$qrProviderPrefix$providerId';

bool _isUuid(String s) => RegExp(
      r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    ).hasMatch(s);

/// Parses scanned / typed text into a provider profile id, or null when
/// the text is not a Near Service provider code.
String? parseProviderIdFromQr(String raw) {
  final s = raw.trim();
  if (s.isEmpty) return null;
  if (s.startsWith(qrProviderPrefix)) {
    final id = s.substring(qrProviderPrefix.length).trim();
    return _isUuid(id) ? id : null;
  }
  return _isUuid(s) ? s : null;
}
