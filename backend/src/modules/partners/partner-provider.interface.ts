// PartnerProvider — the supplier adapter interface (Phase 4, item 5).
// The working implementation is LocalPartnerProvider below: a real,
// queryable parts catalog stored in Postgres (partners +
// partner_catalog_items, seeded by db/0020_partners.sql). A live supplier
// is swapped in by implementing this same interface against the
// supplier's API — see docs/phase4-partners.md. The service never talks
// to a supplier except through this interface, so the swap touches one
// class, not the order flow, ledger or disclosure.
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import { paisaToPkr } from '../../common/utils/money';

export type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export interface CatalogItemView {
  id: string;
  partner_id: string;
  partner_name: string;
  partner_slug: string;
  sku: string;
  name: string;
  category: string;
  description: string | null;
  unit_price_paisa: number;
  unit_price_pkr: number;
  stock_qty: number;
  in_stock: boolean;
  is_active: boolean;
}

export interface CatalogListOpts {
  q?: string;
  category?: string;
  partner_id?: string;
  in_stock_only?: boolean;
  limit?: number;
  offset?: number;
}

export function toCatalogItem(row: Record<string, unknown>): CatalogItemView {
  const price = Number(row.unit_price_paisa);
  return {
    id: String(row.id),
    partner_id: String(row.partner_id),
    partner_name: String(row.partner_name ?? ''),
    partner_slug: String(row.partner_slug ?? ''),
    sku: String(row.sku),
    name: String(row.name),
    category: String(row.category),
    description: row.description ? String(row.description) : null,
    unit_price_paisa: price,
    unit_price_pkr: paisaToPkr(price),
    stock_qty: Number(row.stock_qty),
    in_stock: Number(row.stock_qty) > 0,
    is_active: Boolean(row.is_active),
  };
}

const CATALOG_SELECT = `SELECT i.*, p.name AS partner_name, p.slug AS partner_slug
  FROM partner_catalog_items i JOIN partners p ON p.id=i.partner_id`;

export interface PartnerProvider {
  /** Stable slug identifying this supplier adapter (e.g. 'local'). */
  readonly slug: string;
  readonly displayName: string;
  listCatalog(opts: CatalogListOpts, client?: QueryClient): Promise<{ items: CatalogItemView[]; total: number }>;
  searchCatalog(q: string, opts?: Omit<CatalogListOpts, 'q'>, client?: QueryClient): Promise<{ items: CatalogItemView[]; total: number }>;
  getCatalogItem(id: string, client?: QueryClient): Promise<CatalogItemView | null>;
  /** Reserve stock inside the caller's transaction; throws 409
   *  INSUFFICIENT_STOCK when the quantity is not available. */
  reserveStock(client: QueryClient, itemId: string, quantity: number): Promise<void>;
  /** Return reserved stock (order cancelled). */
  releaseStock(client: QueryClient, itemId: string, quantity: number): Promise<void>;
}

/** Local parts catalog (AC parts, hardware, electrical, plumbing) backed
 *  by Postgres. No network, no API key, no live supplier — this IS the
 *  working implementation until a live supplier is onboarded. */
export class LocalPartnerProvider implements PartnerProvider {
  readonly slug = 'local';
  readonly displayName = 'Local Parts Catalog';

  constructor(private db: DatabaseService) {}

  private client(client?: QueryClient): QueryClient {
    return client ?? (this.db as unknown as QueryClient);
  }

  async listCatalog(opts: CatalogListOpts, client?: QueryClient): Promise<{ items: CatalogItemView[]; total: number }> {
    const c = this.client(client);
    const lim = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const off = Math.max(opts.offset ?? 0, 0);
    const where: string[] = [`i.is_active`, `p.is_active`];
    const params: unknown[] = [];
    if (opts.category) { params.push(opts.category); where.push(`i.category=$${params.length}::varchar`); }
    if (opts.partner_id) { params.push(opts.partner_id); where.push(`i.partner_id=$${params.length}::uuid`); }
    if (opts.in_stock_only) where.push(`i.stock_qty > 0`);
    if (opts.q?.trim()) {
      params.push(`%${opts.q.trim()}%`);
      where.push(`(i.name ILIKE $${params.length} OR i.sku ILIKE $${params.length} OR COALESCE(i.description,'') ILIKE $${params.length})`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = Number((await c.query(`SELECT COUNT(*)::text AS c FROM partner_catalog_items i JOIN partners p ON p.id=i.partner_id ${whereSql}`, params)).rows[0]?.c ?? 0);
    const rows = (await c.query(
      `${CATALOG_SELECT} ${whereSql} ORDER BY i.category, i.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, lim, off],
    )).rows;
    return { items: rows.map(toCatalogItem), total };
  }

  searchCatalog(q: string, opts: Omit<CatalogListOpts, 'q'> = {}, client?: QueryClient): Promise<{ items: CatalogItemView[]; total: number }> {
    return this.listCatalog({ ...opts, q }, client);
  }

  async getCatalogItem(id: string, client?: QueryClient): Promise<CatalogItemView | null> {
    const rows = (await this.client(client).query(`${CATALOG_SELECT} WHERE i.id=$1`, [id])).rows;
    return rows[0] ? toCatalogItem(rows[0]) : null;
  }

  async reserveStock(client: QueryClient, itemId: string, quantity: number): Promise<void> {
    const row = (await client.query(
      `UPDATE partner_catalog_items SET stock_qty = stock_qty - $2, updated_at=now()
        WHERE id=$1 AND stock_qty >= $2 RETURNING id`,
      [itemId, quantity],
    )).rows[0];
    if (!row) throw Errors.conflict('INSUFFICIENT_STOCK', 'Not enough stock for this item');
  }

  async releaseStock(client: QueryClient, itemId: string, quantity: number): Promise<void> {
    await client.query(
      `UPDATE partner_catalog_items SET stock_qty = stock_qty + $2, updated_at=now() WHERE id=$1`,
      [itemId, quantity],
    );
  }
}
