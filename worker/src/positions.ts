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
import { STOCK_ABI, type StockToken } from "../../packages/core/src/index";

/** One valued holding. price8 = Chainlink USD price, 8 decimals. */
export interface Position {
  symbol: string;
  token: `0x${string}`;
  /** Raw ERC-20 balance, 18dp — what transfer() moves; never rebases. */
  rawBalance: bigint;
  /** ERC-8056 multiplier, 1e18 = 1.0. */
  uiMultiplier: bigint;
  /** Chainlink USD price, 8dp. Stale on weekends by design (24/5 feeds). */
  price8: bigint;
  /** true when the feed is stale — value is the best available estimate. */
  priceStale: boolean;
  /** Multiplier-aware value in USDG units (6dp). */
  valueUsdg: bigint;
}

/**
 * rawBalance(18dp) × uiMultiplier(1e18) × price8(1e8) → USDG(6dp).
 * Single division so precision is lost exactly once.
 */
export function positionValueUsdg(args: {
  rawBalance: bigint;
  uiMultiplier: bigint;
  price8: bigint;
}): bigint {
  // denominator: 1e18 (raw dp) × 1e18 (multiplier unit) × 1e8 (price dp) / 1e6 (USDG dp)
  const DENOM = 10n ** 38n;
  return (args.rawBalance * args.uiMultiplier * args.price8) / DENOM;
}

/**
 * Read balances + multipliers for `tokens` from the account's chain and value
 * them with the supplied mainnet Chainlink prices. Tokens that don't exist on
 * the account's chain (testnet demo) read as zero and are dropped.
 */
export async function readPositions(
  client: PublicClient,
  account: `0x${string}`,
  tokens: readonly StockToken[],
  prices: ReadonlyMap<string, { price8: bigint; stale: boolean }>,
): Promise<Position[]> {
  const results = await client
    .multicall({
      contracts: tokens.flatMap(
        (t) =>
          [
            { address: t.address, abi: STOCK_ABI, functionName: "balanceOf", args: [account] },
            { address: t.address, abi: STOCK_ABI, functionName: "uiMultiplier" },
          ] as const,
      ),
    })
    .catch(() => null);
  if (!results) return [];

  const positions: Position[] = [];
  tokens.forEach((t, i) => {
    const bal = results[i * 2];
    const mult = results[i * 2 + 1];
    if (bal?.status !== "success") return;
    const rawBalance = bal.result as bigint;
    if (rawBalance === 0n) return;
    // A live token with an unreadable multiplier is unvaluable — surface as 1.0
    // is WRONG post-split, so skip it entirely rather than misprice it.
    if (mult?.status !== "success") return;
    const uiMultiplier = mult.result as bigint;
    const price = prices.get(t.symbol);
    if (!price || price.price8 <= 0n) return;

    positions.push({
      symbol: t.symbol,
      token: t.address,
      rawBalance,
      uiMultiplier,
      price8: price.price8,
      priceStale: price.stale,
      valueUsdg: positionValueUsdg({ rawBalance, uiMultiplier, price8: price.price8 }),
    });
  });
  return positions;
}
