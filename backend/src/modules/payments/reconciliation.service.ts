// Ledger reconciliation (Stage 2, FIX 8b) — the nightly job.
// The DB-level guard (db/0008) stops NEW unbalanced writes at COMMIT, but
// it cannot prove the wallet balances match the ledger, and it cannot see
// rows written before the guard existed. This job checks both, every run:
//
//   1. every txn_id: SUM(debits) = SUM(credits) over ledger_entries;
//   2. every wallet: wallet_accounts.balance_paisa =
//      SUM over ledger_entries WHERE wallet_id = <wallet> AND
//      account_code = 'wallet' of (+amount for C, -amount for D).
//      (Only 'wallet'-coded legs move the balance: the other leg of each
//      pair — cash_in, commission_rev, promo_expense, referral_expense,
//      refund_expense, compensation_expense — is the counter-account and
//      must NOT be counted. Verified against every writer: wallet.service
//      top-up + wallet-pay, jobs.service cash commission, referral.ts,
//      admin.service dispute refund/compensation.)
//
// Mismatches are written to fraud_signals (signal 'ledger_unbalanced' /
// 'wallet_balance_mismatch', detail carries txn_id / wallet_id) and to a
// reconciliation_reports row (the admin-visible record). The job is
// IDEMPOTENT: re-running it never duplicates a fraud_signal for a
// mismatch already recorded — it only inserts a signal the first time a
// given txn_id / wallet_id is seen mismatching. Each run still appends
// one reconciliation_reports row (the run log).
//
// NIGHTLY SCHEDULING: no cron infra is built in this repo. An external
// scheduler (cron, systemd timer, or the hosting platform's scheduler)
// should call POST /api/v1/admin/reconciliation/run nightly with a
// super_admin / finance credential, e.g.:
//   0 2 * * * curl -X POST https://<host>/api/v1/admin/reconciliation/run \
//     -H "Authorization: Bearer <service-token>"
// On-demand runs use the same endpoint; GET /api/v1/admin/reconciliation
// returns the latest report.
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export interface LedgerMismatch {
  kind: 'txn_unbalanced' | 'wallet_balance';
  txn_id?: string;
  wallet_id?: string;
  user_id?: string | null;
  job_id?: string | null;
  diff_paisa: number;
  detail: string;
}

export interface ReconciliationReport {
  id: string;
  run_at: string;
  triggered_by: string;
  txn_checked: number;
  txn_mismatches: number;
  wallet_checked: number;
  wallet_mismatches: number;
  mismatches: LedgerMismatch[];
  status: 'clean' | 'mismatch';
}

type MismatchRow = {
  txn_id?: string;
  wallet_id?: string;
  user_id?: string | null;
  job_id?: string | null;
  diff_paisa: string;
  balance_paisa?: string;
  derived_paisa?: string;
};

@Injectable()
export class ReconciliationService {
  constructor(private db: DatabaseService) {}

  async run(triggeredBy: 'manual' | 'nightly' = 'manual'): Promise<ReconciliationReport> {
    const mismatches: LedgerMismatch[] = [];

    const txnRows = (await this.db.query<MismatchRow>(
      `SELECT le.txn_id,
              SUM(CASE WHEN le.direction='D' THEN le.amount_paisa ELSE -le.amount_paisa END)::bigint AS diff_paisa,
              MIN(le.job_id::text)::uuid AS job_id, MIN(w.user_id::text)::uuid AS user_id
         FROM ledger_entries le
         LEFT JOIN wallet_accounts w ON w.id = le.wallet_id
        GROUP BY le.txn_id
       HAVING SUM(CASE WHEN le.direction='D' THEN le.amount_paisa ELSE -le.amount_paisa END) <> 0`,
    )).rows;
    const txnChecked = Number(
      (await this.db.query<{ cnt: string }>(`SELECT COUNT(DISTINCT txn_id)::text AS cnt FROM ledger_entries`)).rows[0]?.cnt ?? 0,
    );
    for (const r of txnRows) {
      mismatches.push({
        kind: 'txn_unbalanced',
        txn_id: String(r.txn_id),
        user_id: r.user_id ? String(r.user_id) : null,
        job_id: r.job_id ? String(r.job_id) : null,
        diff_paisa: Number(r.diff_paisa),
        detail: `txn ${r.txn_id}: sum(debits) - sum(credits) = ${r.diff_paisa} paisa`,
      });
    }

    const walletRows = (await this.db.query<MismatchRow>(
      `SELECT w.id AS wallet_id, w.user_id, w.balance_paisa::bigint AS balance_paisa,
              COALESCE(SUM(CASE WHEN le.direction='C' THEN le.amount_paisa ELSE -le.amount_paisa END), 0)::bigint AS derived_paisa
         FROM wallet_accounts w
         LEFT JOIN ledger_entries le
           ON le.wallet_id = w.id AND le.account_code = 'wallet'
        GROUP BY w.id, w.user_id, w.balance_paisa
       HAVING w.balance_paisa <> COALESCE(SUM(CASE WHEN le.direction='C' THEN le.amount_paisa ELSE -le.amount_paisa END), 0)`,
    )).rows;
    const walletChecked = Number(
      (await this.db.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM wallet_accounts`)).rows[0]?.cnt ?? 0,
    );
    for (const r of walletRows) {
      const diff = Number(r.balance_paisa) - Number(r.derived_paisa);
      mismatches.push({
        kind: 'wallet_balance',
        wallet_id: String(r.wallet_id),
        user_id: r.user_id ? String(r.user_id) : null,
        diff_paisa: diff,
        detail: `wallet ${r.wallet_id}: balance_paisa=${r.balance_paisa} but ledger-derived=${r.derived_paisa} (diff ${diff} paisa)`,
      });
    }

    // fraud_signals: one per NEW mismatch only (idempotent re-runs).
    for (const m of mismatches) {
      const signal = m.kind === 'txn_unbalanced' ? 'ledger_unbalanced' : 'wallet_balance_mismatch';
      const keyCol = m.kind === 'txn_unbalanced' ? 'txn_id' : 'wallet_id';
      const keyVal = m.kind === 'txn_unbalanced' ? m.txn_id : m.wallet_id;
      const existing = (await this.db.query(
        `SELECT 1 FROM fraud_signals WHERE signal=$1 AND detail->>$2=$3 LIMIT 1`,
        [signal, keyCol, keyVal],
      )).rows;
      if (existing.length > 0) continue;
      await this.db.query(
        `INSERT INTO fraud_signals (user_id, job_id, signal, detail) VALUES ($1,$2,$3,$4)`,
        [m.user_id ?? null, m.job_id ?? null, signal, JSON.stringify(m)],
      );
    }

    const status: 'clean' | 'mismatch' = mismatches.length === 0 ? 'clean' : 'mismatch';
    const row = (await this.db.query(
      `INSERT INTO reconciliation_reports
         (triggered_by, txn_checked, txn_mismatches, wallet_checked, wallet_mismatches, mismatches, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        triggeredBy,
        txnChecked,
        txnRows.length,
        walletChecked,
        walletRows.length,
        JSON.stringify(mismatches),
        status,
      ],
    )).rows[0];
    return this.toReport(row);
  }

  async latest(): Promise<ReconciliationReport | null> {
    const row = (await this.db.query(
      `SELECT * FROM reconciliation_reports ORDER BY run_at DESC, created_at DESC LIMIT 1`,
    )).rows[0];
    return row ? this.toReport(row) : null;
  }

  private toReport(row: Record<string, unknown>): ReconciliationReport {
    return {
      id: String(row.id),
      run_at: (row.run_at as Date).toISOString(),
      triggered_by: String(row.triggered_by),
      txn_checked: Number(row.txn_checked),
      txn_mismatches: Number(row.txn_mismatches),
      wallet_checked: Number(row.wallet_checked),
      wallet_mismatches: Number(row.wallet_mismatches),
      mismatches: (row.mismatches as LedgerMismatch[]) ?? [],
      status: row.status as 'clean' | 'mismatch',
    };
  }
}
