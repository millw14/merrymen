/**
 * WHAT A CURVE IS PRICED IN, and whether the live route can reach it.
 *
 * THE FACT THAT FORCED THIS MODULE. On the live tape, 384–418 launch-set curves
 * trade every hour and 15–19 of them are quoted in USDG. Native ETH carries
 * most of the trading; SPY, SGOV, NVDA, GOOGL, META and SPCX carry the next
 * tier. The class route enters one hop from USDG only, so it could see under
 * 1% of the market and the Brain was never asked about the rest. The owner's
 * ruling: research EVERY quote asset in shadow, execute none of the new ones
 * until a deterministic multi-quote route has been proven on a canary — and
 * when the best opportunity is one the route cannot execute, SAY SO.
 *
 * So this module answers two questions per quote asset, separately:
 *
 *   PRICEABLE   can its depth and a fill be stated in USD? USDG is a dollar;
 *               native ETH and WETH have the ETH/USD feed; every stock and ETF
 *               token in the registry has its own Chainlink feed; anything
 *               else is unknown and stays unknown — a depth nobody can value
 *               is not a small depth.
 *   EXECUTABLE  can the LIVE route enter it today? USDG only. The reasons the
 *               others cannot are stated per kind, in the owner's words, and
 *               they are stated here because the shadow report has to carry
 *               them next to every unexecutable pick.
 *
 * Nothing here decides a trade. `executable` is read by the shadow harness to
 * label a decision, and by nothing on the live path — widening it is the
 * multi-quote route's job, which is a design with a canary, not a flag.
 */
import type { PublicClient } from "viem";
import { CASH, CASH_FEEDS, CHAINLINK_ABI, STOCK_ABI, STOCK_TOKENS } from "../../../packages/core/src/index";

export type QuoteKind = "usdg" | "native-eth" | "weth" | "stock" | "unknown";

export interface QuoteAsset {
  /** Lowercased. The zero address for native ETH. */
  address: `0x${string}`;
  kind: QuoteKind;
  /** USDG / ETH / NVDA / … or the short address when unknown. */
  symbol: string;
  /** Chainlink USD feed, or null when the asset has none. USDG needs none. */
  feed: `0x${string}` | null;
  /** May the LIVE class route enter a curve quoted in this today? */
  executable: boolean;
  /** Null when executable; otherwise the owner-facing reason. */
  executableWhy: string | null;
}

export interface QuotePrice {
  /** USD per whole UI unit, 8dp — Chainlink's own unit. */
  usd8: bigint;
  /**
   * ERC-8056 multiplier, 1e18 = 1.0. A stock token's raw ERC-20 units never
   * rebase; a split changes this instead, and the Chainlink price is per UI
   * share. Every USD figure from raw units must go through it, or a 2-for-1
   * split reads as a 50% collapse in depth (positions.ts). 1e18 for anything
   * that is not a stock token.
   */
  uiMultiplier: bigint;
  /** Feed timestamp, or null for USDG's constant. */
  updatedAt: number | null;
  /** Older than the 2h rule the worker applies to every feed. */
  stale: boolean;
  source: "constant" | "chainlink";
}

const ZERO = "0x0000000000000000000000000000000000000000";
/** The worker's own rule: a feed older than this is stale (24/5 feeds go quiet at weekends). */
export const FEED_STALE_AFTER_SEC = 2 * 3600;

/** Classify a quote-token address. Pure; the registry is the only source. */
export function classifyQuote(address: `0x${string}`): QuoteAsset {
  const a = address.toLowerCase() as `0x${string}`;
  if (a === ZERO) {
    return {
      address: a,
      kind: "native-eth",
      symbol: "ETH",
      feed: CASH_FEEDS.ETH_USD as `0x${string}`,
      executable: false,
      executableWhy:
        "quoted in native ETH — the vault refuses a native quote by name and every wall permission carries valueLimit 0, so no signed key can fund it",
    };
  }
  if (a === (CASH.USDG as string).toLowerCase()) {
    return { address: a, kind: "usdg", symbol: "USDG", feed: null, executable: true, executableWhy: null };
  }
  if (a === (CASH.WETH as string).toLowerCase()) {
    return {
      address: a,
      kind: "weth",
      symbol: "WETH",
      feed: CASH_FEEDS.ETH_USD as `0x${string}`,
      executable: false,
      executableWhy: "quoted in WETH — the live route enters one hop from USDG only; the multi-quote route is not yet proven",
    };
  }
  const stock = STOCK_TOKENS.find((t) => t.address.toLowerCase() === a);
  if (stock) {
    return {
      address: a,
      kind: "stock",
      symbol: stock.symbol,
      feed: stock.chainlinkFeed,
      executable: false,
      executableWhy: `quoted in ${stock.symbol} — the live route enters one hop from USDG only; the multi-quote route is not yet proven`,
    };
  }
  return {
    address: a,
    kind: "unknown",
    symbol: `${a.slice(0, 6)}…${a.slice(-4)}`,
    feed: null,
    executable: false,
    executableWhy: "quoted in an asset that is not in the registry, so it cannot be priced or reached",
  };
}

/**
 * Real depth in USD at 6dp (the unit every class threshold is written in),
 * or null when the quote has no price. 6dp because `minRealDepthRaw` and
 * `classMinDepthUsdg` are 6dp USDG figures and the comparison must be in one
 * unit; `usd8 / 100` is the 8dp→6dp step.
 */
export const UI_ONE = 10n ** 18n;

export function depthUsd6(
  realQuoteRaw: bigint,
  quoteDecimals: number,
  quoteUsd8: bigint | null,
  uiMultiplier: bigint = UI_ONE,
): bigint | null {
  if (quoteUsd8 === null || quoteUsd8 <= 0n || uiMultiplier <= 0n) return null;
  if (quoteDecimals < 0 || quoteDecimals > 36) return null;
  // raw × mult/1e18 = UI units; × usd8 / 1e8 = USD; × 1e6 = 6dp. One division.
  return (realQuoteRaw * uiMultiplier * quoteUsd8) / (10n ** BigInt(quoteDecimals) * UI_ONE * 100n);
}

/**
 * The same USD notional, in the quote asset's raw units — what a 5 USDG entry
 * into an NVDA-quoted curve would have to hand the curve.
 * spendUsd6 × 10^dec × 10^8 / (usd8 × 10^6).
 */
export function spendInQuoteRaw(
  spendUsd6: bigint,
  quoteDecimals: number,
  quoteUsd8: bigint | null,
  uiMultiplier: bigint = UI_ONE,
): bigint | null {
  if (quoteUsd8 === null || quoteUsd8 <= 0n || spendUsd6 <= 0n || uiMultiplier <= 0n) return null;
  if (quoteDecimals < 0 || quoteDecimals > 36) return null;
  return (spendUsd6 * 10n ** BigInt(quoteDecimals) * 100n * UI_ONE) / (quoteUsd8 * uiMultiplier);
}

/** Raw quote units to USD at 6dp. Null when unpriced. */
export function quoteRawToUsd6(raw: bigint, quoteDecimals: number, quoteUsd8: bigint | null, uiMultiplier: bigint = UI_ONE): bigint | null {
  return depthUsd6(raw, quoteDecimals, quoteUsd8, uiMultiplier);
}

/**
 * Price every distinct quote asset in one round trip. USDG is a constant; the
 * rest go through their Chainlink feed with the worker's 2h staleness rule.
 * A feed that will not answer yields NO entry — absent is "unpriced", which
 * every consumer treats as unknown rather than as zero.
 */
export async function readQuotePrices(
  client: Pick<PublicClient, "multicall">,
  quotes: readonly QuoteAsset[],
  nowSec: number,
): Promise<Map<string, QuotePrice>> {
  const out = new Map<string, QuotePrice>();
  const feeds: { address: `0x${string}`; feed: `0x${string}`; stock: boolean }[] = [];
  for (const q of quotes) {
    if (q.kind === "usdg") {
      out.set(q.address, { usd8: 100_000_000n, uiMultiplier: UI_ONE, updatedAt: null, stale: false, source: "constant" });
      continue;
    }
    if (q.feed) feeds.push({ address: q.address, feed: q.feed, stock: q.kind === "stock" });
  }
  if (feeds.length === 0) return out;
  // One round trip: every feed's latestRoundData, then every stock quote's
  // uiMultiplier. A stock whose multiplier will not read is left UNPRICED —
  // a price without its multiplier is a wrong price, not an approximate one.
  const stocks = feeds.filter((f) => f.stock);
  let results: readonly { status: string; result?: unknown }[] | null = null;
  try {
    results = await client.multicall({
      contracts: [
        ...feeds.map((f) => ({ address: f.feed, abi: CHAINLINK_ABI, functionName: "latestRoundData" }) as const),
        ...stocks.map((f) => ({ address: f.address, abi: STOCK_ABI, functionName: "uiMultiplier" }) as const),
      ],
    });
  } catch {
    results = null;
  }
  if (!results) return out;
  const multipliers = new Map<string, bigint>();
  stocks.forEach((f, i) => {
    const r = results![feeds.length + i];
    if (r && r.status === "success" && typeof r.result === "bigint" && r.result > 0n) multipliers.set(f.address, r.result);
  });
  feeds.forEach((f, i) => {
    const r = results![i];
    if (!r || r.status !== "success" || !Array.isArray(r.result) || r.result.length < 4) return;
    const round = r.result as unknown as readonly [bigint, bigint, bigint, bigint, bigint];
    const answer = round[1];
    const updatedAt = round[3];
    if (typeof answer !== "bigint" || typeof updatedAt !== "bigint" || answer <= 0n) return;
    const uiMultiplier = f.stock ? multipliers.get(f.address) : UI_ONE;
    if (uiMultiplier === undefined) return;
    out.set(f.address, {
      usd8: answer,
      uiMultiplier,
      updatedAt: Number(updatedAt),
      stale: nowSec - Number(updatedAt) > FEED_STALE_AFTER_SEC,
      source: "chainlink",
    });
  });
  return out;
}
