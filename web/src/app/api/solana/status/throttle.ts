/**
 * Per-tenant pacing for GET /api/solana/status. A live account's status reads
 * the vault, its balances and the fee payer from paid RPC, so one signed-in
 * client looping it must not turn into unbounded provider load. Page loads and
 * the refresh after each action fit in the burst; after that one read every
 * few seconds. In-process only, like the group chat's post bucket.
 */
export const SOLANA_STATUS_BURST = 10;
export const SOLANA_STATUS_REFILL_MS = 3_000;
const MAX_TENANTS = 10_000;
const buckets = new Map<string, { tokens: number; at: number }>();

/** Seconds to wait, or null when this tenant may read its status now. */
export function takeSolanaStatusToken(tenant: string, now = Date.now()): number | null {
  const key = tenant.toLowerCase(), had = buckets.get(key);
  const tokens = had ? Math.min(SOLANA_STATUS_BURST, had.tokens + Math.max(0, now - had.at) / SOLANA_STATUS_REFILL_MS) : SOLANA_STATUS_BURST;
  if (tokens < 1) {
    buckets.set(key, { tokens, at: now });
    return Math.max(1, Math.ceil(((1 - tokens) * SOLANA_STATUS_REFILL_MS) / 1000));
  }
  buckets.set(key, { tokens: tokens - 1, at: now });
  if (buckets.size > MAX_TENANTS) {
    for (const [k, b] of buckets) if (b.tokens + Math.max(0, now - b.at) / SOLANA_STATUS_REFILL_MS >= SOLANA_STATUS_BURST) buckets.delete(k);
  }
  return null;
}
