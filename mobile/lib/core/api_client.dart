import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

import 'constants.dart';
import 'errors.dart';
import 'models.dart';
import 'money.dart';
import 'phase3_models.dart';
import '../features/provider/parts_order_screen.dart';

/// HTTP client for the NestJS API (PRD v1.1 + OpenAPI 3.1 skeleton
/// `near-service-openapi.yaml`, Phase 1 only).
/// - Attaches `Authorization: Bearer <accessToken>` when logged in.
/// - On 401, tries one refresh via POST /auth/refresh, then retries once.
/// - Sends an `Idempotency-Key` (UUID) on every mutating call.
/// - Parses the shared error shape {error:{code,message}, request_id}.
/// - Identifier rule (PRD v1.1): `category_id` is ALWAYS a UUID. A slug
///   such as `book-binding` is NEVER sent as `category_id`; it is sent
///   as `category_slug` and the server resolves it. Every method below
///   normalises category values through [_categoryQuery] / [_normaliseCategory]
///   so a slug can never leak into a `category_id` field.
/// - No Phase 2 endpoints (wallet top-up, payment intents, payouts).
/// Phase 2 adds: wallet top-up (JazzCash/Easypaisa, sandbox), wallet
/// payment, promo validation, referrals, GET /jobs + tracking, disputes
/// evidence, reschedule + recurring jobs. See the Phase 2 section below.
/// - Phase 4 (v1.6): partner parts ordering (implements PartnerApi) +
/// warranty product. See the Phase 4 section at the end of this class.
class ApiClient implements PartnerApi {
  ApiClient({http.Client? httpClient, FlutterSecureStorage? storage})
      : _http = httpClient ?? http.Client(),
        _storage = storage ?? const FlutterSecureStorage();

  final http.Client _http;
  final FlutterSecureStorage _storage;
  final _uuid = const Uuid();

  static final _uuidPattern = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  );

  /// True when [value] is a UUID (safe to send as `category_id`).
  static bool isUuid(String value) => _uuidPattern.hasMatch(value);

  /// Builds the category query pair for a value that may be a UUID or a
  /// slug: UUID -> `category_id`, slug -> `category_slug`. Never the
  /// other way round (PRD v1.1 identifier rule).
  static Map<String, String> _categoryQuery(String value) => isUuid(value)
      ? {'category_id': value}
      : {'category_slug': value};

  /// Normalises a request payload that carries a category: a slug value
  /// under `category_id` is moved to `category_slug` so the wire payload
  /// always matches the OpenAPI contract.
  static Map<String, dynamic> _normaliseCategory(
    Map<String, dynamic> payload,
  ) {
    final out = Map<String, dynamic>.from(payload);
    final raw = out['category_id'];
    if (raw is String && raw.isNotEmpty && !isUuid(raw)) {
      out.remove('category_id');
      out['category_slug'] = raw;
    }
    return out;
  }

  Uri _u(String path, [Map<String, String>? query]) {
    final base = AppConstants.apiBaseUrl;
    final uri = Uri.parse('$base$path');
    return query == null ? uri : uri.replace(queryParameters: query);
  }

  Future<Map<String, String>> _headers({bool mutating = false}) async {
    final headers = <String, String>{
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    final token = await _storage.read(key: StorageKeys.accessToken);
    if (token != null && token.isNotEmpty) {
      headers['Authorization'] = 'Bearer $token';
    }
    if (mutating) headers['Idempotency-Key'] = _uuid.v4();
    return headers;
  }

  dynamic _decode(http.Response res) {
    if (res.body.isEmpty) return <String, dynamic>{};
    try {
      return jsonDecode(res.body);
    } on FormatException {
      throw ApiException('BAD_RESPONSE', 'Server returned an unreadable response.', res.statusCode);
    }
  }

  Never _throwError(http.Response res) {
    final body = _decode(res);
    if (body is Map && body['error'] is Map) {
      final e = body['error'] as Map;
      throw ApiException(
        (e['code'] ?? 'UNKNOWN').toString(),
        (e['message'] ?? 'Something went wrong.').toString(),
        res.statusCode,
      );
    }
    throw ApiException('HTTP_${res.statusCode}', 'Request failed (${res.statusCode}).', res.statusCode);
  }

  Future<http.Response> _send(
    Future<http.Response> Function(Map<String, String>) call, {
    bool mutating = false,
    bool retried = false,
  }) async {
    late http.Response res;
    try {
      res = await call(await _headers(mutating: mutating));
    } on SocketException {
      throw const NetworkException();
    } on HttpException {
      throw const NetworkException();
    }
    if (res.statusCode == 401 && !retried) {
      if (await _tryRefresh()) {
        return _send(call, mutating: mutating, retried: true);
      }
    }
    return res;
  }

  Future<bool> _tryRefresh() async {
    final refresh = await _storage.read(key: StorageKeys.refreshToken);
    if (refresh == null || refresh.isEmpty) return false;
    try {
      final res = await _http.post(
        _u('/auth/refresh'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'refreshToken': refresh}),
      );
      if (res.statusCode != 200) return false;
      final body = _decode(res) as Map<String, dynamic>;
      await _saveTokens(body);
      // FIX 10 — re-register this device after a token refresh so push
      // keeps working. Direct POST (no _send) so a failed register can
      // never recurse back into _tryRefresh. Best-effort: never fails login.
      await _registerDeviceBestEffort();
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _saveTokens(Map<String, dynamic> body) async {
    final access = body['accessToken'] ?? body['access_token'];
    final refresh = body['refreshToken'] ?? body['refresh_token'];
    if (access != null) {
      await _storage.write(key: StorageKeys.accessToken, value: access.toString());
    }
    if (refresh != null) {
      await _storage.write(key: StorageKeys.refreshToken, value: refresh.toString());
    }
    if (body['user'] is Map) {
      await _storage.write(
        key: StorageKeys.userJson,
        value: jsonEncode(body['user']),
      );
    }
  }

  /// FIX 10 — tolerant pagination parser (OpenAPI v1.2 envelope
  /// {items, next_cursor}).
  /// FIX 15(c) (Stage 3): the old fallbacks are REMOVED — the backend is
  /// on the v1.2+ envelope everywhere it paginates, so the pre-v1.2
  /// {data: [...]} shape is no longer accepted. A bare List is still
  /// accepted, but ONLY because two bounded endpoints genuinely return a
  /// bare array by contract (GET /me/trusted-contacts, GET
  /// /providers/me/services — see openapi.yaml v1.3 notes); it is not a
  /// fallback for paginated endpoints.
  static List<T> parsePage<T>(
    dynamic body,
    T Function(Map<String, dynamic>) fromJson,
  ) {
    final List list;
    if (body is List) {
      list = body;
    } else if (body is Map) {
      list = (body['items'] ?? []) as List;
    } else {
      list = const [];
    }
    return list
        .map((e) => fromJson(e as Map<String, dynamic>))
        .toList();
  }

  static String? parseNextCursor(dynamic body) =>
      body is Map ? body['next_cursor'] as String? : null;

  // ---- Auth -------------------------------------------------------------
  Future<void> requestOtp(String phone) async {
    final res = await _send(
      (h) => _http.post(_u('/auth/otp/request'),
          headers: h, body: jsonEncode({'phone': phone})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201 && res.statusCode != 202) _throwError(res);
  }

  /// Verifies the OTP. In dev the backend prints the OTP to its console;
  /// the OTP screen shows that hint. Returns the signed-in user.
  Future<AppUser> verifyOtp(String phone, String code) async {
    final fingerprint =
        await _storage.read(key: StorageKeys.deviceFingerprint) ??
            _uuid.v4();
    await _storage.write(
        key: StorageKeys.deviceFingerprint, value: fingerprint);
    final res = await _send(
      (h) => _http.post(_u('/auth/otp/verify'),
          headers: h,
          body: jsonEncode({
            'phone': phone,
            'code': code,
            'device_fingerprint': fingerprint,
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    final body = _decode(res) as Map<String, dynamic>;
    await _saveTokens(body);
    // FIX 10 — register this device right after login (see
    // registerCurrentDevice). Best-effort: a failed register must never
    // fail the login itself.
    await _registerDeviceBestEffort();
    return AppUser.fromJson(
        (body['user'] as Map<String, dynamic>? ?? <String, dynamic>{})
          ..['phone'] = phone);
  }

  Future<void> logout() async {
    try {
      await _send((h) => _http.post(_u('/auth/logout'), headers: h),
          mutating: true);
    } catch (_) {
      // Logout is best-effort; tokens are cleared locally regardless.
    }
    await _storage.delete(key: StorageKeys.accessToken);
    await _storage.delete(key: StorageKeys.refreshToken);
    await _storage.delete(key: StorageKeys.userJson);
  }

  Future<AppUser> getMe() async {
    final res = await _send((h) => _http.get(_u('/me'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return AppUser.fromJson(_decode(res) as Map<String, dynamic>);
  }

  Future<AppUser> patchMe(Map<String, dynamic> patch) async {
    final res = await _send(
      (h) => _http.patch(_u('/me'), headers: h, body: jsonEncode(patch)),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
    return AppUser.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /me/profiles — customer flag + provider card on this one account
  /// (OpenAPI: {customer: bool, provider: ProviderCard | null}).
  Future<MyProfiles> getMyProfiles() async {
    final res = await _send((h) => _http.get(_u('/me/profiles'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return MyProfiles.fromJson(_decode(res) as Map<String, dynamic>);
  }

  Future<List<Address>> listAddresses() async {
    final res =
        await _send((h) => _http.get(_u('/me/addresses'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    // FIX 7 — AddressPage envelope {items, next_cursor} (parsePage also
    // accepts a bare list during transition).
    return parsePage(_decode(res), Address.fromJson);
  }

  Future<Address> createAddress(Map<String, dynamic> input) async {
    final res = await _send(
      (h) => _http.post(_u('/me/addresses'),
          headers: h, body: jsonEncode(input)),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return Address.fromJson(_decode(res) as Map<String, dynamic>);
  }

  Future<Address> updateAddress(
      String addressId, Map<String, dynamic> patch) async {
    final res = await _send(
      (h) => _http.patch(_u('/me/addresses/$addressId'),
          headers: h, body: jsonEncode(patch)),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
    return Address.fromJson(_decode(res) as Map<String, dynamic>);
  }

  // ---- Catalog / discovery ----------------------------------------------
  Future<List<Category>> getCategories() async {
    final res = await _send((h) => _http.get(_u('/categories'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    // FIX 15(c): GET /categories returns a bare array by contract
    // (openapi listCategories) — the old {data}/{categories} fallbacks
    // are removed (Stage 3).
    final list = (body is List ? body : []) as List;
    return list
        .map((e) => Category.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// GET /providers/nearby. [categoryId] must be a UUID; [categorySlug]
  /// is the alternative the OpenAPI contract offers — either way the wire
  /// query carries the right key (see [_categoryQuery]).
  /// NOTE: `min_rating` and `type` are NOT query params in the OpenAPI
  /// contract, so they are applied client-side below instead of sent.
  Future<List<ServiceProvider>> getNearbyProviders({
    required double lat,
    required double lng,
    String? categoryId,
    String? categorySlug,
    double radiusKm = 5,
    bool? openNow,
    bool? verifiedOnly,
    double? minRating,
    String? providerType,
  }) async {
    final query = <String, String>{
      'lat': lat.toString(),
      'lng': lng.toString(),
      'radius_km': radiusKm.toString(),
      if (categoryId != null) ..._categoryQuery(categoryId),
      if (categoryId == null && categorySlug != null)
        'category_slug': categorySlug,
      if (openNow == true) 'open_now': 'true',
      if (verifiedOnly == true) 'verified_only': 'true',
    };
    final res = await _send((h) => _http.get(_u('/providers/nearby', query), headers: h));
    if (res.statusCode != 200) _throwError(res);
    // FIX 7 — ProviderPage envelope {items, next_cursor}.
    // FIX 15(c) (Stage 3): the nearby parser reads ONLY `items` from the
    // v1.2+ envelope — the old {data} / bare-list fallbacks are removed.
    // Nearby is GET /providers/nearby?lat=&lng=&category_id=&radius_km=
    // &open_now=&verified_only= ; is_open_now is computed by the backend
    // in Asia/Karachi from the provider's availability rows (FIX 11).
    var providers = parsePage(_decode(res), ServiceProvider.fromJson);
    if (minRating != null && minRating > 0) {
      providers = providers.where((p) => p.rating >= minRating).toList();
    }
    if (providerType != null) {
      providers = providers.where((p) => p.type == providerType).toList();
    }
    return providers;
  }

  Future<ServiceProvider> getProvider(String id) async {
    final res = await _send((h) => _http.get(_u('/providers/$id'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return ServiceProvider.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /places/nearby — real-world shops from OpenStreetMap (free, no
  /// key). Returns the shops plus `degraded` (true when Overpass errored,
  /// timed out or found nothing — the list is then empty and the caller
  /// keeps showing registered providers). A non-200 here is a real client
  /// error (e.g. unknown category slug -> 422) and still throws.
  Future<({List<PlaceShop> shops, bool degraded})> getNearbyPlaces({
    required double lat,
    required double lng,
    required String categorySlug,
    double radiusKm = AppConstants.placesRadiusKm,
  }) async {
    final query = <String, String>{
      'lat': lat.toString(),
      'lng': lng.toString(),
      'category_slug': categorySlug,
      'radius_km': radiusKm.toString(),
    };
    final res = await _send((h) => _http.get(_u('/places/nearby', query), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res) as Map<String, dynamic>;
    final items = (body['items'] as List? ?? [])
        .map((e) => PlaceShop.fromJson(e as Map<String, dynamic>))
        .toList();
    return (shops: items, degraded: body['degraded'] == true);
  }

  Future<void> setOnline(bool online, double lat, double lng) async {
    final res = await _send(
      (h) => _http.patch(_u('/providers/me/online'),
          headers: h,
          body: jsonEncode({'is_online': online, 'lat': lat, 'lng': lng})),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
  }

  /// GET /search — OpenAPI returns {categories: Category[], providers:
  /// ProviderCard[]}. Normalised into one list of maps with a `type`
  /// marker so the UI can route category taps to the request form and
  /// provider taps to the provider profile.
  Future<List<Map<String, dynamic>>> search(String q, double lat, double lng) async {
    final res = await _send((h) =>
        _http.get(_u('/search', {'q': q, 'lat': lat.toString(), 'lng': lng.toString()}), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    if (body is List) return body.cast<Map<String, dynamic>>();
    final out = <Map<String, dynamic>>[];
    final cats = (body['categories'] as List?) ?? const [];
    for (final e in cats) {
      final c = Category.fromJson(e as Map<String, dynamic>);
      out.add({
        'type': 'category',
        'id': c.id,
        'category_id': c.id,
        'category_slug': c.slug,
        'name': c.nameEn,
        'name_roman': c.nameRoman,
      });
    }
    final provsRaw = body['providers'];
    // FIX 7 — SearchResults.providers is a ProviderPage envelope
    // {items, next_cursor}. FIX 15(c): bare-list and {data} fallbacks
    // removed (Stage 3) — the backend is on the v1.2+ envelope.
    final provs = (provsRaw is Map ? provsRaw['items'] ?? [] : []) as List;
    for (final e in provs) {
      final p = ServiceProvider.fromJson(e as Map<String, dynamic>);
      out.add({
        'type': 'provider',
        'id': p.id,
        'name': p.displayName,
        'name_roman': p.displayName,
      });
    }
    return out;
  }

  /// GET /categories/{categoryId}/form-schema — JSON Schema for the
  /// dynamic request form of one category (UUID in the path).
  Future<Map<String, dynamic>> getCategoryFormSchema(String categoryId) async {
    final res = await _send(
        (h) => _http.get(_u('/categories/$categoryId/form-schema'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// GET /pricing/fair-range — [categoryId] is a UUID, [categorySlug] the
  /// slug alternative; the wire query carries the matching key.
  Future<FairRange> fairRange({
    String? categoryId,
    String? categorySlug,
    Map<String, dynamic> specs = const {},
    String? cityId,
  }) async {
    final query = <String, String>{
      if (categoryId != null) ..._categoryQuery(categoryId),
      if (categoryId == null && categorySlug != null)
        'category_slug': categorySlug,
      if (specs.isNotEmpty) 'specs': jsonEncode(specs),
      if (cityId != null) 'city_id': cityId,
    };
    final res = await _send((h) => _http.get(
        _u('/pricing/fair-range', query),
        headers: h));
    if (res.statusCode != 200) _throwError(res);
    return FairRange.fromJson(_decode(res) as Map<String, dynamic>);
  }

  // ---- Requests / offers --------------------------------------------------
  /// POST /requests — CreateRequest per the OpenAPI contract:
  /// `category_id` (UUID) OR `category_slug`; `service_id` /
  /// `provider_id` are not contract fields and are not sent.
  /// The payload is normalised so a slug can never be sent as
  /// `category_id` (see [_normaliseCategory]).
  Future<ServiceRequest> createRequest(Map<String, dynamic> payload) async {
    final res = await _send(
      (h) => _http.post(_u('/requests'),
          headers: h, body: jsonEncode(_normaliseCategory(payload))),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return ServiceRequest.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /requests/{requestId} — request status (OpenAPI).
  Future<ServiceRequest> getRequest(String requestId) async {
    final res =
        await _send((h) => _http.get(_u('/requests/$requestId'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return ServiceRequest.fromJson(_decode(res) as Map<String, dynamic>);
  }

  Future<List<Offer>> getOffers(String requestId) async {
    final res = await _send((h) => _http.get(_u('/requests/$requestId/offers'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    // FIX 7 — OfferPage envelope {items, next_cursor} (parsePage also
    // accepts a bare list during transition).
    return parsePage(_decode(res), Offer.fromJson);
  }

  Future<Offer> submitOffer(
    String requestId, {
    required int price,
    int? etaMinutes,
    String? note,
    Map<String, int>? breakdown,
  }) async {
    final res = await _send(
      (h) => _http.post(_u('/requests/$requestId/offers'),
          headers: h,
          body: jsonEncode({
            'price': price,
            if (etaMinutes != null) 'eta_minutes': etaMinutes,
            if (note != null) 'note': note,
            if (breakdown != null) 'breakdown': breakdown,
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return Offer.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// Accepts an offer. Batch 2 (J3): the customer picks the pickup
  /// time (today/tomorrow + time) and it is sent as `scheduled_at`
  /// — the provider's committed arrival time.
  Future<Job> acceptOffer(String offerId, {DateTime? scheduledAt}) async {
    final res = await _send(
      (h) => _http.post(_u('/offers/$offerId/accept'),
          headers: h,
          body: jsonEncode({
            if (scheduledAt != null)
              'scheduled_at': scheduledAt.toIso8601String(),
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    final body = _decode(res) as Map<String, dynamic>;
    final jobJson = (body['job'] as Map<String, dynamic>?) ?? body;
    return Job.fromJson(jobJson);
  }

  Future<Offer> counterOffer(String offerId, int price, {String? note}) async {
    final res = await _send(
      (h) => _http.post(_u('/offers/$offerId/counter'),
          headers: h, body: jsonEncode({'price': price, if (note != null) 'note': note})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return Offer.fromJson(_decode(res) as Map<String, dynamic>);
  }

  Future<void> declineOffer(String offerId, String reasonCode) async {
    final res = await _send(
      (h) => _http.post(_u('/offers/$offerId/decline'),
          headers: h, body: jsonEncode({'reason_code': reasonCode})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
  }

  Future<void> cancelRequest(String requestId) async {
    final res = await _send(
      (h) => _http.post(_u('/requests/$requestId/cancel'), headers: h, body: '{}'),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
  }

  // ---- Jobs ---------------------------------------------------------------
  Future<Job> transitionJob(String jobId, String toState, {double? lat, double? lng}) async {
    final res = await _send(
      (h) => _http.post(_u('/jobs/$jobId/transition'),
          headers: h,
          body: jsonEncode({
            'to_state': toState,
            if (lat != null) 'lat': lat,
            if (lng != null) 'lng': lng,
          })),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
    return Job.fromJson(_decode(res) as Map<String, dynamic>);
  }

  Future<Job> completeJob(String jobId) async {
    final res = await _send(
      (h) => _http.post(_u('/jobs/$jobId/complete'), headers: h, body: '{}'),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
    return Job.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /jobs/{jobId}/confirm-payment — cash only in Phase 1.
  /// The OpenAPI contract defines no request body for this call
  /// (cash is the only payment method), so an empty body is sent.
  Future<Job> confirmPayment(String jobId) async {
    final res = await _send(
      (h) => _http.post(_u('/jobs/$jobId/confirm-payment'), headers: h, body: '{}'),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
    return Job.fromJson(_decode(res) as Map<String, dynamic>);
  }

  Future<void> submitReview(String jobId, int stars, List<String> tags, String comment, {List<String> photoKeys = const []}) async {
    await submitReviewWithPhotos(jobId, stars, tags, comment, photoKeys: photoKeys);
  }

  Future<void> sendSos(String jobId, double lat, double lng) async {
    final res = await _send(
      (h) => _http.post(_u('/sos'),
          headers: h,
          body: jsonEncode({'job_id': jobId, 'lat': lat, 'lng': lng})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
  }

  // ---- Chat / wallet --------------------------------------------------------
  Future<List<ChatMessage>> getMessages(String chatId, String myId) async {
    final res = await _send((h) => _http.get(_u('/chats/$chatId/messages'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    // FIX 7 — MessagePage envelope {items, next_cursor} (parsePage also
    // accepts a bare list during transition).
    return parsePage(
        _decode(res), (m) => ChatMessage.fromJson(m, myId));
  }

  Future<ChatMessage> sendMessage(String chatId, String body, String myId) async {
    final res = await _send(
      (h) => _http.post(_u('/chats/$chatId/messages'),
          headers: h, body: jsonEncode({'body': body, 'kind': 'text'})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return ChatMessage.fromJson(_decode(res) as Map<String, dynamic>, myId);
  }

  Future<WalletInfo> getWallet() async {
    final res = await _send((h) => _http.get(_u('/wallet'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return WalletInfo.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /providers/onboarding — resumable wizard, one step per call.
  /// Contract body is exactly {step, data} where step is one of
  /// identity | business | service_area | payout (PRD v1.1).
  /// Returns the wizard state {completed_steps, review_status}.
  /// Phase 1 verification is MANUAL review only.
  Future<Map<String, dynamic>> submitProviderOnboarding({
    required String step,
    required Map<String, dynamic> data,
  }) async {
    const steps = {'identity', 'business', 'service_area', 'payout'};
    assert(steps.contains(step), 'Unknown onboarding step: $step');
    final res = await _send(
      (h) => _http.post(_u('/providers/onboarding'),
          headers: h,
          body: jsonEncode({'step': step, 'data': data})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// POST /providers/me/documents — signed upload URL for one document.
  /// Contract response is {upload_url, storage_key}; the app PUTs the
  /// file to `upload_url` and keeps `storage_key` for the review record.
  /// doc_type: cnic_front | cnic_back | selfie | shop_photo | certificate.
  Future<({String uploadUrl, String storageKey})> requestDocumentUpload(
    String docType,
  ) async {
    const types = {
      'cnic_front',
      'cnic_back',
      'selfie',
      'shop_photo',
      'certificate',
    };
    assert(types.contains(docType), 'Unknown doc_type: $docType');
    final res = await _send(
      (h) => _http.post(_u('/providers/me/documents'),
          headers: h, body: jsonEncode({'doc_type': docType})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    final body = _decode(res) as Map<String, dynamic>;
    return (
      uploadUrl: (body['upload_url'] ?? '').toString(),
      storageKey: (body['storage_key'] ?? '').toString(),
    );
  }

  // ---- Phase 2: wallet ------------------------------------------------
  /// GET /wallet/transactions — cursor-paginated ledger.
  Future<({List<WalletTransaction> items, String? nextCursor})>
      getWalletTransactions({String? cursor, int limit = 20}) async {
    final query = <String, String>{'limit': limit.toString()};
    if (cursor != null && cursor.isNotEmpty) query['cursor'] = cursor;
    final res = await _send(
        (h) => _http.get(_u('/wallet/transactions', query), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    final list = (body is Map ? body['items'] ?? [] : []) as List; // FIX 15(c): v1.2+ envelope only — {data}/bare-list fallbacks removed
    return (
      items: list
          .map((e) => WalletTransaction.fromJson(e as Map<String, dynamic>))
          .toList(),
      nextCursor: (body is Map ? body['next_cursor'] as String? : null),
    );
  }

  /// POST /wallet/topup — starts a sandbox top-up. Returns
  /// {payment_id, provider, status, reference, sandbox: true}.
  /// No real money moves in sandbox; the UI must say so.
  Future<Map<String, dynamic>> topUpWallet({
    required String method, // jazzcash | easypaisa
    required int amountPkr,
    required String phone,
  }) async {
    final res = await _send(
      (h) => _http.post(_u('/wallet/topup'),
          headers: h,
          body: jsonEncode({
            'method': method,
            'amount_pkr': amountPkr,
            'phone': phone,
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// POST /wallet/topup/confirm — credits the wallet for a sandbox
  /// top-up started by [topUpWallet].
  Future<WalletInfo> confirmTopUp(String paymentId) async {
    final res = await _send(
      (h) => _http.post(_u('/wallet/topup/confirm'),
          headers: h, body: jsonEncode({'payment_id': paymentId})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    final body = _decode(res) as Map<String, dynamic>;
    final walletJson = (body['wallet'] as Map<String, dynamic>?) ?? body;
    return WalletInfo.fromJson(walletJson);
  }

  // ---- Phase 2: payments / promos / referrals -------------------------
  /// GET /payments/methods — [{id: 'cash'|'wallet'|'jazzcash'|
  /// 'easypaisa', sandbox: true}]. JazzCash/Easypaisa are sandbox-only
  /// top-up routes, never live payments.
  Future<List<PaymentMethodInfo>> getPaymentMethods() async {
    final res =
        await _send((h) => _http.get(_u('/payments/methods'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    // FIX 15(c): GET /payments/methods returns a bare array by contract
    // (openapi listPaymentMethods) — old {data}/{methods} fallbacks removed.
    final list = (body is List ? body : []) as List;
    return list
        .map((e) => PaymentMethodInfo.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// POST /jobs/{jobId}/pay-wallet — wallet-paid settlement.
  /// Throws ApiException code INSUFFICIENT_WALLET_BALANCE (409) when
  /// the balance is short; the payment screen handles that code.
  Future<Job> payJobWithWallet(String jobId, {String? promoCode}) async {
    final res = await _send(
      (h) => _http.post(_u('/jobs/$jobId/pay-wallet'),
          headers: h,
          body: jsonEncode({
            if (promoCode != null && promoCode.isNotEmpty)
              'promo_code': promoCode,
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    final body = _decode(res) as Map<String, dynamic>;
    final jobJson = (body['job'] as Map<String, dynamic>?) ?? body;
    return Job.fromJson(jobJson);
  }

  /// POST /promos/validate — {valid, kind, value, discount_paisa,
  /// reason?}. Never throws for an invalid code: a valid=false
  /// response is returned and shown to the user.
  Future<PromoValidation> validatePromo({
    required String code,
    String? categoryId,
    int? amountPkr,
  }) async {
    final res = await _send(
      (h) => _http.post(_u('/promos/validate'),
          headers: h,
          body: jsonEncode({
            'code': code,
            if (categoryId != null) 'category_id': categoryId,
            if (amountPkr != null) 'amount_pkr': amountPkr,
          })),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
    return PromoValidation.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /referrals/me — {code, referred_count, credit_paisa,
  /// pending_count}.
  Future<ReferralInfo> getReferral() async {
    final res = await _send((h) => _http.get(_u('/referrals/me'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return ReferralInfo.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /referrals/claim {code} — claims someone else's referral code.
  Future<ReferralInfo> claimReferral(String code) async {
    final res = await _send(
      (h) => _http.post(_u('/referrals/claim'),
          headers: h, body: jsonEncode({'code': code})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return ReferralInfo.fromJson(_decode(res) as Map<String, dynamic>);
  }

  // ---- Phase 2: jobs list / tracking / reschedule ----------------------
  /// GET /jobs?role=customer|provider&state=&cursor=&limit=.
  Future<({List<Job> items, String? nextCursor})> listJobs({
    required String role, // customer | provider
    String? state,
    String? cursor,
    int limit = 20,
  }) async {
    final query = <String, String>{
      'role': role,
      'limit': limit.toString(),
      if (state != null && state.isNotEmpty) 'state': state,
      if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
    };
    final res =
        await _send((h) => _http.get(_u('/jobs', query), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    final list = (body is Map ? body['items'] ?? [] : []) as List; // FIX 15(c): v1.2+ envelope only — {data}/bare-list fallbacks removed
    return (
      items: list.map((e) => Job.fromJson(e as Map<String, dynamic>)).toList(),
      nextCursor: (body is Map ? body['next_cursor'] as String? : null),
    );
  }

  /// GET /jobs/{jobId} — job details.
  Future<Job> getJob(String jobId) async {
    final res = await _send((h) => _http.get(_u('/jobs/$jobId'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return Job.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /jobs/{jobId}/tracking — provider position, distance, ETA,
  /// trail polyline points.
  Future<JobTracking> getJobTracking(String jobId) async {
    final res = await _send(
        (h) => _http.get(_u('/jobs/$jobId/tracking'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return JobTracking.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /jobs/{jobId}/reschedule {scheduled_at, reason, scope_changed?}.
  /// Throws ApiException code SCOPE_CHANGED_REQUIRES_RENEGOTIATION (409)
  /// when the change alters the scope — the caller must renegotiate
  /// instead of silently rescheduling.
  Future<Job> rescheduleJob(
    String jobId, {
    required DateTime scheduledAt,
    String? reason,
    bool scopeChanged = false,
  }) async {
    final res = await _send(
      (h) => _http.post(_u('/jobs/$jobId/reschedule'),
          headers: h,
          body: jsonEncode({
            'scheduled_at': scheduledAt.toIso8601String(),
            if (reason != null) 'reason': reason,
            'scope_changed': scopeChanged,
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return Job.fromJson(_decode(res) as Map<String, dynamic>);
  }

  // ---- Phase 2: recurring jobs ------------------------------------------
  /// POST /recurring-jobs — frequency weekly|monthly, optional
  /// day_of_week / day_of_month, starts_at, optional ends_at.
  Future<RecurringJob> createRecurringJob(Map<String, dynamic> payload) async {
    final res = await _send(
      (h) => _http.post(_u('/recurring-jobs'),
          headers: h, body: jsonEncode(_normaliseCategory(payload))),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return RecurringJob.fromJson(_decode(res) as Map<String, dynamic>);
  }

  Future<List<RecurringJob>> listRecurringJobs() async {
    final res =
        await _send((h) => _http.get(_u('/recurring-jobs'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    final list = (body is Map ? body['items'] ?? [] : []) as List; // FIX 15(c): v1.2+ envelope only — {data}/bare-list fallbacks removed
    return list
        .map((e) => RecurringJob.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// PATCH /recurring-jobs/{id} {status: active|paused|cancelled}.
  Future<RecurringJob> updateRecurringJob(String id, String status) async {
    final res = await _send(
      (h) => _http.patch(_u('/recurring-jobs/$id'),
          headers: h, body: jsonEncode({'status': status})),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
    return RecurringJob.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /recurring-jobs/{id}/skip-next.
  Future<RecurringJob> skipNextRecurringJob(String id) async {
    final res = await _send(
      (h) => _http.post(_u('/recurring-jobs/$id/skip-next'),
          headers: h, body: '{}'),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return RecurringJob.fromJson(_decode(res) as Map<String, dynamic>);
  }

  // ---- Phase 2: disputes -------------------------------------------------
  /// POST /disputes/{id}/evidence {kind: photo|chat|gps, storage_key?,
  /// note?}. Photo evidence: there is no direct in-app upload API in
  /// Phase 2, so a photo is recorded as a note + kind (see
  /// DisputeScreen) — never faked as an uploaded file.
  Future<Map<String, dynamic>> addDisputeEvidence(
    String disputeId, {
    required String kind, // photo | chat | gps
    String? storageKey,
    String? note,
  }) async {
    final res = await _send(
      (h) => _http.post(_u('/disputes/$disputeId/evidence'),
          headers: h,
          body: jsonEncode({
            'kind': kind,
            if (storageKey != null && storageKey.isNotEmpty)
              'storage_key': storageKey,
            if (note != null && note.isNotEmpty) 'note': note,
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// GET /disputes?status=&cursor=&limit=.
  Future<({List<Dispute> items, String? nextCursor})> listDisputes({
    String? status,
    String? cursor,
    int limit = 20,
  }) async {
    final query = <String, String>{'limit': limit.toString()};
    if (status != null && status.isNotEmpty) query['status'] = status;
    if (cursor != null && cursor.isNotEmpty) query['cursor'] = cursor;
    final res = await _send((h) => _http.get(_u('/disputes', query), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    final list = (body is Map ? body['items'] ?? [] : []) as List; // FIX 15(c): v1.2+ envelope only — {data}/bare-list fallbacks removed
    return (
      items: list.map((e) => Dispute.fromJson(e as Map<String, dynamic>)).toList(),
      nextCursor: (body is Map ? body['next_cursor'] as String? : null),
    );
  }

  /// POST /jobs/{jobId}/disputes — opens a dispute (201) with SLA
  /// timestamps in the response.
  Future<Map<String, dynamic>> openDispute(
    String jobId, {
    required String reasonCode,
    String? description,
  }) async {
    final res = await _send(
      (h) => _http.post(_u('/jobs/$jobId/disputes'),
          headers: h,
          body: jsonEncode({
            'reason_code': reasonCode,
            if (description != null) 'description': description,
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  // ---- FIX 10: devices / trusted contacts / blocks / reports ---------
  // NOTE on FCM: this app has NO firebase_messaging dependency and no
  // Firebase setup (see pubspec.yaml), so there is no FCM token to
  // obtain. Registration therefore sends the stored device fingerprint
  // (created at OTP verify, StorageKeys.deviceFingerprint) with
  // fcm_token null — the backend upserts on (user, fingerprint) and
  // stores a null token until Firebase Messaging is wired in. Do NOT
  // invent a token here. If Firebase is added later, pass the real
  // token via registerCurrentDevice(fcmToken: ...).

  static String get _platform =>
      Platform.isAndroid ? 'android' : Platform.isIOS ? 'ios' : 'web';

  /// POST /me/devices — register/update this device. Uses a direct
  /// POST (not [_send]) so it can be called from [_tryRefresh] without
  /// recursing into the refresh flow. Returns the stored device, or
  /// null when the call fails (callers treat it as best-effort).
  Future<DeviceInfo?> registerCurrentDevice({String? fcmToken}) async {
    try {
      final fingerprint =
          await _storage.read(key: StorageKeys.deviceFingerprint) ??
              _uuid.v4();
      await _storage.write(
          key: StorageKeys.deviceFingerprint, value: fingerprint);
      final token = await _storage.read(key: StorageKeys.accessToken);
      final res = await _http.post(
        _u('/me/devices'),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          if (token != null && token.isNotEmpty)
            'Authorization': 'Bearer $token',
          'Idempotency-Key': _uuid.v4(),
        },
        body: jsonEncode({
          'device_fingerprint': fingerprint,
          'platform': _platform,
          // DeviceInput: fcm_token is nullable; null clears it.
          'fcm_token': fcmToken,
        }),
      );
      if (res.statusCode != 200 && res.statusCode != 201) return null;
      final device =
          DeviceInfo.fromJson(_decode(res) as Map<String, dynamic>);
      if (device.id.isNotEmpty) {
        await _storage.write(key: StorageKeys.deviceId, value: device.id);
      }
      return device;
    } catch (_) {
      return null;
    }
  }

  /// Best-effort wrapper: device registration must never throw into
  /// the login / token-refresh flow.
  Future<void> _registerDeviceBestEffort() async {
    await registerCurrentDevice();
  }

  /// DELETE /me/devices/{id} — unregister a device (204, stops push).
  Future<void> unregisterDevice(String deviceId) async {
    final res = await _send(
      (h) => _http.delete(_u('/me/devices/$deviceId'), headers: h),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 204) _throwError(res);
    final stored = await _storage.read(key: StorageKeys.deviceId);
    if (stored == deviceId) {
      await _storage.delete(key: StorageKeys.deviceId);
    }
  }

  /// GET /me/trusted-contacts — at most 5 (OpenAPI: bare array;
  /// [parsePage] also accepts {items:[...]} for forward-compat).
  Future<List<TrustedContact>> listTrustedContacts() async {
    final res =
        await _send((h) => _http.get(_u('/me/trusted-contacts'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), TrustedContact.fromJson);
  }

  /// POST /me/trusted-contacts — backend enforces max 5 with
  /// 409 TRUSTED_CONTACT_LIMIT; phone must match ^\+92\d{10}$.
  Future<TrustedContact> addTrustedContact({
    required String name,
    required String phone,
    String? relation,
  }) async {
    final res = await _send(
      (h) => _http.post(_u('/me/trusted-contacts'),
          headers: h,
          body: jsonEncode({
            'name': name,
            'phone': phone,
            if (relation != null && relation.isNotEmpty)
              'relation': relation,
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return TrustedContact.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// DELETE /me/trusted-contacts/{id} (204).
  Future<void> deleteTrustedContact(String contactId) async {
    final res = await _send(
      (h) => _http.delete(_u('/me/trusted-contacts/$contactId'), headers: h),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 204) _throwError(res);
  }

  /// POST /blocks — blocking is immediate and mutual.
  /// Contract mismatch (flagged, not silently resolved): OpenAPI v1.2
  /// BlockInput requires `blocked_user_id`, while the live backend
  /// TrustController BlockDto reads `blocked_id`. Both keys are sent
  /// so either side accepts the call; the backend value wins where
  /// both are read. The id passed must be a USER id — the provider
  /// profile endpoint does not expose the provider's user_id, so
  /// callers pass the best id they have (see ProviderProfileScreen)
  /// and the backend should expose provider user_id to make blocks
  /// exact.
  Future<Map<String, dynamic>> createBlock(String blockedUserId) async {
    final res = await _send(
      (h) => _http.post(_u('/blocks'),
          headers: h,
          body: jsonEncode({
            'blocked_user_id': blockedUserId,
            'blocked_id': blockedUserId,
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    final body = _decode(res);
    return body is Map<String, dynamic>
        ? body
        : <String, dynamic>{'status': 'blocked'};
  }

  /// POST /reports — report a user / provider / job / message.
  /// Same dual-shape note as [createBlock]: OpenAPI ReportInput uses
  /// {target_type, target_id, reason_code, description}; the live
  /// backend ReportDto reads {reported_id, context, reason_code,
  /// detail}. Both shapes are sent.
  Future<Map<String, dynamic>> reportUser({
    required String targetId,
    String targetType = 'user', // user | provider | job | message
    required String reasonCode,
    String? description,
  }) async {
    final res = await _send(
      (h) => _http.post(_u('/reports'),
          headers: h,
          body: jsonEncode({
            'target_type': targetType,
            'target_id': targetId,
            'reported_id': targetId,
            'context': targetType,
            'reason_code': reasonCode,
            'description': description,
            'detail': description,
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    final body = _decode(res);
    return body is Map<String, dynamic>
        ? body
        : <String, dynamic>{'status': 'reported'};
  }

  // ---- FIX 10: job price adjustments ----------------------------------
  /// POST /jobs/{jobId}/adjustments — provider requests extra work
  /// while the job is IN_PROGRESS (backend: 409 NOT_IN_PROGRESS
  /// otherwise). OpenAPI requires items + reason + added_amount
  /// (sum of the lines, PKR, > 0); the backend computes added_amount
  /// itself from items, so the sent value is the same sum.
  /// Photo support: there is no adjustment-photo upload endpoint in
  /// Phase 2 — each line may carry an optional `photo_key` (a storage
  /// key already obtained elsewhere); it is sent through untouched
  /// and never faked as an uploaded file.
  Future<JobAdjustment> createJobAdjustment(
    String jobId, {
    required List<AdjustmentItem> items,
    required String reason,
  }) async {
    final added = items.fold<int>(0, (s, i) => s + i.amount);
    final res = await _send(
      (h) => _http.post(_u('/jobs/$jobId/adjustments'),
          headers: h,
          body: jsonEncode({
            'items': items.map((i) => i.toJson()).toList(),
            'reason': reason,
            'added_amount': added,
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return JobAdjustment.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /adjustments/{id}/decide {approve} — customer approves or
  /// rejects a pending adjustment; the job resumes IN_PROGRESS.
  Future<JobAdjustment> decideAdjustment(String adjustmentId, bool approve) async {
    final res = await _send(
      (h) => _http.post(_u('/adjustments/$adjustmentId/decide'),
          headers: h, body: jsonEncode({'approve': approve})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return JobAdjustment.fromJson(_decode(res) as Map<String, dynamic>);
  }

  // ---- FIX 10: provider "me" settings ---------------------------------
  /// GET /providers/me/services — categories offered, with starting
  /// prices (OpenAPI: bare array; [parsePage] tolerates {items}).
  Future<List<ProviderService>> getMyServices() async {
    final res = await _send(
        (h) => _http.get(_u('/providers/me/services'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), ProviderService.fromJson);
  }

  /// PUT /providers/me/services — replaces the offered list.
  /// Each entry sends category_slug (or category_id when it is a
  /// UUID) + starting_price + is_active, per ProviderServicesUpdate.
  Future<List<ProviderService>> updateMyServices(
      List<ProviderService> services) async {
    final res = await _send(
      (h) => _http.put(_u('/providers/me/services'),
          headers: h,
          body: jsonEncode({
            'services': services.map((s) => s.toUpdateJson()).toList(),
          })),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), ProviderService.fromJson);
  }

  /// PUT /providers/me/service-area — exactly one of center+radius_km
  /// or polygon; this client sends the radius form only.
  /// radius_km must be > 0 and <= 100 (backend 422 otherwise).
  Future<ServiceArea> updateServiceArea({
    required double lat,
    required double lng,
    required double radiusKm,
  }) async {
    final res = await _send(
      (h) => _http.put(_u('/providers/me/service-area'),
          headers: h,
          body: jsonEncode({
            'center': {'lat': lat, 'lng': lng},
            'radius_km': radiusKm,
          })),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
    return ServiceArea.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// PUT /providers/me/availability — weekly slots, one per weekday
  /// (0 = Monday … 6 = Sunday, max 7). Day-off slots send opens /
  /// closes null.
  Future<List<AvailabilitySlot>> updateAvailability(
      List<AvailabilitySlot> slots) async {
    final res = await _send(
      (h) => _http.put(_u('/providers/me/availability'),
          headers: h,
          body: jsonEncode({
            'slots': slots.map((s) => s.toJson()).toList(),
          })),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), AvailabilitySlot.fromJson);
  }

  // ---- Phase 3 (v1.5) ---------------------------------------------------
  // AI Gateway (local provider only), risk, subscriptions, teams,
  // tenders, verification, escrow + payouts. Honesty notes: photo search
  // is a heuristic keyword match (not vision); voice search has no STT —
  // send a transcript from on-device recognition, audio-only is 422
  // STT_UNAVAILABLE; verification assists are advisory only; every
  // payout carries sandbox: true.

  /// GET /ai/health — public.
  Future<Map<String, dynamic>> aiHealth() async {
    final res = await _send((h) => _http.get(_u('/ai/health'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// POST /ai/intent — public. PII is redacted server-side before parsing.
  Future<AiIntent> parseIntent(String text) async {
    final res = await _send((h) => _http.post(_u('/ai/intent'),
        headers: h, body: jsonEncode({'text': text})));
    if (res.statusCode != 201) _throwError(res);
    return AiIntent.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /ai/photo-search — public. Heuristic match on description /
  /// tags / filename; no image pixels are read.
  Future<List<PhotoSuggestion>> photoSearch({
    String? mediaKey,
    String? description,
    List<String>? tags,
  }) async {
    final res = await _send((h) => _http.post(_u('/ai/photo-search'),
        headers: h,
        body: jsonEncode({
          if (mediaKey != null) 'media_key': mediaKey,
          if (description != null) 'description': description,
          if (tags != null) 'tags': tags,
        })));
    if (res.statusCode != 201) _throwError(res);
    final body = _decode(res) as Map<String, dynamic>;
    return ((body['suggestions'] ?? []) as List)
        .map((e) => PhotoSuggestion.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// POST /ai/voice-search — needs a transcript (on-device recognition).
  /// Audio-only fails with 422 STT_UNAVAILABLE on the local provider.
  /// Always requires_confirmation: show the transcript for manual
  /// correction before posting a request.
  Future<Map<String, dynamic>> voiceSearch({
    String? transcript,
    String? audioKey,
    String language = 'ur',
  }) async {
    final res = await _send((h) => _http.post(_u('/ai/voice-search'),
        headers: h,
        body: jsonEncode({
          if (transcript != null) 'transcript': transcript,
          if (audioKey != null) 'audio_key': audioKey,
          'language': language,
        })));
    if (res.statusCode != 201) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// GET /ai/fair-price — public learned estimate for (category, city,
  /// quantity). Hidden when the sample is too thin to publish.
  Future<AiFairPrice> aiFairPrice({
    String? categoryId,
    String? categorySlug,
    String? cityId,
    int? quantity,
  }) async {
    final query = <String, String>{
      if (categoryId != null) ..._categoryQuery(categoryId),
      if (categoryId == null && categorySlug != null)
        'category_slug': categorySlug,
      if (cityId != null) 'city_id': cityId,
      if (quantity != null) 'quantity': quantity.toString(),
    };
    final res = await _send(
        (h) => _http.get(_u('/ai/fair-price', query), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return AiFairPrice.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /ai/chats/:id/translation — my translation preference.
  Future<TranslationPref> getTranslationPref(String chatId) async {
    final res = await _send(
        (h) => _http.get(_u('/ai/chats/$chatId/translation'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return TranslationPref.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// PUT /ai/chats/:id/translation — auto_translate needs target_lang.
  Future<TranslationPref> setTranslationPref(
    String chatId, {
    String? targetLang,
    required bool autoTranslate,
  }) async {
    final res = await _send((h) => _http.put(
        _u('/ai/chats/$chatId/translation'),
        headers: h,
        body: jsonEncode({
          if (targetLang != null) 'target_lang': targetLang,
          'auto_translate': autoTranslate,
        })));
    if (res.statusCode != 200) _throwError(res);
    return TranslationPref.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /ai/chats/:id/messages/:messageId/translate — original is
  /// always preserved and returned alongside the translation.
  Future<Map<String, dynamic>> translateMessage(
    String chatId,
    String messageId,
    String targetLang,
  ) async {
    final res = await _send((h) => _http.post(
        _u('/ai/chats/$chatId/messages/$messageId/translate'),
        headers: h,
        body: jsonEncode({'target_lang': targetLang})));
    if (res.statusCode != 201) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// GET /risk/me — my own risk score (never customer-visible to others).
  Future<RiskScore> getMyRiskScore() async {
    final res =
        await _send((h) => _http.get(_u('/risk/me'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return RiskScore.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /subscription-plans — active plans.
  Future<List<SubscriptionPlan>> listSubscriptionPlans() async {
    final res = await _send(
        (h) => _http.get(_u('/subscription-plans'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), SubscriptionPlan.fromJson);
  }

  /// GET /subscriptions/me — my current subscription (Free when none).
  Future<SubscriptionView> getMySubscription() async {
    final res = await _send(
        (h) => _http.get(_u('/subscriptions/me'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return SubscriptionView.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /subscriptions — subscribe (paid plans bill from my wallet).
  Future<SubscriptionView> subscribe(String planCode) async {
    final res = await _send((h) => _http.post(_u('/subscriptions'),
        headers: h, body: jsonEncode({'plan_code': planCode})),
        mutating: true);
    if (res.statusCode != 201) _throwError(res);
    return SubscriptionView.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /subscriptions/change — upgrade immediate, downgrade at period end.
  Future<SubscriptionView> changePlan(String planCode) async {
    final res = await _send((h) => _http.post(_u('/subscriptions/change'),
        headers: h, body: jsonEncode({'plan_code': planCode})),
        mutating: true);
    if (res.statusCode != 200) _throwError(res);
    return SubscriptionView.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /subscriptions/cancel — stays active until period end.
  Future<SubscriptionView> cancelSubscription() async {
    final res = await _send((h) => _http.post(_u('/subscriptions/cancel'),
        headers: h, body: jsonEncode({})),
        mutating: true);
    if (res.statusCode != 200) _throwError(res);
    return SubscriptionView.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /subscriptions/me/analytics — Pro / Business only (403 otherwise).
  Future<ProviderAnalytics> getSubscriptionAnalytics({int days = 30}) async {
    final res = await _send((h) => _http.get(
        _u('/subscriptions/me/analytics', {'days': days.toString()}),
        headers: h));
    if (res.statusCode != 200) _throwError(res);
    return ProviderAnalytics.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /teams — create a team (I become its owner).
  Future<Team> createTeam(String name) async {
    final res = await _send((h) => _http.post(_u('/teams'),
        headers: h, body: jsonEncode({'name': name})),
        mutating: true);
    if (res.statusCode != 201) _throwError(res);
    return Team.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /teams — teams I belong to.
  Future<List<Team>> listMyTeams() async {
    final res =
        await _send((h) => _http.get(_u('/teams'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), Team.fromJson);
  }

  /// GET /teams/:id — one team with my role.
  Future<Team> getTeam(String teamId) async {
    final res = await _send(
        (h) => _http.get(_u('/teams/$teamId'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return Team.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /teams/:id/members — invite a member (manager/worker).
  Future<TeamMember> inviteTeamMember(
    String teamId,
    String userId,
    String role,
  ) async {
    final res = await _send((h) => _http.post(_u('/teams/$teamId/members'),
        headers: h,
        body: jsonEncode({'user_id': userId, 'role': role})),
        mutating: true);
    if (res.statusCode != 201) _throwError(res);
    return TeamMember.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /teams/:id/members/accept — accept my invite.
  Future<TeamMember> acceptTeamInvite(String teamId) async {
    final res = await _send((h) => _http.post(
        _u('/teams/$teamId/members/accept'),
        headers: h,
        body: jsonEncode({})),
        mutating: true);
    if (res.statusCode != 200) _throwError(res);
    return TeamMember.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// DELETE /teams/:id/members/:memberId — remove a member.
  Future<void> removeTeamMember(String teamId, String memberId) async {
    final res = await _send((h) =>
        _http.delete(_u('/teams/$teamId/members/$memberId'), headers: h));
    if (res.statusCode != 200) _throwError(res);
  }

  /// GET /teams/:id/members — team members.
  Future<List<TeamMember>> listTeamMembers(String teamId) async {
    final res = await _send(
        (h) => _http.get(_u('/teams/$teamId/members'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), TeamMember.fromJson);
  }

  /// POST /teams/:id/jobs/:jobId/assign — assign a job to a worker.
  Future<Map<String, dynamic>> assignTeamJob(
    String teamId,
    String jobId,
    String workerUserId,
  ) async {
    final res = await _send((h) => _http.post(
        _u('/teams/$teamId/jobs/$jobId/assign'),
        headers: h,
        body: jsonEncode({'worker_user_id': workerUserId})),
        mutating: true);
    if (res.statusCode != 200) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// DELETE /teams/:id/jobs/:jobId/assignment — unassign a job.
  Future<void> unassignTeamJob(String teamId, String jobId) async {
    final res = await _send((h) => _http.delete(
        _u('/teams/$teamId/jobs/$jobId/assignment'),
        headers: h));
    if (res.statusCode != 200) _throwError(res);
  }

  /// GET /teams/:id/jobs — team jobs visible to me.
  Future<List<Job>> listTeamJobs(String teamId) async {
    final res = await _send(
        (h) => _http.get(_u('/teams/$teamId/jobs'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), Job.fromJson);
  }

  /// GET /teams/:id/earnings — team earnings summary.
  Future<TeamEarnings> getTeamEarnings(String teamId) async {
    final res = await _send(
        (h) => _http.get(_u('/teams/$teamId/earnings'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return TeamEarnings.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /tenders — create a tender (organisation customer).
  Future<Tender> createTender(Map<String, dynamic> payload) async {
    final res = await _send((h) => _http.post(_u('/tenders'),
        headers: h, body: jsonEncode(payload)),
        mutating: true);
    if (res.statusCode != 201) _throwError(res);
    return Tender.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /tenders — my tenders.
  Future<List<Tender>> listMyTenders() async {
    final res =
        await _send((h) => _http.get(_u('/tenders'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), Tender.fromJson);
  }

  /// GET /tenders/open — open tenders for providers to quote on.
  Future<List<Tender>> listOpenTenders() async {
    final res = await _send(
        (h) => _http.get(_u('/tenders/open'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), Tender.fromJson);
  }

  /// GET /tenders/:id — one tender.
  Future<Tender> getTender(String tenderId) async {
    final res = await _send(
        (h) => _http.get(_u('/tenders/$tenderId'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return Tender.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /tenders/:id/quotes — submit a sealed quote (no fee at quote time;
  /// a flat PKR 500 lead fee is charged once to the winning provider at award).
  Future<TenderQuote> submitTenderQuote(
    String tenderId,
    Map<String, dynamic> payload,
  ) async {
    final res = await _send((h) => _http.post(_u('/tenders/$tenderId/quotes'),
        headers: h, body: jsonEncode(payload)),
        mutating: true);
    if (res.statusCode != 201) _throwError(res);
    return TenderQuote.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /tenders/:id/quotes — sealed until award.
  Future<List<TenderQuote>> listTenderQuotes(String tenderId) async {
    final res = await _send(
        (h) => _http.get(_u('/tenders/$tenderId/quotes'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), TenderQuote.fromJson);
  }

  /// GET /tenders/:id/audit — full audit trail, oldest first.
  Future<Map<String, dynamic>> getTenderAudit(String tenderId) async {
    final res = await _send(
        (h) => _http.get(_u('/tenders/$tenderId/audit'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// POST /tenders/:id/cancel — cancel my tender while open.
  Future<Tender> cancelTender(String tenderId) async {
    final res = await _send((h) => _http.post(_u('/tenders/$tenderId/cancel'),
        headers: h, body: jsonEncode({})),
        mutating: true);
    if (res.statusCode != 200) _throwError(res);
    return Tender.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /tenders/quotes/:quoteId/withdraw — withdraw my quote.
  Future<TenderQuote> withdrawTenderQuote(String quoteId) async {
    final res = await _send((h) => _http.post(
        _u('/tenders/quotes/$quoteId/withdraw'),
        headers: h,
        body: jsonEncode({})),
        mutating: true);
    if (res.statusCode != 200) _throwError(res);
    return TenderQuote.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /tenders/quotes/:quoteId/accept — award the tender (atomic).
  Future<Map<String, dynamic>> acceptTenderQuote(String quoteId) async {
    final res = await _send((h) => _http.post(
        _u('/tenders/quotes/$quoteId/accept'),
        headers: h,
        body: jsonEncode({})),
        mutating: true);
    if (res.statusCode != 201) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// POST /verification/face-match — selfie + CNIC photo (base64).
  /// Advisory score only; it never approves or rejects anything.
  Future<FaceMatchResult> submitFaceMatch({
    required String selfieBase64,
    required String cnicPhotoBase64,
    String? selfieStorageKey,
    String? cnicPhotoStorageKey,
  }) async {
    final res = await _send((h) => _http.post(_u('/verification/face-match'),
        headers: h,
        body: jsonEncode({
          'selfie_image_base64': selfieBase64,
          'cnic_photo_image_base64': cnicPhotoBase64,
          if (selfieStorageKey != null)
            'selfie_storage_key': selfieStorageKey,
          if (cnicPhotoStorageKey != null)
            'cnic_photo_storage_key': cnicPhotoStorageKey,
        })));
    if (res.statusCode != 201) _throwError(res);
    return FaceMatchResult.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /verification/face-match/:id — one face-match result.
  Future<FaceMatchResult> getFaceMatch(String resultId) async {
    final res = await _send((h) =>
        _http.get(_u('/verification/face-match/$resultId'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return FaceMatchResult.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /verification/liveness/start — start a liveness challenge.
  Future<LivenessChallenge> startLiveness() async {
    final res = await _send((h) => _http.post(
        _u('/verification/liveness/start'),
        headers: h,
        body: jsonEncode({})));
    if (res.statusCode != 201) _throwError(res);
    return LivenessChallenge.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /verification/liveness/:id/respond — answer the challenge.
  Future<Map<String, dynamic>> respondLiveness(
    String challengeId,
    List<String> observedActions,
  ) async {
    final res = await _send((h) => _http.post(
        _u('/verification/liveness/$challengeId/respond'),
        headers: h,
        body: jsonEncode({'observed_actions': observedActions})));
    if (res.statusCode != 201) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// GET /verification/liveness/:id — one liveness challenge.
  Future<LivenessChallenge> getLiveness(String challengeId) async {
    final res = await _send((h) =>
        _http.get(_u('/verification/liveness/$challengeId'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return LivenessChallenge.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /jobs/:id/escrow/hold — hold the job amount in escrow
  /// (customer; job must be COMPLETED and at/above the PKR 5,000 minimum).
  Future<EscrowHold> createEscrowHold(String jobId) async {
    final res = await _send((h) => _http.post(_u('/jobs/$jobId/escrow/hold'),
        headers: h, body: jsonEncode({})),
        mutating: true);
    if (res.statusCode != 201) _throwError(res);
    return EscrowHold.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /escrow/holds/:id/release — confirm completion, release to provider.
  Future<EscrowHold> releaseEscrowHold(String holdId) async {
    final res = await _send((h) => _http.post(
        _u('/escrow/holds/$holdId/release'),
        headers: h,
        body: jsonEncode({})),
        mutating: true);
    if (res.statusCode != 200) _throwError(res);
    return EscrowHold.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /escrow/holds — my escrow holds.
  Future<List<EscrowHold>> listEscrowHolds() async {
    final res = await _send(
        (h) => _http.get(_u('/escrow/holds'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), EscrowHold.fromJson);
  }

  /// POST /payouts — request a payout (finance must approve; sandbox only).
  Future<Payout> requestPayout({
    required double amountPkr,
    required String method,
    required String destinationPhone,
    required String kind,
    String? scheduledFor,
  }) async {
    final res = await _send((h) => _http.post(_u('/payouts'),
        headers: h,
        body: jsonEncode({
          'amount_pkr': amountPkr,
          'method': method,
          'destination_phone': destinationPhone,
          'kind': kind,
          if (scheduledFor != null) 'scheduled_for': scheduledFor,
        })),
        mutating: true);
    if (res.statusCode != 201) _throwError(res);
    return Payout.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /payouts — my payouts (every item carries sandbox: true).
  Future<List<Payout>> listPayouts() async {
    final res =
        await _send((h) => _http.get(_u('/payouts'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), Payout.fromJson);
  }

  /// GET /payouts/:id — one payout.
  Future<Payout> getPayout(String payoutId) async {
    final res = await _send(
        (h) => _http.get(_u('/payouts/$payoutId'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return Payout.fromJson(_decode(res) as Map<String, dynamic>);
  }

  // ---- Phase 4 (v1.6): partner parts ordering + warranty ---------------
  // Partners (item 5): ApiClient implements PartnerApi (see
  // features/provider/parts_order_screen.dart), so PartsOrderScreen can
  // be constructed with `api: ref.read(apiClientProvider)`. Prices are
  // ALWAYS server-priced from the catalog: the app sends item ids +
  // quantities only; totals come from the API response, never from a
  // client-side sum. Every order view carries the partner disclosure.
  // Warranty (item 4): signatures from features/warranty/
  // warranty_widgets.dart. The fee is collected at payment time
  // (collect-fee, called automatically at settlement server-side);
  // opt-in only prices it. NOT compile-verified (no Flutter/Dart here).

  /// GET /partners/catalog — search/list the parts catalog.
  @override
  Future<List<PartnerCatalogItem>> listPartnerCatalog(
      {String? q, String? category, bool inStockOnly = false}) async {
    final query = <String, String>{};
    if (q != null && q.isNotEmpty) query['q'] = q;
    if (category != null && category.isNotEmpty) query['category'] = category;
    if (inStockOnly) query['in_stock_only'] = 'true';
    final res = await _send(
        (h) => _http.get(_u('/partners/catalog', query), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    final items = (body is Map ? body['items'] as List? : body as List?) ?? [];
    return items
        .map((e) => PartnerCatalogItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// POST /partners/orders — place a parts order for one of my jobs
  /// (provider). Sends item ids + quantities only; the server prices
  /// every line from the catalog and rejects a mismatched price.
  @override
  Future<PartnerOrder> createPartnerOrder(
      {required String jobId,
      required List<Map<String, dynamic>> items}) async {
    final res = await _send(
        (h) => _http.post(_u('/partners/orders'),
            headers: h,
            body: jsonEncode({'job_id': jobId, 'lines': items})),
        mutating: true);
    if (res.statusCode != 201) _throwError(res);
    return PartnerOrder.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /partners/orders — my partner orders (provider).
  @override
  Future<List<PartnerOrder>> listMyPartnerOrders() async {
    final res = await _send(
        (h) => _http.get(_u('/partners/orders'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    final items = (body is List ? body : (body as Map)['items'] as List?) ?? [];
    return items
        .map((e) => PartnerOrder.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// GET /partners/orders/:id — one partner order (job party only).
  Future<PartnerOrder> getPartnerOrder(String id) async {
    final res = await _send(
        (h) => _http.get(_u('/partners/orders/$id'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return PartnerOrder.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /partners/orders/:id/{confirm|deliver|cancel}.
  @override
  Future<PartnerOrder> transitionPartnerOrder(String id, String action) async {
    assert(action == 'confirm' || action == 'deliver' || action == 'cancel',
        'action must be confirm, deliver or cancel');
    final res = await _send(
        (h) => _http.post(_u('/partners/orders/$id/$action'),
            headers: h, body: jsonEncode({})),
        mutating: true);
    if (res.statusCode != 200) _throwError(res);
    return PartnerOrder.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /partners/jobs/:jobId/orders — job partner-orders + disclosure.
  @override
  Future<JobPartnerOrders> getJobPartnerOrders(String jobId) async {
    final res = await _send(
        (h) => _http.get(_u('/partners/jobs/$jobId/orders'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return JobPartnerOrders.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /warranty/quote?job_price_pkr=… — fee quote before opting in.
  Future<Map<String, dynamic>> getWarrantyQuote(double jobPricePkr) async {
    final res = await _send((h) => _http.get(
        _u('/warranty/quote', {'job_price_pkr': jobPricePkr.toString()}),
        headers: h));
    if (res.statusCode != 200) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// POST /jobs/:id/warranty/opt-in — opt a job into the 7-day warranty
  /// (customer, Tier 3 only). No money moves here.
  Future<Map<String, dynamic>> optInWarranty(String jobId) async {
    final res = await _send(
        (h) => _http.post(_u('/jobs/$jobId/warranty/opt-in'),
            headers: h, body: jsonEncode({})),
        mutating: true);
    if (res.statusCode != 201) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// POST /jobs/:id/warranty/collect-fee — collect the warranty fee at
  /// payment time. Normally automatic at settlement server-side; this is
  /// the manual fallback when the warranty is still pending_payment.
  Future<Map<String, dynamic>> collectWarrantyFee(String jobId) async {
    final res = await _send(
        (h) => _http.post(_u('/jobs/$jobId/warranty/collect-fee'),
            headers: h, body: jsonEncode({})),
        mutating: true);
    if (res.statusCode != 200) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// GET /providers/:id/warranty-badge — Tier 3 shows WARRANTY_7_DAY.
  Future<Map<String, dynamic>> getWarrantyBadge(String providerId) async {
    final res = await _send((h) =>
        _http.get(_u('/providers/$providerId/warranty-badge'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// GET /jobs/:id/warranty/receipt — job price, fee, coverage, claim.
  Future<Map<String, dynamic>> getJobWarrantyReceipt(String jobId) async {
    final res = await _send((h) =>
        _http.get(_u('/jobs/$jobId/warranty/receipt'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// POST /jobs/:id/warranty/claims — file a claim within 7 days.
  Future<Map<String, dynamic>> fileWarrantyClaim(String jobId,
      {required String reason, required String description}) async {
    final res = await _send(
        (h) => _http.post(_u('/jobs/$jobId/warranty/claims'),
            headers: h,
            body: jsonEncode({'reason': reason, 'description': description})),
        mutating: true);
    if (res.statusCode != 201) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }

  /// GET /warranty/rules — published warranty rules (public).
  Future<Map<String, dynamic>> getWarrantyRules() async {
    final res = await _send(
        (h) => _http.get(_u('/warranty/rules'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return _decode(res) as Map<String, dynamic>;
  }
  // ---- Batch 2 ------------------------------------------------------------
  // Favourites, photo reviews, Live Support, push preferences,
  // completion confirmation, no-show reports, active promotions.
  // These endpoints are the Batch 2 contract; at the time of writing
  // the backend agent was still adding them, so each call follows the
  // contract exactly as specified and degrades gracefully (callers
  // show a plain message) if the backend answers 404.

  /// POST /providers/:id/favourite.
  Future<void> addFavourite(String providerId) async {
    final res = await _send(
      (h) => _http.post(_u('/providers/$providerId/favourite'), headers: h, body: '{}'),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
  }

  /// DELETE /providers/:id/favourite.
  Future<void> removeFavourite(String providerId) async {
    final res = await _send(
      (h) => _http.delete(_u('/providers/$providerId/favourite'), headers: h),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 204) _throwError(res);
  }

  /// GET /favourites — {items: [provider list items], next_cursor}.
  /// NOTE: the backend's favourite items are a SLIM shape
  /// {provider_id, display_name, provider_type, rating_bayes,
  /// jobs_completed, favourited_at} — not the full provider shape —
  /// so they are parsed with [ServiceProvider.fromFavouriteJson].
  Future<({List<ServiceProvider> items, String? nextCursor})> listFavourites({String? cursor}) async {
    final query = <String, String>{
      if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
    };
    final res = await _send((h) => _http.get(_u('/favourites', query), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    return (
      items: parsePage(body, ServiceProvider.fromFavouriteJson),
      nextCursor: parseNextCursor(body),
    );
  }

  /// GET /promotions/active (public) — {items: [{code, title,
  /// discount_text}]}. The home banner shows ONLY these items.
  Future<List<PromoItem>> getActivePromotions() async {
    final res = await _send((h) => _http.get(_u('/promotions/active'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    final list = (body is Map ? body['items'] ?? [] : []) as List;
    return list.map((e) => PromoItem.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// GET /promotions/today (public) — Batch 3 "Deals of the day".
  Future<List<TodayDeal>> getDealsToday() async {
    final res = await _send((h) => _http.get(_u('/promotions/today'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    final list = (body is Map ? body['items'] ?? [] : []) as List;
    return list.map((e) => TodayDeal.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// GET /providers/me — Batch 3: the provider's own profile (its id is
  /// what the "My QR code" screen encodes).
  Future<MyProviderProfile> getMyProviderProfile() async {
    final res = await _send((h) => _http.get(_u('/providers/me'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return MyProviderProfile.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /providers/me/earnings — Batch 3: provider earnings dashboard.
  Future<ProviderEarnings> getProviderEarnings() async {
    final res = await _send((h) => _http.get(_u('/providers/me/earnings'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return ProviderEarnings.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// GET /providers/:id/reviews — public, paginated {items, next_cursor}.
  /// Each review carries `photos: string[]` (Batch 2).
  Future<({List<ProviderReview> items, String? nextCursor})> getProviderReviews(String providerId, {String? cursor}) async {
    final query = <String, String>{
      if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
    };
    final res = await _send((h) => _http.get(_u('/providers/$providerId/reviews', query), headers: h));
    if (res.statusCode != 200) _throwError(res);
    final body = _decode(res);
    return (
      items: parsePage(body, ProviderReview.fromJson),
      nextCursor: parseNextCursor(body),
    );
  }

  /// Signed-URL upload for a review photo, mirroring the dispute
  /// evidence flow (POST /disputes/:id/evidence/upload-request ->
  /// {upload_url, storage_key}, PUT bytes, attach the key).
  /// Contract assumed: POST /jobs/:id/reviews/upload-request returns
  /// the same {upload_url, storage_key} shape. If the backend has not
  /// added it yet, this throws and the rating screen submits the
  /// review without photos instead of failing the review.
  Future<({String uploadUrl, String storageKey})> requestReviewPhotoUpload(String jobId) async {
    final res = await _send(
      (h) => _http.post(_u('/jobs/$jobId/reviews/upload-request'), headers: h, body: '{}'),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    final body = _decode(res) as Map<String, dynamic>;
    return (
      uploadUrl: (body['upload_url'] ?? '').toString(),
      storageKey: (body['storage_key'] ?? '').toString(),
    );
  }

  /// PUTs raw photo bytes to a signed upload URL (same flow as
  /// provider documents / dispute evidence). Returns true on 2xx.
  Future<bool> uploadPhotoBytes(String uploadUrl, List<int> bytes, {String contentType = 'image/jpeg'}) async {
    try {
      final res = await _http.put(
        Uri.parse(uploadUrl),
        headers: {'Content-Type': contentType},
        body: bytes,
      );
      return res.statusCode >= 200 && res.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  /// POST /jobs/:id/reviews — Batch 2 adds optional photo_keys (max 3).
  Future<void> submitReviewWithPhotos(String jobId, int stars, List<String> tags, String comment, {List<String> photoKeys = const []}) async {
    final res = await _send(
      (h) => _http.post(_u('/jobs/$jobId/reviews'),
          headers: h,
          body: jsonEncode({
            'stars': stars,
            'tags': tags,
            'comment': comment,
            if (photoKeys.isNotEmpty) 'photo_keys': photoKeys.take(3).toList(),
          })),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
  }

  /// POST /support/threads {subject, message}.
  Future<SupportThread> createSupportThread({required String subject, required String message}) async {
    final res = await _send(
      (h) => _http.post(_u('/support/threads'),
          headers: h, body: jsonEncode({'subject': subject, 'message': message})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    final body = _decode(res) as Map<String, dynamic>;
    final threadJson = (body['thread'] as Map<String, dynamic>?) ?? body;
    return SupportThread.fromJson(threadJson);
  }

  /// GET /support/threads.
  Future<List<SupportThread>> listSupportThreads() async {
    final res = await _send((h) => _http.get(_u('/support/threads'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), SupportThread.fromJson);
  }

  /// GET /support/threads/:id/messages.
  Future<List<SupportMessage>> getSupportMessages(String threadId) async {
    final res = await _send((h) => _http.get(_u('/support/threads/$threadId/messages'), headers: h));
    if (res.statusCode != 200) _throwError(res);
    return parsePage(_decode(res), SupportMessage.fromJson);
  }

  /// POST /support/threads/:id/messages {body} — the backend DTO is
  /// SendSupportMessageDto {body} (not `message`).
  Future<SupportMessage> sendSupportMessage(String threadId, String message) async {
    final res = await _send(
      (h) => _http.post(_u('/support/threads/$threadId/messages'),
          headers: h, body: jsonEncode({'body': message})),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
    return SupportMessage.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// PATCH /users/me/notification-preferences {push_enabled}.
  /// NOTE: this only syncs the preference. Real push delivery needs
  /// Firebase (see docs/push-notifications-setup.md) — there is no
  /// firebase_messaging in this app and no FCM token is invented here.
  Future<void> updateNotificationPreferences({required bool pushEnabled}) async {
    final res = await _send(
      (h) => _http.patch(_u('/users/me/notification-preferences'),
          headers: h, body: jsonEncode({'push_enabled': pushEnabled})),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
  }

  /// POST /jobs/:id/confirm-completion (customer-only). The job's
  /// payment settles only after this call.
  Future<Job> confirmCompletion(String jobId) async {
    final res = await _send(
      (h) => _http.post(_u('/jobs/$jobId/confirm-completion'), headers: h, body: '{}'),
      mutating: true,
    );
    if (res.statusCode != 200) _throwError(res);
    return Job.fromJson(_decode(res) as Map<String, dynamic>);
  }

  /// POST /jobs/:id/report-no-show (customer-only, after scheduled_at).
  Future<void> reportNoShow(String jobId) async {
    final res = await _send(
      (h) => _http.post(_u('/jobs/$jobId/report-no-show'), headers: h, body: '{}'),
      mutating: true,
    );
    if (res.statusCode != 200 && res.statusCode != 201) _throwError(res);
  }

  /// A review photo value is only a fetchable image when the backend
  /// returned a full http(s) URL; a bare storage key is not.
  static String? photoDisplayUrl(String photo) =>
      photo.startsWith('http://') || photo.startsWith('https://') ? photo : null;
}

final apiClientProvider = Provider<ApiClient>((ref) => ApiClient());
