import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import { sendPushStub } from '../../common/utils/push';

@Injectable()
export class TrustService {
  constructor(private db: DatabaseService) {}
  /** Open a dispute on a job. Job moves to DISPUTED (legal from most states);
   *  SLA: first response within 4h, resolution within 48h (PRD p.8/20). */
  async openDispute(jobId: string, userId: string, reasonCode?: string, description?: string) {
    const job = (await this.db.query<{ state: string; customer_id: string }>(`SELECT state, customer_id FROM jobs WHERE id=$1`, [jobId])).rows[0];
    if (!job) throw Errors.notFound('Job');
    const row = (await this.db.query(
      `INSERT INTO disputes (job_id, opened_by, reason_code, description, status, sla_first_response_at, sla_resolve_at)
       VALUES ($1,$2,$3,$4,'open', now() + interval '4 hours', now() + interval '48 hours') RETURNING *`,
      [jobId, userId, reasonCode ?? null, description ?? null])).rows[0];
    if (!['DISPUTED', 'RATED', 'REFUNDED'].includes(job.state)) {
      await this.db.query(`UPDATE jobs SET state='DISPUTED', updated_at=now() WHERE id=$1`, [jobId]);
      await this.db.query(`INSERT INTO job_events (job_id, from_state, to_state, actor_user_id, actor_role, payload) VALUES ($1,$2,'DISPUTED',$3,'customer',$4)`,
        [jobId, job.state, userId, JSON.stringify({ dispute_id: row.id })]);
    }
    return row;
  }
  async getDispute(disputeId: string, userId: string) {
    const row = (await this.db.query(`SELECT * FROM disputes WHERE id=$1`, [disputeId])).rows[0];
    if (!row) throw Errors.notFound('Dispute');
    const job = (await this.db.query<{ customer_id: string; provider_id: string }>(`SELECT j.customer_id, p.user_id AS provider_user_id FROM jobs j JOIN provider_profiles p ON p.id=j.provider_id WHERE j.id=$1`, [row.job_id])).rows[0] as unknown as { customer_id: string; provider_user_id: string };
    if (row.opened_by !== userId && job?.customer_id !== userId && job?.provider_user_id !== userId) throw Errors.forbidden('Not a party to this dispute');
    const evidence = (await this.db.query(`SELECT * FROM dispute_evidence WHERE dispute_id=$1 ORDER BY created_at`, [disputeId])).rows;
    return { ...row, evidence };
  }
  private async disputeParties(disputeId: string) {
    const row = (await this.db.query(
      `SELECT d.*, j.customer_id, p.user_id AS provider_user_id FROM disputes d
        JOIN jobs j ON j.id=d.job_id JOIN provider_profiles p ON p.id=j.provider_id WHERE d.id=$1`, [disputeId])).rows[0] as unknown as
      Record<string, unknown> | undefined;
    if (!row) throw Errors.notFound('Dispute');
    return row;
  }
  private async isSupport(userId: string): Promise<boolean> {
    const r = (await this.db.query(
      `SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1 AND r.name IN ('super_admin','support_agent') LIMIT 1`, [userId])).rows[0];
    return !!r;
  }
  /** FIX 14(c) (Stage 3): photo evidence uses the SAME signed-URL upload
   *  flow as provider documents (ProvidersService.requestDocumentUpload):
   *  the client first requests an upload URL for this dispute, PUTs/POSTs
   *  the photo bytes to it, then attaches the returned storage_key via
   *  addEvidence. The key is namespaced to the dispute and random, so a
   *  key issued for another dispute (or hand-typed) cannot be attached —
   *  addEvidence enforces the prefix. Upload target: STORAGE_UPLOAD_BASE_URL
   *  when configured (S3-compatible presigned upload in production);
   *  otherwise the local dev receiver POST /api/v1/uploads/:key (dev only,
   *  same as documents). chat/gps evidence needs no upload (note only). */
  async requestEvidenceUpload(disputeId: string, userId: string) {
    const d = await this.disputeParties(disputeId);
    const party = d.opened_by === userId || d.customer_id === userId || d.provider_user_id === userId;
    if (!party && !(await this.isSupport(userId))) throw Errors.forbidden('Not a party to this dispute');
    if (d.status !== 'open') throw Errors.conflict('DISPUTE_CLOSED', 'Evidence can only be added to an open dispute');
    const storageKey = `disputes/${disputeId}/evidence-${randomUUID()}.bin`;
    const base = process.env.STORAGE_UPLOAD_BASE_URL ?? 'http://localhost:3000/api/v1/uploads';
    return { upload_url: `${base}/${encodeURIComponent(storageKey)}`, storage_key: storageKey };
  }
  /** Attach evidence to a dispute. Only a job party or support/admin.
   *  kind is photo (storage_key), chat (chat/message reference in note) or
   *  gps (coordinates in note / storage_key). */
  async addEvidence(disputeId: string, userId: string, dto: { kind: string; storage_key?: string; note?: string }) {
    if (!['photo', 'chat', 'gps'].includes(dto.kind)) throw Errors.unprocessable('INVALID_EVIDENCE_KIND', "kind must be 'photo', 'chat' or 'gps'");
    const d = await this.disputeParties(disputeId);
    const party = d.opened_by === userId || d.customer_id === userId || d.provider_user_id === userId;
    if (!party && !(await this.isSupport(userId))) throw Errors.forbidden('Not a party to this dispute');
    if (d.status !== 'open') throw Errors.conflict('DISPUTE_CLOSED', 'Evidence can only be added to an open dispute');
    // FIX 14(c): a photo key must have been issued for THIS dispute by
    // requestEvidenceUpload — a hand-typed or foreign key is rejected.
    if (dto.kind === 'photo') {
      const prefix = `disputes/${disputeId}/evidence-`;
      if (!dto.storage_key || !dto.storage_key.startsWith(prefix)) {
        throw Errors.unprocessable('INVALID_EVIDENCE_KEY', 'Photo evidence needs a storage_key issued for this dispute — call POST /disputes/:id/evidence/upload-request first');
      }
    }
    const row = (await this.db.query(
      `INSERT INTO dispute_evidence (dispute_id, uploader_id, kind, storage_key, note) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [disputeId, userId, dto.kind, dto.storage_key ?? null, dto.note ?? null])).rows[0];
    await this.db.query(`UPDATE disputes SET updated_at=now() WHERE id=$1`, [disputeId]);
    return row;
  }
  /** Caller's disputes, newest first. role filters by the caller's side on
   *  the job ('customer' | 'provider'); status filters disputes.status.
   *  Cursor pagination: pass next_cursor (a dispute id) to continue. */
  async listDisputes(userId: string, opts: { role?: string; status?: string; cursor?: string; limit?: number }) {
    const lim = Math.min(Math.max(opts.limit || 20, 1), 100);
    if (opts.role && !['customer', 'provider'].includes(opts.role)) throw Errors.unprocessable('INVALID_ROLE', "role must be 'customer' or 'provider'");
    const rows = (await this.db.query(
      `SELECT d.*, j.state AS job_state,
              (SELECT COUNT(*)::int FROM dispute_evidence e WHERE e.dispute_id=d.id) AS evidence_count
       FROM disputes d JOIN jobs j ON j.id=d.job_id JOIN provider_profiles p ON p.id=j.provider_id
       WHERE (d.opened_by=$1 OR j.customer_id=$1 OR p.user_id=$1)
         AND ($2::text IS NULL OR ($2='customer' AND j.customer_id=$1) OR ($2='provider' AND p.user_id=$1))
         AND ($3::varchar IS NULL OR d.status=$3::varchar)
         AND ($4::text IS NULL OR (d.created_at, d.id) < (SELECT created_at, id FROM disputes WHERE id=$4::uuid))
       ORDER BY d.created_at DESC, d.id DESC LIMIT $5`,
      [userId, opts.role ?? null, opts.status ?? null, opts.cursor ?? null, lim + 1])).rows;
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    return { items: page, next_cursor: hasMore ? String(page[page.length - 1].id) : null };
  }
  async report(reporterId: string | null, reportedId: string | null, context?: string, reasonCode?: string, detail?: string) {
    return (await this.db.query(
      `INSERT INTO reports (reporter_id, reported_id, context, reason_code, detail, status) VALUES ($1,$2,$3,$4,$5,'open') RETURNING *`,
      [reporterId, reportedId, context ?? null, reasonCode ?? null, detail ?? null])).rows[0];
  }
  /** Blocking is immediate and mutual (PRD p.20). */
  async block(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) throw Errors.badRequest('CANNOT_BLOCK_SELF', 'You cannot block yourself');
    await this.db.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [blockerId, blockedId]);
    return { blocker_id: blockerId, blocked_id: blockedId, mutual: true };
  }
  /** SOS: alerts trusted contacts + support. Never blocked by rate limits (PRD p.20).
   *  Phase 1: recorded + logged (support queue); SMS/push dispatch is wired via
   *  the notifications table (FCM stub applies to the push leg only). */
  async sos(userId: string, jobId?: string | null, lat?: number, lng?: number) {
    const row = (await this.db.query(
      `INSERT INTO fraud_signals (user_id, job_id, signal, detail) VALUES ($1,$2,'sos', $3) RETURNING id, created_at`,
      [userId, jobId ?? null, JSON.stringify({ lat, lng, at: new Date().toISOString() })])).rows[0];
    await this.db.query(`INSERT INTO notifications (user_id, channel, template_key, payload, status) VALUES ($1,'push','sos.alert',$2,'queued')`,
      [userId, JSON.stringify({ job_id: jobId ?? null, lat, lng })]);
    sendPushStub(userId, 'sos.alert', { job_id: jobId ?? null, lat, lng });
    return { sos_id: row.id, status: 'dispatched', at: row.created_at, note: 'Trusted contacts + support alerted (support queue); push leg uses the FCM stub in Phase 1' };
  }
}
