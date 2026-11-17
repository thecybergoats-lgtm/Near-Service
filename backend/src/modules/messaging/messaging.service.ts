import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { Errors } from '../../common/errors/api-error';
import { isContactSharing } from '../../common/utils/contact-sharing';
import { withIdempotency } from '../../common/utils/idempotency';
import { pageOf } from '../../common/utils/pagination';
@Injectable()
export class MessagingService {
  constructor(private db: DatabaseService, private redis: RedisService, private realtime: RealtimeService) {}
  private async providerIdFor(userId: string): Promise<string | null> {
    const row = (await this.db.query<{ id: string }>(`SELECT id FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
    return row?.id ?? null;
  }
  /** Caller chats (OpenAPI listChats). FIX 14(d) (Stage 3): moved here
   *  from JobsQueryService — the messaging module owns all chat reads
   *  and writes. Query and shape unchanged. */
  async listChats(userId: string, jobId?: string, cursor?: string, limit = 20) {
    const lim = Math.min(Math.max(limit || 20, 1), 100);
    const providerId = await this.providerIdFor(userId);
    const rows = (await this.db.query(
      `SELECT c.* FROM chats c
       WHERE (c.customer_id=$1 OR ($2::uuid IS NOT NULL AND c.provider_id=$2))
         AND ($3::uuid IS NULL OR c.job_id=$3)
         AND ($4::text IS NULL OR (c.created_at, c.id) < (SELECT created_at, id FROM chats WHERE id=$4::uuid))
       ORDER BY c.created_at DESC, c.id DESC LIMIT $5`,
      [userId, providerId, jobId ?? null, cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return { items: page, next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }
  /** Chat history (OpenAPI listMessages). v1.2 MessagePage envelope, newest
   *  first in storage but returned oldest-first in the page; next_cursor is
   *  the OLDEST message id in the page, so passing it back fetches older
   *  messages (created_at < that message). */
  async listMessages(chatId: string, userId: string, limit = 20, cursor?: string) {
    const chat = (await this.db.query<{ customer_id: string; provider_id: string }>(
      `SELECT c.customer_id, p.user_id AS provider_user_id FROM chats c JOIN provider_profiles p ON p.id=c.provider_id WHERE c.id=$1`, [chatId])).rows[0] as unknown as { customer_id: string; provider_user_id: string } | undefined;
    if (!chat) throw Errors.notFound('Chat');
    if (userId !== chat.customer_id && userId !== chat.provider_user_id) throw Errors.forbidden('Not a participant');
    const lim = Math.min(Math.max(limit, 1), 100);
    const rows = cursor
      ? (await this.db.query(`SELECT * FROM messages WHERE chat_id=$1 AND created_at < (SELECT created_at FROM messages WHERE id=$3) ORDER BY created_at DESC LIMIT $2`, [chatId, lim + 1, cursor])).rows
      : (await this.db.query(`SELECT * FROM messages WHERE chat_id=$1 ORDER BY created_at DESC LIMIT $2`, [chatId, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = (hasMore ? rows.slice(0, lim) : rows).reverse();
    return pageOf(page, hasMore && page.length ? String(page[0].id) : null);
  }
  async sendMessage(chatId: string, senderId: string, body: string | null, kind = 'text', mediaKey?: string, idempotencyKey?: string) {
    return withIdempotency(this.redis, 'chat-message', idempotencyKey, async () => this.sendMessageInner(chatId, senderId, body, kind, mediaKey));
  }
  private async sendMessageInner(chatId: string, senderId: string, body: string | null, kind = 'text', mediaKey?: string) {
    const chat = (await this.db.query<{ customer_id: string; provider_id: string }>(
      `SELECT c.customer_id, p.user_id AS provider_user_id FROM chats c JOIN provider_profiles p ON p.id=c.provider_id WHERE c.id=$1`, [chatId])).rows[0] as unknown as { customer_id: string; provider_user_id: string } | undefined;
    if (!chat) throw Errors.notFound('Chat');
    if (senderId !== chat.customer_id && senderId !== chat.provider_user_id) throw Errors.forbidden('Not a participant');
    const flagged = isContactSharing(body);
    const msg = (await this.db.query(
      `INSERT INTO messages (chat_id, sender_id, kind, body, media_key, is_flagged) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [chatId, senderId, kind, body, mediaKey ?? null, flagged])).rows[0];
    const otherId = senderId === chat.customer_id ? chat.provider_user_id : chat.customer_id;
    this.realtime.emitToUser(otherId, 'chat.message', { message: msg });
    this.realtime.emitToRoom(`chat:${chatId}`, 'chat.message', { message: msg });
    return { ...msg, moderation: flagged ? 'flagged_contact_sharing' : 'ok' };
  }
}
