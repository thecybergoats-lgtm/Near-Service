// v1.1 wallet rule: exactly ONE wallet per user (wallet_accounts.user_id
// UNIQUE). Customer and provider are profile-level VIEWS over that one
// wallet — never separate wallets. get-or-create is the only way a wallet
// row comes into existence.
export async function ensureWallet(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  userId: string,
): Promise<string> {
  const rows = (await client.query(
    `INSERT INTO wallet_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING id`, [userId])).rows;
  if (rows[0]) return String(rows[0].id);
  const existing = (await client.query(`SELECT id FROM wallet_accounts WHERE user_id=$1`, [userId])).rows[0];
  return String(existing.id);
}
