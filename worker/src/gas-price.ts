/**
 * What a trade's gas actually cost, in the currency the book is kept in.
 *
 * Gas leaves the account in ETH; the book is denominated in USDG; and before
 * this the worker had no ETH price at all. So every P&L figure merrymen had
 * produced was GROSS OF GAS — which at the 6.25 USDG trade size in the July
 * ledger was ~55 bps of an ~89 bps round trip, i.e. most of the cost.
 *
 * (There IS a Chainlink ETH/USD feed on this chain, CASH_FEEDS.ETH_USD. The
 * worker reads it as the fallback when the pool below is refused, and to price
 * gas settled after the fact at the round then in force — eth-feed.ts.)
 *
 * The price comes first from the WETH/USDG pool's TWAP, through the same guarded
 * reader that values feedless holdings (venues/pool-price.ts): time-averaged so
 * moving it means holding the price away from the market for the whole window,
 * with a liquidity floor and a spot-vs-TWAP divergence band. A refusal is a
 * feature — an unpriceable gas cost is recorded as unpriced, never as zero.
 *
 * WHY GAS IS SUBTRACTED FROM P&L RATHER THAN ETH ADDED TO EQUITY. Folding a
 * volatile asset into `equity_usdg` would feed it to the high-water mark and
 * the drawdown breaker: an ETH rally would ratchet the HWM and accrue a
 * performance fee on the gas float, and an hour where the WETH pool is refused
 * would drop equity by the whole ETH balance and read as a real drawdown. The
 * book is the USDG book; ETH is the fuel, and its consumption is charged
 * against the book at the price on the day it was burned.
 */

import type { StockToken } from "../../packages/core/src/index";

/** 1e18 (wei per ETH) × 1e8 (price8) ÷ 1e6 (USDG units) = 1e20. */
const WEI_PRICE8_TO_USDG = 10n ** 20n;

/**
 * Convert gas paid in wei to USDG (6dp) at a given ETH price (8dp).
 *
 * Truncates rather than rounds, so a cost is never overstated by the
 * conversion. At realistic gas figures the difference is under a millionth of a
 * USDG; the direction is the point.
 */
export function gasCostUsdg(gasWei: bigint, ethPrice8: bigint): bigint {
  if (gasWei <= 0n || ethPrice8 <= 0n) return 0n;
  return (gasWei * ethPrice8) / WEI_PRICE8_TO_USDG;
}

/**
 * WETH as the price reader expects a token. Declared `memecoin` because that is
 * this codebase's word for "priced from a pool, not a feed" — it carries no
 * ERC-8056 multiplier and must go through the liquidity and divergence guards
 * like anything else without a feed.
 */
export function wethPriceToken(address: `0x${string}`): StockToken {
  return {
    symbol: "WETH",
    name: "Wrapped Ether",
    address,
    chainlinkFeed: null,
    kind: "memecoin",
    decimals: 18,
    // Quoting WETH against WETH is meaningless — it must find the direct
    // USDG pair.
    quote: "usdg",
  };
}

/** What is known about one trade's gas cost. */
export interface GasCost {
  gasWei: bigint;
  /** null when the ETH price could not be established at the time of the trade. */
  usdg: bigint | null;
  /** Why, when usdg is null — surfaced rather than swallowed. */
  reason?: string;
}

/**
 * Price one gas figure. Pure: the caller supplies the price it managed to read,
 * so this is testable without a chain and the refusal path is explicit.
 */
export function priceGas(gasWei: bigint, ethPrice8: bigint | null, refusal?: string): GasCost {
  if (ethPrice8 === null || ethPrice8 <= 0n) {
    return {
      gasWei,
      usdg: null,
      reason: refusal ?? "no ETH price available — this trade's gas is unpriced, not free",
    };
  }
  return { gasWei, usdg: gasCostUsdg(gasWei, ethPrice8) };
}
