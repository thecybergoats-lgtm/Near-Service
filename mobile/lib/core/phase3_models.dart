/// Phase 3 (v1.5) data models mirroring the backend OpenAPI contract.
/// All `fromJson` parsers are defensive (missing fields fall back to sane
/// defaults), following the convention in core/models.dart.
///
/// Honesty notes, from the backend contract:
/// - AI photo search is a heuristic keyword match, NOT image recognition.
/// - Voice search has no STT on the local provider: audio-only fails with
///   422 STT_UNAVAILABLE; send a transcript from on-device recognition.
/// - Verification assists (face-match / liveness / OCR) are advisory only.
/// - Every payout carries sandbox: true — payouts are SANDBOX ONLY.

class AiIntent {
  final Map<String, dynamic>? service;
  final double confidence;
  final bool fallbackToKeywordSearch;
  final String? searchQuery;
  final String provider;

  const AiIntent({
    this.service,
    this.confidence = 0,
    this.fallbackToKeywordSearch = true,
    this.searchQuery,
    this.provider = 'local',
  });

  factory AiIntent.fromJson(Map<String, dynamic> j) => AiIntent(
        service: j['service'] as Map<String, dynamic>?,
        confidence: (j['confidence'] as num?)?.toDouble() ?? 0,
        fallbackToKeywordSearch:
            (j['fallbackToKeywordSearch'] as bool?) ?? true,
        searchQuery: j['searchQuery'] as String?,
        provider: (j['provider'] as String?) ?? 'local',
      );

  String get categorySlug =>
      (service?['category_slug'] as String?) ?? '';
  String get categoryName =>
      (service?['name_en'] as String?) ?? '';
}

class PhotoSuggestion {
  final String categoryId;
  final String categorySlug;
  final String nameEn;
  final double confidence;

  const PhotoSuggestion({
    required this.categoryId,
    required this.categorySlug,
    required this.nameEn,
    required this.confidence,
  });

  factory PhotoSuggestion.fromJson(Map<String, dynamic> j) =>
      PhotoSuggestion(
        categoryId: (j['categoryId'] ?? '').toString(),
        categorySlug: (j['categorySlug'] ?? '').toString(),
        nameEn: (j['nameEn'] ?? '').toString(),
        confidence: (j['confidence'] as num?)?.toDouble() ?? 0,
      );
}

class AiFairPrice {
  final String? categoryId;
  final double? min;
  final double? typical;
  final double? max;
  final int sampleSize;
  final String source;
  final bool hidden;

  const AiFairPrice({
    this.categoryId,
    this.min,
    this.typical,
    this.max,
    this.sampleSize = 0,
    this.source = 'empty',
    this.hidden = true,
  });

  factory AiFairPrice.fromJson(Map<String, dynamic> j) => AiFairPrice(
        categoryId: j['category_id'] as String?,
        min: (j['min'] as num?)?.toDouble(),
        typical: (j['typical'] as num?)?.toDouble(),
        max: (j['max'] as num?)?.toDouble(),
        sampleSize: (j['sample_size'] as num?)?.toInt() ?? 0,
        source: (j['source'] as String?) ?? 'empty',
        hidden: (j['hidden'] as bool?) ?? true,
      );
}

class TranslationPref {
  final String chatId;
  final String? targetLang;
  final bool autoTranslate;

  const TranslationPref({
    required this.chatId,
    this.targetLang,
    this.autoTranslate = false,
  });

  factory TranslationPref.fromJson(Map<String, dynamic> j) =>
      TranslationPref(
        chatId: (j['chat_id'] ?? '').toString(),
        targetLang: j['target_lang'] as String?,
        autoTranslate: (j['auto_translate'] as bool?) ?? false,
      );
}

class RiskScore {
  final String userId;
  final int score;
  final String level;
  final int reviewThreshold;
  final int blockThreshold;

  const RiskScore({
    required this.userId,
    this.score = 0,
    this.level = 'low',
    this.reviewThreshold = 60,
    this.blockThreshold = 85,
  });

  factory RiskScore.fromJson(Map<String, dynamic> j) => RiskScore(
        userId: (j['user_id'] ?? '').toString(),
        score: (j['score'] as num?)?.toInt() ?? 0,
        level: (j['level'] as String?) ?? 'low',
        reviewThreshold: (j['review_threshold'] as num?)?.toInt() ?? 60,
        blockThreshold: (j['block_threshold'] as num?)?.toInt() ?? 85,
      );
}

class SubscriptionPlan {
  final String id;
  final String code;
  final String name;
  final double pricePkr;
  final double commissionMultiplier;
  final int maxStaffAccounts;
  final bool featured;
  final bool analyticsEnabled;
  final bool isActive;

  const SubscriptionPlan({
    required this.id,
    required this.code,
    required this.name,
    this.pricePkr = 0,
    this.commissionMultiplier = 1,
    this.maxStaffAccounts = 0,
    this.featured = false,
    this.analyticsEnabled = false,
    this.isActive = true,
  });

  factory SubscriptionPlan.fromJson(Map<String, dynamic> j) =>
      SubscriptionPlan(
        id: (j['id'] ?? '').toString(),
        code: (j['code'] as String?) ?? 'free',
        name: (j['name'] as String?) ?? '',
        pricePkr: (j['price_pkr'] as num?)?.toDouble() ?? 0,
        commissionMultiplier:
            (j['commission_multiplier'] as num?)?.toDouble() ?? 1,
        maxStaffAccounts: (j['max_staff_accounts'] as num?)?.toInt() ?? 0,
        featured: (j['featured'] as bool?) ?? false,
        analyticsEnabled: (j['analytics_enabled'] as bool?) ?? false,
        isActive: (j['is_active'] as bool?) ?? true,
      );
}

class SubscriptionView {
  final String? id;
  final String providerId;
  final String planCode;
  final String planName;
  final double pricePkr;
  final double commissionMultiplier;
  final String status;

  const SubscriptionView({
    this.id,
    required this.providerId,
    required this.planCode,
    required this.planName,
    this.pricePkr = 0,
    this.commissionMultiplier = 1,
    this.status = 'none',
  });

  factory SubscriptionView.fromJson(Map<String, dynamic> j) =>
      SubscriptionView(
        id: j['id'] as String?,
        providerId: (j['provider_id'] ?? '').toString(),
        planCode: (j['plan_code'] as String?) ?? 'free',
        planName: (j['plan_name'] as String?) ?? '',
        pricePkr: (j['price_pkr'] as num?)?.toDouble() ?? 0,
        commissionMultiplier:
            (j['commission_multiplier'] as num?)?.toDouble() ?? 1,
        status: (j['status'] as String?) ?? 'none',
      );
}

class ProviderAnalytics {
  final int jobsTotal;
  final int jobsSettled;
  final double grossPkr;
  final double commissionPkr;
  final double netEarningsPkr;
  final double avgStars;
  final int reviewCount;

  const ProviderAnalytics({
    this.jobsTotal = 0,
    this.jobsSettled = 0,
    this.grossPkr = 0,
    this.commissionPkr = 0,
    this.netEarningsPkr = 0,
    this.avgStars = 0,
    this.reviewCount = 0,
  });

  factory ProviderAnalytics.fromJson(Map<String, dynamic> j) =>
      ProviderAnalytics(
        jobsTotal: (j['jobs_total'] as num?)?.toInt() ?? 0,
        jobsSettled: (j['jobs_settled'] as num?)?.toInt() ?? 0,
        grossPkr: (j['gross_pkr'] as num?)?.toDouble() ?? 0,
        commissionPkr: (j['commission_pkr'] as num?)?.toDouble() ?? 0,
        netEarningsPkr: (j['net_earnings_pkr'] as num?)?.toDouble() ?? 0,
        avgStars: (j['avg_stars'] as num?)?.toDouble() ?? 0,
        reviewCount: (j['review_count'] as num?)?.toInt() ?? 0,
      );
}

class Team {
  final String id;
  final String providerId;
  final String ownerUserId;
  final String name;
  final String? myRole;

  const Team({
    required this.id,
    required this.providerId,
    required this.ownerUserId,
    required this.name,
    this.myRole,
  });

  factory Team.fromJson(Map<String, dynamic> j) => Team(
        id: (j['id'] ?? '').toString(),
        providerId: (j['provider_id'] ?? '').toString(),
        ownerUserId: (j['owner_user_id'] ?? '').toString(),
        name: (j['name'] as String?) ?? '',
        myRole: j['my_role'] as String?,
      );
}

class TeamMember {
  final String id;
  final String teamId;
  final String userId;
  final String role;
  final String status;

  const TeamMember({
    required this.id,
    required this.teamId,
    required this.userId,
    required this.role,
    required this.status,
  });

  factory TeamMember.fromJson(Map<String, dynamic> j) => TeamMember(
        id: (j['id'] ?? '').toString(),
        teamId: (j['team_id'] ?? '').toString(),
        userId: (j['user_id'] ?? '').toString(),
        role: (j['role'] as String?) ?? 'worker',
        status: (j['status'] as String?) ?? 'invited',
      );
}

class TeamEarnings {
  final int jobsTotal;
  final int jobsSettled;
  final double grossPkr;
  final double commissionPkr;
  final double netEarningsPkr;

  const TeamEarnings({
    this.jobsTotal = 0,
    this.jobsSettled = 0,
    this.grossPkr = 0,
    this.commissionPkr = 0,
    this.netEarningsPkr = 0,
  });

  factory TeamEarnings.fromJson(Map<String, dynamic> j) => TeamEarnings(
        jobsTotal: (j['jobs_total'] as num?)?.toInt() ?? 0,
        jobsSettled: (j['jobs_settled'] as num?)?.toInt() ?? 0,
        grossPkr: (j['gross_pkr'] as num?)?.toDouble() ?? 0,
        commissionPkr: (j['commission_pkr'] as num?)?.toDouble() ?? 0,
        netEarningsPkr: (j['net_earnings_pkr'] as num?)?.toDouble() ?? 0,
      );
}

class Tender {
  final String id;
  final String title;
  final String organizationName;
  final String organizationType;
  final String? description;
  final String status;
  final String? deliveryDeadline;

  const Tender({
    required this.id,
    required this.title,
    required this.organizationName,
    required this.organizationType,
    this.description,
    required this.status,
    this.deliveryDeadline,
  });

  factory Tender.fromJson(Map<String, dynamic> j) => Tender(
        id: (j['id'] ?? '').toString(),
        title: (j['title'] as String?) ?? '',
        organizationName: (j['organization_name'] as String?) ?? '',
        organizationType: (j['organization_type'] as String?) ?? '',
        description: j['description'] as String?,
        status: (j['status'] as String?) ?? 'OPEN',
        deliveryDeadline: j['delivery_deadline'] as String?,
      );
}

class TenderQuote {
  final String id;
  final String tenderId;
  final String providerId;
  final double totalPrice;
  final String status;

  const TenderQuote({
    required this.id,
    required this.tenderId,
    required this.providerId,
    required this.totalPrice,
    required this.status,
  });

  factory TenderQuote.fromJson(Map<String, dynamic> j) => TenderQuote(
        id: (j['id'] ?? '').toString(),
        tenderId: (j['tender_id'] ?? '').toString(),
        providerId: (j['provider_id'] ?? '').toString(),
        totalPrice: (j['total_price'] as num?)?.toDouble() ?? 0,
        status: (j['status'] as String?) ?? 'submitted',
      );
}

class FaceMatchResult {
  final String id;
  final double? score;
  final String verdict;
  final String? officerDecision;

  const FaceMatchResult({
    required this.id,
    this.score,
    required this.verdict,
    this.officerDecision,
  });

  factory FaceMatchResult.fromJson(Map<String, dynamic> j) =>
      FaceMatchResult(
        id: (j['id'] ?? '').toString(),
        score: (j['face_match_score'] as num?)?.toDouble(),
        verdict: (j['verdict'] as String?) ?? 'inconclusive',
        officerDecision: j['officer_decision'] as String?,
      );
}

class LivenessChallenge {
  final String challengeId;
  final List<String> actions;
  final String status;
  final int attemptsAllowed;
  final int attemptsUsed;
  final String? expiresAt;

  const LivenessChallenge({
    required this.challengeId,
    this.actions = const [],
    required this.status,
    this.attemptsAllowed = 3,
    this.attemptsUsed = 0,
    this.expiresAt,
  });

  factory LivenessChallenge.fromJson(Map<String, dynamic> j) =>
      LivenessChallenge(
        challengeId: (j['challenge_id'] ?? '').toString(),
        actions: (j['actions'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const [],
        status: (j['status'] as String?) ?? 'pending',
        attemptsAllowed: (j['attempts_allowed'] as num?)?.toInt() ?? 3,
        attemptsUsed: (j['attempts_used'] as num?)?.toInt() ?? 0,
        expiresAt: j['expires_at'] as String?,
      );
}

class EscrowHold {
  final String id;
  final String jobId;
  final double amountPkr;
  final String status;
  final String? autoReleaseAt;

  const EscrowHold({
    required this.id,
    required this.jobId,
    required this.amountPkr,
    required this.status,
    this.autoReleaseAt,
  });

  factory EscrowHold.fromJson(Map<String, dynamic> j) => EscrowHold(
        id: (j['id'] ?? '').toString(),
        jobId: (j['job_id'] ?? '').toString(),
        amountPkr: (j['amount_pkr'] as num?)?.toDouble() ?? 0,
        status: (j['status'] as String?) ?? 'held',
        autoReleaseAt: j['auto_release_at'] as String?,
      );
}

class Payout {
  final String id;
  final double amountPkr;
  final double netPkr;
  final String kind;
  final String status;
  final bool sandbox;

  const Payout({
    required this.id,
    required this.amountPkr,
    required this.netPkr,
    required this.kind,
    required this.status,
    this.sandbox = true,
  });

  factory Payout.fromJson(Map<String, dynamic> j) => Payout(
        id: (j['id'] ?? '').toString(),
        amountPkr: (j['amount_pkr'] as num?)?.toDouble() ?? 0,
        netPkr: (j['net_pkr'] as num?)?.toDouble() ?? 0,
        kind: (j['kind'] as String?) ?? 'instant',
        status: (j['status'] as String?) ?? 'requested',
        sandbox: (j['sandbox'] as bool?) ?? true,
      );
}
