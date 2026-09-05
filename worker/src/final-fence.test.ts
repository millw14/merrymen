import assert from "node:assert/strict";
import { encodeFunctionData, erc20Abi } from "viem";
import test from "node:test";
import { UNISWAP, UNISWAP_SWAP_ROUTER_ABI } from "../../packages/core/src/index";
import { checkV3SwapCalls, type FenceCall } from "./final-fence";
import { buildTradeCalls, encodePath } from "./venues/uniswap";

/**
 * FED FROM THE REAL BUILDER, deliberately.
 *
 * A fence tested against hand-written calldata proves the fence agrees with the
 * test author. Feeding it `buildTradeCalls`'s own output means the pass case is
 * the actual production shape, so an encoder change fails a test here rather
 * than quietly turning this into a wall (every trade refused) or an escape hatch
 * (every trade waved through). recovery-shape.test.ts makes the same argument
 * about Kernel's encoders and it is the reason that gate is trustworthy.
 *
 * The refusals are then MUTATIONS of that real output — one field moved at a
 * time — which is the only way to know the check is load-bearing rather than
 * incidentally true.
 */

const ROUTER = UNISWAP.swapRouter02 as `0x${string}`;
const USDG = "0x5fc5360d5d1cc6e3b0b0a4b3a0f5c5b5a5d5e5f1" as `0x${string}`;
const QQQ = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const WETH = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const ME = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const THIEF = "0x4444444444444444444444444444444444444444" as `0x${string}`;

const AMOUNT_IN = 50_000_000n;
const MIN_OUT = 970_000_000_000_000_000n;

const expect = {
  router: ROUTER,
  tokenIn: USDG,
  tokenOut: QQQ,
  recipient: ME,
  amountIn: AMOUNT_IN,
  minOut: MIN_OUT,
};

const build = (over: { path?: { tokens: readonly `0x${string}`[]; fees: readonly number[] } } = {}) =>
  buildTradeCalls({
    quote: { fee: 500, amountOut: 1_000_000_000_000_000_000n, gasEstimate: 0n, ...over },
    tokenIn: USDG,
    tokenOut: QQQ,
    recipient: ME,
    amountIn: AMOUNT_IN,
    minAmountOut: MIN_OUT,
    deadline: 1_800_000_300,
  }) as unknown as FenceCall[];

/** Replace the swap leg, keeping the approve as built. */
const withSwap = (data: `0x${string}`): FenceCall[] => [build()[0]!, { to: ROUTER, value: 0n, data }];

const single = (over: Partial<Record<string, unknown>> = {}): `0x${string}` =>
  encodeFunctionData({
    abi: UNISWAP_SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: USDG,
        tokenOut: QQQ,
        fee: 500,
        recipient: ME,
        amountIn: AMOUNT_IN,
        amountOutMinimum: MIN_OUT,
        sqrtPriceLimitX96: 0n,
        ...over,
      } as never,
    ],
  });

test("the real builder's output passes, single-hop and multi-hop", () => {
  assert.deepEqual(checkV3SwapCalls(build(), expect), { ok: true });
  const multi = build({ path: { tokens: [USDG, WETH, QQQ], fees: [500, 3000] } });
  assert.deepEqual(checkV3SwapCalls(multi, expect), { ok: true });
});

test("THE 263x CLASS: a floor that is not the floor we approved", () => {
  // Vex's incident, 2026-08-27 on Robinhood Chain: a confirmed fill 263x worse
  // than quoted, because the execute path re-quoted at broadcast and derived its
  // floor from the fresher route. This is the check that would have caught it
  // regardless of which end the drift came from.
  const low = checkV3SwapCalls(withSwap(single({ amountOutMinimum: MIN_OUT / 263n })), expect);
  assert.equal(low.ok, false);
  assert.equal(low.ok === false ? low.rule : null, "price-floor");

  // EQUALITY, NOT "AT LEAST". A higher floor is not a safer trade, it is a
  // different one — and it is also what a build carrying a stale quote looks
  // like when the price moved the other way.
  const high = checkV3SwapCalls(withSwap(single({ amountOutMinimum: MIN_OUT + 1n })), expect);
  assert.equal(high.ok, false);
  assert.equal(high.ok === false ? high.rule : null, "price-floor");
});

test("the output must land in the account", () => {
  const v = checkV3SwapCalls(withSwap(single({ recipient: THIEF })), expect);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false ? v.rule : null, "recipient");
});

test("both legs of the asset pair are read, not just the one that is easy", () => {
  const inWrong = checkV3SwapCalls(withSwap(single({ tokenIn: WETH })), expect);
  assert.equal(inWrong.ok === false ? inWrong.rule : null, "asset");
  const outWrong = checkV3SwapCalls(withSwap(single({ tokenOut: THIEF })), expect);
  assert.equal(outWrong.ok === false ? outWrong.rule : null, "asset");
});

test("A MULTI-HOP PATH IS CHECKED AT BOTH ENDS", () => {
  // The output token of a packed path is the half that MOVES with hop count, so
  // it is the one a decoder is most likely to skip — and the one an attacker
  // would change. Vex's guard reads both floors of a native-output swap for the
  // same reason: reading only the first leaves the other free.
  const swapped = encodeFunctionData({
    abi: UNISWAP_SWAP_ROUTER_ABI,
    functionName: "exactInput",
    args: [
      {
        path: encodePath([USDG, WETH, THIEF], [500, 3000]),
        recipient: ME,
        amountIn: AMOUNT_IN,
        amountOutMinimum: MIN_OUT,
      } as never,
    ],
  });
  const v = checkV3SwapCalls(withSwap(swapped), expect);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false ? v.rule : null, "asset");
});

test("the approval is bounded to this trade and to this router", () => {
  const [, swap] = build();
  const infinite: FenceCall = {
    to: USDG,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ROUTER, 2n ** 256n - 1n],
    }),
  };
  const v = checkV3SwapCalls([infinite, swap!], expect);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false ? v.rule : null, "approval");

  // A spender that is not the router this swap calls is the whole shape of the
  // hole the wall was closed for: approve somebody, then let them pull.
  const elsewhere: FenceCall = {
    to: USDG,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [THIEF, AMOUNT_IN] }),
  };
  const w = checkV3SwapCalls([elsewhere, swap!], expect);
  assert.equal(w.ok === false ? w.rule : null, "approval");
});

test("UNRECOGNISED IS A REFUSAL, NEVER A PASS", () => {
  // The property that makes a decoder worth having. A shape this function does
  // not understand must not fall through as fine.
  const [approve, swap] = build();
  assert.equal(checkV3SwapCalls([], expect).ok, false, "no calls");
  assert.equal(checkV3SwapCalls([approve!], expect).ok, false, "one call");
  assert.equal(checkV3SwapCalls([approve!, swap!, swap!], expect).ok, false, "three calls");
  assert.equal(checkV3SwapCalls([{ ...approve!, data: "0xdeadbeef" }, swap!], expect).ok, false);
  assert.equal(checkV3SwapCalls([approve!, { ...swap!, data: "0xdeadbeef" }], expect).ok, false);
  // A different router function that happens to decode is still not a swap we build.
  const sweep = encodeFunctionData({
    abi: UNISWAP_SWAP_ROUTER_ABI,
    functionName: "exactInput",
    args: [
      { path: encodePath([USDG, QQQ], [500]), recipient: ME, amountIn: AMOUNT_IN, amountOutMinimum: MIN_OUT } as never,
    ],
  });
  // ...and the well-formed one still passes, so the refusals above are not the
  // function simply rejecting everything.
  assert.deepEqual(checkV3SwapCalls(withSwap(sweep), expect), { ok: true });
});

test("no ETH moves on this path", () => {
  // Every permission in the wall carries valueLimit: 0n, so a non-zero value is
  // refused on-chain anyway — but on-chain means after it was signed and paid for.
  const [approve, swap] = build();
  assert.equal(checkV3SwapCalls([{ ...approve!, value: 1n }, swap!], expect).ok, false);
  assert.equal(checkV3SwapCalls([approve!, { ...swap!, value: 1n }], expect).ok, false);
});

test("the swap must be addressed to the router, not merely mention it", () => {
  const [approve, swap] = build();
  const v = checkV3SwapCalls([approve!, { ...swap!, to: THIEF }], expect);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false ? v.rule : null, "build-integrity");
});
