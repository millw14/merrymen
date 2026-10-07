/**
 * ERC-8056 (Scaled UI Amount) position accounting.
 *
 * Stock Token raw balances NEVER rebase — corporate actions (splits, stock
 * dividends) adjust uiMultiplier() instead. Every position valuation must go
 * through the multiplier: on a 2-for-1 split the multiplier doubles and the
 * reference price halves, so value is unchanged. Skipping the multiplier makes
 * a split look like a 50% crash and trips the drawdown breaker on nothing.
 *
 * UI shares  = rawBalance × uiMultiplier / 1e18
 * USD value  = UI shares × chainlinkPrice / 1e8
 * USDG (6dp) = USD value × 1e6
 */

import type { PublicClient } from "viem";
import { STOCK_ABI, type PriceQuote, type StockToken } from "../../packages/core/src/index";

/** One valued holding. price8 = USD price, 8 decimals. */
export interface Position {
  symbol: string;
  token: `0x${string}`;
  /** Raw ERC-20 balance in the token's own decimals — what transfer() moves. */
  rawBalance: bigint;
  /** ERC-8056 multiplier, 1e18 = 1.0. Always 1e18 for non-ERC-8056 tokens. */
  uiMultiplier: bigint;
  /** ERC-20 decimals — 18 for stock tokens, whatever the owner declared otherwise. */
  decimals: number;
  /** USD price, 8dp. Stale on weekends by design (24/5 feeds). */
  price8: bigint;
  /** true when the feed is stale — value is the best available estimate. */
  priceStale: boolean;
  /**
   * Where price8 came from. A pool-priced holding is a weaker claim than a
   * Chainlink-priced one, and every surface that shows a value should be able to
   * say so rather than presenting both as the same kind of fact.
   */
  priceSource: PriceQuote["source"];
  /** Multiplier-aware value in USDG units (6dp). */
  valueUsdg: bigint;
}

/**
 * rawBalance(10^decimals) × uiMultiplier(1e18) × price8(1e8) → USDG(6dp).
 * Single division so precision is lost exactly once.
 *
 * `decimals` defaults to 18 — every Stock Token and WETH — but a memecoin can be
 * 6 or 9, and assuming 18 there would undervalue the position by a factor of a
 * billion. Equity feeds the drawdown breaker, so that is not a display bug.
 */
export function positionValueUsdg(args: {
  rawBalance: bigint;
  uiMultiplier: bigint;
  price8: bigint;
  decimals?: number;
}): bigint {
  const decimals = args.decimals ?? 18;
  // denominator: 10^decimals (raw) × 1e18 (multiplier unit) × 1e8 (price dp) / 1e6 (USDG dp)
  const DENOM = 10n ** BigInt(decimals + 20);
  return (args.rawBalance * args.uiMultiplier * args.price8) / DENOM;
}

export interface PositionsRead {
  positions: Position[];
  /**
   * Held (balance > 0) but unvaluable THIS READ, even though a price feed is
   * configured — the multiplier reverted, or the feed read failed. Valuing these
   * at zero would crater equity and can trip the drawdown breaker on a transient
   * RPC hiccup, so the caller treats the snapshot as incomplete and retries.
   * TRANSIENT by definition: the next tick usually fixes it.
   */
  missingPrice: string[];
  /**
   * Held, but the asset has NO price feed configured at all (chainlinkFeed:
   * null) — every memecoin, and any token whose feed was withdrawn.
   *
   * This is the crucial difference: a missing feed NEVER recovers, so treating it
   * like a transient gap and waiting made the tick halt forever — no equity, no
   * breaker, no strategy run, and therefore NO WAY TO SELL OUT of the position.
   * The caller must not value these, but must also not freeze because of them.
   */
  unpricedByDesign: string[];
  /**
   * The whole balance read failed, so we cannot tell held from unheld and the
   * empty `positions` above means NOTHING KNOWN, not "nothing owned".
   *
   * This used to be silent. The read returned three empty arrays, the caller's
   * `missingPrice.length` guard therefore never fired, and the tick sailed on to
   * write an equity row with positionsUsdg = 0 — a held book cratering to zero
   * on one RPC hiccup, which is exactly the phantom 30% drawdown sitting in the
   * July ledger. An unknown must never be representable as a zero.
   */
  readFailed: boolean;
}

/**
 * Read balances + multipliers for `tokens` from the account's chain and value
 * them with the supplied mainnet Chainlink prices. Tokens that don't exist on
 * the account's chain (testnet demo) read as zero and are dropped. A token that
 * IS held but can't be valued (feed/multiplier read failed) is reported in
 * `missingPrice` — never silently valued at zero.
 */
/** 1.0 in ERC-8056's fixed-point convention. */
export const UI_MULTIPLIER_ONE = 10n ** 18n;

/**
 * Which multiplier a price source's unit implies.
 *
 * A Chainlink feed quotes USD per ERC-8056 UI SHARE, so the multiplier converts
 * raw → shares before pricing. A pool quotes USD per WHOLE ERC-20 TOKEN, and a
 * broker quotes USD per SHARE AS THE BROKER COUNTS IT — in both cases the
 * market's own unit, which already reflects any split. Applying the multiplier
 * to those counts the split twice: after a 2-for-1 the position reads double,
 * the high-water mark ratchets to a peak that never happened, a performance fee
 * accrues on it, and the drawdown breaker trips when the phantom unwinds.
 *
 * An exhaustive switch on purpose. This used to be `source === "pool" ? 1e18 :
 * uiMultiplier`, where every FUTURE source silently fell into the Chainlink arm
 * — which is exactly the wrong default for every source added since, "broker"
 * included. Now a new member of the union fails to compile until someone
 * decides its unit here, on this comment, deliberately.
 */
export function valuationMultiplierFor(source: PriceQuote["source"], uiMultiplier: bigint): bigint {
  switch (source) {
    case "chainlink":
      return uiMultiplier;
    case "pool":
    case "broker":
    // A Pons bonding curve quotes USD per whole ERC-20, exactly as a pool does.
    // Curve tokens are plain ERC-20s with no ERC-8056 multiplier to apply — and
    // if one ever grew a split, the curve's reserves would already reflect it,
    // so applying a multiplier here would count it twice.
    //
    // Note this is the ONLY question this switch asks. It decides a UNIT, not
    // whether the price can be trusted: a curve quote is a weaker kind of
    // evidence than a pool quote, and that difference is enforced elsewhere —
    // it stays inside the scout ceiling and out of the high-water mark.
    case "curve":
    // A Uniswap v4 pool quotes USD per whole ERC-20, exactly as v3 does — the
    // VENUE changed, the unit did not. Graduated memecoins are plain ERC-20s
    // with no ERC-8056 multiplier to apply. (That a v4 quote is weaker evidence
    // than a v3 one — no oracle behind it — is enforced elsewhere, by keeping it
    // inside the scout ceiling; it is not a question about units.)
    case "v4":
    // A sampled price is a v3 pool's own spot, averaged: USD per whole ERC-20.
    case "sampled":
      return UI_MULTIPLIER_ONE;
    default: {
      const never: never = source;
      throw new Error(`unhandled price source: ${String(never)}`);
    }
  }
}

/**
 * Just the multipliers, for callers with no on-chain balance to read.
 *
 * Paper mode needs these and can't get them from readPositions: it never queries
 * balances, because the book IS the ledger. But uiMultiplier is a property of the
 * TOKEN, not of any holding — it's just as real for a simulated position as a
 * funded one. Without it a stock split halves the paper book overnight and trips
 * the drawdown breaker on a corporate action that cost nobody anything.
 *
 * Fails closed exactly like readPositions: a token whose multiplier can't be read
 * lands in `unreadable` rather than defaulting to 1.0, because silently assuming
 * 1.0 after a split is the mis-pricing this whole file exists to prevent.
 */
export async function readMultipliers(
  client: PublicClient,
  tokens: readonly StockToken[],
): Promise<{ multipliers: Map<string, bigint>; unreadable: string[] }> {
  const multipliers = new Map<string, bigint>();
  const unreadable: string[] = [];

  // Same rule as readPositions: ERC-8056 is a Stock Token thing. Asking a
  // memecoin would revert, and honouring whatever a random contract returned
  // would let it scale the owner's equity.
  const scaled = tokens.filter((t) => t.kind !== "memecoin");
  for (const t of tokens) if (t.kind === "memecoin") multipliers.set(t.symbol, UI_MULTIPLIER_ONE);
  if (scaled.length === 0) return { multipliers, unreadable };

  type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: unknown };
  const results = (await client
    .multicall({
      contracts: scaled.map((t) => ({ address: t.address, abi: STOCK_ABI, functionName: "uiMultiplier" })) as never,
    })
    .catch(() => null)) as CallResult[] | null;
  if (!results) return { multipliers, unreadable: scaled.map((t) => t.symbol) };

  scaled.forEach((t, i) => {
    const r = results[i];
    if (r?.status === "success" && typeof r.result === "bigint" && r.result > 0n) multipliers.set(t.symbol, r.result);
    else unreadable.push(t.symbol);
  });
  return { multipliers, unreadable };
}

export async function readPositions(
  client: PublicClient,
  account: `0x${string}`,
  tokens: readonly StockToken[],
  prices: ReadonlyMap<string, PriceQuote>,
): Promise<PositionsRead> {
  // ERC-8056 is a Stock Token thing. An owner-added memecoin has no
  // uiMultiplier() at all, so asking would revert and get read as "held but
  // unvaluable" — the transient gap that halts the tick forever. Worse, if some
  // token DID expose the selector, honouring whatever it returned would let an
  // arbitrary contract scale the owner's equity (and the drawdown breaker with
  // it). So we don't ask, and we don't look: non-ERC-8056 tokens are 1.0, flat.
  const isScaled = (t: StockToken) => t.kind !== "memecoin";

  // Index bookkeeping, because the contracts-per-token count now varies.
  const slots: { token: StockToken; balAt: number; multAt: number | null }[] = [];
  const contracts: {
    address: `0x${string}`;
    abi: typeof STOCK_ABI;
    functionName: string;
    args?: readonly unknown[];
  }[] = [];
  for (const t of tokens) {
    const balAt = contracts.length;
    contracts.push({ address: t.address, abi: STOCK_ABI, functionName: "balanceOf", args: [account] });
    let multAt: number | null = null;
    if (isScaled(t)) {
      multAt = contracts.length;
      contracts.push({ address: t.address, abi: STOCK_ABI, functionName: "uiMultiplier" });
    }
    slots.push({ token: t, balAt, multAt });
  }

  // viem infers per-call result types from a literal tuple; this array is built
  // at runtime (memecoins contribute one call, Stock Tokens two), so the shape is
  // asserted here instead. Each entry is still checked for success below.
  type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: unknown };
  const results = (await client
    .multicall({ contracts: contracts as never })
    .catch(() => null)) as CallResult[] | null;
  // Whole read failed — we can't tell held from unheld. Report nothing valued and
  // no coverage; the tick can't trust this, but "" avoids a per-symbol miss list.
  if (!results) return { positions: [], missingPrice: [], unpricedByDesign: [], readFailed: true };

  const positions: Position[] = [];
  const missingPrice: string[] = [];
  const unpricedByDesign: string[] = [];
  for (const { token: t, balAt, multAt } of slots) {
    const bal = results[balAt];
    if (bal?.status !== "success") continue; // balance unreadable → can't say it's held
    const rawBalance = bal.result as bigint;
    if (rawBalance === 0n) continue; // genuinely not held — not a coverage gap

    // Held, but unvaluable: an unreadable multiplier mis-prices post-split. Fail
    // closed — flag, don't drop. (Only ERC-8056 tokens have one to read.)
    let uiMultiplier = 10n ** 18n;
    if (multAt !== null) {
      const mult = results[multAt];
      if (mult?.status !== "success") {
        missingPrice.push(t.symbol);
        continue;
      }
      uiMultiplier = mult.result as bigint;
    }

    const price = prices.get(t.symbol);
    if (!price || price.price8 <= 0n) {
      // No feed CONFIGURED is a permanent condition, not a hiccup — waiting for
      // it to clear would trap the position forever. Kept separate so the caller
      // can keep trading (and therefore selling) instead of freezing.
      if (t.chainlinkFeed === null) unpricedByDesign.push(t.symbol);
      else missingPrice.push(t.symbol);
      continue;
    }

    const decimals = t.decimals ?? 18;
    const valuationMultiplier = valuationMultiplierFor(price.source, uiMultiplier);
    positions.push({
      symbol: t.symbol,
      token: t.address,
      rawBalance,
      uiMultiplier,
      decimals,
      price8: price.price8,
      priceStale: price.stale,
      priceSource: price.source,
      valueUsdg: positionValueUsdg({
        rawBalance,
        uiMultiplier: valuationMultiplier,
        price8: price.price8,
        decimals,
      }),
    });
  }
  return { positions, missingPrice, unpricedByDesign, readFailed: false };
}

/**
 * Positions valued off a bonding curve. None of them may ratchet a peak.
 *
 * A NAMED RULE RATHER THAN AN INLINE FILTER, because it has to hold in three
 * places at once and got half-applied the first time: the live fee accrual, the
 * live in-memory peak the drawdown breaker divides by, and the persisted paper
 * peak. Guarding only the first two left the breaker measuring against a mark
 * no oracle stands behind — so a curve spike, then a revert, halted every
 * non-exit intent on a drawdown that never happened, for the whole process.
 *
 * Why it exists at all: both high-water marks are monotonic and persisted
 * (`MAX(hwm_usdg, ?)` for the live one, with a performance fee written in the
 * same breath), and nothing walks either back. A curve mark has no oracle
 * behind it, moves 1,546 bps at p99 over four minutes, and arrives
 * DISCONTINUOUSLY — the tick a curve first clears its guard, the holding jumps
 * from carried-at-cost to carried-at-mark with no trade having happened.
 *
 * Skipping is conservative in both directions: a fee not charged, and a
 * drawdown measured from the last peak that a feed or a pool stood behind.
 *
 * A SAMPLED MARK IS HELD TO THE SAME RULE. It is a coin new enough that its
 * pool keeps no oracle, averaged over minutes by us rather than by the pool —
 * the same volatility, and after a restart the same discontinuity, since an
 * empty series values the holding off one spot reading until it refills
 * (venues/spot-sampler.ts). No peak or fee is set off it.
 */
export function curveMarkedSymbols(positions: readonly Position[]): string[] {
  return positions.filter((p) => p.priceSource === "curve" || p.priceSource === "sampled").map((p) => p.symbol);
}

/** May this book's equity set a new high-water mark? */
export function mayRatchetHwm(positions: readonly Position[]): boolean {
  return curveMarkedSymbols(positions).length === 0;
}
