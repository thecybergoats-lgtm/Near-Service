import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import { fairRangeFromPrices } from '../../common/utils/fair-range';
import { resolveCategoryId, isUuid } from '../../common/utils/category-resolve';
import { SearchGatewayService } from '../search/search-gateway.service';

/** Validate a category form JSON Schema. Rules (per the Phase 2 task): it
 *  must be an object with type 'object' and a properties object; every
 *  property must have a type; enum values, when present, must be arrays. */
export function validateFormSchema(schema: unknown): asserts schema is Record<string, unknown> {
  const fail = (msg: string) => { throw Errors.unprocessable('INVALID_FORM_SCHEMA', msg); };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) fail('form schema must be a JSON object');
  const s = schema as Record<string, unknown>;
  if (s.type !== 'object') fail("form schema must have type 'object'");
  if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) fail('form schema must have a properties object');
  for (const [name, prop] of Object.entries(s.properties as Record<string, unknown>)) {
    if (!prop || typeof prop !== 'object' || Array.isArray(prop)) fail(`property '${name}' must be an object`);
    const p = prop as Record<string, unknown>;
    if (typeof p.type !== 'string') fail(`property '${name}' must have a string type`);
    if (p.enum !== undefined && !Array.isArray(p.enum)) fail(`property '${name}' enum must be an array`);
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string')) fail('required must be an array of property names');
  }
}
@Injectable()
export class CatalogService {
  constructor(private db: DatabaseService, private searchGateway: SearchGatewayService) {}
  categoryLookup() {
    return {
      byId: async (id: string) => (await this.db.query<{ id: string }>(`SELECT id FROM categories WHERE id=$1 AND is_active`, [id])).rows[0] ?? null,
      bySlug: async (slug: string) => (await this.db.query<{ id: string }>(`SELECT id FROM categories WHERE slug=$1 AND is_active`, [slug])).rows[0] ?? null,
    };
  }
  async tree() {
    const rows = (await this.db.query(`SELECT id, parent_id, level, slug, name_en, name_ur, name_roman, icon_key, sort_order FROM categories WHERE is_active ORDER BY level, sort_order`)).rows;
    const byId = new Map<string, Record<string, unknown> & { children: unknown[] }>();
    rows.forEach((r) => byId.set(r.id as string, { ...r, children: [] }));
    const roots: unknown[] = [];
    rows.forEach((r) => {
      const node = byId.get(r.id as string)!;
      if (r.parent_id && byId.has(r.parent_id as string)) (byId.get(r.parent_id as string)!.children as unknown[]).push(node);
      else roots.push(node);
    });
    return roots;
  }
  /** form-schema: categoryId is a UUID end-to-end (v1.1). */
  async formSchema(categoryId: string) {
    if (!isUuid(categoryId)) throw Errors.unprocessable('CATEGORY_ID_NOT_UUID', 'categoryId must be a UUID', { categoryId });
    const row = (await this.db.query(
      `SELECT c.id, c.slug, c.name_en, s.schema FROM categories c LEFT JOIN category_form_schemas s ON s.category_id=c.id WHERE c.id=$1`, [categoryId])).rows[0];
    if (!row) throw Errors.notFound('Category');
    return { category_id: row.id, slug: row.slug, name_en: row.name_en, form_schema: row.schema ?? { type: 'object', properties: {} } };
  }
  /** Admin write for a category form schema (PUT /admin/categories/:id/form-schema).
   *  Validates the JSON Schema, then upserts into category_form_schemas. */
  async putFormSchema(categoryId: string, schema: unknown, adminId: string) {
    validateFormSchema(schema);
    if (!isUuid(categoryId)) throw Errors.unprocessable('CATEGORY_ID_NOT_UUID', 'categoryId must be a UUID', { categoryId });
    const cat = (await this.db.query(`SELECT id, slug, name_en FROM categories WHERE id=$1`, [categoryId])).rows[0];
    if (!cat) throw Errors.notFound('Category');
    const row = (await this.db.query(
      `INSERT INTO category_form_schemas (category_id, schema, updated_by, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (category_id) DO UPDATE SET schema=EXCLUDED.schema, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING *`,
      [categoryId, JSON.stringify(schema), adminId])).rows[0];
    return { category_id: cat.id, slug: cat.slug, name_en: cat.name_en, form_schema: row.schema };
  }
  /** Fair range from completed-job prices (percentiles); falls back to seed
   *  fair-price data when no completed jobs exist yet. */
  async fairRange(categoryId: string | undefined, categorySlug: string | undefined, cityId?: string) {
    const resolved = await resolveCategoryId(this.categoryLookup(), { category_id: categoryId, category_slug: categorySlug });
    const prices = (await this.db.query<{ price: string }>(
      `SELECT j.agreed_price::text AS price FROM jobs j JOIN service_requests r ON r.id=j.request_id
        WHERE r.category_id=$1 AND j.state IN ('COMPLETED','PAYMENT_SETTLED','RATED') ORDER BY j.created_at DESC LIMIT 500`, [resolved])).rows
      .map((r) => Number(r.price));
    let range = fairRangeFromPrices(prices);
    if (range.sampleSize === 0) {
      const seed = (await this.db.query<{ min_p: string; typical_p: string; max_p: string; sample_size: number }>(
        `SELECT min_price AS min_p, typical_price AS typical_p, max_price AS max_p, sample_size FROM fair_price_seed WHERE category_id=$1 AND ($2::uuid IS NULL OR city_id=$2) ORDER BY sample_size DESC LIMIT 1`,
        [resolved, cityId ?? null])).rows[0];
      if (seed) range = { min: Number(seed.min_p), typical: Number(seed.typical_p), max: Number(seed.max_p), sampleSize: seed.sample_size, hidden: seed.sample_size < 5 };
    }
    // OpenAPI FairRange shape: {min, typical, max, sample_size}.
    return { min: range.min, typical: range.typical, max: range.max, sample_size: range.sampleSize };
  }
  /** GET /search — Phase 4, item 1: delegated to the search gateway
   *  (SearchProvider interface). Behaviour and response shape are
   *  unchanged; the provider (trigram / scaled / remote) is selected by
   *  SEARCH_PROVIDER / SEARCH_SERVICE_URL. The SQL that used to live here
   *  is now TrigramSearchProvider, verbatim. */
  async search(q: string, lat?: number, lng?: number, locale = 'en', cursor?: string, limit = 20) {
    return this.searchGateway.search({ q, lat, lng, locale, cursor, limit });
  }
}
