/**
 * GIVING A VAULT COIN NOBODY CAN PRICE BACK THE COST THE VAULT RECORDED.
 *
 * The quarantine carries a holding nobody can price at what it COST
 * (quarantine.ts). A holding with no cost on record is carried at zero, and
 * one of those makes the whole book unknown: no equity row, no peak, no fee,
 * and the drawdown breaker skipped (index.ts `unknownCost`). The Trencher
 * vault keeps every coin's cost on chain (`TrencherVault.cost(token)`: the
 * USDG paid for what is still held, pro-rated on each sale), and the tick
 * restored a missing basis from it — for PRICED coins only. A vault coin
 * unpriced by design, which is every coin no venue can price, got nothing, so
 * the one figure that would have kept its book whole was never asked for.
 *
 * This is the same restore for those coins, under the rules #384 set for it:
 *
 *   - NEVER FROM A PARTIAL BALANCE. A coin whose ACCOUNT balance row failed is
 *     held at an unknown size; unread-held.ts strips it whole. And a coin the
 *     account holds too is skipped, as the priced restore skips it: the
 *     vault's cost covers only the vault's half.
 *   - A FAILED READ SEEDS NOTHING, never a zero: a basis lookup that throws
 *     (store.ts readBasis, not getBasis, which answers zero for a failed
 *     query) and a `cost()` read that fails both leave the coin for the next
 *     tick to ask again.
 *   - ONLY UPWARD FROM NOTHING. A basis already on record always wins.
 *
 * AND ONE RULE OF ITS OWN: ONLY A COIN THAT CAN BE SOLD IS CARRIED AT COST.
 * Carrying at cost hides what a holding is really worth — that is the
 * quarantine's stated limit, bounded by the scout budget. For a coin whose
 * sale into its pool reverts (sell-lock.ts), cost is not a stand-in for its
 * worth, it is the loss: GATO cost Shogun 2.5 USDG and is worth about 0.0074.
 * Restoring it at cost would carry that loss as a 2.5 USDG holding, take it out
 * of the drawdown the breaker reads, and lift a block that is honest. So a
 * vault coin is restored only when a simulated sale of the vault's own
 * holding, on the chain's own state, goes through; locked or unknown, it stays
 * "no cost on record" and the book stays incomplete, which refuses entries
 * and keeps every exit. Writing such a coin off is the owner's call, not this.
 */

import type { SellCheck } from "./sell-lock";

type Addr = `0x${string}`;

/** What happened to one unpriced vault coin this tick. */
export type RestoreResult =
  | "restored"
  | "has-basis"
  | "account-unread"
  | "account-holds"
  | "not-watched"
  | "no-balance"
  | "basis-unread"
  | "not-sellable"
  | "cost-unread"
  | "cost-zero";

export interface RestoreOutcome {
  symbol: string;
  result: RestoreResult;
  /** The sell check's own words, for a coin left unrestored because of it. */
  detail?: string;
  /** What was written, for a restored coin. */
  costUsdg?: bigint;
}

export interface UnpricedVaultRestore {
  /** custodyRead.unpricedByDesign: what the vault holds that has no feed at all. */
  unpriced: readonly string[];
  /** Symbols whose ACCOUNT balance row failed this tick. */
  accountUnread: ReadonlySet<string>;
  /** Symbols the account itself holds (priced, unpriced or missing a price), read before the vault merge. */
  accountHeld: ReadonlySet<string>;
  tokenOf: (symbol: string) => Addr | undefined;
  /** The vault's raw balance, from the very read that found it unpriced (custodyRead.balances). */
  vaultRawOf: (token: Addr) => bigint | undefined;
  /** store.ts readBasis: a missing row is zero, a failed query THROWS. */
  readBasis: (symbol: string) => Promise<{ qtyRaw: bigint; costUsdg: bigint }>;
  /** Can the vault's own holding be sold? sell-lock.ts, on the chain's own state. */
  sellCheck: (token: Addr, raw: bigint) => Promise<SellCheck>;
  /** TrencherVault.cost(token), USDG 6dp; null when the read failed. */
  vaultCost: (token: Addr) => Promise<bigint | null>;
  setBasis: (symbol: string, b: { qtyRaw: bigint; costUsdg: bigint }) => Promise<void>;
}

/** Restore what can be restored, in order, and say what happened to each coin. */
export async function restoreUnpricedVaultCosts(d: UnpricedVaultRestore): Promise<RestoreOutcome[]> {
  const out: RestoreOutcome[] = [];
  for (const symbol of d.unpriced) {
    if (d.accountUnread.has(symbol)) {
      out.push({ symbol, result: "account-unread" });
      continue;
    }
    if (d.accountHeld.has(symbol)) {
      out.push({ symbol, result: "account-holds" });
      continue;
    }
    const token = d.tokenOf(symbol);
    if (!token) {
      out.push({ symbol, result: "not-watched" });
      continue;
    }
    const raw = d.vaultRawOf(token) ?? 0n;
    if (raw <= 0n) {
      out.push({ symbol, result: "no-balance" });
      continue;
    }
    let saved: { qtyRaw: bigint; costUsdg: bigint };
    try {
      saved = await d.readBasis(symbol);
    } catch {
      out.push({ symbol, result: "basis-unread" });
      continue;
    }
    if (saved.qtyRaw !== 0n || saved.costUsdg !== 0n) {
      out.push({ symbol, result: "has-basis" });
      continue;
    }
    // BEFORE the cost read: a coin left unrestored here is asked about every
    // tick, and the sell check is cached (hours, for a lock), the read is not.
    const sell = await d.sellCheck(token, raw);
    if (sell.verdict !== "sellable") {
      out.push({ symbol, result: "not-sellable", detail: sell.detail });
      continue;
    }
    const cost = await d.vaultCost(token);
    if (cost === null) {
      out.push({ symbol, result: "cost-unread" });
      continue;
    }
    if (cost <= 0n) {
      out.push({ symbol, result: "cost-zero" });
      continue;
    }
    await d.setBasis(symbol, { qtyRaw: raw, costUsdg: cost });
    out.push({ symbol, result: "restored", costUsdg: cost });
  }
  return out;
}

/**
 * A `cost()` that answered ZERO is not asked again for `ttlMs`. A coin sent to
 * the vault rather than bought by it has no cost there and never will, and
 * without this it would cost one read a tick for as long as it sat there. A
 * failed read is not remembered: the next tick asks again. One per worker,
 * keyed by the caller (index.ts uses vault|token), so it outlives the tick.
 */
export function zeroCostMemo(
  ttlMs: number,
  now: () => number = Date.now,
): (key: string, read: () => Promise<bigint | null>) => Promise<bigint | null> {
  const zeroUntil = new Map<string, number>();
  return async (key, read) => {
    const k = key.toLowerCase();
    const until = zeroUntil.get(k);
    if (until !== undefined && until > now()) return 0n;
    const cost = await read();
    if (cost === 0n) zeroUntil.set(k, now() + ttlMs);
    else zeroUntil.delete(k);
    return cost;
  };
}
