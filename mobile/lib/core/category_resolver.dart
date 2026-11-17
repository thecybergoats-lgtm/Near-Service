import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';
import 'models.dart';

/// Resolves between category slugs and UUIDs (PRD v1.1 identifier rule).
///
/// The API contract is strict: `category_id` is ALWAYS a UUID
/// (`format: uuid`). A client may instead send `category_slug` and the
/// server resolves it. This helper is the single place the app translates
/// between the two, using the GET /categories tree (which returns both
/// `id` and `slug` for every category).
///
/// Rules enforced here and in [ApiClient]:
/// - a slug such as `book-binding` is NEVER sent as `category_id`;
/// - when only a slug is known, the call sends `category_slug` instead;
/// - when the UUID is known, the call sends `category_id`.
class CategoryResolver {
  CategoryResolver(this._api);

  final ApiClient _api;

  List<Category>? _cache;

  static final _uuidPattern = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  );

  /// True when [value] is already a UUID (safe to send as `category_id`).
  static bool isUuid(String value) => _uuidPattern.hasMatch(value);

  /// Full category tree (level 1 + children), cached per app lifetime.
  /// Falls back to an empty list when the API is unreachable; callers
  /// then send the slug as `category_slug` instead of guessing a UUID.
  Future<List<Category>> all() async {
    if (_cache != null) return _cache!;
    try {
      _cache = await _api.getCategories();
    } catch (_) {
      _cache = const [];
    }
    return _cache!;
  }

  List<Category> _flatten(List<Category> cats) {
    final out = <Category>[];
    for (final c in cats) {
      out.add(c);
      out.addAll(_flatten(c.children));
    }
    return out;
  }

  /// Slug -> UUID via the category tree. Returns null when the slug is
  /// not in the tree (e.g. offline) — the caller must then send the slug
  /// as `category_slug`, never as `category_id`.
  Future<String?> idForSlug(String slug) async {
    final cats = await all();
    for (final c in _flatten(cats)) {
      if (c.slug == slug) return c.id;
    }
    return null;
  }

  /// UUID -> slug via the category tree. Returns null when unknown.
  Future<String?> slugForId(String id) async {
    final cats = await all();
    for (final c in _flatten(cats)) {
      if (c.id == id) return c.slug;
    }
    return null;
  }

  /// Resolves an incoming value that may be either a UUID or a slug.
  /// Returns `({categoryId, categorySlug})` with at most one side set:
  /// the UUID when it is known, otherwise the slug.
  Future<({String? categoryId, String? categorySlug})> resolve(
    String value,
  ) async {
    if (isUuid(value)) {
      return (categoryId: value, categorySlug: await slugForId(value));
    }
    return (categoryId: await idForSlug(value), categorySlug: value);
  }
}

final categoryResolverProvider = Provider<CategoryResolver>(
  (ref) => CategoryResolver(ref.read(apiClientProvider)),
);
