/**
 * Per-tenant pacing for the owner and permission routes (POST /api/solana/owner
 * and POST /api/solana/setup), like the status and intent routes'. Preparing an
 * owner transaction reads the vault, the owner wallet, rents and a blockhash,
 * simulates it for a priority fee and saves it; a WSOL withdrawal also asks
 * Jupiter and Pyth for its value. Submitting reads both providers for the
 * outcome. One signed-in client looping any of these must not become unbounded
 * provider load.
 *
 * Three buckets per tenant:
 * - revoke: preparing a revocation. Its own bucket, so looping withdrawals or
 *   permissions never delays the emergency revoke.
 * - prepare: every other prepare (withdrawals, resume-buys, a trading
 *   permission) and any other request that reads the chain to build or record
 *   something for the owner.
 * - submit: submitting signed bytes (again) and activating a permission. More
 *   generous: the page resubmits signed bytes to learn their outcome.
 *
 * A paced request is answered 429 before the runtime runs, so nothing is read,
 * prepared, saved or sent by it. In-process only, like the other Solana buckets.
 */
export const SOLANA_OWNER_PACE = {
  revoke: { burst: 5, refillMs: 6_000 },
  prepare: { burst: 5, refillMs: 6_000 },
  submit: { burst: 10, refillMs: 3_000 },
} as const;
export type SolanaOwnerBucket = keyof typeof SOLANA_OWNER_PACE;
const MAX_TENANTS = 10_000;
const buckets: Record<SolanaOwnerBucket, Map<string, { tokens: number; at: number }>> = { revoke: new Map(), prepare: new Map(), submit: new Map() };

/** Seconds to wait, or null when this tenant may make this request now. */
export function takeSolanaOwnerToken(tenant: string, bucketName: SolanaOwnerBucket, now = Date.now()): number | null {
  const { burst, refillMs } = SOLANA_OWNER_PACE[bucketName], bucket = buckets[bucketName];
  const key = tenant.toLowerCase(), had = bucket.get(key);
  const tokens = had ? Math.min(burst, had.tokens + Math.max(0, now - had.at) / refillMs) : burst;
  if (tokens < 1) {
    bucket.set(key, { tokens, at: now });
    return Math.max(1, Math.ceil(((1 - tokens) * refillMs) / 1000));
  }
  bucket.set(key, { tokens: tokens - 1, at: now });
  if (bucket.size > MAX_TENANTS) {
    for (const [k, b] of bucket) if (b.tokens + Math.max(0, now - b.at) / refillMs >= burst) bucket.delete(k);
  }
  return null;
}

/**
 * The 429 a paced owner or permission request answers. A paced submission
 * speaks only for this request: the page resubmits signed bytes to learn their
 * outcome, and an earlier submission of them may already have been saved and
 * sent, so it never says nothing was sent.
 */
export function solanaOwnerPacedMessage(bucketName: SolanaOwnerBucket, wait: number): string {
  const seconds = `${wait} second${wait === 1 ? "" : "s"}`;
  return bucketName === "submit"
    ? `Too many Solana owner requests. This request was not processed; a transaction you already signed and submitted is unaffected. Refresh to check it, then try again in ${seconds}.`
    : `Too many Solana owner requests. Nothing was prepared. Try again in ${seconds}.`;
}

