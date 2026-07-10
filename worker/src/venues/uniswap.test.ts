import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData } from "viem";
import { UNISWAP, UNISWAP_SWAP_ROUTER_ABI } from "@merrymen/core";
import { buildSwapCall, minOutWithSlippage, pickBestQuote, type Quote } from "./uniswap";

const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const ACCOUNT = "0x7777777777777777777777777777777777777777" as const;

describe("minOutWithSlippage", () => {
  it("applies bps slippage with floor semantics", () => {
    assert.equal(minOutWithSlippage(10_000n, 100), 9_900n); // 1%
    assert.equal(minOutWithSlippage(1_000_000n, 50), 995_000n); // 0.5%
    assert.equal(minOutWithSlippage(999n, 100), 989n); // floors, never rounds up
  });

  it("zero slippage passes the quote through", () => {
    assert.equal(minOutWithSlippage(12_345n, 0), 12_345n);
  });

  it("rejects out-of-range slippage", () => {
    assert.throws(() => minOutWithSlippage(1n, -1));
    assert.throws(() => minOutWithSlippage(1n, 10_000));
  });
});

describe("pickBestQuote", () => {
  const q = (fee: number, amountOut: bigint): Quote => ({ fee, amountOut, gasEstimate: 100_000n });

  it("picks the highest output across tiers", () => {
    const best = pickBestQuote([q(500, 90n), q(3000, 120n), q(10000, 100n)]);
    assert.equal(best?.fee, 3000);
    assert.equal(best?.amountOut, 120n);
  });

  it("ignores missing tiers (no pool)", () => {
    const best = pickBestQuote([null, q(3000, 50n), null]);
    assert.equal(best?.fee, 3000);
  });

  it("ignores zero-output quotes (empty pool)", () => {
    assert.equal(pickBestQuote([null, q(3000, 0n)]), null);
  });

  it("returns null when nothing is executable", () => {
    assert.equal(pickBestQuote([null, null, null]), null);
  });
});

describe("buildSwapCall", () => {
  it("targets SwapRouter02 with a well-formed exactInputSingle", () => {
    const call = buildSwapCall({
      tokenIn: USDG,
      tokenOut: AAPL,
      fee: 3000,
      recipient: ACCOUNT,
      amountIn: 25_000_000n,
      minAmountOut: 9_900n,
    });
    assert.equal(call.to, UNISWAP.swapRouter02);
    assert.equal(call.value, 0n);

    const decoded = decodeFunctionData({ abi: UNISWAP_SWAP_ROUTER_ABI, data: call.data });
    assert.equal(decoded.functionName, "exactInputSingle");
    const p = decoded.args[0];
    assert.equal(p.tokenIn, USDG);
    assert.equal(p.tokenOut, AAPL);
    assert.equal(p.fee, 3000);
    assert.equal(p.recipient, ACCOUNT);
    assert.equal(p.amountIn, 25_000_000n);
    assert.equal(p.amountOutMinimum, 9_900n);
    assert.equal(p.sqrtPriceLimitX96, 0n);
  });
});
