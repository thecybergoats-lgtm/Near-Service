import 'package:intl/intl.dart';

/// Money helpers. Money is integer PKR in the app UI (paisa only inside the
/// backend ledger — PRD p.16). Never use doubles for money arithmetic here;
/// amounts are whole rupees.
class Money {
  static final NumberFormat _fmt = NumberFormat('#,##0', 'en_PK');

  static String pkr(num amount) => 'PKR ${_fmt.format(amount)}';

  static String pkrShort(num amount) {
    if (amount >= 100000) return 'PKR ${(amount / 100000).toStringAsFixed(1)}L';
    if (amount >= 1000) return 'PKR ${(amount / 1000).toStringAsFixed(1)}k';
    return pkr(amount);
  }

  /// Parse a user-typed PKR amount; returns null when invalid / <= 0.
  static int? tryParse(String raw) {
    final cleaned = raw.replaceAll(RegExp(r'[^0-9]'), '');
    if (cleaned.isEmpty) return null;
    final value = int.tryParse(cleaned);
    if (value == null || value <= 0) return null;
    return value;
  }
}

/// Fair-price range returned by GET /pricing/fair-range (PRD p.24).
class FairRange {
  final int min;
  final int typical;
  final int max;
  final int sampleSize;

  const FairRange({
    required this.min,
    required this.typical,
    required this.max,
    this.sampleSize = 0,
  });

  factory FairRange.fromJson(Map<String, dynamic> j) => FairRange(
        min: (j['min'] as num?)?.toInt() ?? 0,
        typical: (j['typical'] as num?)?.toInt() ?? 0,
        max: (j['max'] as num?)?.toInt() ?? 0,
        sampleSize: (j['sample_size'] as num?)?.toInt() ?? 0,
      );

  /// Hidden client-side when the sample is too small (PRD p.24).
  bool get isReliable => sampleSize >= 5 && max > min;

  /// -1 too low, 0 inside range, 1 too high.
  int classify(int offer) {
    if (offer < min) return -1;
    if (offer > max) return 1;
    return 0;
  }
}
