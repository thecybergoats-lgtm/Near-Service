import { resolveCategoryId } from '../../src/common/utils/category-resolve';
import { ApiError } from '../../src/common/errors/api-error';
const lookup = {
  byId: async (id: string) => (id === '11111111-1111-4111-8111-111111111111' ? { id } : null),
  bySlug: async (slug: string) => (slug === 'book-binding' ? { id: '11111111-1111-4111-8111-111111111111' } : slug === 'ac-repair' ? { id: '22222222-2222-4222-8222-222222222222' } : null),
};
describe('category resolution (v1.1: UUID end-to-end, slug resolved server-side)', () => {
  it('resolves a UUID directly', async () => {
    await expect(resolveCategoryId(lookup, { category_id: '11111111-1111-4111-8111-111111111111' })).resolves.toBe('11111111-1111-4111-8111-111111111111');
  });
  it('resolves a slug to the canonical UUID', async () => {
    await expect(resolveCategoryId(lookup, { category_slug: 'book-binding' })).resolves.toBe('11111111-1111-4111-8111-111111111111');
  });
  it('accepts both when they agree', async () => {
    await expect(resolveCategoryId(lookup, { category_id: '11111111-1111-4111-8111-111111111111', category_slug: 'book-binding' })).resolves.toBe('11111111-1111-4111-8111-111111111111');
  });
  it('returns 422 when id and slug disagree', async () => {
    const err = await resolveCategoryId(lookup, { category_id: '11111111-1111-4111-8111-111111111111', category_slug: 'ac-repair' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('CATEGORY_MISMATCH');
  });
  it('returns 422 for a non-UUID category_id', async () => {
    const err = await resolveCategoryId(lookup, { category_id: 'book-binding' }).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.code).toBe('CATEGORY_ID_NOT_UUID');
  });
  it('returns 422 when neither id nor slug is sent', async () => {
    const err = await resolveCategoryId(lookup, {}).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.code).toBe('CATEGORY_REQUIRED');
  });
  it('returns 422 for an unknown slug', async () => {
    const err = await resolveCategoryId(lookup, { category_slug: 'nope' }).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.code).toBe('CATEGORY_NOT_FOUND');
  });
});
