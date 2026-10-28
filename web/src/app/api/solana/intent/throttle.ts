/**
 * Per-tenant pacing for POST /api/solana/intent, like the status route's. A
 * preview asks the paid Jupiter quote API (and, live, the vault program's RPC);
 * a trade also builds a route, reads the vault and the independent SOL price
 * and simulates. One signed-in client looping either must not become unbounded
 * provider load. Previews and trades have separate buckets, so previewing never
 * uses up the trades an exit needs. Normal use fits in the burst; after it, one
 * more every refill. A paced request is answered 429 before anything runs, so
 * nothing is quoted, signed, recorded or sent. In-process only, like the status
 * route's and the group chat's buckets.
 */
export const SOLANA_INTENT_PACE = {
  preview: { burst: 10, refillMs: 3_000 },
  trade: { burst: 5, refillMs: 6_000 },
} as const;
export type SolanaIntentAction = keyof typeof SOLANA_INTENT_PACE;
const MAX_TENANTS = 10_000;
const buckets: Record<SolanaIntentAction, Map<string, { tokens: number; at: number }>> = { preview: new Map(), trade: new Map() };

/** Seconds to wait, or null when this tenant may make this request now. */
export function takeSolanaIntentToken(tenant: string, action: SolanaIntentAction, now = Date.now()): number | null {
  const { burst, refillMs } = SOLANA_INTENT_PACE[action], bucket = buckets[action];
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
