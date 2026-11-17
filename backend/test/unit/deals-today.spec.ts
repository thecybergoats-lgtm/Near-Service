// Deals of the day (Batch 3) — unit tests for PromotionsService.listTodayDeals.
// FakeDb pattern-matches the SQL the service emits; no live DB.
// Run with: npx jest --runInBand test/unit/deals-today.spec.ts
import { PromotionsService } from '../../src/modules/payments/promotions.service';
import { DatabaseService } from '../../src/database/database.service';

type Row = Record<string, any>;

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
});

class FakeDb {
  promos: Row[] = [];
  redemptionsUsed = 0;

  async query(sql: string, _params?: unknown[]): Promise<{ rows: Row[] }> {
    if (sql.includes('FROM promos WHERE is_active')) return { rows: this.promos };
    if (sql.includes('FROM promo_redemptions WHERE promo_id=$1')) {
      return { rows: [{ cnt: String(this.redemptionsUsed) }] };
    }
    throw new Error(`unexpected SQL in FakeDb: ${sql.slice(0, 120)}`);
  }
}

function makeService(db: FakeDb) {
  return new PromotionsService(db as unknown as DatabaseService);
}

function promo(over: Partial<Row>): Row {
  return {
    id: 'promo-1', code: 'DEAL10', kind: 'percent', value: 10, max_uses: null,
    per_user_limit: 1, per_device_limit: 1, category_id: null, city_id: null,
    first_job_only: false, valid_from: null, valid_to: null, is_active: true,
    ...over,
  };
}

describe('listTodayDeals (Batch 3)', () => {
  it('returns active promos with discount text and validity window', async () => {
    const db = new FakeDb();
    db.promos = [
      promo({ code: 'DEAL10', kind: 'percent', value: 10 }),
      promo({ id: 'promo-2', code: 'FLAT500', kind: 'fixed', value: 500 }),
    ];
    const { items } = await makeService(db).listTodayDeals();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ code: 'DEAL10', discount_text: '10% off', ends_today: false });
    expect(items[1]).toMatchObject({ code: 'FLAT500', discount_text: 'PKR 500 off', ends_today: false });
  });

  it('ends_today is true when valid_to falls on today (Asia/Karachi)', async () => {
    const db = new FakeDb();
    // Today 23:59 in PKT, expressed as an ISO instant.
    const nowPkt = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi' }));
    const endOfTodayPkt = new Date(nowPkt);
    endOfTodayPkt.setHours(23, 59, 0, 0);
    // Convert the PKT wall time back to UTC (PKT = UTC+5).
    const validTo = new Date(endOfTodayPkt.getTime() - 5 * 60 * 60 * 1000).toISOString();
    expect(dayFmt.format(new Date(validTo))).toBe(dayFmt.format(new Date()));
    db.promos = [promo({ code: 'TODAYONLY', valid_to: validTo })];
    const { items } = await makeService(db).listTodayDeals();
    expect(items).toHaveLength(1);
    expect(items[0].ends_today).toBe(true);
    expect(items[0].valid_to).toBe(validTo);
  });

  it('skips promos whose max_uses are exhausted', async () => {
    const db = new FakeDb();
    db.promos = [promo({ code: 'ONEUSE', max_uses: 1 })];
    db.redemptionsUsed = 1;
    const { items } = await makeService(db).listTodayDeals();
    expect(items).toEqual([]);
  });

  it('never invents a deal — an empty promos table returns an empty list', async () => {
    const db = new FakeDb();
    db.promos = [];
    const { items } = await makeService(db).listTodayDeals();
    expect(items).toEqual([]);
  });
});
