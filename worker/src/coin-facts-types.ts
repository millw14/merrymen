/**
 * A COIN'S MEASURED MARKET FACTS, AS PLAIN DATA (docs/tg-groups.md "A coin's
 * facts, on request"; Milla, 2026-10-09: "when asked for actual facts she
 * should be able to look").
 *
 * desk/facts.ts reads them from GeckoTerminal's public index (a token's
 * pools, its main pool's hourly closes, the token's info); tg-fomo-port.ts
 * says them in a room. Neither imports the other: both import this file,
 * which imports nothing.
 *
 * Every field is a measurement with its source's time, or null when it could
 * not be read. Nothing here is a guess, a reason or a person: no address of
 * any kind (mint, pool or creator) is kept, only the creator's holding share
 * as the index lists it.
 */

export type FactsNetwork = "robinhood" | "solana" | "base" | "ethereum" | "bsc";

export interface CoinFacts {
  network: FactsNetwork;
  /** When the index was read (ms). */
  observedAt: number;
  /** The coin's price on its main pool now, in USD. */
  priceUsd: number;
  /** Fully diluted value now, from the main pool (only when the coin is the pool's base token). */
  fdvNowUsd: number | null;
  /** The highest HOURLY CLOSE on the main pool (never a wick high), with its FDV when the supply is known, and when that close settled (the bar's end, or the read time for the bar still forming). */
  high: { closeUsd: number; fdvUsd: number | null; atMs: number } | null;
  /** How far back the hourly closes reach, and when the main pool was created: a high before the bars is not seen. */
  barsFromMs: number | null;
  poolCreatedAtMs: number | null;
  /** From that highest close to now, percent below (0 when it is at a new high). */
  drawdownPct: number | null;
  /** The biggest fall between closes one to three hours apart, kept only when it is 50% or more: from when, how many hours. */
  steepest: { pct: number; fromMs: number; hours: number } | null;
  /** The main pool's liquidity, and the coin's 24h change there (base token only). */
  liquidityUsd: number | null;
  change24hPct: number | null;
  /** Distinct buyers and sellers on the main pool in 24h (base token only). */
  buyers24h: number | null;
  sellers24h: number | null;
  /** Holders as the index counts them, the top ten's share, and when it counted. */
  holders: { count: number; top10Pct: number | null; updatedAtMs: number | null } | null;
  /** The creator's holding share as the index lists it now (never the creator's address). */
  creatorHoldingPct: number | null;
  /**
   * Whether the token's info (holders, the creator's share) was read: "read",
   * "failed" (an error, a timeout, too little time left, a body that did not
   * parse or was another token's), or "not-asked". A null holding after a
   * failed read is unread, never "none".
   */
  info: "read" | "failed" | "not-asked";
  /** How many pools the index listed for the coin. */
  poolsSeen: number;
}

export type CoinFactsRead = { ok: true; facts: CoinFacts } | { ok: false; why: "busy" | "not-found" | "unavailable" | "unsupported" };

/** Reads one coin's facts. Never throws. `withInfo`: also the token's info (holders, the creator's share). */
export type CoinFactsReader = (q: { network: FactsNetwork; address: string; chatId: number; timeoutMs: number; withInfo: boolean }) => Promise<CoinFactsRead>;

/** The least a coin's high must have been worth (FDV) to call its fall a collapse: dust that went to less dust is not one. */
export const COLLAPSE_HIGH_FDV_USD = 100_000;
/** How far below its highest close, or how far down in 24h, a coin must be to count as collapsed. */
export const COLLAPSE_DRAWDOWN_PCT = 90;

/**
 * DID IT COLLAPSE, AS MEASURED (the collapse permit's measured source,
 * docs/tg-groups.md "Rugged coins"): a credible main pool (the reader returns
 * facts only with one), a high worth saying (its FDV at least
 * COLLAPSE_HIGH_FDV_USD; a high whose worth is unknown, because the supply
 * is not listed or the coin is only its main pool's quote token, is no
 * collapse: review r2), and either at least COLLAPSE_DRAWDOWN_PCT below
 * that close or down that much in 24h. Milla said "80 to 90%": 90 is the safe end.
 */
export function collapseOf(f: CoinFacts | null | undefined): boolean {
  if (!f || !f.high || !(f.high.closeUsd > 0)) return false;
  const worth = f.high.fdvUsd !== null && f.high.fdvUsd >= COLLAPSE_HIGH_FDV_USD;
  if (!worth) return false;
  const fell = (f.drawdownPct !== null && f.drawdownPct >= COLLAPSE_DRAWDOWN_PCT) || (f.change24hPct !== null && f.change24hPct <= -COLLAPSE_DRAWDOWN_PCT);
  return fell;
}
