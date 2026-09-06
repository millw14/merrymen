import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import { CASH, UNISWAP, UNISWAP_SWAP_ROUTER_ABI } from "../../../packages/core/src/index";
import { buildConvertCall } from "./convert";

describe("buildConvertCall", () => {
  const SELF = "0x00000000000000000000000000000000000000aa" as const;

  it("is one native-input exactInputSingle against SwapRouter02 — no approve, no wrap call", () => {
    const call = buildConvertCall({
      surplusEth: 1_500_000_000_000_000n,
      fee: 500,
      minAmountOut: 4_000_000n,
      recipient: SELF,
    });
    assert.equal(call.to.toLowerCase(), UNISWAP.swapRouter02.toLowerCase());
    // The value IS the amountIn — this is what makes it a native-input swap,
    // and what the wall's non-zero valueLimit bounds.
    assert.equal(call.value, 1_500_000_000_000_000n);
    const decoded = decodeFunctionData({
      abi: UNISWAP_SWAP_ROUTER_ABI,
      data: call.data,
    });
    const params = decoded.args[0] as {
      tokenIn: string;
      tokenOut: string;
      fee: number;
      recipient: string;
      amountIn: bigint;
      amountOutMinimum: bigint;
      sqrtPriceLimitX96: bigint;
    };
    assert.equal(params.tokenIn.toLowerCase(), CASH.WETH.toLowerCase(), "tokenIn = WETH is the native-input marker");
    assert.equal(params.tokenOut.toLowerCase(), CASH.USDG.toLowerCase());
    assert.equal(params.fee, 500);
    assert.equal(params.recipient.toLowerCase(), SELF.toLowerCase(), "the wall pins the recipient — calldata must agree");
    assert.equal(params.amountIn, call.value, "struct amountIn and msg.value must be the same number");
    assert.equal(params.amountOutMinimum, 4_000_000n);
    assert.equal(params.sqrtPriceLimitX96, 0n);
  });
});
