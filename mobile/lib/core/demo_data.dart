import 'models.dart';

/// DEMO FALLBACK ONLY — used when the API is unreachable (offline demo).
/// Realistic Quetta providers; clearly marked as demo data in the UI
/// ("Demo data — connect to the API for live providers"). The API is always
/// the primary path; this list is never sent to the server.
/// Names are invented realistic Quetta shop/person names, not copied from
/// any backend seed (backend seed was not available when this was written).
class DemoData {
  static const List<Category> categories = [
    Category(
      id: 'book-binding',
      slug: 'book-binding',
      nameEn: 'Book Binding',
      nameUr: 'کتاب کی جلد سازی',
      nameRoman: 'Book Binding',
      iconKey: 'book',
      children: [
        Category(id: 'bb-hard', slug: 'hard-binding', nameEn: 'Hard Binding', nameRoman: 'Hard Binding'),
        Category(id: 'bb-soft', slug: 'soft-binding', nameEn: 'Soft Binding', nameRoman: 'Soft Binding'),
        Category(id: 'bb-thesis', slug: 'thesis-binding', nameEn: 'Thesis Binding', nameRoman: 'Thesis Binding'),
      ],
    ),
    Category(
      id: 'ac-repair',
      slug: 'ac-repair',
      nameEn: 'AC Repair',
      nameUr: 'اے سی مرمت',
      nameRoman: 'AC Repair',
      iconKey: 'ac_unit',
      children: [
        Category(id: 'ac-gas', slug: 'gas-refill', nameEn: 'Gas Refill', nameRoman: 'Gas Refill'),
        Category(id: 'ac-service', slug: 'general-service', nameEn: 'General Service', nameRoman: 'General Service'),
        Category(id: 'ac-install', slug: 'installation', nameEn: 'Installation', nameRoman: 'Installation'),
      ],
    ),
    Category(
      id: 'electrician',
      slug: 'electrician',
      nameEn: 'Electrician',
      nameUr: 'بجلی کا کام',
      nameRoman: 'Electrician',
      iconKey: 'electrical_services',
    ),
    Category(
      id: 'plumber',
      slug: 'plumber',
      nameEn: 'Plumber',
      nameUr: 'پلمبر',
      nameRoman: 'Plumber',
      iconKey: 'plumbing',
    ),
    Category(
      id: 'mobile-repair',
      slug: 'mobile-repair',
      nameEn: 'Mobile Repair',
      nameUr: 'موبائل مرمت',
      nameRoman: 'Mobile Repair',
      iconKey: 'phone_android',
    ),
  ];

  static const List<Provider> providers = [
    Provider(
      id: 'demo-p1', displayName: 'Ahmed Book Binding', shopName: 'Ahmed Book Binding House',
      type: 'SHOP', tier: 2, rating: 4.8, ratingCount: 214, jobsCompleted: 312,
      distanceKm: 0.8, etaMinutes: 10, startingPrice: 150, responseSecondsAvg: 45,
      lat: 30.1820, lng: 66.9720, bio: 'Hard & soft binding, thesis binding. 12 years in Satellite Town.',
    ),
    Provider(
      id: 'demo-p2', displayName: 'Bilal Ahmed', shopName: 'Bilal Cool Air Services',
      type: 'SHOP', tier: 2, rating: 4.7, ratingCount: 186, jobsCompleted: 268,
      distanceKm: 1.4, etaMinutes: 15, startingPrice: 800, responseSecondsAvg: 60,
      lat: 30.1760, lng: 66.9800, bio: 'Split & window AC — gas refill, service, installation.',
    ),
    Provider(
      id: 'demo-p3', displayName: 'Muhammad Aslam', type: 'INDIVIDUAL',
      tier: 1, rating: 4.6, ratingCount: 98, jobsCompleted: 141,
      distanceKm: 2.1, etaMinutes: 20, startingPrice: 500, responseSecondsAvg: 90,
      lat: 30.1900, lng: 66.9650, bio: 'House wiring, fans, switches, UPS fitting.',
    ),
    Provider(
      id: 'demo-p4', displayName: 'Naseer Khan', shopName: 'Naseer Sanitary Store',
      type: 'SHOP', tier: 3, rating: 4.9, ratingCount: 320, jobsCompleted: 540,
      distanceKm: 2.8, etaMinutes: 25, startingPrice: 400, responseSecondsAvg: 40,
      lat: 30.1700, lng: 66.9900, bio: 'Leak repair, fitting, motor & tank work. Trusted Pro.',
    ),
    Provider(
      id: 'demo-p5', displayName: 'Usman Ghani', shopName: 'Usman Mobile Lab',
      type: 'SHOP', tier: 1, rating: 4.5, ratingCount: 167, jobsCompleted: 203,
      distanceKm: 1.1, etaMinutes: 12, startingPrice: 300, responseSecondsAvg: 55,
      lat: 30.1850, lng: 66.9780, bio: 'Screen, battery, charging port, software. All brands.',
    ),
    Provider(
      id: 'demo-p6', displayName: 'Abdul Rehman', type: 'INDIVIDUAL',
      tier: 1, rating: 4.4, ratingCount: 76, jobsCompleted: 112,
      distanceKm: 3.5, etaMinutes: 30, startingPrice: 700, responseSecondsAvg: 120,
      lat: 30.1600, lng: 66.9600, bio: 'AC service & gas refill, home visits across Quetta.',
    ),
    Provider(
      id: 'demo-p7', displayName: 'Haji Karim Book Depot', shopName: 'Karim Book Binding',
      type: 'SHOP', tier: 2, rating: 4.7, ratingCount: 143, jobsCompleted: 198,
      distanceKm: 4.2, etaMinutes: 35, startingPrice: 120, responseSecondsAvg: 75,
      lat: 30.1950, lng: 67.0000, bio: 'Bulk school & office binding, lamination, printing.',
    ),
  ];

  /// Demo offers for the live-offers screen when the API is unreachable.
  static List<Offer> demoOffers(String requestId) => [
        Offer(
          id: 'demo-o1', requestId: requestId, providerId: 'demo-p1',
          providerName: 'Ahmed Book Binding House', providerRating: 4.8,
          providerDistanceKm: 0.8, price: 2400, etaMinutes: 60,
          note: 'Aaj pickup, kal delivery.', round: 1,
          breakdown: const {'labour': 1800, 'parts': 400, 'visit_fee': 200},
          expiresAt: DateTime.now().add(const Duration(minutes: 9)),
        ),
        Offer(
          id: 'demo-o2', requestId: requestId, providerId: 'demo-p7',
          providerName: 'Karim Book Binding', providerRating: 4.7,
          providerDistanceKm: 4.2, price: 2700, etaMinutes: 90,
          note: 'Bulk discount included.', round: 1,
          breakdown: const {'labour': 2100, 'parts': 400, 'visit_fee': 200},
          expiresAt: DateTime.now().add(const Duration(minutes: 8)),
        ),
      ];
}
