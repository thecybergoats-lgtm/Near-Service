import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Thin pg Pool wrapper. The pool is created lazily only when DATABASE_URL
 *  is set, so `npm run build` / unit tests work with no live database.
 *  All SQL is parameterised ($1, $2, ...) — never string-interpolated. */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool | null = null;

  private getPool(): Pool {
    if (!this.pool) {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL is not set — database unavailable');
      this.pool = new Pool({ connectionString: url, max: 20 });
      this.pool.on('error', (e) => this.logger.error('pg pool error', e));
    }
    return this.pool;
  }
  get available(): boolean { return !!process.env.DATABASE_URL; }
  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.getPool().query<T>(text, params as never[]);
  }
  async getClient(): Promise<PoolClient> { return this.getPool().connect(); }
  /** Run fn inside a single transaction; rolls back on any error. */
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async ping(): Promise<boolean> {
    try { await this.query('SELECT 1'); return true; } catch { return false; }
  }
  async onModuleDestroy() { if (this.pool) await this.pool.end(); }
}
