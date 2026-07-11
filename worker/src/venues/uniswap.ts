/**
 * Uniswap v3 direct execution — the permissionless swap venue.
 *
 * Rialto's /quote API needs integrator onboarding; Uniswap v3 needs nobody's
 * permission. Flow per swap: QuoterV2 simulation across fee tiers (this IS the
 * pre-trade simulation — it reverts where the swap would revert and returns a
 * gas estimate we store as the receipt) → slippage-bounded minOut →
 * exactInputSingle through SwapRouter02.
 *
 * LIQUIDITY REALITY (2026-07): stock-token v3 pools are seed-sized. The quoter
 * tells us the truth about impact before any money moves — a missing pool or
 * dust liquidity shows up as no-quote/terrible-quote and the trade is skipped
 * by the impact guard upstream.
 */

import { encodeFunctionData, parseAbi, type Hex, type PublicClient } from "viem";
import { UNISWAP, UNISWAP_SWAP_ROUTER_ABI } from "../../../packages/core/src/index";

/** Fee tiers to scan, most-likely-liquid first. */
export const FEE_TIERS = [500, 3000, 10000] as const;

export const QUOTER_V2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export interface Quote {
  fee: number;
  amountOut: bigint;
  gasEstimate: bigint;
}

/** Highest amountOut wins; null when no tier has a pool with liquidity. */
export function pickBestQuote(quotes: readonly (Quote | null)[]): Quote | null {
  let best: Quote | null = null;
  for (const q of quotes) {
    if (q && q.amountOut > 0n && (!best || q.amountOut > best.amountOut)) best = q;
  }
  return best;
}

/** minOut = quoted × (10000 − slippageBps) / 10000, floor semantics. */
export function minOutWithSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`slippageBps out of range: ${slippageBps}`);
  }
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Quote one tier via eth_call simulation; null = no pool / no liquidity there. */
export async function quoteTier(
  client: PublicClient,
  args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint; fee: number },
): Promise<Quote | null> {
  try {
    const { result } = await client.simulateContract({
      address: UNISWAP.v3QuoterV2 as `0x${string}`,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          amountIn: args.amountIn,
          fee: args.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const [amountOut, , , gasEstimate] = result;
    return { fee: args.fee, amountOut, gasEstimate };
  } catch {
    return null;
  }
}

/** Scan all fee tiers concurrently and return the best executable quote. */
export async function bestQuote(
  client: PublicClient,
  args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint },
): Promise<Quote | null> {
  const quotes = await Promise.all(FEE_TIERS.map((fee) => quoteTier(client, { ...args, fee })));
  return pickBestQuote(quotes);
}

export interface SwapCall {
  to: `0x${string}`;
  value: 0n;
  data: Hex;
}

/** Build the exactInputSingle call. Caller must have approved amountIn to the router. */
export function buildSwapCall(args: {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fee: number;
  recipient: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
}): SwapCall {
  return {
    to: UNISWAP.swapRouter02 as `0x${string}`,
    value: 0n,
    data: encodeFunctionData({
      abi: UNISWAP_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          fee: args.fee,
          recipient: args.recipient,
          amountIn: args.amountIn,
          amountOutMinimum: args.minAmountOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  };
}
