/** Cursor pagination envelope (OpenAPI v1.2/1.3 `Page`): every list endpoint
 *  returns `{ items, next_cursor }`; clients pass `next_cursor` back as
 *  `?cursor=` for the next page, and `next_cursor` is null on the last page.
 *
 *  Two cursor kinds exist in this codebase:
 *  - id cursors: the last item's id (lists ordered by a stable key such as
 *    (created_at, id)); services fetch limit+1 rows and call pageFromRows.
 *  - offset cursors: an opaque base64url token `{"o": <offset>}` for ranked
 *    or computed lists (nearby, search, commission rules) where no stable id
 *    key exists; use offsetPage on the fully-ranked in-memory list.
 *  A malformed offset cursor decodes to 0 (first page) rather than failing. */
export interface PageEnvelope<T> {
  items: T[];
  next_cursor: string | null;
}

export function pageOf<T>(items: T[], nextCursor: string | null): PageEnvelope<T> {
  return { items, next_cursor: nextCursor };
}

/** Split limit+1 id-keyed rows into a page; cursor is the last item's id.
 *  Rows are untyped query results — the id is read dynamically. */
export function pageFromRows<T extends Record<string, unknown>>(rows: T[], limit: number): PageEnvelope<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return pageOf(page, hasMore && page.length ? String(page[page.length - 1].id) : null);
}

/** Encode an offset as an opaque cursor token. */
export function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

/** Decode an offset cursor; garbage or a missing cursor means offset 0. */
export function decodeOffset(cursor?: string | null): number {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    return typeof v.o === 'number' && Number.isInteger(v.o) && v.o >= 0 ? v.o : 0;
  } catch {
    return 0;
  }
}

/** Slice a fully-ranked in-memory list by offset cursor. */
export function offsetPage<T>(all: T[], cursor: string | undefined, limit: number): PageEnvelope<T> {
  const start = decodeOffset(cursor);
  const page = all.slice(start, start + limit);
  const next = start + limit < all.length ? encodeOffset(start + limit) : null;
  return pageOf(page, next);
}
