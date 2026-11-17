// Teams (Phase 3) — a shop owner adds employees, assigns accepted jobs to
// workers, and sees all earnings centrally.
//
// PERMISSIONS (enforced here, server-side, in every method — never only in
// the controller or the client):
//   owner   — the provider-profile user; full control of their team.
//   manager — invited by the owner; can invite/assign and view all team jobs.
//   worker  — invited by the owner/manager; sees ONLY jobs assigned to them,
//             and only their own membership row. A worker gets 403 FORBIDDEN
//             on another worker's jobs, on unassigned jobs, and on team
//             earnings / member management.
//   Anyone who is not the owner or an ACTIVE member of the team gets 403.
//   Invited (not yet accepted) members can only accept their own invite.
// Jobs are assignable only while ACCEPTED (the state set when a customer
// accepts an offer); the job must belong to the team's provider profile.
//
// STAFF SEATS: only a Business subscription includes staff accounts
// (max_staff_accounts = 5; Free/Pro = 0). Invites beyond the owner's active
// plan limit fail with 409 TEAM_SEAT_LIMIT. The owner themself is not a seat.
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Errors } from '../../common/errors/api-error';
import { pageFromRows } from '../../common/utils/pagination';

export type TeamRole = 'owner' | 'manager' | 'worker';
export type MemberStatus = 'invited' | 'active' | 'removed';

type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

interface TeamRow { id: string; provider_id: string; owner_user_id: string; name: string }
interface MemberRow { id: string; team_id: string; user_id: string; role: TeamRole; status: MemberStatus }

@Injectable()
export class TeamsService {
  constructor(private db: DatabaseService) {}

  // ---- Internal access checks (server-side enforcement) -----------------
  private async teamById(client: QueryClient, teamId: string): Promise<TeamRow> {
    const row = (await client.query(`SELECT * FROM teams WHERE id=$1`, [teamId])).rows[0] as unknown as TeamRow | undefined;
    if (!row) throw Errors.notFound('Team');
    return row;
  }

  private async membership(client: QueryClient, teamId: string, userId: string): Promise<MemberRow | null> {
    const row = (await client.query(
      `SELECT * FROM team_members WHERE team_id=$1 AND user_id=$2`, [teamId, userId],
    )).rows[0] as unknown as MemberRow | undefined;
    return row ?? null;
  }

  /** Resolve the caller's standing in a team. Owner is implicit (the team
   *  row); everyone else needs an ACTIVE membership row. Throws 403 otherwise. */
  private async requireTeamAccess(client: QueryClient, teamId: string, userId: string, allowed: TeamRole[]): Promise<{ team: TeamRow; role: TeamRole }> {
    const team = await this.teamById(client, teamId);
    if (team.owner_user_id === userId) {
      if (!allowed.includes('owner')) throw Errors.forbidden('This action requires a different team role');
      return { team, role: 'owner' };
    }
    const m = await this.membership(client, teamId, userId);
    if (!m || m.status !== 'active') throw Errors.forbidden('Not a member of this team');
    if (!allowed.includes(m.role)) throw Errors.forbidden(`This action requires role: ${allowed.join(' or ')}`);
    return { team, role: m.role };
  }

  private async providerIdFor(client: QueryClient, userId: string): Promise<string> {
    const row = (await client.query(
      `SELECT id FROM provider_profiles WHERE user_id=$1 AND deleted_at IS NULL`, [userId],
    )).rows[0] as unknown as { id: string } | undefined;
    if (!row) throw Errors.forbidden('No provider profile for this account');
    return row.id;
  }

  private async staffSeatLimit(client: QueryClient, providerId: string): Promise<number> {
    const row = (await client.query(
      `SELECT p.max_staff_accounts FROM subscriptions s
       JOIN subscription_plans p ON p.id=s.plan_id
       WHERE s.provider_id=$1 AND s.status='active'`, [providerId],
    )).rows[0] as unknown as { max_staff_accounts: number } | undefined;
    return row ? Number(row.max_staff_accounts) : 0;
  }

  // ---- Teams --------------------------------------------------------------
  async createTeam(ownerUserId: string, name: string) {
    return this.db.withTransaction(async (c) => {
      const client = c as unknown as QueryClient;
      const providerId = await this.providerIdFor(client, ownerUserId);
      const existing = (await client.query(`SELECT id FROM teams WHERE provider_id=$1`, [providerId])).rows[0];
      if (existing) throw Errors.conflict('TEAM_EXISTS', 'This provider already has a team');
      const team = (await client.query(
        `INSERT INTO teams (provider_id, owner_user_id, name) VALUES ($1,$2,$3) RETURNING *`,
        [providerId, ownerUserId, name],
      )).rows[0] as unknown as TeamRow;
      await client.query(
        `INSERT INTO team_members (team_id, user_id, role, status, invited_by) VALUES ($1,$2,'owner','active',$2)`,
        [team.id, ownerUserId],
      );
      return team;
    });
  }

  async listMyTeams(userId: string) {
    const rows = (await this.db.query(
      `SELECT t.*, m.role AS my_role FROM teams t JOIN team_members m ON m.team_id=t.id
       WHERE m.user_id=$1 AND m.status='active' ORDER BY t.created_at DESC`, [userId],
    )).rows;
    return { items: rows, next_cursor: null };
  }

  async getTeam(teamId: string, userId: string) {
    const { team, role } = await this.requireTeamAccess(this.db as unknown as QueryClient, teamId, userId, ['owner', 'manager', 'worker']);
    return { ...team, my_role: role };
  }

  // ---- Members --------------------------------------------------------------
  async inviteMember(teamId: string, actorUserId: string, workerUserId: string, role: 'manager' | 'worker') {
    return this.db.withTransaction(async (c) => {
      const client = c as unknown as QueryClient;
      const { team } = await this.requireTeamAccess(client, teamId, actorUserId, ['owner', 'manager']);
      if (workerUserId === team.owner_user_id) throw Errors.conflict('CANNOT_INVITE_OWNER', 'The team owner is already a member');
      const user = (await client.query(`SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL`, [workerUserId])).rows[0];
      if (!user) throw Errors.notFound('User');
      const existing = await this.membership(client, teamId, workerUserId);
      if (existing && existing.status !== 'removed') {
        throw Errors.conflict('ALREADY_MEMBER', 'This user is already a member of the team');
      }
      // Staff seats: Business only (Free/Pro max_staff_accounts = 0).
      const limit = await this.staffSeatLimit(client, team.provider_id);
      const used = (await client.query(
        `SELECT COUNT(*) AS n FROM team_members WHERE team_id=$1 AND role <> 'owner' AND status IN ('invited','active')`,
        [teamId],
      )).rows[0] as unknown as { n: string };
      if (Number(used.n) >= limit) {
        throw Errors.conflict('TEAM_SEAT_LIMIT', `Staff accounts require a Business subscription (limit ${limit} seats)`);
      }
      const row = (await client.query(
        `INSERT INTO team_members (team_id, user_id, role, status, invited_by) VALUES ($1,$2,$3,'invited',$4)
         ON CONFLICT (team_id, user_id) DO UPDATE SET role=EXCLUDED.role, status='invited', invited_by=EXCLUDED.invited_by, updated_at=now()
         RETURNING *`,
        [teamId, workerUserId, role, actorUserId],
      )).rows[0];
      return row;
    });
  }

  /** Only the invited user themself can accept their invite. */
  async acceptInvite(teamId: string, userId: string) {
    const m = await this.membership(this.db as unknown as QueryClient, teamId, userId);
    if (!m) throw Errors.notFound('Team invitation');
    if (m.status === 'active') return m;
    if (m.status !== 'invited') throw Errors.conflict('INVITE_NOT_PENDING', 'This invitation is no longer pending');
    const row = (await this.db.query(
      `UPDATE team_members SET status='active', updated_at=now() WHERE team_id=$1 AND user_id=$2 RETURNING *`,
      [teamId, userId],
    )).rows[0];
    return row;
  }

  /** Owner only. The owner themself cannot be removed. */
  async removeMember(teamId: string, actorUserId: string, memberUserId: string) {
    const { team } = await this.requireTeamAccess(this.db as unknown as QueryClient, teamId, actorUserId, ['owner']);
    if (memberUserId === team.owner_user_id) throw Errors.conflict('CANNOT_REMOVE_OWNER', 'The team owner cannot be removed');
    const m = await this.membership(this.db as unknown as QueryClient, teamId, memberUserId);
    if (!m || m.status === 'removed') throw Errors.notFound('Team member');
    // Unassign any jobs held by the removed member first.
    await this.db.query(`DELETE FROM team_job_assignments WHERE team_id=$1 AND worker_user_id=$2`, [teamId, memberUserId]);
    const row = (await this.db.query(
      `UPDATE team_members SET status='removed', updated_at=now() WHERE team_id=$1 AND user_id=$2 RETURNING *`,
      [teamId, memberUserId],
    )).rows[0];
    return row;
  }

  /** Owner/manager see all members; a worker sees only their own row. */
  async listMembers(teamId: string, userId: string) {
    const { role } = await this.requireTeamAccess(this.db as unknown as QueryClient, teamId, userId, ['owner', 'manager', 'worker']);
    const params: unknown[] = [teamId];
    let where = `team_id=$1 AND status IN ('invited','active')`;
    if (role === 'worker') { params.push(userId); where += ` AND user_id=$2`; }
    const rows = (await this.db.query(
      `SELECT id, team_id, user_id, role, status, invited_by, created_at FROM team_members WHERE ${where} ORDER BY created_at ASC`,
      params,
    )).rows;
    return { items: rows, next_cursor: null };
  }

  // ---- Job assignment -------------------------------------------------------
  /** Assign an ACCEPTED job of this team's provider to an active worker.
   *  Reassignment overwrites the previous assignee. */
  async assignJob(teamId: string, actorUserId: string, jobId: string, workerUserId: string) {
    return this.db.withTransaction(async (c) => {
      const client = c as unknown as QueryClient;
      const { team } = await this.requireTeamAccess(client, teamId, actorUserId, ['owner', 'manager']);
      const job = (await client.query(
        `SELECT id, provider_id, state FROM jobs WHERE id=$1`, [jobId],
      )).rows[0] as unknown as { id: string; provider_id: string; state: string } | undefined;
      if (!job) throw Errors.notFound('Job');
      if (job.provider_id !== team.provider_id) throw Errors.forbidden('This job does not belong to the team provider');
      if (job.state !== 'ACCEPTED') {
        throw Errors.conflict('JOB_NOT_ASSIGNABLE', `Only ACCEPTED jobs can be assigned (job is ${job.state})`);
      }
      const worker = await this.membership(client, teamId, workerUserId);
      if (!worker || worker.status !== 'active' || worker.role === 'owner') {
        throw Errors.conflict('WORKER_NOT_ACTIVE', 'Assignee must be an active team worker or manager');
      }
      const row = (await client.query(
        `INSERT INTO team_job_assignments (team_id, job_id, worker_user_id, assigned_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (job_id) DO UPDATE SET worker_user_id=EXCLUDED.worker_user_id, assigned_by=EXCLUDED.assigned_by,
           assigned_at=now(), updated_at=now() RETURNING *`,
        [teamId, jobId, workerUserId, actorUserId],
      )).rows[0];
      return row;
    });
  }

  async unassignJob(teamId: string, actorUserId: string, jobId: string) {
    const { team } = await this.requireTeamAccess(this.db as unknown as QueryClient, teamId, actorUserId, ['owner', 'manager']);
    const deleted = (await this.db.query(
      `DELETE FROM team_job_assignments WHERE team_id=$1 AND job_id=$2 RETURNING *`, [team.id, jobId],
    )).rows[0];
    if (!deleted) throw Errors.notFound('Job assignment');
    return { unassigned: true, job_id: jobId, team_id: team.id };
  }

  // ---- Team job visibility (the core worker-isolation rule) ------------------
  private jobSelect() {
    return `SELECT j.*, a.worker_user_id AS assigned_to, a.assigned_at
            FROM jobs j LEFT JOIN team_job_assignments a ON a.job_id=j.id`;
  }

  /** Owner/manager: every job of the team provider (assigned or not).
   *  Worker: ONLY jobs assigned to them. */
  async listTeamJobs(teamId: string, userId: string, cursor?: string, limit = 20) {
    const { team, role } = await this.requireTeamAccess(this.db as unknown as QueryClient, teamId, userId, ['owner', 'manager', 'worker']);
    const lim = Math.min(Math.max(limit || 20, 1), 100);
    const params: unknown[] = [team.provider_id, cursor ?? null];
    let where = `j.provider_id=$1 AND ($2::text IS NULL OR (j.created_at, j.id) < (SELECT created_at, id FROM jobs WHERE id=$2::uuid))`;
    if (role === 'worker') { params.push(userId); where += ` AND a.worker_user_id=$${params.length}`; }
    params.push(lim + 1);
    const rows = (await this.db.query(
      `${this.jobSelect()} WHERE ${where} ORDER BY j.created_at DESC, j.id DESC LIMIT $${params.length}`,
      params,
    )).rows as unknown as Record<string, unknown>[];
    const page = pageFromRows(rows, lim);
    return { items: page.items, next_cursor: page.next_cursor };
  }

  /** One job: owner/manager see any team job; a worker sees it only when
   *  it is assigned to them — otherwise 403, never a leak of its existence
   *  beyond "not visible to you". */
  async getTeamJob(teamId: string, userId: string, jobId: string) {
    const { team, role } = await this.requireTeamAccess(this.db as unknown as QueryClient, teamId, userId, ['owner', 'manager', 'worker']);
    const row = (await this.db.query(
      `${this.jobSelect()} WHERE j.id=$1 AND j.provider_id=$2`, [jobId, team.provider_id],
    )).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) throw Errors.notFound('Job');
    if (role === 'worker' && row.assigned_to !== userId) {
      throw Errors.forbidden('Workers can only view jobs assigned to them');
    }
    return row;
  }

  // ---- Central earnings (owner/manager only) ---------------------------------
  async getTeamEarnings(teamId: string, userId: string) {
    const { team } = await this.requireTeamAccess(this.db as unknown as QueryClient, teamId, userId, ['owner', 'manager']);
    const totals = (await this.db.query(
      `SELECT COUNT(*) AS jobs_total,
              COUNT(*) FILTER (WHERE payment_status='settled') AS jobs_settled,
              COALESCE(SUM(final_price),0) AS gross_pkr,
              COALESCE(SUM(commission_amount),0) AS commission_pkr
       FROM jobs WHERE provider_id=$1 AND payment_status='settled'`,
      [team.provider_id],
    )).rows[0] as unknown as Record<string, unknown>;
    const byWorker = (await this.db.query(
      `SELECT a.worker_user_id, COUNT(*) AS jobs_settled,
              COALESCE(SUM(j.final_price),0) AS gross_pkr,
              COALESCE(SUM(j.commission_amount),0) AS commission_pkr
       FROM jobs j JOIN team_job_assignments a ON a.job_id=j.id
       WHERE j.provider_id=$1 AND j.payment_status='settled' GROUP BY a.worker_user_id`,
      [team.provider_id],
    )).rows as unknown as Record<string, unknown>[];
    const unassigned = (await this.db.query(
      `SELECT COUNT(*) AS jobs_settled, COALESCE(SUM(final_price),0) AS gross_pkr,
              COALESCE(SUM(commission_amount),0) AS commission_pkr
       FROM jobs j WHERE j.provider_id=$1 AND j.payment_status='settled'
         AND NOT EXISTS (SELECT 1 FROM team_job_assignments a WHERE a.job_id=j.id)`,
      [team.provider_id],
    )).rows[0] as unknown as Record<string, unknown>;
    const gross = Number(totals.gross_pkr ?? 0);
    const commission = Number(totals.commission_pkr ?? 0);
    return {
      team_id: team.id,
      provider_id: team.provider_id,
      jobs_total: Number(totals.jobs_total ?? 0),
      jobs_settled: Number(totals.jobs_settled ?? 0),
      gross_pkr: gross,
      commission_pkr: commission,
      net_earnings_pkr: gross - commission,
      by_worker: byWorker.map((r) => ({
        worker_user_id: String(r.worker_user_id),
        jobs_settled: Number(r.jobs_settled),
        gross_pkr: Number(r.gross_pkr),
        commission_pkr: Number(r.commission_pkr),
        net_earnings_pkr: Number(r.gross_pkr) - Number(r.commission_pkr),
      })),
      unassigned: {
        jobs_settled: Number(unassigned.jobs_settled ?? 0),
        gross_pkr: Number(unassigned.gross_pkr ?? 0),
        commission_pkr: Number(unassigned.commission_pkr ?? 0),
        net_earnings_pkr: Number(unassigned.gross_pkr ?? 0) - Number(unassigned.commission_pkr ?? 0),
      },
    };
  }
}
