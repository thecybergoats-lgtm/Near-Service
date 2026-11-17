import 'dart:convert';

/// Data models mirroring the backend API contract (PRD pp.24–25).
/// All `fromJson` parsers are defensive: missing fields fall back to sane
/// defaults instead of crashing, because the backend is built in parallel.

class AppUser {
  final String id;
  final String phone;
  final String? fullName;
  final String language;
  final List<String> roles;
  final DateTime? createdAt;

  const AppUser({
    required this.id,
    required this.phone,
    this.fullName,
    this.language = 'ur',
    this.roles = const ['customer'],
    this.createdAt,
  });

  factory AppUser.fromJson(Map<String, dynamic> j) => AppUser(
        id: (j['id'] ?? '').toString(),
        phone: (j['phone'] ?? '').toString(),
        fullName: j['full_name'] as String? ?? j['fullName'] as String?,
        language: (j['language'] as String?) ?? 'ur',
        roles: (j['roles'] as List?)?.map((e) => e.toString()).toList() ??
            const ['customer'],
        createdAt: j['created_at'] == null
            ? null
            : DateTime.tryParse(j['created_at'].toString()),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'phone': phone,
        'full_name': fullName,
        'language': language,
        'roles': roles,
        if (createdAt != null) 'created_at': createdAt!.toIso8601String(),
      };
}

/// One real-world shop from OpenStreetMap (GET /places/nearby). NOT a
/// registered Near Service provider — shown on the map as an amber pin
/// with a Directions button instead of a quote flow.
class PlaceShop {
  final String name;
  final double lat;
  final double lng;
  final double distanceKm;
  final String? shop;
  final String? craft;

  const PlaceShop({
    required this.name,
    required this.lat,
    required this.lng,
    required this.distanceKm,
    this.shop,
    this.craft,
  });

  factory PlaceShop.fromJson(Map<String, dynamic> j) => PlaceShop(
        name: (j['name'] as String?)?.trim().isNotEmpty == true
            ? (j['name'] as String)
            : 'Unnamed shop',
        lat: (j['lat'] as num?)?.toDouble() ?? 0,
        lng: (j['lng'] as num?)?.toDouble() ?? 0,
        distanceKm: (j['distance_km'] as num?)?.toDouble() ?? 0,
        shop: (j['tags'] as Map?)?['shop'] as String?,
        craft: (j['tags'] as Map?)?['craft'] as String?,
      );

  /// Short human label for the shop kind, e.g. "Stationery" / "Books".
  String get kindLabel {
    final raw = shop ?? craft ?? '';
    if (raw.isEmpty) return 'Shop';
    return raw.replaceAll('_', ' ').split(' ').map((w) =>
        w.isEmpty ? w : w[0].toUpperCase() + w.substring(1)).join(' ');
  }
}

/// GET /me/profiles response (OpenAPI): {customer: bool, provider:
/// ProviderCard | null} — the two profiles held by ONE account
/// (PRD v1.1). The wallet is likewise single per account; the profiles
/// are views over it, not separate wallets.
class MyProfiles {
  final bool customer;
  final ServiceProvider? provider;

  const MyProfiles({required this.customer, this.provider});

  factory MyProfiles.fromJson(Map<String, dynamic> j) => MyProfiles(
        customer: (j['customer'] as bool?) ?? false,
        provider: j['provider'] == null
            ? null
            : ServiceProvider.fromJson(j['provider'] as Map<String, dynamic>),
      );
}

/// Saved address (GET/POST /me/addresses, OpenAPI Address / AddressInput).
class Address {
  final String id;
  final String label; // home | work | other
  final String? addressText;
  final double lat;
  final double lng;

  const Address({
    required this.id,
    required this.label,
    this.addressText,
    this.lat = 0,
    this.lng = 0,
  });

  factory Address.fromJson(Map<String, dynamic> j) => Address(
        id: (j['id'] ?? '').toString(),
        label: (j['label'] ?? 'home').toString(),
        addressText: j['address_text'] as String?,
        lat: (j['lat'] as num?)?.toDouble() ?? 0,
        lng: (j['lng'] as num?)?.toDouble() ?? 0,
      );
}

class Category {
  final String id;
  final String slug;
  final String nameEn;
  final String nameUr;
  final String nameRoman;
  final String iconKey;
  final List<Category> children;

  const Category({
    required this.id,
    required this.slug,
    required this.nameEn,
    this.nameUr = '',
    this.nameRoman = '',
    this.iconKey = 'build',
    this.children = const [],
  });

  factory Category.fromJson(Map<String, dynamic> j) => Category(
        id: (j['id'] ?? j['slug'] ?? '').toString(),
        slug: (j['slug'] ?? '').toString(),
        nameEn: (j['name_en'] ?? j['nameEn'] ?? j['name'] ?? '').toString(),
        nameUr: (j['name_ur'] ?? j['nameUr'] ?? '').toString(),
        nameRoman: (j['name_roman'] ?? j['nameRoman'] ?? '').toString(),
        iconKey: (j['icon_key'] ?? j['iconKey'] ?? 'build').toString(),
        children: (j['children'] as List?)
                ?.map((e) => Category.fromJson(e as Map<String, dynamic>))
                .toList() ??
            const [],
      );

  String displayName(String locale) {
    if (locale == 'ur' && nameUr.isNotEmpty) return nameUr;
    if (locale == 'ur-roman' && nameRoman.isNotEmpty) return nameRoman;
    return nameEn;
  }
}

class ServiceProvider {
  final String id;
  final String displayName;
  final String? shopName;
  final String type; // SHOP | INDIVIDUAL
  final int tier; // 0..3
  final double rating;
  final int ratingCount;
  final int jobsCompleted;
  final double distanceKm;
  final int etaMinutes;
  final bool isOpen;
  final bool isOnline;
  final int startingPrice;
  final int responseSecondsAvg;
  final List<String> languages;
  final double lat;
  final double lng;
  final String? photoUrl;
  final String? bio;

  const ServiceProvider({
    required this.id,
    required this.displayName,
    this.shopName,
    this.type = 'INDIVIDUAL',
    this.tier = 0,
    this.rating = 0,
    this.ratingCount = 0,
    this.jobsCompleted = 0,
    this.distanceKm = 0,
    this.etaMinutes = 0,
    this.isOpen = true,
    this.isOnline = true,
    this.startingPrice = 0,
    this.responseSecondsAvg = 0,
    this.languages = const ['Urdu'],
    this.lat = 0,
    this.lng = 0,
    this.photoUrl,
    this.bio,
  });

  factory ServiceProvider.fromJson(Map<String, dynamic> j) {
    double numD(dynamic v) => (v as num?)?.toDouble() ?? 0;
    return ServiceProvider(
      id: (j['id'] ?? '').toString(),
      displayName: (j['display_name'] ?? j['displayName'] ?? '').toString(),
      shopName: j['shop_name'] as String? ?? j['shopName'] as String?,
      type: (j['provider_type'] ?? j['type'] ?? 'INDIVIDUAL').toString(),
      tier: (j['tier'] as num?)?.toInt() ?? 0,
      rating: numD(j['rating_avg'] ?? j['rating']),
      ratingCount: (j['rating_count'] as num?)?.toInt() ?? 0,
      jobsCompleted: (j['jobs_completed'] as num?)?.toInt() ?? 0,
      distanceKm: numD(j['distance_km'] ?? j['distanceKm']),
      etaMinutes: (j['eta_minutes'] as num?)?.toInt() ?? 0,
      isOpen: (j['is_open'] ?? j['isOpen'] ?? true) as bool,
      isOnline: (j['is_online'] ?? j['isOnline'] ?? true) as bool,
      startingPrice: (j['starting_price'] as num?)?.toInt() ?? 0,
      responseSecondsAvg:
          (j['response_seconds_avg'] as num?)?.toInt() ?? 0,
      languages: (j['languages'] as List?)
              ?.map((e) => e.toString())
              .toList() ??
          const ['Urdu'],
      lat: numD(j['lat'] ?? j['latitude']),
      lng: numD(j['lng'] ?? j['longitude']),
      photoUrl: j['photo_url'] as String?,
      bio: j['bio'] as String?,
    );
  }

  String get name => shopName ?? displayName;
  String get tierLabel =>
      ['Unverified', 'ID Verified', 'Verified', 'Trusted Pro'][tier.clamp(0, 3)];
  bool get isShop => type == 'SHOP';

  /// Batch 2 favourites shape from GET /favourites (backend
  /// FavouritesService.list): {provider_id, display_name,
  /// provider_type, rating_bayes, jobs_completed, favourited_at}.
  /// Slim on purpose — no lat/lng, distance or price — so those
  /// default to 0 and the card shows name, rating and jobs only.
  factory ServiceProvider.fromFavouriteJson(Map<String, dynamic> j) =>
      ServiceProvider(
        id: (j['provider_id'] ?? j['id'] ?? '').toString(),
        displayName: (j['display_name'] ?? j['displayName'] ?? '').toString(),
        type: (j['provider_type'] ?? j['type'] ?? 'INDIVIDUAL').toString(),
        rating: ((j['rating_bayes'] ?? j['rating_avg'] ?? j['rating']) as num?)
                ?.toDouble() ??
            0,
        jobsCompleted: (j['jobs_completed'] as num?)?.toInt() ?? 0,
      );
}

class Offer {
  final String id;
  final String requestId;
  final String providerId;
  final String providerName;
  final double providerRating;
  final double providerDistanceKm;
  final int price;
  final int? etaMinutes;
  final String? note;
  final Map<String, int> breakdown; // labour / parts / visit_fee
  final int round;
  final String offeredBy; // provider | customer
  final String status; // pending | accepted | rejected | countered | expired | closed
  final DateTime? expiresAt;

  const Offer({
    required this.id,
    required this.requestId,
    required this.providerId,
    required this.providerName,
    this.providerRating = 0,
    this.providerDistanceKm = 0,
    required this.price,
    this.etaMinutes,
    this.note,
    this.breakdown = const {},
    this.round = 1,
    this.offeredBy = 'provider',
    this.status = 'pending',
    this.expiresAt,
  });

  factory Offer.fromJson(Map<String, dynamic> j) {
    final p = j['provider'] as Map<String, dynamic>?;
    final bd = j['breakdown'] as Map<String, dynamic>?;
    return Offer(
      id: (j['id'] ?? '').toString(),
      requestId: (j['request_id'] ?? j['requestId'] ?? '').toString(),
      providerId: (j['provider_id'] ?? j['providerId'] ?? p?['id'] ?? '').toString(),
      providerName: (p?['display_name'] ?? p?['shop_name'] ?? j['provider_name'] ?? 'Provider').toString(),
      providerRating: ((p?['rating_avg'] ?? j['provider_rating']) as num?)?.toDouble() ?? 0,
      providerDistanceKm: ((p?['distance_km'] ?? j['provider_distance_km']) as num?)?.toDouble() ?? 0,
      price: (j['price'] as num?)?.toInt() ?? 0,
      etaMinutes: (j['eta_minutes'] as num?)?.toInt(),
      note: j['note'] as String?,
      breakdown: bd == null
          ? const {}
          : bd.map((k, v) => MapEntry(k, (v as num).toInt())),
      round: (j['round'] as num?)?.toInt() ?? 1,
      offeredBy: (j['offered_by'] ?? 'provider').toString(),
      status: (j['status'] ?? 'pending').toString(),
      expiresAt: j['expires_at'] == null
          ? null
          : DateTime.tryParse(j['expires_at'].toString()),
    );
  }
}

class ServiceRequest {
  final String id;
  final String categoryId;
  final String description;
  final String fulfillment; // VISIT_SHOP | PROVIDER_COMES | PICKUP_DELIVERY
  final int? customerOffer;
  final String status;
  final DateTime? expiresAt;

  const ServiceRequest({
    required this.id,
    required this.categoryId,
    required this.description,
    this.fulfillment = 'PROVIDER_COMES',
    this.customerOffer,
    this.status = 'DRAFT',
    this.expiresAt,
  });

  factory ServiceRequest.fromJson(Map<String, dynamic> j) => ServiceRequest(
        id: (j['id'] ?? '').toString(),
        categoryId: (j['category_id'] ?? '').toString(),
        description: (j['description'] ?? '').toString(),
        fulfillment: (j['fulfillment'] ?? 'PROVIDER_COMES').toString(),
        customerOffer: (j['customer_offer'] as num?)?.toInt(),
        status: (j['status'] ?? 'DRAFT').toString(),
        expiresAt: j['expires_at'] == null
            ? null
            : DateTime.tryParse(j['expires_at'].toString()),
      );
}

class Job {
  final String id;
  final String requestId;
  final String state;
  final int agreedPrice;
  final String paymentMethod;
  final String paymentStatus;
  final String providerName;
  final String providerId;
  final String customerName;
  final String categoryName;
  final DateTime? createdAt;
  final DateTime? scheduledAt;
  final DateTime? completionConfirmedAt;

  const Job({
    required this.id,
    required this.requestId,
    required this.state,
    required this.agreedPrice,
    this.paymentMethod = 'cash',
    this.paymentStatus = 'unpaid',
    this.providerName = '',
    this.providerId = '',
    this.customerName = '',
    this.categoryName = '',
    this.createdAt,
    this.scheduledAt,
    this.completionConfirmedAt,
  });

  factory Job.fromJson(Map<String, dynamic> j) {
    final p = j['provider'] as Map<String, dynamic>?;
    final c = j['customer'] as Map<String, dynamic>?;
    final cat = j['category'] as Map<String, dynamic>?;
    return Job(
      id: (j['id'] ?? '').toString(),
      requestId: (j['request_id'] ?? '').toString(),
      state: (j['state'] ?? 'ACCEPTED').toString(),
      agreedPrice: (j['agreed_price'] as num?)?.toInt() ?? 0,
      paymentMethod: (j['payment_method'] ?? 'cash').toString(),
      paymentStatus: (j['payment_status'] ?? 'unpaid').toString(),
      providerName: (p?['display_name'] ?? p?['shop_name'] ?? j['provider_name'] ?? '').toString(),
      providerId: (j['provider_id'] ?? p?['id'] ?? '').toString(),
      customerName: (c?['full_name'] ?? j['customer_name'] ?? '').toString(),
      categoryName: (cat?['name_en'] ?? cat?['name'] ?? j['category_name'] ?? '').toString(),
      createdAt: j['created_at'] == null
          ? null
          : DateTime.tryParse(j['created_at'].toString()),
      scheduledAt: j['scheduled_at'] == null
          ? null
          : DateTime.tryParse(j['scheduled_at'].toString()),
      completionConfirmedAt: j['completion_confirmed_at'] == null
          ? null
          : DateTime.tryParse(j['completion_confirmed_at'].toString()),
    );
  }
}

/// ---- Batch 2 models -----------------------------------------------------
/// GET /promotions/active item (public). The home banner shows ONLY
/// items returned by this endpoint — never hardcoded promo text.
class PromoItem {
  final String code;
  final String title;
  final String discountText;

  const PromoItem({required this.code, required this.title, this.discountText = ''});

  factory PromoItem.fromJson(Map<String, dynamic> j) => PromoItem(
        code: (j['code'] ?? '').toString(),
        title: (j['title'] ?? '').toString(),
        discountText: (j['discount_text'] ?? j['discountText'] ?? '').toString(),
      );
}

/// One public provider review (GET /providers/:id/reviews).
/// `photos` are storage keys or URLs as returned by the backend; the
/// UI shows a network image only for http(s) values and a photo chip
/// otherwise (a bare storage key is not a fetchable URL).
class ProviderReview {
  final String id;
  final String reviewerName;
  final int stars;
  final String comment;
  final List<String> tags;
  final List<String> photos;
  final DateTime? createdAt;

  const ProviderReview({
    this.id = '',
    this.reviewerName = '',
    this.stars = 5,
    this.comment = '',
    this.tags = const [],
    this.photos = const [],
    this.createdAt,
  });

  factory ProviderReview.fromJson(Map<String, dynamic> j) => ProviderReview(
        id: (j['id'] ?? '').toString(),
        reviewerName: (j['reviewer_name'] ?? j['reviewerName'] ?? '').toString(),
        stars: (j['stars'] as num?)?.toInt() ?? 5,
        comment: (j['comment'] ?? '').toString(),
        tags: (j['tags'] as List?)?.map((e) => e.toString()).toList() ?? const [],
        photos: (j['photos'] as List?)?.map((e) => e.toString()).toList() ?? const [],
        createdAt: j['created_at'] == null
            ? null
            : DateTime.tryParse(j['created_at'].toString()),
      );

  bool get hasPhotos => photos.isNotEmpty;
}

/// A Live Support thread (POST/GET /support/threads).
class SupportThread {
  final String id;
  final String subject;
  final String status; // open | pending | resolved | closed
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const SupportThread({
    required this.id,
    this.subject = '',
    this.status = 'open',
    this.createdAt,
    this.updatedAt,
  });

  factory SupportThread.fromJson(Map<String, dynamic> j) => SupportThread(
        id: (j['id'] ?? '').toString(),
        subject: (j['subject'] ?? '').toString(),
        status: (j['status'] ?? 'open').toString(),
        createdAt: j['created_at'] == null
            ? null
            : DateTime.tryParse(j['created_at'].toString()),
        updatedAt: j['updated_at'] == null
            ? null
            : DateTime.tryParse(j['updated_at'].toString()),
      );

  bool get isOpen => status == 'open' || status == 'pending';
}

/// One message in a support thread.
class SupportMessage {
  final String id;
  final String senderRole; // customer | support | admin | agent
  final String body;
  final DateTime? createdAt;

  const SupportMessage({
    this.id = '',
    this.senderRole = 'customer',
    this.body = '',
    this.createdAt,
  });

  factory SupportMessage.fromJson(Map<String, dynamic> j) {
    final sender = (j['sender_role'] ?? j['sender_type'] ?? j['role'] ?? 'customer').toString();
    return SupportMessage(
      id: (j['id'] ?? '').toString(),
      senderRole: sender,
      body: (j['message'] ?? j['body'] ?? '').toString(),
      createdAt: j['created_at'] == null
          ? null
          : DateTime.tryParse(j['created_at'].toString()),
    );
  }

  bool get isFromSupport => senderRole != 'customer';
}

/// Ordered job states (PRD p.8 state machine).
const List<String> jobStates = [
  'ACCEPTED',
  'PROVIDER_EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'PAYMENT_SETTLED',
  'RATED',
];

class ChatMessage {
  final String id;
  final String chatId;
  final String senderId;
  final String body;
  final String kind;
  final DateTime createdAt;
  final bool isMine;

  const ChatMessage({
    required this.id,
    required this.chatId,
    required this.senderId,
    required this.body,
    this.kind = 'text',
    required this.createdAt,
    this.isMine = false,
  });

  factory ChatMessage.fromJson(Map<String, dynamic> j, String myId) =>
      ChatMessage(
        id: (j['id'] ?? '').toString(),
        chatId: (j['chat_id'] ?? '').toString(),
        senderId: (j['sender_id'] ?? '').toString(),
        body: (j['body'] ?? '').toString(),
        kind: (j['kind'] ?? 'text').toString(),
        createdAt: DateTime.tryParse(j['created_at']?.toString() ?? '') ??
            DateTime.now(),
        isMine: (j['sender_id']?.toString() ?? '') == myId,
      );
}

/// GET /wallet (Phase 2): {balance_paisa, balance_pkr, escrow_held_paisa,
/// currency: 'PKR', profile_views: {customer: {...}, provider: {...}}}.
/// One wallet per account; the two profile views are views over the SAME
/// balance, not separate wallets. The Phase 1 `ledger` field is kept for
/// backwards compatibility but the transaction list now comes from
/// GET /wallet/transactions.
class WalletInfo {
  final int balancePaisa;
  final int escrowHeldPaisa;
  final List<Map<String, dynamic>> ledger;
  final int? balancePkrRaw;
  final String currency;
  final WalletProfileView? customerView;
  final WalletProfileView? providerView;

  const WalletInfo({
    this.balancePaisa = 0,
    this.escrowHeldPaisa = 0,
    this.ledger = const [],
    this.balancePkrRaw,
    this.currency = 'PKR',
    this.customerView,
    this.providerView,
  });

  factory WalletInfo.fromJson(Map<String, dynamic> j) {
    final views = j['profile_views'] as Map<String, dynamic>?;
    return WalletInfo(
      balancePaisa: (j['balance_paisa'] as num?)?.toInt() ?? 0,
      escrowHeldPaisa: (j['escrow_held_paisa'] as num?)?.toInt() ?? 0,
      ledger: (j['ledger'] as List?)?.cast<Map<String, dynamic>>() ?? const [],
      balancePkrRaw: (j['balance_pkr'] as num?)?.toInt(),
      currency: (j['currency'] ?? 'PKR').toString(),
      customerView: views?['customer'] == null
          ? null
          : WalletProfileView.fromJson(views!['customer'] as Map<String, dynamic>),
      providerView: views?['provider'] == null
          ? null
          : WalletProfileView.fromJson(views!['provider'] as Map<String, dynamic>),
    );
  }

  int get balancePkr => balancePkrRaw ?? balancePaisa ~/ 100;

  /// Commission the provider owes on cash jobs (0 for pure customers).
  int get commissionOwedPkr => providerView?.commissionOwedPkr ?? 0;

  /// Negative balance means commission owed exceeds the balance.
  bool get isNegative => balancePkr < 0;
}

/// One profile's view over the single shared wallet.
class WalletProfileView {
  final int balancePkr;
  final int spentPkr;
  final int pendingPkr;
  final int earningsPkr;
  final int commissionOwedPkr;

  const WalletProfileView({
    this.balancePkr = 0,
    this.spentPkr = 0,
    this.pendingPkr = 0,
    this.earningsPkr = 0,
    this.commissionOwedPkr = 0,
  });

  factory WalletProfileView.fromJson(Map<String, dynamic> j) =>
      WalletProfileView(
        balancePkr: (j['balance_pkr'] as num?)?.toInt() ?? 0,
        spentPkr: (j['spent_pkr'] as num?)?.toInt() ?? 0,
        pendingPkr: (j['pending_pkr'] as num?)?.toInt() ?? 0,
        earningsPkr: (j['earnings_pkr'] as num?)?.toInt() ?? 0,
        commissionOwedPkr: (j['commission_owed_pkr'] as num?)?.toInt() ?? 0,
      );
}

/// One row of GET /wallet/transactions.
class WalletTransaction {
  final String id;
  final String txnId;
  final String accountCode;
  final String direction; // credit | debit
  final int amountPaisa;
  final String? jobId;
  final String memo;
  final DateTime? createdAt;

  const WalletTransaction({
    required this.id,
    this.txnId = '',
    this.accountCode = '',
    this.direction = 'credit',
    this.amountPaisa = 0,
    this.jobId,
    this.memo = '',
    this.createdAt,
  });

  factory WalletTransaction.fromJson(Map<String, dynamic> j) =>
      WalletTransaction(
        id: (j['id'] ?? '').toString(),
        txnId: (j['txn_id'] ?? '').toString(),
        accountCode: (j['account_code'] ?? '').toString(),
        direction: (j['direction'] ?? 'credit').toString(),
        amountPaisa: (j['amount_paisa'] as num?)?.toInt() ?? 0,
        jobId: j['job_id'] as String?,
        memo: (j['memo'] ?? '').toString(),
        createdAt: j['created_at'] == null
            ? null
            : DateTime.tryParse(j['created_at'].toString()),
      );

  int get amountPkr => amountPaisa ~/ 100;
  bool get isCredit => direction == 'credit';
}

/// POST /promos/validate response.
class PromoValidation {
  final bool valid;
  final String kind; // e.g. percent | fixed | first_job
  final num value;
  final int discountPaisa;
  final String? reason;

  const PromoValidation({
    required this.valid,
    this.kind = '',
    this.value = 0,
    this.discountPaisa = 0,
    this.reason,
  });

  factory PromoValidation.fromJson(Map<String, dynamic> j) =>
      PromoValidation(
        valid: (j['valid'] as bool?) ?? false,
        kind: (j['kind'] ?? '').toString(),
        value: (j['value'] as num?) ?? 0,
        discountPaisa: (j['discount_paisa'] as num?)?.toInt() ?? 0,
        reason: j['reason'] as String?,
      );

  int get discountPkr => discountPaisa ~/ 100;
}

/// One entry of GET /payments/methods.
class PaymentMethodInfo {
  final String id; // cash | wallet | jazzcash | easypaisa
  final bool sandbox;

  const PaymentMethodInfo({required this.id, this.sandbox = false});

  factory PaymentMethodInfo.fromJson(Map<String, dynamic> j) =>
      PaymentMethodInfo(
        id: (j['id'] ?? '').toString(),
        sandbox: (j['sandbox'] as bool?) ?? false,
      );

  bool get isSandbox => sandbox;
  bool get isWallet => id == 'wallet';
  bool get isCash => id == 'cash';
}

/// GET /referrals/me response.
class ReferralInfo {
  final String code;
  final int referredCount;
  final int creditPaisa;
  final int pendingCount;

  const ReferralInfo({
    this.code = '',
    this.referredCount = 0,
    this.creditPaisa = 0,
    this.pendingCount = 0,
  });

  factory ReferralInfo.fromJson(Map<String, dynamic> j) => ReferralInfo(
        code: (j['code'] ?? '').toString(),
        referredCount: (j['referred_count'] as num?)?.toInt() ?? 0,
        creditPaisa: (j['credit_paisa'] as num?)?.toInt() ?? 0,
        pendingCount: (j['pending_count'] as num?)?.toInt() ?? 0,
      );

  int get creditPkr => creditPaisa ~/ 100;
}

/// GET /jobs/{id}/tracking response.
class JobTracking {
  final String jobId;
  final String state;
  final double? providerLat;
  final double? providerLng;
  final DateTime? providerUpdatedAt;
  final double? distanceKm;
  final int? etaMinutes;
  final List<TrailPoint> trail;

  const JobTracking({
    required this.jobId,
    this.state = '',
    this.providerLat,
    this.providerLng,
    this.providerUpdatedAt,
    this.distanceKm,
    this.etaMinutes,
    this.trail = const [],
  });

  factory JobTracking.fromJson(Map<String, dynamic> j) {
    final p = j['provider'] as Map<String, dynamic>?;
    final trailJson = (j['trail'] as List?) ?? const [];
    return JobTracking(
      jobId: (j['job_id'] ?? '').toString(),
      state: (j['state'] ?? '').toString(),
      providerLat: (p?['lat'] as num?)?.toDouble(),
      providerLng: (p?['lng'] as num?)?.toDouble(),
      providerUpdatedAt: p?['updated_at'] == null
          ? null
          : DateTime.tryParse(p!['updated_at'].toString()),
      distanceKm: (j['distance_km'] as num?)?.toDouble(),
      etaMinutes: (j['eta_minutes'] as num?)?.toInt(),
      trail: trailJson
          .map((e) => TrailPoint.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  bool get hasProviderLocation => providerLat != null && providerLng != null;
}

class TrailPoint {
  final double lat;
  final double lng;
  final DateTime? at;

  const TrailPoint({required this.lat, required this.lng, this.at});

  factory TrailPoint.fromJson(Map<String, dynamic> j) => TrailPoint(
        lat: (j['lat'] as num?)?.toDouble() ?? 0,
        lng: (j['lng'] as num?)?.toDouble() ?? 0,
        at: j['at'] == null ? null : DateTime.tryParse(j['at'].toString()),
      );
}

/// One dispute from GET /disputes (and POST /jobs/{id}/disputes).
class Dispute {
  final String id;
  final String jobId;
  final String reasonCode;
  final String description;
  final String status; // open | under_review | resolved | rejected
  final String? resolution;
  final String? slaDueAt;
  final DateTime? createdAt;

  const Dispute({
    required this.id,
    required this.jobId,
    this.reasonCode = '',
    this.description = '',
    this.status = 'open',
    this.resolution,
    this.slaDueAt,
    this.createdAt,
  });

  factory Dispute.fromJson(Map<String, dynamic> j) => Dispute(
        id: (j['id'] ?? '').toString(),
        jobId: (j['job_id'] ?? '').toString(),
        reasonCode: (j['reason_code'] ?? '').toString(),
        description: (j['description'] ?? '').toString(),
        status: (j['status'] ?? 'open').toString(),
        resolution: j['resolution'] as String? ?? j['outcome'] as String?,
        slaDueAt: j['sla_due_at'] as String? ?? j['sla_due'] as String?,
        createdAt: j['created_at'] == null
            ? null
            : DateTime.tryParse(j['created_at'].toString()),
      );

  bool get isResolved => status == 'resolved' || status == 'rejected';
}

/// One recurring job (GET /recurring-jobs).
class RecurringJob {
  final String id;
  final String categoryId;
  final String frequency; // weekly | monthly
  final int? dayOfWeek;
  final int? dayOfMonth;
  final String status; // active | paused | cancelled
  final DateTime? startsAt;
  final DateTime? endsAt;
  final DateTime? nextRunAt;

  const RecurringJob({
    required this.id,
    this.categoryId = '',
    this.frequency = 'weekly',
    this.dayOfWeek,
    this.dayOfMonth,
    this.status = 'active',
    this.startsAt,
    this.endsAt,
    this.nextRunAt,
  });

  factory RecurringJob.fromJson(Map<String, dynamic> j) => RecurringJob(
        id: (j['id'] ?? '').toString(),
        categoryId: (j['category_id'] ?? '').toString(),
        frequency: (j['frequency'] ?? 'weekly').toString(),
        dayOfWeek: (j['day_of_week'] as num?)?.toInt(),
        dayOfMonth: (j['day_of_month'] as num?)?.toInt(),
        status: (j['status'] ?? 'active').toString(),
        startsAt: j['starts_at'] == null
            ? null
            : DateTime.tryParse(j['starts_at'].toString()),
        endsAt: j['ends_at'] == null
            ? null
            : DateTime.tryParse(j['ends_at'].toString()),
        nextRunAt: j['next_run_at'] == null
            ? null
            : DateTime.tryParse(j['next_run_at'].toString()),
      );
}

/// ---- FIX 10 models ------------------------------------------------------
/// POST /me/devices response (Device schema, OpenAPI v1.2).
class DeviceInfo {
  final String id;
  final String deviceFingerprint;
  final String platform; // android | ios | web
  final DateTime? lastSeenAt;
  final DateTime? createdAt;

  const DeviceInfo({
    required this.id,
    this.deviceFingerprint = '',
    this.platform = 'android',
    this.lastSeenAt,
    this.createdAt,
  });

  factory DeviceInfo.fromJson(Map<String, dynamic> j) => DeviceInfo(
        id: (j['id'] ?? '').toString(),
        deviceFingerprint: (j['device_fingerprint'] ?? '').toString(),
        platform: (j['platform'] ?? 'android').toString(),
        lastSeenAt: j['last_seen_at'] == null
            ? null
            : DateTime.tryParse(j['last_seen_at'].toString()),
        createdAt: j['created_at'] == null
            ? null
            : DateTime.tryParse(j['created_at'].toString()),
      );
}

/// One trusted contact (GET/POST /me/trusted-contacts, max 5).
class TrustedContact {
  final String id;
  final String name;
  final String phone; // +92XXXXXXXXXX
  final String? relation;
  final DateTime? createdAt;

  const TrustedContact({
    required this.id,
    required this.name,
    required this.phone,
    this.relation,
    this.createdAt,
  });

  factory TrustedContact.fromJson(Map<String, dynamic> j) => TrustedContact(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        phone: (j['phone'] ?? '').toString(),
        relation: j['relation'] as String?,
        createdAt: j['created_at'] == null
            ? null
            : DateTime.tryParse(j['created_at'].toString()),
      );

  /// Backend phone rule: ^\+92\d{10}$ (TrustedContactDto).
  static bool isValidPhone(String phone) =>
      RegExp(r'^\+92\d{10}$').hasMatch(phone.trim());
}

/// One category the provider offers (GET/PUT /providers/me/services).
class ProviderService {
  final String categoryId; // UUID when known, '' otherwise
  final String slug;
  final String nameEn;
  final int? startingPrice; // PKR, must be > 0 when set
  final bool isActive;

  const ProviderService({
    this.categoryId = '',
    required this.slug,
    this.nameEn = '',
    this.startingPrice,
    this.isActive = true,
  });

  factory ProviderService.fromJson(Map<String, dynamic> j) =>
      ProviderService(
        categoryId: (j['category_id'] ?? '').toString(),
        slug: (j['slug'] ?? j['category_slug'] ?? '').toString(),
        nameEn: (j['name_en'] ?? j['name'] ?? '').toString(),
        startingPrice: (j['starting_price'] as num?)?.toInt(),
        isActive: (j['is_active'] as bool?) ?? true,
      );

  /// ProviderServiceInput: category_id (UUID) OR category_slug — send
  /// whichever the entry actually has, never both with different values.
  Map<String, dynamic> toUpdateJson() => {
        if (categoryId.isNotEmpty) 'category_id': categoryId,
        if (categoryId.isEmpty && slug.isNotEmpty) 'category_slug': slug,
        if (startingPrice != null) 'starting_price': startingPrice,
        'is_active': isActive,
      };

  ProviderService copyWith({int? startingPrice, bool? isActive}) =>
      ProviderService(
        categoryId: categoryId,
        slug: slug,
        nameEn: nameEn,
        startingPrice: startingPrice ?? this.startingPrice,
        isActive: isActive ?? this.isActive,
      );
}

/// Provider service area (PUT /providers/me/service-area response).
class ServiceArea {
  final double? centerLat;
  final double? centerLng;
  final double? radiusKm;
  final Map<String, dynamic>? polygon;
  final DateTime? updatedAt;

  const ServiceArea({
    this.centerLat,
    this.centerLng,
    this.radiusKm,
    this.polygon,
    this.updatedAt,
  });

  factory ServiceArea.fromJson(Map<String, dynamic> j) {
    final center = j['center'] as Map<String, dynamic>?;
    return ServiceArea(
      centerLat: (center?['lat'] as num?)?.toDouble(),
      centerLng: (center?['lng'] as num?)?.toDouble(),
      radiusKm: (j['radius_km'] as num?)?.toDouble(),
      polygon: j['polygon'] as Map<String, dynamic>?,
      updatedAt: j['updated_at'] == null
          ? null
          : DateTime.tryParse(j['updated_at'].toString()),
    );
  }

  bool get isRadius =>
      centerLat != null && centerLng != null && radiusKm != null;
}

/// One weekly working-hours slot (PUT /providers/me/availability).
/// weekday: 0 = Monday … 6 = Sunday (OpenAPI AvailabilitySlot).
class AvailabilitySlot {
  final int weekday;
  final String? opens; // HH:MM, null when day off
  final String? closes; // HH:MM, null when day off
  final bool isDayOff;

  const AvailabilitySlot({
    required this.weekday,
    this.opens,
    this.closes,
    this.isDayOff = false,
  });

  factory AvailabilitySlot.fromJson(Map<String, dynamic> j) =>
      AvailabilitySlot(
        weekday: (j['weekday'] as num?)?.toInt() ?? 0,
        opens: j['opens'] as String?,
        closes: j['closes'] as String?,
        isDayOff: (j['is_day_off'] as bool?) ?? false,
      );

  Map<String, dynamic> toJson() => {
        'weekday': weekday,
        'opens': isDayOff ? null : opens,
        'closes': isDayOff ? null : closes,
        'is_day_off': isDayOff,
      };

  static const weekdayNames = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ];

  String get weekdayName => weekdayNames[weekday.clamp(0, 6)];

  AvailabilitySlot copyWith({
    String? opens,
    String? closes,
    bool? isDayOff,
  }) =>
      AvailabilitySlot(
        weekday: weekday,
        opens: opens ?? this.opens,
        closes: closes ?? this.closes,
        isDayOff: isDayOff ?? this.isDayOff,
      );
}

/// One itemised line of a job price adjustment (OpenAPI Adjustment).
/// photo_key is a storage key only — there is no adjustment-photo
/// upload endpoint in Phase 2, so it is never faked as an upload.
class AdjustmentItem {
  final String label;
  final int amount; // PKR, > 0
  final String? photoKey;

  const AdjustmentItem({
    required this.label,
    required this.amount,
    this.photoKey,
  });

  factory AdjustmentItem.fromJson(Map<String, dynamic> j) => AdjustmentItem(
        label: (j['label'] ?? '').toString(),
        amount: (j['amount'] as num?)?.toInt() ?? 0,
        photoKey: j['photo_key'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'label': label,
        'amount': amount,
        if (photoKey != null && photoKey!.isNotEmpty) 'photo_key': photoKey,
      };
}

/// A price adjustment on a job (POST /jobs/{id}/adjustments response:
/// the job_price_adjustments row — id, job_id, items, reason,
/// added_amount, status pending|approved|rejected).
class JobAdjustment {
  final String id;
  final String jobId;
  final List<AdjustmentItem> items;
  final String reason;
  final int addedAmount;
  final String status;

  const JobAdjustment({
    required this.id,
    this.jobId = '',
    this.items = const [],
    this.reason = '',
    this.addedAmount = 0,
    this.status = 'pending',
  });

  factory JobAdjustment.fromJson(Map<String, dynamic> j) {
    // items may arrive as a JSON array, or as a JSON-encoded string
    // (raw job_price_adjustments row from the DB).
    final raw = j['items'];
    // NOTE: intentionally not `final` — a final assigned inside try{}
    // cannot be assigned again in catch{} (analyzer: "might already be
    // assigned"); every path below assigns exactly once.
    List decodedItems;
    if (raw is String) {
      try {
        decodedItems = jsonDecode(raw) as List;
      } catch (_) {
        decodedItems = const [];
      }
    } else if (raw is List) {
      decodedItems = raw;
    } else {
      decodedItems = const [];
    }
    final items = decodedItems
        .whereType<Map<String, dynamic>>()
        .map(AdjustmentItem.fromJson)
        .toList();
    return JobAdjustment(
      id: (j['id'] ?? '').toString(),
      jobId: (j['job_id'] ?? '').toString(),
      items: items,
      reason: (j['reason'] ?? '').toString(),
      addedAmount: (j['added_amount'] as num?)?.toInt() ??
          items.fold<int>(0, (s, i) => s + i.amount),
      status: (j['status'] ?? 'pending').toString(),
    );
  }

  bool get isPending => status == 'pending';
}
