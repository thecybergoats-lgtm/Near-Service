import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import { bayesianRating } from '../../common/utils/ranking';

export interface FavouriteItem {
  provider_id: string;
  display_name: string;
  provider_type: string;
  rating_bayes: number;
  jobs_completed: number;
  favourited_at: string;
}

@Injectable()
export class FavouritesService {
  constructor(private db: DatabaseService) {}

  /** Favourite a provider. Idempotent: favouriting twice returns the same
   *  row (second call reports already=true) and never creates a duplicate —
   *  enforced by the (user_id, provider_id) PK on user_favourites. */
  async add(userId: string, providerId: string): Promise<{ provider_id: string; favourited_at: string; already: boolean }> {
    const profile = (await this.db.query<{ id: string }>(
      `SELECT id FROM provider_profiles WHERE id=$1 AND deleted_at IS NULL`, [providerId])).rows[0];
    if (!profile) throw Errors.notFound('Provider');
    const row = (await this.db.query(
      `INSERT INTO user_favourites (user_id, provider_id) VALUES ($1,$2)
       ON CONFLICT (user_id, provider_id) DO NOTHING RETURNING provider_id, created_at`,
      [userId, providerId])).rows[0];
    if (row) return { provider_id: String(row.provider_id), favourited_at: String(row.created_at), already: false };
    const existing = (await this.db.query<{ created_at: string }>(
      `SELECT created_at FROM user_favourites WHERE user_id=$1 AND provider_id=$2`, [userId, providerId])).rows[0];
    return { provider_id: providerId, favourited_at: String(existing?.created_at), already: true };
  }

  /** Unfavourite. Idempotent: removing a favourite that does not exist is
   *  still a success (204 from the controller) — no 404 for a no-op. */
  async remove(userId: string, providerId: string): Promise<void> {
    await this.db.query(`DELETE FROM user_favourites WHERE user_id=$1 AND provider_id=$2`, [userId, providerId]);
  }

  /** The caller's favourites, newest first. Cursor pagination (v1.2
   *  envelope {items, next_cursor}), same shape as listChats/listReviews. */
  async list(userId: string, cursor?: string, limit = 20): Promise<{ items: FavouriteItem[]; next_cursor: string | null }> {
    const lim = Math.min(Math.max(limit || 20, 1), 100);
    const rows = (await this.db.query(
      `SELECT p.id AS provider_id, p.display_name, p.provider_type, p.rating_avg, p.jobs_completed, f.created_at AS favourited_at
       FROM user_favourites f JOIN provider_profiles p ON p.id=f.provider_id
       WHERE f.user_id=$1 AND p.deleted_at IS NULL
         AND ($2::text IS NULL OR (f.created_at, f.provider_id) < (SELECT created_at, provider_id FROM user_favourites WHERE user_id=$1 AND provider_id=$2::uuid))
       ORDER BY f.created_at DESC, f.provider_id DESC LIMIT $3`,
      [userId, cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return {
      items: page.map((r) => ({
        provider_id: String(r.provider_id),
        display_name: String(r.display_name),
        provider_type: String(r.provider_type),
        rating_bayes: bayesianRating(Number(r.rating_avg), Number(r.jobs_completed)),
        jobs_completed: Number(r.jobs_completed),
        favourited_at: String(r.favourited_at),
      })),
      next_cursor: hasMore ? String(page[page.length - 1].provider_id) : null,
    };
  }
}
