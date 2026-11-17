// SEO data layer (Phase 4, item 3). Reads real providers, real reviews
// and the real fair-price seed for the public landing / shop pages.
// Rendering lives in seo-render.ts (pure HTML); this file only fetches.
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import {
  LandingPageData,
  LandingProvider,
  ReviewSummary,
  ShopPageData,
  LandingIndexEntry,
} from './seo-render';

interface ReviewRow {
  reviewee_id: string;
  stars: number;
  comment: string | null;
  created_at: string;
}

@Injectable()
export class SeoService {
  constructor(private db: DatabaseService) {}

  /** Aggregate raw review rows into the public summary: average, count,
   *  1–5 distribution and the 3 most recent non-empty comments. Held
   *  reviews (is_held) never appear on a public page. */
  summarizeReviews(rows: ReviewRow[]): ReviewSummary {
    const count = rows.length;
    if (count === 0) return { reviewCount: 0, avgStars: null, distribution: {}, recentComments: [] };
    const avg = rows.reduce((s, r) => s + Number(r.stars), 0) / count;
    const distribution: Record<string, number> = {};
    for (const r of rows) distribution[String(r.stars)] = (distribution[String(r.stars)] ?? 0) + 1;
    const recentComments = rows
      .filter((r) => r.comment && r.comment.trim().length > 0)
      .slice(0, 3)
      .map((r) => ({ stars: Number(r.stars), comment: r.comment as string, createdAt: String(r.created_at) }));
    return { reviewCount: count, avgStars: Number(avg.toFixed(2)), distribution, recentComments };
  }

  private async reviewsFor(userIds: string[]): Promise<Map<string, ReviewRow[]>> {
    const byUser = new Map<string, ReviewRow[]>();
    if (userIds.length === 0) return byUser;
    const rows = (await this.db.query(
      `SELECT reviewee_id, stars, comment, created_at FROM reviews
        WHERE reviewee_id = ANY($1::uuid[]) AND is_held = false ORDER BY created_at DESC`,
      [userIds],
    )).rows as unknown as ReviewRow[];
    for (const r of rows) {
      const list = byUser.get(r.reviewee_id) ?? [];
      list.push(r);
      byUser.set(r.reviewee_id, list);
    }
    return byUser;
  }

  /** Data for /services/:categorySlug/:areaSlug. Providers are the
   *  online providers offering that category whose base point sits
   *  inside the city's default radius of the area centre. */
  async landingPageData(categorySlug: string, areaSlug: string): Promise<LandingPageData> {
    const head = (await this.db.query(
      `SELECT a.id AS area_id, a.name AS area_name, a.slug AS area_slug,
              c.id AS city_id, c.name AS city_name, c.slug AS city_slug, c.default_radius_km,
              cat.id AS category_id, cat.name_en AS category_name, cat.slug AS category_slug
         FROM city_areas a
         JOIN cities c ON c.id = a.city_id
         JOIN categories cat ON cat.slug = $1
        WHERE a.slug = $2`,
      [categorySlug, areaSlug],
    )).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!head) throw Errors.notFound('Landing page');
    const providers = (await this.db.query(
      `SELECT p.id, p.user_id, p.display_name, p.shop_name, p.provider_type, p.tier,
              p.rating_avg, p.jobs_completed, ps.starting_price
         FROM provider_profiles p
         JOIN provider_services ps ON ps.provider_id = p.id AND ps.category_id = $1
         JOIN city_areas a ON a.slug = $2
         JOIN cities c ON c.id = a.city_id
        WHERE p.deleted_at IS NULL AND p.is_online
          AND ST_DWithin(p.base_point, a.center, c.default_radius_km * 1000)
        ORDER BY p.rating_avg DESC, p.jobs_completed DESC`,
      [String(head.category_id), areaSlug],
    )).rows as unknown as Record<string, unknown>[];
    const reviews = await this.reviewsFor(providers.map((p) => String(p.user_id)));
    const fairPrice = (await this.db.query(
      `SELECT min_price, typical_price, max_price, sample_size, city_id FROM fair_price_seed
        WHERE category_id=$1 AND (city_id=$2 OR city_id IS NULL)
        ORDER BY (city_id IS NULL) ASC LIMIT 1`,
      [String(head.category_id), String(head.city_id)],
    )).rows[0] as unknown as Record<string, unknown> | undefined;
    const landingProviders: LandingProvider[] = providers.map((p) => ({
      id: String(p.id),
      displayName: String(p.display_name),
      shopName: p.shop_name ? String(p.shop_name) : null,
      providerType: String(p.provider_type),
      tier: Number(p.tier),
      ratingAvg: Number(p.rating_avg),
      jobsCompleted: Number(p.jobs_completed),
      startingPricePkr: p.starting_price != null ? Number(p.starting_price) : null,
      reviewSummary: this.summarizeReviews(reviews.get(String(p.user_id)) ?? []),
    }));
    return {
      categorySlug: String(head.category_slug),
      categoryName: String(head.category_name),
      areaSlug: String(head.area_slug),
      areaName: String(head.area_name),
      cityName: String(head.city_name),
      citySlug: String(head.city_slug),
      providers: landingProviders,
      fairPrice: fairPrice
        ? {
            minPrice: Number(fairPrice.min_price),
            typicalPrice: Number(fairPrice.typical_price),
            maxPrice: Number(fairPrice.max_price),
            sampleSize: Number(fairPrice.sample_size),
            source: fairPrice.city_id ? 'city' : 'global',
          }
        : null,
    };
  }

  /** Data for /shops/:providerId — the public shop page with the real
   *  review summary. The city is the nearest city centre to the
   *  provider's base point. */
  async shopPageData(providerId: string): Promise<ShopPageData> {
    const prof = (await this.db.query(
      `SELECT p.id, p.user_id, p.display_name, p.shop_name, p.provider_type, p.tier,
              p.rating_avg, p.jobs_completed, p.completion_rate,
              (SELECT c.name FROM cities c ORDER BY ST_Distance(p.base_point, c.center) ASC LIMIT 1) AS city_name
         FROM provider_profiles p WHERE p.id=$1 AND p.deleted_at IS NULL`,
      [providerId],
    )).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!prof) throw Errors.notFound('Provider');
    const services = (await this.db.query(
      `SELECT c.slug AS category_slug, c.name_en AS category_name, ps.starting_price
         FROM provider_services ps JOIN categories c ON c.id = ps.category_id
        WHERE ps.provider_id=$1 ORDER BY c.sort_order`,
      [providerId],
    )).rows as unknown as Record<string, unknown>[];
    const reviews = await this.reviewsFor([String(prof.user_id)]);
    return {
      providerId: String(prof.id),
      displayName: String(prof.display_name),
      shopName: prof.shop_name ? String(prof.shop_name) : null,
      providerType: String(prof.provider_type),
      tier: Number(prof.tier),
      ratingAvg: Number(prof.rating_avg),
      jobsCompleted: Number(prof.jobs_completed),
      completionRate: prof.completion_rate != null ? Number(prof.completion_rate) : null,
      cityName: prof.city_name ? String(prof.city_name) : null,
      services: services.map((s) => ({
        categorySlug: String(s.category_slug),
        categoryName: String(s.category_name),
        startingPricePkr: s.starting_price != null ? Number(s.starting_price) : null,
      })),
      reviewSummary: this.summarizeReviews(reviews.get(String(prof.user_id)) ?? []),
    };
  }

  /** Every enabled (category × area) landing page, with live provider
   *  counts — the index crawlers start from. Disabled categories
   *  (e.g. Karachi's, still pending) do not appear. */
  async landingIndex(): Promise<LandingIndexEntry[]> {
    const rows = (await this.db.query(
      `SELECT cat.slug AS category_slug, cat.name_en AS category_name,
              a.slug AS area_slug, a.name AS area_name, c.name AS city_name,
              (SELECT COUNT(*)::int FROM provider_profiles p
                JOIN provider_services ps ON ps.provider_id = p.id AND ps.category_id = cat.id
               WHERE p.deleted_at IS NULL AND p.is_online
                 AND ST_DWithin(p.base_point, a.center, c.default_radius_km * 1000)) AS provider_count
         FROM city_areas a
         JOIN cities c ON c.id = a.city_id
         JOIN city_category_overrides o ON o.city_id = c.id AND o.is_enabled
         JOIN categories cat ON cat.id = o.category_id
        ORDER BY c.name, a.name, cat.sort_order`,
    )).rows as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      categorySlug: String(r.category_slug),
      categoryName: String(r.category_name),
      areaSlug: String(r.area_slug),
      areaName: String(r.area_name),
      cityName: String(r.city_name),
      providerCount: Number(r.provider_count),
    }));
  }
}
