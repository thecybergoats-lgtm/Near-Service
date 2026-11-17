// Live Support (Batch 2) — customer <-> support/admin tickets.
//
// Design choice: NEW tables (support_threads + support_messages), NOT the
// messaging tables. chats/messages are keyed to a job + provider
// (chats.job_id/provider_id are NOT NULL, messages join provider_profiles
// for every read), so a support thread has no job and no provider to hang
// off — reusing them would mean nullable FKs and a thread-type column
// threaded through every chat query. The new tables mirror the messaging
// shapes instead (cursor pagination, same message envelope), so the mobile
// client can render both the same way.
//
// What this is NOT: there is no bot, no canned reply, no fake agent.
// An unanswered thread stays status 'open' until a human with the
// super_admin or support_agent role replies or closes it.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import { NotificationsService } from '../notifications/notifications.service';

export interface SupportThread {
  id: string;
  customer_id: string;
  subject: string;
  status: 'open' | 'closed';
  closed_at: string | null;
  closed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupportMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_role: 'customer' | 'support';
  body: string;
  created_at: string;
}

function toThread(row: Record<string, unknown>): SupportThread {
  return {
    id: String(row.id), customer_id: String(row.customer_id), subject: String(row.subject),
    status: row.status as 'open' | 'closed',
    closed_at: row.closed_at ? String(row.closed_at) : null,
    closed_by: row.closed_by ? String(row.closed_by) : null,
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

function toMessage(row: Record<string, unknown>): SupportMessage {
  return {
    id: String(row.id), thread_id: String(row.thread_id), sender_id: String(row.sender_id),
    sender_role: row.sender_role as 'customer' | 'support', body: String(row.body),
    created_at: String(row.created_at),
  };
}

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);
  constructor(
    private db: DatabaseService,
    // @Optional so direct construction with (db) in older tests keeps
    // working; when absent, support replies simply send no push.
    @Optional() @Inject(NotificationsService) private notifications?: NotificationsService,
  ) {}

  private async isSupport(userId: string): Promise<boolean> {
    const r = (await this.db.query(
      `SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1 AND r.name IN ('super_admin','support_agent') LIMIT 1`, [userId])).rows[0];
    return !!r;
  }

  /** Customer opens a thread with a subject + first message (one txn). */
  async createThread(customerId: string, subject: string, message: string): Promise<SupportThread & { first_message: SupportMessage }> {
    const out = await this.db.withTransaction(async (c) => {
      const thread = (await c.query(
        `INSERT INTO support_threads (customer_id, subject) VALUES ($1,$2) RETURNING *`,
        [customerId, subject])).rows[0];
      const first = (await c.query(
        `INSERT INTO support_messages (thread_id, sender_id, sender_role, body) VALUES ($1,$2,'customer',$3) RETURNING *`,
        [thread.id, customerId, message])).rows[0];
      return { thread: toThread(thread), first: toMessage(first) };
    });
    return { ...out.thread, first_message: out.first };
  }

  async listThreads(customerId: string, cursor?: string, limit = 20): Promise<{ items: SupportThread[]; next_cursor: string | null }> {
    const lim = Math.min(Math.max(limit || 20, 1), 100);
    const rows = (await this.db.query(
      `SELECT * FROM support_threads WHERE customer_id=$1
         AND ($2::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM support_threads WHERE id=$2::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [customerId, cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return { items: page.map(toThread), next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }

  async listAdminThreads(status?: string, cursor?: string, limit = 20): Promise<{ items: SupportThread[]; next_cursor: string | null }> {
    if (status && !['open', 'closed'].includes(status)) throw Errors.unprocessable('INVALID_STATUS', "status must be 'open' or 'closed'");
    const lim = Math.min(Math.max(limit || 20, 1), 100);
    const rows = (await this.db.query(
      `SELECT * FROM support_threads
       WHERE ($1::varchar IS NULL OR status=$1::varchar)
         AND ($2::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM support_threads WHERE id=$2::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [status ?? null, cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return { items: page.map(toThread), next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }

  private async loadThread(threadId: string) {
    const row = (await this.db.query(`SELECT * FROM support_threads WHERE id=$1`, [threadId])).rows[0];
    if (!row) throw Errors.notFound('Support thread');
    return row as Record<string, unknown>;
  }

  async listMessages(threadId: string, userId: string, cursor?: string, limit = 20): Promise<{ items: SupportMessage[]; next_cursor: string | null }> {
    const thread = await this.loadThread(threadId);
    const support = await this.isSupport(userId);
    if (thread.customer_id !== userId && !support) throw Errors.forbidden('Not your support thread');
    const lim = Math.min(Math.max(limit || 20, 1), 100);
    const rows = cursor
      ? (await this.db.query(
          `SELECT * FROM support_messages WHERE thread_id=$1 AND created_at < (SELECT created_at FROM support_messages WHERE id=$3) ORDER BY created_at DESC LIMIT $2`,
          [threadId, lim + 1, cursor])).rows
      : (await this.db.query(
          `SELECT * FROM support_messages WHERE thread_id=$1 ORDER BY created_at DESC LIMIT $2`,
          [threadId, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = (hasMore ? rows.slice(0, lim) : rows).reverse();
    // Oldest-first page, like MessagingService.listMessages; next_cursor is
    // the OLDEST message id in the page (pass it back for older messages).
    return { items: page.map(toMessage), next_cursor: hasMore && page.length ? String(page[0].id) : null };
  }

  /** Customer replies on their own thread. A closed thread cannot be
   *  re-opened by replying — 409; the customer opens a new thread. */
  async sendCustomerMessage(threadId: string, customerId: string, body: string): Promise<SupportMessage> {
    const thread = await this.loadThread(threadId);
    if (thread.customer_id !== customerId) throw Errors.forbidden('Not your support thread');
    if (thread.status !== 'open') throw Errors.conflict('THREAD_CLOSED', 'This support thread is closed — open a new thread');
    const row = (await this.db.query(
      `INSERT INTO support_messages (thread_id, sender_id, sender_role, body) VALUES ($1,$2,'customer',$3) RETURNING *`,
      [threadId, customerId, body])).rows[0];
    await this.db.query(`UPDATE support_threads SET updated_at=now() WHERE id=$1`, [threadId]);
    return toMessage(row);
  }

  /** Support/admin replies. Re-opening a closed thread is not allowed —
   *  close is final; a new thread starts a new conversation. Best-effort
   *  push to the customer (never fails the reply). */
  async sendAdminMessage(threadId: string, adminId: string, body: string): Promise<SupportMessage> {
    const thread = await this.loadThread(threadId);
    if (thread.status !== 'open') throw Errors.conflict('THREAD_CLOSED', 'This support thread is closed');
    const row = (await this.db.query(
      `INSERT INTO support_messages (thread_id, sender_id, sender_role, body) VALUES ($1,$2,'support',$3) RETURNING *`,
      [threadId, adminId, body])).rows[0];
    await this.db.query(`UPDATE support_threads SET updated_at=now() WHERE id=$1`, [threadId]);
    const msg = toMessage(row);
    try {
      await this.notifications?.sendToUser(String(thread.customer_id), 'support.reply', { thread_id: threadId, message_id: msg.id });
    } catch (e) {
      this.logger.warn(`support reply push failed (best-effort): ${(e as Error).message}`);
    }
    return msg;
  }

  async closeThread(threadId: string, adminId: string): Promise<SupportThread> {
    const thread = await this.loadThread(threadId);
    if (thread.status === 'closed') throw Errors.conflict('THREAD_ALREADY_CLOSED', 'This support thread is already closed');
    const row = (await this.db.query(
      `UPDATE support_threads SET status='closed', closed_at=now(), closed_by=$2, updated_at=now() WHERE id=$1 RETURNING *`,
      [threadId, adminId])).rows[0];
    return toThread(row);
  }
}
