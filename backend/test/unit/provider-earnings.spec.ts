// Provider earnings dashboard + own profile (Batch 3) — unit tests.
// FakeDb pattern-matches the SQL the service emits; no live DB.
// Run with: npx jest --runInBand test/unit/provider-earnings.spec.ts
import { ProvidersService } from '../../src/modules/providers/providers.service';
import { DatabaseService } from '../../src/database/database.service';
import { RedisService } from '../../src/database/redis.service';
import { ApiError } from '../../src/common/errors/api-error';

type Row = Record<string, any>;

class FakeDb {
  profile: Row | null = {
    id: 'prov-1', user_id: 'user-1', display_name: 'Ustad Kareem Binder',
    shop_name: 'Kareem Book Binding', provider_type: 'INDIVIDUAL', tier: 1,
    is_online: true, rating_avg: '4.5', jobs_completed: 89,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  // pg returns numeric columns as strings — the service Number()s them.
  agg: Row = {
    today_earnings: '1000', today_commission: '100', today_jobs: '2',
    week_earnings: '5000', week_commission: '500', week_jobs: '8',
    month_earnings: '20000', month_commission: '2000', month_jobs: '30',
    all_earnings: '90000', all_commission: '9000', all_jobs: '120',
    pending_payout: '3500',
  };
  wallet: Row | null = { balance_paisa: '250000' }; // PKR 2,500
  payouts: Row[] = [{
    id: 'pay-1', amount_paisa: '100000', fee_paisa: '0', destination: 'JazzCash',
    status: 'requested', kind: 'instant', created_at: '2026-11-10T10:00:00.000Z',
  }];

  async query(sql: string, _params?: unknown[]): Promise<{ rows: Row[] }> {
    if (sql.includes('display_name') && sql.includes('FROM provider_profiles WHERE user_id=$1')) {
      return { rows: this.profile ? [this.profile] : [] };
    }
    if (sql.includes('SELECT id FROM provider_profiles WHERE user_id=$1')) {
      return { rows: this.profile ? [{ id: this.profile.id }] : [] };
    }
    if (sql.includes('WITH bounds AS')) return { rows: [this.agg] };
    if (sql.includes('FROM wallet_accounts WHERE user_id=$1')) {
      return { rows: this.wallet ? [this.wallet] : [] };
    }
    if (sql.includes('FROM payouts p JOIN wallet_accounts')) return { rows: this.payouts };
    throw new Error(`unexpected SQL in FakeDb: ${sql.slice(0, 120)}`);
  }

  async withTransaction<T>(fn: (c: any) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function makeService(db: FakeDb) {
  return new ProvidersService(
    db as unknown as DatabaseService,
    {} as unknown as RedisService,
  );
}

const expectErr = (p: Promise<unknown>, code: string, status: number) =>
  expect(p).rejects.toMatchObject({ code, status } as Partial<ApiError>);

describe('getMyProfile (Batch 3)', () => {
  it('returns the provider profile for the caller', async () => {
    const svc = makeService(new FakeDb());
    const p = await svc.getMyProfile('user-1');
    expect(p.id).toBe('prov-1');
    expect(p.display_name).toBe('Ustad Kareem Binder');
    expect(p.shop_name).toBe('Kareem Book Binding');
    expect(p.rating_avg).toBe(4.5);
    expect(p.jobs_completed).toBe(89);
  });

  it('403s when the account has no provider profile', async () => {
    const db = new FakeDb();
    db.profile = null;
    await expectErr(makeService(db).getMyProfile('user-1'), 'FORBIDDEN', 403);
  });
});

describe('getEarnings (Batch 3)', () => {
  it('maps today / 7-day / 30-day / all-time periods from the aggregate row', async () => {
    const svc = makeService(new FakeDb());
    const e = await svc.getEarnings('user-1');
    expect(e.provider_id).toBe('prov-1');
    expect(e.currency).toBe('PKR');
    expect(e.today).toEqual({ earnings_pkr: 1000, commission_pkr: 100, completed_jobs: 2 });
    expect(e.last_7_days).toEqual({ earnings_pkr: 5000, commission_pkr: 500, completed_jobs: 8 });
    expect(e.last_30_days).toEqual({ earnings_pkr: 20000, commission_pkr: 2000, completed_jobs: 30 });
    expect(e.all_time).toEqual({ earnings_pkr: 90000, commission_pkr: 9000, completed_jobs: 120 });
  });

  it('pending payout is COMPLETED-but-unpaid money; wallet balance converts paisa to PKR', async () => {
    const svc = makeService(new FakeDb());
    const e = await svc.getEarnings('user-1');
    expect(e.pending_payout_pkr).toBe(3500);
    expect(e.wallet_balance_pkr).toBe(2500);
  });

  it('lists payouts with amounts converted to PKR', async () => {
    const svc = makeService(new FakeDb());
    const e = await svc.getEarnings('user-1');
    expect(e.payouts).toHaveLength(1);
    expect(e.payouts[0]).toMatchObject({
      id: 'pay-1', amount_pkr: 1000, fee_pkr: 0,
      destination: 'JazzCash', status: 'requested', kind: 'instant',
    });
  });

  it('empty wallet / no payouts degrade to 0 / [] instead of failing', async () => {
    const db = new FakeDb();
    db.wallet = null;
    db.payouts = [];
    const e = await makeService(db).getEarnings('user-1');
    expect(e.wallet_balance_pkr).toBe(0);
    expect(e.payouts).toEqual([]);
  });

  it('403s when the account has no provider profile', async () => {
    const db = new FakeDb();
    db.profile = null;
    await expectErr(makeService(db).getEarnings('user-1'), 'FORBIDDEN', 403);
  });
});
