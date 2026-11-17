// Subscriptions + Teams unit tests (Phase 3) — no live DB.
// FakeDb interprets exactly the SQL the two services emit (same pattern as
// test/unit/payments.spec.ts). Run: npm test -- subscriptions-teams
import { randomUUID } from 'crypto';
import { SubscriptionsService, applyPlanCommissionRate, featuredPlacementForPlan } from '../../src/modules/subscriptions/subscriptions.service';
import { TeamsService } from '../../src/modules/teams/teams.service';
import { ApiError } from '../../src/common/errors/api-error';

type Row = Record<string, any>;

const nowIso = () => new Date().toISOString();
const monthLaterIso = () => new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

class FakeDb {
  users: Row[] = [];
  provider_profiles: Row[] = [];
  wallet_accounts: Row[] = [];
  ledger_entries: Row[] = [];
  subscription_plans: Row[] = [
    { id: 'plan-free', code: 'free', name: 'Free', price_pkr: 0, commission_multiplier: 1.0, max_staff_accounts: 0, featured: false, analytics_enabled: false, is_active: true },
    { id: 'plan-pro', code: 'pro', name: 'Pro', price_pkr: 999, commission_multiplier: 0.8, max_staff_accounts: 0, featured: false, analytics_enabled: true, is_active: true },
    { id: 'plan-business', code: 'business', name: 'Business', price_pkr: 2499, commission_multiplier: 0.6, max_staff_accounts: 5, featured: true, analytics_enabled: true, is_active: true },
  ];
  subscriptions: Row[] = [];
  teams: Row[] = [];
  team_members: Row[] = [];
  team_job_assignments: Row[] = [];
  jobs: Row[] = [];
  reviews: Row[] = [];

  planById(id: string) { return this.subscription_plans.find((p) => p.id === id); }
  planByCode(code: string) { return this.subscription_plans.find((p) => p.code === code && p.is_active); }

  activeSubRow(providerId: string): Row | undefined {
    return this.subscriptions.find((s) => s.provider_id === providerId && s.status === 'active');
  }
  activeSubView(providerId: string): Row | undefined {
    const s = this.activeSubRow(providerId);
    if (!s) return undefined;
    const p = this.planById(s.plan_id)!;
    const pending = s.pending_plan_id ? this.planById(s.pending_plan_id) : undefined;
    return { ...s, plan_code: p.code, plan_name: p.name, price_pkr: p.price_pkr, commission_multiplier: p.commission_multiplier, max_staff_accounts: p.max_staff_accounts, featured: p.featured, analytics_enabled: p.analytics_enabled, pending_plan_code: pending?.code ?? null };
  }

  async withTransaction<T>(fn: (c: FakeDb) => Promise<T>): Promise<T> { return fn(this); }

  async query(text: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    const p = params as any[];
    const has = (s: string) => text.includes(s);

    // ---- wallet (ensureWallet + charge) ----
    if (has('INSERT INTO wallet_accounts')) {
      if (!this.wallet_accounts.some((w) => w.user_id === p[0])) {
        const row = { id: randomUUID(), user_id: p[0], balance_paisa: 0, escrow_held_paisa: 0, currency: 'PKR' };
        this.wallet_accounts.push(row);
        return { rows: [{ id: row.id }] };
      }
      return { rows: [] };
    }
    if (has('SELECT id FROM wallet_accounts')) {
      const w = this.wallet_accounts.find((x) => x.user_id === p[0]);
      return { rows: w ? [{ id: w.id }] : [] };
    }
    if (has('SELECT balance_paisa FROM wallet_accounts')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      return { rows: w ? [{ balance_paisa: String(w.balance_paisa) }] : [] };
    }
    if (has('UPDATE wallet_accounts SET balance_paisa = balance_paisa - $2')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      if (w) w.balance_paisa -= p[1];
      return { rows: [] };
    }
    if (has('UPDATE wallet_accounts SET balance_paisa = balance_paisa + $2')) {
      const w = this.wallet_accounts.find((x) => x.id === p[0]);
      if (w) w.balance_paisa += p[1];
      return { rows: [] };
    }
    if (has('INSERT INTO ledger_entries')) {
      this.ledger_entries.push({ txn_id: p[0], wallet_id: p[1], account_code: p[2], direction: p[3], amount_paisa: p[4], memo: p[5] });
      return { rows: [] };
    }

    // ---- plans ----
    if (has('SELECT * FROM subscription_plans WHERE is_active')) return { rows: [...this.subscription_plans].sort((a, b) => a.price_pkr - b.price_pkr) };
    if (has('SELECT * FROM subscription_plans WHERE code=$1')) {
      const plan = this.planByCode(p[0]);
      return { rows: plan ? [plan] : [] };
    }
    if (has('INSERT INTO subscription_plans')) {
      const row: Row = { id: randomUUID(), code: p[0], name: p[1], price_pkr: p[2], commission_multiplier: p[3], max_staff_accounts: p[4], featured: p[5], analytics_enabled: p[6], is_active: true };
      this.subscription_plans.push(row);
      return { rows: [row] };
    }
    if (has('UPDATE subscription_plans SET')) {
      const row = this.subscription_plans.find((x) => x.id === p[0]);
      if (!row) return { rows: [] };
      const setPart = text.split('SET')[1].split('WHERE')[0];
      for (const m of setPart.matchAll(/(\w+)=\$(\d+)/g)) row[m[1]] = p[Number(m[2]) - 1];
      return { rows: [row] };
    }

    // ---- provider profile ----
    if (has('SELECT id FROM provider_profiles WHERE user_id=$1')) {
      const prof = this.provider_profiles.find((x) => x.user_id === p[0] && !x.deleted_at);
      return { rows: prof ? [{ id: prof.id }] : [] };
    }
    if (has('UPDATE provider_profiles SET subscription_plan=$2')) {
      const prof = this.provider_profiles.find((x) => x.id === p[0]);
      if (prof) prof.subscription_plan = p[1];
      return { rows: [] };
    }
    if (has("UPDATE provider_profiles SET subscription_plan='free'")) {
      const prof = this.provider_profiles.find((x) => x.id === p[0]);
      if (prof) prof.subscription_plan = 'free';
      return { rows: [] };
    }

    // ---- subscriptions ----
    if (has('pending_plan_code') && has('FROM subscriptions s JOIN subscription_plans p')) {
      const v = this.activeSubView(p[0]);
      return { rows: v ? [v] : [] };
    }
    if (has('max_staff_accounts FROM subscriptions s')) {
      const v = this.activeSubView(p[0]);
      return { rows: v ? [{ max_staff_accounts: v.max_staff_accounts }] : [] };
    }
    if (has('SELECT s.*, p.code AS plan_code FROM subscriptions s')) {
      return { rows: this.subscriptions.map((s) => ({ ...s, plan_code: this.planById(s.plan_id)?.code })) };
    }
    if (has('INSERT INTO subscriptions')) {
      const row: Row = { id: randomUUID(), provider_id: p[0], user_id: p[1], plan_id: p[2], status: 'active', current_period_start: nowIso(), current_period_end: monthLaterIso(), pending_plan_id: null, cancel_at_period_end: false, created_at: nowIso() };
      this.subscriptions.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (has("UPDATE subscriptions SET plan_id=$2, current_period_start=now(), current_period_end=now() + interval '1 month'")) {
      const s = this.subscriptions.find((x) => x.id === p[0]);
      if (s) { s.plan_id = p[1]; s.pending_plan_id = null; s.cancel_at_period_end = false; s.current_period_start = nowIso(); s.current_period_end = monthLaterIso(); }
      return { rows: [] };
    }
    if (has('UPDATE subscriptions SET pending_plan_id=$2')) {
      const s = this.subscriptions.find((x) => x.id === p[0]);
      if (s) { s.pending_plan_id = p[1]; s.cancel_at_period_end = false; }
      return { rows: [] };
    }
    if (has("UPDATE subscriptions SET status='cancelled'")) {
      const s = this.subscriptions.find((x) => x.id === p[0]);
      if (s) { s.status = 'cancelled'; s.cancel_at_period_end = true; s.pending_plan_id = null; }
      return { rows: [] };
    }
    if (has("UPDATE subscriptions SET status='expired'")) {
      const s = this.subscriptions.find((x) => x.id === p[0]);
      if (s) s.status = 'expired';
      return { rows: [] };
    }
    if (has("UPDATE subscriptions SET plan_id=$2, status='active', current_period_start=now()")) {
      const s = this.subscriptions.find((x) => x.id === p[0]);
      if (s) { s.plan_id = p[1]; s.status = 'active'; s.pending_plan_id = null; s.current_period_start = nowIso(); s.current_period_end = monthLaterIso(); }
      return { rows: [] };
    }
    if (has("WHERE s.status='active' AND s.current_period_end <= now()")) {
      const due = this.subscriptions.filter((s) => s.status === 'active' && new Date(s.current_period_end) <= new Date())
        .map((s) => ({ ...s, pending_plan_code: s.pending_plan_id ? this.planById(s.pending_plan_id)?.code : null }));
      return { rows: due };
    }

    // ---- analytics ----
    if (has('COUNT(*) AS jobs_total') && has('created_at >= $2')) {
      const since = p[1] as string;
      const js = this.jobs.filter((j) => j.provider_id === p[0] && j.created_at >= since);
      return { rows: [{ jobs_total: String(js.length), jobs_settled: String(js.filter((j) => j.state === 'PAYMENT_SETTLED' || j.state === 'RATED').length), gross_pkr: String(js.reduce((s, j) => s + Number(j.final_price ?? 0), 0)), commission_pkr: String(js.reduce((s, j) => s + Number(j.commission_amount ?? 0), 0)) }] };
    }
    if (has('AVG(stars)')) {
      const since = p[1] as string;
      const rs = this.reviews.filter((r) => r.reviewee_id === p[0] && r.created_at >= since);
      return { rows: [{ avg_stars: String(rs.length ? rs.reduce((s, r) => s + r.stars, 0) / rs.length : 0), review_count: String(rs.length) }] };
    }
    if (has('GROUP BY state')) {
      const since = p[1] as string;
      const map = new Map<string, number>();
      for (const j of this.jobs.filter((x) => x.provider_id === p[0] && x.created_at >= since)) map.set(j.state, (map.get(j.state) ?? 0) + 1);
      return { rows: [...map.entries()].map(([state, n]) => ({ state, n: String(n) })) };
    }

    // ---- users ----
    if (has('SELECT id FROM users WHERE id=$1')) {
      const u = this.users.find((x) => x.id === p[0] && !x.deleted_at);
      return { rows: u ? [{ id: u.id }] : [] };
    }

    // ---- teams ----
    if (has('SELECT * FROM teams WHERE id=$1')) {
      const t = this.teams.find((x) => x.id === p[0]);
      return { rows: t ? [t] : [] };
    }
    if (has('SELECT id FROM teams WHERE provider_id=$1')) {
      const t = this.teams.find((x) => x.provider_id === p[0]);
      return { rows: t ? [{ id: t.id }] : [] };
    }
    if (has('INSERT INTO teams')) {
      const row: Row = { id: randomUUID(), provider_id: p[0], owner_user_id: p[1], name: p[2], created_at: nowIso() };
      this.teams.push(row);
      return { rows: [row] };
    }
    if (has('FROM teams t JOIN team_members m')) {
      const rows = this.teams.filter((t) => this.team_members.some((m) => m.team_id === t.id && m.user_id === p[0] && m.status === 'active'))
        .map((t) => ({ ...t, my_role: this.team_members.find((m) => m.team_id === t.id && m.user_id === p[0])?.role }));
      return { rows };
    }
    if (has('SELECT * FROM team_members WHERE team_id=$1 AND user_id=$2')) {
      const m = this.team_members.find((x) => x.team_id === p[0] && x.user_id === p[1]);
      return { rows: m ? [m] : [] };
    }
    if (has("SELECT COUNT(*) AS n FROM team_members WHERE team_id=$1 AND role <> 'owner'")) {
      const n = this.team_members.filter((x) => x.team_id === p[0] && x.role !== 'owner' && (x.status === 'invited' || x.status === 'active')).length;
      return { rows: [{ n: String(n) }] };
    }
    if (has('INSERT INTO team_members')) {
      // createTeam inserts literals ('owner','active'); inviteMember inserts
      // role as $3 and status as the literal 'invited'.
      if (has(`'owner'`)) {
        const row: Row = { id: randomUUID(), team_id: p[0], user_id: p[1], role: 'owner', status: 'active', invited_by: p[1], created_at: nowIso() };
        this.team_members.push(row);
        return { rows: [row] };
      }
      const existing = this.team_members.find((x) => x.team_id === p[0] && x.user_id === p[1]);
      if (existing) { existing.role = p[2]; existing.status = 'invited'; existing.invited_by = p[3]; return { rows: [existing] }; }
      const row: Row = { id: randomUUID(), team_id: p[0], user_id: p[1], role: p[2], status: 'invited', invited_by: p[3], created_at: nowIso() };
      this.team_members.push(row);
      return { rows: [row] };
    }
    if (has("UPDATE team_members SET status='active'")) {
      const m = this.team_members.find((x) => x.team_id === p[0] && x.user_id === p[1]);
      if (m) m.status = 'active';
      return { rows: m ? [m] : [] };
    }
    if (has("UPDATE team_members SET status='removed'")) {
      const m = this.team_members.find((x) => x.team_id === p[0] && x.user_id === p[1]);
      if (m) m.status = 'removed';
      return { rows: m ? [m] : [] };
    }
    if (has('SELECT id, team_id, user_id, role, status, invited_by, created_at FROM team_members')) {
      let rows = this.team_members.filter((x) => x.team_id === p[0] && (x.status === 'invited' || x.status === 'active'));
      if (p[1]) rows = rows.filter((x) => x.user_id === p[1]);
      return { rows };
    }
    if (has('INSERT INTO team_job_assignments')) {
      const existing = this.team_job_assignments.find((x) => x.job_id === p[1]);
      if (existing) { existing.worker_user_id = p[2]; existing.assigned_by = p[3]; existing.assigned_at = nowIso(); return { rows: [existing] }; }
      const row: Row = { id: randomUUID(), team_id: p[0], job_id: p[1], worker_user_id: p[2], assigned_by: p[3], assigned_at: nowIso() };
      this.team_job_assignments.push(row);
      return { rows: [row] };
    }
    if (has('DELETE FROM team_job_assignments WHERE team_id=$1 AND worker_user_id=$2')) {
      this.team_job_assignments = this.team_job_assignments.filter((x) => !(x.team_id === p[0] && x.worker_user_id === p[1]));
      return { rows: [] };
    }
    if (has('DELETE FROM team_job_assignments WHERE team_id=$1 AND job_id=$2')) {
      const found = this.team_job_assignments.find((x) => x.team_id === p[0] && x.job_id === p[1]);
      this.team_job_assignments = this.team_job_assignments.filter((x) => !(x.team_id === p[0] && x.job_id === p[1]));
      return { rows: found ? [found] : [] };
    }
    // team job reads (list + single share the select; single has WHERE j.id=$1)
    if (has('FROM jobs j LEFT JOIN team_job_assignments a')) {
      if (has('WHERE j.id=$1 AND j.provider_id=$2')) {
        const j = this.jobs.find((x) => x.id === p[0] && x.provider_id === p[1]);
        if (!j) return { rows: [] };
        const a = this.team_job_assignments.find((x) => x.job_id === j.id);
        return { rows: [{ ...j, assigned_to: a?.worker_user_id ?? null, assigned_at: a?.assigned_at ?? null }] };
      }
      const workerOnly = has('a.worker_user_id=$');
      let js = this.jobs.filter((x) => x.provider_id === p[0]);
      if (workerOnly) {
        const workerId = p[2] as string;
        js = js.filter((x) => this.team_job_assignments.some((a) => a.job_id === x.id && a.worker_user_id === workerId));
      }
      js = [...js].sort((a, b) => (b.created_at + b.id).localeCompare(a.created_at + a.id));
      return { rows: js.map((j) => { const a = this.team_job_assignments.find((x) => x.job_id === j.id); return { ...j, assigned_to: a?.worker_user_id ?? null, assigned_at: a?.assigned_at ?? null }; }) };
    }
    if (has('SELECT id, provider_id, state FROM jobs WHERE id=$1')) {
      const j = this.jobs.find((x) => x.id === p[0]);
      return { rows: j ? [{ id: j.id, provider_id: j.provider_id, state: j.state }] : [] };
    }
    // team earnings
    if (has("FROM jobs WHERE provider_id=$1 AND payment_status='settled'") && has('jobs_total')) {
      const js = this.jobs.filter((x) => x.provider_id === p[0] && x.payment_status === 'settled');
      return { rows: [{ jobs_total: String(js.length), jobs_settled: String(js.length), gross_pkr: String(js.reduce((s, j) => s + Number(j.final_price ?? 0), 0)), commission_pkr: String(js.reduce((s, j) => s + Number(j.commission_amount ?? 0), 0)) }] };
    }
    if (has('FROM jobs j JOIN team_job_assignments a')) {
      const map = new Map<string, Row>();
      for (const j of this.jobs.filter((x) => x.provider_id === p[0] && x.payment_status === 'settled')) {
        const a = this.team_job_assignments.find((x) => x.job_id === j.id);
        if (!a) continue;
        const cur = map.get(a.worker_user_id) ?? { worker_user_id: a.worker_user_id, jobs_settled: '0', gross_pkr: '0', commission_pkr: '0' };
        cur.jobs_settled = String(Number(cur.jobs_settled) + 1);
        cur.gross_pkr = String(Number(cur.gross_pkr) + Number(j.final_price ?? 0));
        cur.commission_pkr = String(Number(cur.commission_pkr) + Number(j.commission_amount ?? 0));
        map.set(a.worker_user_id, cur);
      }
      return { rows: [...map.values()] };
    }
    if (has('NOT EXISTS (SELECT 1 FROM team_job_assignments')) {
      const js = this.jobs.filter((x) => x.provider_id === p[0] && x.payment_status === 'settled' && !this.team_job_assignments.some((a) => a.job_id === x.id));
      return { rows: [{ jobs_settled: String(js.length), gross_pkr: String(js.reduce((s, j) => s + Number(j.final_price ?? 0), 0)), commission_pkr: String(js.reduce((s, j) => s + Number(j.commission_amount ?? 0), 0)) }] };
    }

    throw new Error(`FakeDb: unhandled SQL: ${text.slice(0, 160)}`);
  }
}

async function expectApiError(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { return e as ApiError; }
  throw new Error('expected promise to reject with an ApiError');
}

/** Fresh fixture: owner user + provider profile + wallet, plus worker users. */
function fixture() {
  const db = new FakeDb();
  const ownerId = randomUUID();
  const worker1 = randomUUID();
  const worker2 = randomUUID();
  const outsider = randomUUID();
  for (const id of [ownerId, worker1, worker2, outsider]) db.users.push({ id, phone: `+92300${id.slice(0, 6)}` });
  const providerId = randomUUID();
  db.provider_profiles.push({ id: providerId, user_id: ownerId, subscription_plan: 'free' });
  db.wallet_accounts.push({ id: randomUUID(), user_id: ownerId, balance_paisa: 500000, escrow_held_paisa: 0, currency: 'PKR' }); // PKR 5,000
  const subs = new SubscriptionsService(db as unknown as any);
  const teams = new TeamsService(db as unknown as any);
  return { db, subs, teams, ownerId, worker1, worker2, outsider, providerId };
}

function seedJob(db: FakeDb, providerId: string, overrides: Partial<Row> = {}): Row {
  const job: Row = { id: randomUUID(), provider_id: providerId, customer_id: randomUUID(), state: 'ACCEPTED', payment_status: 'unpaid', final_price: 2000, commission_amount: 200, created_at: nowIso(), ...overrides };
  db.jobs.push(job);
  return job;
}

describe('plan commission effect (pure)', () => {
  it('Free keeps the base rate, Pro x0.80, Business x0.60', () => {
    expect(applyPlanCommissionRate(0.1, 1.0)).toBe(0.1);
    expect(applyPlanCommissionRate(0.1, 0.8)).toBeCloseTo(0.08);
    expect(applyPlanCommissionRate(0.1, 0.6)).toBeCloseTo(0.06);
    expect(applyPlanCommissionRate(0.15, 0.8)).toBeCloseTo(0.12);
    expect(applyPlanCommissionRate(0.15, 0.6)).toBeCloseTo(0.09);
  });
  it('clamps to the 0.05–0.15 band (floor binds at low base rates)', () => {
    expect(applyPlanCommissionRate(0.05, 0.6)).toBe(0.05);
    expect(applyPlanCommissionRate(0.05, 0.8)).toBe(0.05);
    expect(applyPlanCommissionRate(0.2, 1.0)).toBe(0.15);
  });
  it('featured placement is always labelled "Sponsored"', () => {
    expect(featuredPlacementForPlan(true)).toEqual({ sponsored: true, label: 'Sponsored' });
    expect(featuredPlacementForPlan(false)).toEqual({ sponsored: false, label: null });
  });
});

describe('subscriptions service', () => {
  it('lists the three seeded plans in price order', async () => {
    const { subs } = fixture();
    const plans = await subs.listPlans();
    expect(plans.map((p) => p.code)).toEqual(['free', 'pro', 'business']);
    expect(plans.find((p) => p.code === 'business')!.placement).toEqual({ sponsored: true, label: 'Sponsored' });
  });

  it('a provider with no subscription reads as Free', async () => {
    const { subs, ownerId } = fixture();
    const mine = await subs.getMySubscription(ownerId);
    expect(mine.plan_code).toBe('free');
    expect(mine.status).toBe('none');
    expect(mine.placement).toEqual({ sponsored: false, label: null });
  });

  it('Pro subscribe charges the wallet (PKR 999) and syncs provider_profiles.subscription_plan', async () => {
    const { db, subs, ownerId, providerId } = fixture();
    const mine = await subs.subscribe(ownerId, 'pro');
    expect(mine.plan_code).toBe('pro');
    expect(mine.status).toBe('active');
    expect(db.wallet_accounts[0].balance_paisa).toBe(500000 - 99900);
    // Balanced ledger: one D wallet + one C subscription_revenue, same txn.
    expect(db.ledger_entries).toHaveLength(2);
    expect(db.ledger_entries[0].txn_id).toBe(db.ledger_entries[1].txn_id);
    expect(db.ledger_entries.map((e) => `${e.account_code}:${e.direction}`.toString()).sort()).toEqual(['subscription_revenue:C', 'wallet:D']);
    expect(db.provider_profiles.find((x) => x.id === providerId)!.subscription_plan).toBe('pro');
  });

  it('Free subscribe costs nothing and writes no ledger rows', async () => {
    const { db, subs, ownerId } = fixture();
    const mine = await subs.subscribe(ownerId, 'free');
    expect(mine.plan_code).toBe('free');
    expect(db.wallet_accounts[0].balance_paisa).toBe(500000);
    expect(db.ledger_entries).toHaveLength(0);
  });

  it('subscribe fails 409 when a wallet is short, and writes nothing', async () => {
    const { db, subs, ownerId } = fixture();
    db.wallet_accounts[0].balance_paisa = 100; // PKR 1
    const err = await expectApiError(subs.subscribe(ownerId, 'business'));
    expect(err.status).toBe(409);
    expect(err.code).toBe('INSUFFICIENT_WALLET_BALANCE');
    expect(db.subscriptions).toHaveLength(0);
    expect(db.ledger_entries).toHaveLength(0);
  });

  it('second subscribe fails 409 SUBSCRIPTION_EXISTS', async () => {
    const { subs, ownerId } = fixture();
    await subs.subscribe(ownerId, 'pro');
    const err = await expectApiError(subs.subscribe(ownerId, 'business'));
    expect(err.status).toBe(409);
    expect(err.code).toBe('SUBSCRIPTION_EXISTS');
  });

  it('upgrade charges the new price immediately; downgrade is pending until period end', async () => {
    const { db, subs, ownerId } = fixture();
    await subs.subscribe(ownerId, 'pro');
    const upgraded = await subs.changePlan(ownerId, 'business');
    expect(upgraded.plan_code).toBe('business');
    expect(upgraded.pending_plan_code).toBeNull();
    expect(db.wallet_accounts[0].balance_paisa).toBe(500000 - 99900 - 249900);
    const downgraded = await subs.changePlan(ownerId, 'pro');
    expect(downgraded.plan_code).toBe('business'); // still Business until period end
    expect(downgraded.pending_plan_code).toBe('pro');
    expect(db.wallet_accounts[0].balance_paisa).toBe(500000 - 99900 - 249900); // no charge for a downgrade
  });

  it('same-plan change fails 409 SAME_PLAN', async () => {
    const { subs, ownerId } = fixture();
    await subs.subscribe(ownerId, 'pro');
    const err = await expectApiError(subs.changePlan(ownerId, 'pro'));
    expect(err.code).toBe('SAME_PLAN');
  });

  it('cancel keeps benefits to period end; expire sweep applies a pending downgrade', async () => {
    const { db, subs, ownerId, providerId } = fixture();
    await subs.subscribe(ownerId, 'business');
    await subs.changePlan(ownerId, 'pro'); // pending downgrade
    const cancelled = await subs.cancel(ownerId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancel_at_period_end).toBe(true);
    // Cancel clears the pending downgrade; a fresh Business sub then expires.
    await subs.subscribe(ownerId, 'business');
    const sub = db.subscriptions.find((s) => s.status === 'active')!;
    sub.current_period_end = new Date(Date.now() - 1000).toISOString();
    const swept = await subs.expireEndedSubscriptions();
    expect(swept.processed).toBe(1);
    expect(db.provider_profiles.find((x) => x.id === providerId)!.subscription_plan).toBe('free');
  });

  it('effectiveCommissionRate applies the plan multiplier (Business 0.10 -> 0.06)', async () => {
    const { subs, ownerId } = fixture();
    expect(await subs.effectiveCommissionRate(ownerId, 0.1)).toBe(0.1); // Free
    await subs.subscribe(ownerId, 'business');
    expect(await subs.effectiveCommissionRate(ownerId, 0.1)).toBeCloseTo(0.06);
    expect(await subs.effectiveCommissionRate(ownerId, 0.15)).toBeCloseTo(0.09);
  });

  it('isProviderFeatured is true only for active Business', async () => {
    const { subs, ownerId, providerId } = fixture();
    expect(await subs.isProviderFeatured(providerId)).toEqual({ sponsored: false, label: null });
    await subs.subscribe(ownerId, 'business');
    expect(await subs.isProviderFeatured(providerId)).toEqual({ sponsored: true, label: 'Sponsored' });
  });

  it('analytics is 403 on Free and returns aggregates on Pro', async () => {
    const { db, subs, ownerId, providerId } = fixture();
    const err = await expectApiError(subs.getAnalytics(ownerId));
    expect(err.status).toBe(403);
    await subs.subscribe(ownerId, 'pro');
    seedJob(db, providerId, { state: 'PAYMENT_SETTLED', payment_status: 'settled', final_price: 2000, commission_amount: 160 });
    seedJob(db, providerId, { state: 'ACCEPTED', payment_status: 'unpaid', final_price: 3000, commission_amount: 240 });
    db.reviews.push({ reviewee_id: ownerId, stars: 5, created_at: nowIso() });
    const a = await subs.getAnalytics(ownerId);
    expect(a.jobs_total).toBe(2);
    expect(a.jobs_settled).toBe(1);
    expect(a.gross_pkr).toBe(5000);
    expect(a.commission_pkr).toBe(400);
    expect(a.net_earnings_pkr).toBe(4600);
    expect(a.avg_stars).toBe(5);
    expect(a.jobs_by_state).toEqual({ PAYMENT_SETTLED: 1, ACCEPTED: 1 });
  });

  it('admin can create and update a plan', async () => {
    const { subs } = fixture();
    const created = await subs.createPlan({ code: 'enterprise', name: 'Enterprise', price_pkr: 4999, commission_multiplier: 0.5, max_staff_accounts: 20, featured: true, analytics_enabled: true });
    expect(created.code).toBe('enterprise');
    const updated = await subs.updatePlan(created.id, { price_pkr: 3999 });
    expect(updated.price_pkr).toBe(3999);
    expect((await subs.listPlans()).map((p) => p.code)).toContain('enterprise');
  });
});

describe('teams service — permissions and visibility', () => {
  async function businessTeam() {
    const f = fixture();
    await f.subs.subscribe(f.ownerId, 'business');
    const team = await f.teams.createTeam(f.ownerId, 'Ali Repair Shop');
    return { ...f, team };
  }

  it('owner creates a team and is its owner member; a second team is 409', async () => {
    const { teams, ownerId } = await businessTeam();
    const err = await expectApiError(teams.createTeam(ownerId, 'Second Shop'));
    expect(err.code).toBe('TEAM_EXISTS');
  });

  it('invite requires a Business plan: Free owner hits TEAM_SEAT_LIMIT', async () => {
    const f = fixture();
    const team = await f.teams.createTeam(f.ownerId, 'Shop');
    const err = await expectApiError(f.teams.inviteMember(team.id, f.ownerId, f.worker1, 'worker'));
    expect(err.status).toBe(409);
    expect(err.code).toBe('TEAM_SEAT_LIMIT');
  });

  it('invite -> accept flow; duplicate invite is 409; unknown user is 404', async () => {
    const f = await businessTeam();
    const invited = await f.teams.inviteMember(f.team.id, f.ownerId, f.worker1, 'worker');
    expect(invited.status).toBe('invited');
    const err = await expectApiError(f.teams.inviteMember(f.team.id, f.ownerId, f.worker1, 'worker'));
    expect(err.code).toBe('ALREADY_MEMBER');
    const err2 = await expectApiError(f.teams.inviteMember(f.team.id, f.ownerId, randomUUID(), 'worker'));
    expect(err2.status).toBe(404);
    const accepted = await f.teams.acceptInvite(f.team.id, f.worker1);
    expect(accepted.status).toBe('active');
  });

  it('Business seat limit is 5: the 6th invite fails', async () => {
    const f = await businessTeam();
    const extra = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const id of extra) f.db.users.push({ id });
    for (const id of extra.slice(0, 5)) await f.teams.inviteMember(f.team.id, f.ownerId, id, 'worker');
    const err = await expectApiError(f.teams.inviteMember(f.team.id, f.ownerId, extra[5], 'worker'));
    expect(err.code).toBe('TEAM_SEAT_LIMIT');
  });

  it('a worker cannot invite members (403) and cannot see the full member list', async () => {
    const f = await businessTeam();
    await f.teams.inviteMember(f.team.id, f.ownerId, f.worker1, 'worker');
    await f.teams.acceptInvite(f.team.id, f.worker1);
    await f.teams.inviteMember(f.team.id, f.ownerId, f.worker2, 'worker');
    const err = await expectApiError(f.teams.inviteMember(f.team.id, f.worker1, f.worker2, 'worker'));
    expect(err.status).toBe(403);
    const mine = await f.teams.listMembers(f.team.id, f.worker1);
    expect(mine.items.map((m: Row) => m.user_id)).toEqual([f.worker1]);
    const all = await f.teams.listMembers(f.team.id, f.ownerId);
    expect(all.items.length).toBe(3); // owner + 2 workers
  });

  it('assign requires ACCEPTED state and an active team worker', async () => {
    const f = await businessTeam();
    const job = seedJob(f.db, f.providerId);
    const inProgress = seedJob(f.db, f.providerId, { state: 'IN_PROGRESS' });
    const errState = await expectApiError(f.teams.assignJob(f.team.id, f.ownerId, inProgress.id, f.worker1));
    expect(errState.code).toBe('JOB_NOT_ASSIGNABLE');
    // worker1 not yet a member
    const errWorker = await expectApiError(f.teams.assignJob(f.team.id, f.ownerId, job.id, f.worker1));
    expect(errWorker.code).toBe('WORKER_NOT_ACTIVE');
    await f.teams.inviteMember(f.team.id, f.ownerId, f.worker1, 'worker');
    await f.teams.acceptInvite(f.team.id, f.worker1);
    const assigned = await f.teams.assignJob(f.team.id, f.ownerId, job.id, f.worker1);
    expect(assigned.worker_user_id).toBe(f.worker1);
  });

  it('worker visibility: sees only assigned jobs; other worker and unassigned jobs are 403', async () => {
    const f = await businessTeam();
    for (const w of [f.worker1, f.worker2]) { await f.teams.inviteMember(f.team.id, f.ownerId, w, 'worker'); await f.teams.acceptInvite(f.team.id, w); }
    const mine = seedJob(f.db, f.providerId);
    const theirs = seedJob(f.db, f.providerId);
    const unassigned = seedJob(f.db, f.providerId);
    await f.teams.assignJob(f.team.id, f.ownerId, mine.id, f.worker1);
    await f.teams.assignJob(f.team.id, f.ownerId, theirs.id, f.worker2);
    // list: worker1 sees exactly their own job
    const list = await f.teams.listTeamJobs(f.team.id, f.worker1);
    expect(list.items.map((j: Row) => j.id)).toEqual([mine.id]);
    // single: own job ok, other's job 403, unassigned 403
    expect((await f.teams.getTeamJob(f.team.id, f.worker1, mine.id)).id).toBe(mine.id);
    const errOther = await expectApiError(f.teams.getTeamJob(f.team.id, f.worker1, theirs.id));
    expect(errOther.status).toBe(403);
    const errUnassigned = await expectApiError(f.teams.getTeamJob(f.team.id, f.worker1, unassigned.id));
    expect(errUnassigned.status).toBe(403);
    // owner sees all three, including unassigned
    const ownerList = await f.teams.listTeamJobs(f.team.id, f.ownerId);
    expect(ownerList.items.map((j: Row) => j.id).sort()).toEqual([mine.id, theirs.id, unassigned.id].sort());
    expect((await f.teams.getTeamJob(f.team.id, f.ownerId, unassigned.id)).assigned_to).toBeNull();
  });

  it('outsider (non-member) gets 403 on team reads and earnings', async () => {
    const f = await businessTeam();
    const err = await expectApiError(f.teams.getTeam(f.team.id, f.outsider));
    expect(err.status).toBe(403);
    const err2 = await expectApiError(f.teams.getTeamEarnings(f.team.id, f.outsider));
    expect(err2.status).toBe(403);
  });

  it('worker cannot read team earnings (403); owner sees central totals + per-worker split', async () => {
    const f = await businessTeam();
    await f.teams.inviteMember(f.team.id, f.ownerId, f.worker1, 'worker');
    await f.teams.acceptInvite(f.team.id, f.worker1);
    const settledMine = seedJob(f.db, f.providerId, { state: 'ACCEPTED', payment_status: 'unpaid', final_price: 2000, commission_amount: 120 });
    const settledOther = seedJob(f.db, f.providerId, { state: 'PAYMENT_SETTLED', payment_status: 'settled', final_price: 1000, commission_amount: 60 });
    await f.teams.assignJob(f.team.id, f.ownerId, settledMine.id, f.worker1);
    // The job settles after assignment (assignment only happens while ACCEPTED).
    settledMine.state = 'PAYMENT_SETTLED';
    settledMine.payment_status = 'settled';
    void settledOther;
    const err = await expectApiError(f.teams.getTeamEarnings(f.team.id, f.worker1));
    expect(err.status).toBe(403);
    const e = await f.teams.getTeamEarnings(f.team.id, f.ownerId);
    expect(e.gross_pkr).toBe(3000);
    expect(e.commission_pkr).toBe(180);
    expect(e.net_earnings_pkr).toBe(2820);
    expect(e.by_worker).toEqual([{ worker_user_id: f.worker1, jobs_settled: 1, gross_pkr: 2000, commission_pkr: 120, net_earnings_pkr: 1880 }]);
    expect(e.unassigned.jobs_settled).toBe(1);
    expect(e.unassigned.gross_pkr).toBe(1000);
  });

  it('removing a member unassigns their jobs and blocks their access', async () => {
    const f = await businessTeam();
    await f.teams.inviteMember(f.team.id, f.ownerId, f.worker1, 'worker');
    await f.teams.acceptInvite(f.team.id, f.worker1);
    const job = seedJob(f.db, f.providerId);
    await f.teams.assignJob(f.team.id, f.ownerId, job.id, f.worker1);
    await f.teams.removeMember(f.team.id, f.ownerId, f.worker1);
    const err = await expectApiError(f.teams.getTeamJob(f.team.id, f.worker1, job.id));
    expect(err.status).toBe(403);
    expect((await f.teams.getTeamJob(f.team.id, f.ownerId, job.id)).assigned_to).toBeNull();
  });

  it('only the owner can remove a member; the owner cannot be removed', async () => {
    const f = await businessTeam();
    await f.teams.inviteMember(f.team.id, f.ownerId, f.worker1, 'manager');
    await f.teams.acceptInvite(f.team.id, f.worker1);
    const err = await expectApiError(f.teams.removeMember(f.team.id, f.worker1, f.worker1));
    expect(err.status).toBe(403);
    const err2 = await expectApiError(f.teams.removeMember(f.team.id, f.ownerId, f.ownerId));
    expect(err2.code).toBe('CANNOT_REMOVE_OWNER');
  });
});
