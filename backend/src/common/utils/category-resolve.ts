import { ApiError } from '../errors/api-error';
// v1.1 identifier rule: category_id is always a UUID end-to-end. A client
// may instead send category_slug; the API resolves the slug to its canonical
// UUID and echoes the UUID in every response. If BOTH are sent they must
// resolve to the same category, otherwise 422.
export interface CategoryLookup {
  byId(id: string): Promise<{ id: string } | null>;
  bySlug(slug: string): Promise<{ id: string } | null>;
}
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: string): boolean { return UUID_RE.test(v); }

export async function resolveCategoryId(
  lookup: CategoryLookup,
  opts: { category_id?: string | null; category_slug?: string | null },
): Promise<string> {
  const { category_id, category_slug } = opts;
  if (category_id && !isUuid(category_id)) {
    throw new ApiError(422, 'CATEGORY_ID_NOT_UUID', 'category_id must be a UUID; send category_slug to resolve by slug', { category_id });
  }
  let byId: { id: string } | null = null;
  let bySlug: { id: string } | null = null;
  if (category_id) byId = await lookup.byId(category_id);
  if (category_slug) bySlug = await lookup.bySlug(category_slug);
  if (category_id && !byId) throw new ApiError(422, 'CATEGORY_NOT_FOUND', `Unknown category_id: ${category_id}`, { category_id });
  if (category_slug && !bySlug) throw new ApiError(422, 'CATEGORY_NOT_FOUND', `Unknown category_slug: ${category_slug}`, { category_slug });
  if (byId && bySlug && byId.id !== bySlug.id) {
    throw new ApiError(422, 'CATEGORY_MISMATCH', 'category_id and category_slug resolve to different categories', { category_id, category_slug });
  }
  const resolved = (byId ?? bySlug)?.id;
  if (!resolved) throw new ApiError(422, 'CATEGORY_REQUIRED', 'Provide category_id (UUID) or category_slug');
  return resolved;
}
