/**
 * The auto-convert leg: NATIVE ETH → USDG in one call.
 *
 * SwapRouter02 identifies a native-input swap by `tokenIn` being the WETH
 * address while `msg.value` carries the actual ETH — it wraps internally and
 * refunds excess value, so no separate WETH.deposit() call and no approve are
 * needed (native ETH has no allowance to grant). That single-call shape is what
 * makes it expressible to the wall at all: the exactInputSingle permission pins
 * tokenIn ONE_OF (…asset set, WETH), tokenOut ONE_OF (asset set), recipient to
 * the account, and carries the wall's only non-zero `valueLimit`.
 *
 * Pricing: a WETH→USDG quote IS the ETH→USDG price — the pool is the same one
 * the router will fill — so callers quote with bestRoute() and thread the fee
 * and minOut straight through, exactly like a token trade.
 */

import { encodeFunctionData } from "viem";
import type { Call } from "../executor";
import { CASH, UNISWAP, UNISWAP_SWAP_ROUTER_ABI } from "../../../packages/core/src/index";

export interface ConvertCallArgs {
  /** Native ETH to convert, in wei. Sent as msg.value — this is the amountIn. */
  surplusEth: bigint;
  /** The quoted pool's fee tier (from the WETH→USDG quote). */
  fee: number;
  /** Slippage-bounded minimum USDG out (6dp), from minOutWithSlippage. */
  minAmountOut: bigint;
  /** The agent's own smart account — the wall pins the recipient here. */
  recipient: `0x${string}`;
}

/**
 * The convert call. Value is the amountIn; the router's struct still names
 * tokenIn = WETH, which is how the wall's ONE_OF pin (and the router's native
 * path) recognize a native-input swap.
 */
export function buildConvertCall(args: ConvertCallArgs): Call {
  return {
    to: UNISWAP.swapRouter02 as `0x${string}`,
    value: args.surplusEth,
    data: encodeFunctionData({
      abi: UNISWAP_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: CASH.WETH as `0x${string}`,
          tokenOut: CASH.USDG as `0x${string}`,
          fee: args.fee,
          recipient: args.recipient,
          amountIn: args.surplusEth,
          amountOutMinimum: args.minAmountOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  };
}