// Referral credit (Phase 2) — one-way helper: jobs/payments code calls
// this; nothing in here imports any module, so no module cycle is possible.
// Rule: when a referred user completes their FIRST paid job, the referrer
// is credited PKR 200 (20000 paisa) as a balanced ledger entry, inside the
// same settlement transaction as the job payment.
import { ensureWallet } from './wallet';

export const REFERRAL_CREDIT_PAISA = 20000; // PKR 200
export const REFERRAL_CREDIT_PKR = 200;

/** Referral code for a user: 'NS-' + first 8 hex chars of their id
 *  (dashes stripped, so the code is always NS-XXXXXXXX). */
export function referralCodeFor(userId: string): string {
  return `NS-${String(userId).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export type QueryClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * Credit the referrer if this settlement is the referred user's FIRST paid
 * job. Call AFTER the job has been marked PAYMENT_SETTLED/payment_status=
 * 'settled' inside the same transaction, so the settled-job count includes
 * this job. Returns true when a credit was written.
 */
export async function creditReferrerIfFirstPaidJob(
  client: QueryClient,
  referredUserId: string,
  jobId: string,
): Promise<boolean> {
  const ref = (await client.query(
    `SELECT * FROM referrals WHERE referred_id=$1 AND status='pending'`,
    [referredUserId],
  )).rows[0] as unknown as { id: string; referrer_id: string } | undefined;
  if (!ref) return false;
  const settled = (await client.query(
    `SELECT COUNT(*) AS cnt FROM jobs WHERE customer_id=$1 AND payment_status='settled'`,
    [referredUserId],
  )).rows[0] as unknown as { cnt: string };
  if (Number(settled.cnt) !== 1) return false; // not their first paid job
  const walletId = await ensureWallet(client, String(ref.referrer_id));
  const txnId = jobId; // reuse the job id as the txn grouping key
  await client.query(
    `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [txnId, walletId, 'referral_expense', 'D', REFERRAL_CREDIT_PAISA, jobId, 'Referral credit expense'],
  );
  await client.query(
    `INSERT INTO ledger_entries (txn_id, wallet_id, account_code, direction, amount_paisa, job_id, memo)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [txnId, walletId, 'wallet', 'C', REFERRAL_CREDIT_PAISA, jobId, 'Referral credit'],
  );
  await client.query(`UPDATE wallet_accounts SET balance_paisa = balance_paisa + $2 WHERE id=$1`, [
    walletId,
    REFERRAL_CREDIT_PAISA,
  ]);
  await client.query(
    `UPDATE referrals SET status='credited', credit_paisa=$2 WHERE id=$1`,
    [ref.id, REFERRAL_CREDIT_PAISA],
  );
  return true;
}
