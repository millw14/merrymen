/**
 * THE LAST THING BETWEEN A BUILD AND A SIGNATURE.
 *
 * Every other check on this path judges the INTENT: the wall's mirror judges a
 * notional, the impact guard judges a probe, the gas bounds judge an estimate.
 * Nothing has ever read the bytes that are actually about to be signed and asked
 * whether they say what we decided.
 *
 * WHY IT IS WORTH THE HUNDRED LINES. Vex took a confirmed production fill on
 * Robinhood Chain 263x worse than quoted, on 2026-08-27, because the execute
 * path re-quoted at broadcast time and derived its floor from the fresher route
 * — so the approved quote never reached the signed transaction. merrymen does
 * not have that bug (venues/uniswap.ts threads one quote object from bestRoute
 * into buildTradeCalls, deliberately), but "does not have it today" and "cannot
 * have it" are different claims, and only one of them survives a refactor.
 *
 * TWO INDEPENDENT LAYERS, which is the part worth copying:
 *
 *   PROVENANCE — the calls are the ones this trade built: two of them, the
 *   right targets, no value moving.
 *
 *   MEANING — the calldata is DECODED and the floor read back out. An encoder
 *   that started writing the wrong `amountOutMinimum` would satisfy every
 *   structural check perfectly, which is precisely why the decode is not
 *   redundant with the shape check above it.
 *
 * EQUALITY, NOT "AT LEAST". The build writes the approved floor and nothing
 * else, so a difference in EITHER direction is a build nobody authorised. A
 * higher floor is not a safer trade, it is a different one.
 *
 * SCOPE, STATED. This fences the v3 lane — an ERC-20 approve followed by
 * `exactInputSingle` or `exactInput` — which is what every grant this repo can
 * currently produce actually reaches. The v4 adapter and legacy Permit2 lanes
 * are NOT fenced here and must not be passed to it: their calldata is built by
 * different builders with a structurally pinned recipient, and a decoder that
 * silently returned "fine" for a shape it does not understand would be worse
 * than no decoder at all. Unrecognised input is a refusal, never a pass.
 */

import { decodeFunctionData, erc20Abi, type Hex } from "viem";
import { UNISWAP_SWAP_ROUTER_ABI } from "../../packages/core/src/index";

export type FenceRule =
  /** The calls are not the shape this trade builds. */
  | "build-integrity"
  /** The signed floor is not the floor that was approved. */
  | "price-floor"
  /** The output would land somewhere other than the account. */
  | "recipient"
  /** A leg names a token this trade is not for. */
  | "asset"
  /** The approval is not bounded to this trade. */
  | "approval";

export type FenceVerdict = { ok: true } | { ok: false; rule: FenceRule; detail: string };

export interface FenceCall {
  to: `0x${string}`;
  value: bigint;
  data: Hex;
}

export interface FenceExpect {
  router: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  recipient: `0x${string}`;
  amountIn: bigint;
  /** The floor the trade was judged against. Compared by EQUALITY. */
  minOut: bigint;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const no = (rule: FenceRule, detail: string): FenceVerdict => ({ ok: false, rule, detail });

/** First and last 20-byte addresses of a packed v3 path. */
function pathEnds(path: Hex): { first: `0x${string}`; last: `0x${string}` } | null {
  const body = path.slice(2);
  // token(20) ++ [fee(3) ++ token(20)]+ — 40 + n*46 hex characters.
  if (body.length < 86 || (body.length - 40) % 46 !== 0) return null;
  return {
    first: `0x${body.slice(0, 40)}` as `0x${string}`,
    last: `0x${body.slice(-40)}` as `0x${string}`,
  };
}

/**
 * Does this pair of calls do exactly the trade that was approved?
 *
 * Returns a refusal rather than throwing, so the caller books it the way it
 * books every other pre-broadcast refusal: nothing signed, nothing spent.
 */
export function checkV3SwapCalls(
  calls: readonly FenceCall[],
  expect: FenceExpect,
): FenceVerdict {
  if (calls.length !== 2) {
    return no("build-integrity", `expected an approve and a swap, got ${calls.length} call(s)`);
  }
  const [approve, swap] = calls as [FenceCall, FenceCall];

  // NO ETH MOVES ON THIS PATH, EVER. Every permission in the wall carries
  // `valueLimit: 0n`, so a non-zero value would be refused on-chain anyway —
  // but it would be refused after being signed and paid for.
  if (approve.value !== 0n || swap.value !== 0n) {
    return no("build-integrity", "a v3 swap moves no ETH, and one of these legs carries value");
  }

  // ── leg one: the approval, bounded to this trade ────────────────────────
  if (!same(approve.to, expect.tokenIn)) {
    return no("asset", `the approval is against ${approve.to}, not the token being sold`);
  }
  let approveArgs: readonly unknown[];
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: approve.data });
    if (d.functionName !== "approve") {
      return no("approval", `the first leg is \`${d.functionName}\`, not an approval`);
    }
    approveArgs = d.args as readonly unknown[];
  } catch {
    return no("approval", "the first leg does not decode as an ERC-20 call");
  }
  const [spender, allowance] = approveArgs as [`0x${string}`, bigint];
  if (!same(spender, expect.router)) {
    return no("approval", `the approval names ${spender}, not the router this swap calls`);
  }
  // EXACTLY the input, not a ceiling above it. An allowance larger than the
  // trade is a standing permission the next caller inherits.
  if (allowance !== expect.amountIn) {
    return no("approval", `the approval is for ${allowance}, but the trade sells ${expect.amountIn}`);
  }

  // ── leg two: the swap, and what it actually says ────────────────────────
  if (!same(swap.to, expect.router)) {
    return no("build-integrity", `the swap is addressed to ${swap.to}, not the router`);
  }
  let fn: string;
  let params: Record<string, unknown>;
  try {
    const d = decodeFunctionData({ abi: UNISWAP_SWAP_ROUTER_ABI, data: swap.data });
    fn = d.functionName;
    params = (d.args as readonly unknown[])[0] as Record<string, unknown>;
  } catch {
    return no("build-integrity", "the swap leg does not decode against the router ABI");
  }
  if (fn !== "exactInputSingle" && fn !== "exactInput") {
    return no("build-integrity", `the swap leg is \`${fn}\`, which this trade never builds`);
  }

  if (!same(params.recipient as string, expect.recipient)) {
    return no("recipient", `the output would go to ${String(params.recipient)}, not the account`);
  }
  if (params.amountIn !== expect.amountIn) {
    return no("build-integrity", `the swap sells ${String(params.amountIn)}, not ${expect.amountIn}`);
  }

  // THE ONE THE 263x INCIDENT WAS ABOUT.
  if (params.amountOutMinimum !== expect.minOut) {
    return no(
      "price-floor",
      `the floor about to be signed is ${String(params.amountOutMinimum)}, but this trade was ` +
        `judged against ${expect.minOut}. A build carrying a different floor is a different trade.`,
    );
  }

  if (fn === "exactInputSingle") {
    if (!same(params.tokenIn as string, expect.tokenIn)) {
      return no("asset", `the swap sells ${String(params.tokenIn)}, not the token quoted`);
    }
    if (!same(params.tokenOut as string, expect.tokenOut)) {
      return no("asset", `the swap buys ${String(params.tokenOut)}, not the token quoted`);
    }
    return { ok: true };
  }

  // exactInput: the assets are the ENDS of a packed path, and the output token
  // is the half that moves with hop count — which is exactly why reading it
  // matters more here than in the single-hop form.
  const ends = pathEnds(params.path as Hex);
  if (!ends) return no("asset", "the multi-hop path is not a well-formed token/fee sequence");
  if (!same(ends.first, expect.tokenIn)) {
    return no("asset", `the path starts at ${ends.first}, not the token quoted`);
  }
  if (!same(ends.last, expect.tokenOut)) {
    return no("asset", `the path ends at ${ends.last}, not the token quoted`);
  }
  return { ok: true };
}
