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
 * SCOPE, STATED. This fences TWO lanes, each with its own function:
 *
 *   checkV3SwapCalls — an ERC-20 approve followed by `exactInputSingle` or
 *   `exactInput`, which is what every trading grant this repo can currently
 *   produce actually reaches.
 *
 *   checkEnergySwapCalls — the energy buy: a USDG approve followed by the
 *   Uniswap v2 fee-on-transfer swap over the one route the grant sealed. It is
 *   STRICTER than the v3 fence, and stricter than the wall: the swap's bytes
 *   must EQUAL a canonical re-encoding, because the wall pins six words and
 *   admits anything around them (trailing bytes, an unpinned floor) that the
 *   router would still decode. See that function.
 *
 * The v4 adapter and legacy Permit2 lanes are NOT fenced here and must not be
 * passed to either: their calldata is built by different builders with a
 * structurally pinned recipient, and a decoder that silently returned "fine"
 * for a shape it does not understand would be worse than no decoder at all.
 * Unrecognised input is a refusal, never a pass.
 */

import { decodeFunctionData, encodeFunctionData, erc20Abi, type Hex } from "viem";
import {
  ENERGY_SWAP_SELECTOR,
  UNISWAP_SWAP_ROUTER_ABI,
  UNISWAP_V2_ENERGY_ABI,
  energyCallWords,
  type EnergyRoute,
} from "../../packages/core/src/index";

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

// ── the energy lane ─────────────────────────────────────────────────────────

export interface EnergyFenceExpect {
  /** The route the grant sealed (grantEnergyRoute) — router and the three-hop path. */
  route: EnergyRoute;
  /** The account itself. */
  recipient: `0x${string}`;
  /** Raw USDG the swap sells and the approve allows — the same number. */
  amountIn: bigint;
  /** The post-tax floor the trade was judged against. Compared by EQUALITY. */
  minOut: bigint;
  /** The deadline the build was given. */
  deadline: bigint;
}

/**
 * Does this pair of calls do EXACTLY the energy buy that was approved?
 *
 * PROVENANCE, as the v3 fence has it: two calls, no value, an approve on USDG
 * naming the router for exactly the input.
 *
 * MEANING, and here the bar is higher than decoding. The swap's calldata must
 * be BYTE-EQUAL (case-insensitively) to a canonical re-encoding of the approved
 * terms. The wall pins only words 2, 3 and 5–8 and leaves the amount, the
 * floor and the deadline open; it also admits trailing bytes, and it cannot
 * tell a canonical head from one that relocates the path — only its w2 pin
 * does. A decoder-based check would pass calldata that decodes to the right
 * values in a non-canonical layout; equality with the one encoding does not.
 * On inequality it decodes only to NAME the rule: the floor (price-floor), the
 * recipient, the path (asset), or anything else (build-integrity).
 *
 * AND THE LAYOUT THE WALL PINS, asserted on the canonical bytes through the
 * same helper the wall's own test uses (core energyCallWords): nine words, the
 * selector 0x5c11d795, the path offset 0xa0, a path of three, and the three
 * hops. If the encoder ever produced a layout the wall does not pin, the chain
 * would refuse it after we paid — so the fence refuses it before we sign.
 *
 * Unconditional in the energy arm: there is no other builder and no skip.
 */
export function checkEnergySwapCalls(calls: readonly FenceCall[], expect: EnergyFenceExpect): FenceVerdict {
  if (calls.length !== 2) {
    return no("build-integrity", `expected an approve and the energy swap, got ${calls.length} call(s)`);
  }
  const [approve, swap] = calls as [FenceCall, FenceCall];
  if (approve.value !== 0n || swap.value !== 0n) {
    return no("build-integrity", "the energy buy moves no ETH, and one of these legs carries value");
  }
  const usdg = expect.route.path[0];
  const router = expect.route.router;

  // ── leg one: the approval, bounded to this buy ──────────────────────────
  if (!same(approve.to, usdg)) {
    return no("asset", `the approval is against ${approve.to}, not USDG`);
  }
  let approveArgs: readonly unknown[];
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: approve.data });
    if (d.functionName !== "approve") return no("approval", `the first leg is \`${d.functionName}\`, not an approval`);
    approveArgs = d.args as readonly unknown[];
  } catch {
    return no("approval", "the first leg does not decode as an ERC-20 call");
  }
  const [spender, allowance] = approveArgs as [`0x${string}`, bigint];
  if (!same(spender, router)) {
    return no("approval", `the approval names ${spender}, not the energy router`);
  }
  if (allowance !== expect.amountIn) {
    return no("approval", `the approval is for ${allowance}, but the buy spends ${expect.amountIn}`);
  }
  const canonicalApprove = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, expect.amountIn] });
  if (approve.data.toLowerCase() !== canonicalApprove.toLowerCase()) {
    return no("build-integrity", "the approval decodes right but is not its canonical encoding (trailing or re-laid bytes)");
  }

  // ── leg two: the swap, byte for byte ────────────────────────────────────
  if (!same(swap.to, router)) {
    return no("build-integrity", `the swap is addressed to ${swap.to}, not the energy router`);
  }
  const canonical = encodeFunctionData({
    abi: UNISWAP_V2_ENERGY_ABI,
    functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [expect.amountIn, expect.minOut, [...expect.route.path], expect.recipient, expect.deadline],
  });
  if (swap.data.toLowerCase() !== canonical.toLowerCase()) return nameEnergyMismatch(swap.data, expect);

  // ── the layout the wall pins, on the bytes about to be signed ───────────
  const w = energyCallWords(canonical);
  const hop = (i: number) => `0x${w!.words[i]!.toString(16).padStart(40, "0")}`;
  if (
    !w ||
    w.selector !== ENERGY_SWAP_SELECTOR ||
    w.words.length !== 9 ||
    w.words[2] !== 0xa0n ||
    w.words[5] !== 3n ||
    !same(hop(3), expect.recipient) ||
    !expect.route.path.every((a, i) => same(hop(6 + i), a))
  ) {
    return no(
      "build-integrity",
      "the canonical encoding no longer lays out the words the wall pins (9 words, path at 0xa0, length 3) — the chain would refuse it",
    );
  }
  return { ok: true };
}

/** The swap bytes are not the canonical ones: say which part differs, never "fine". */
function nameEnergyMismatch(data: Hex, expect: EnergyFenceExpect): FenceVerdict {
  if (data.slice(0, 10).toLowerCase() !== ENERGY_SWAP_SELECTOR) {
    return no("build-integrity", `the swap leg's selector is ${data.slice(0, 10)}, not the fee-on-transfer swap the wall granted`);
  }
  let args: readonly unknown[];
  try {
    args = decodeFunctionData({ abi: UNISWAP_V2_ENERGY_ABI, data }).args as readonly unknown[];
  } catch {
    return no("build-integrity", "the swap leg does not decode as the energy swap");
  }
  const [amountIn, amountOutMin, path, to, deadline] = args as [bigint, bigint, readonly string[], string, bigint];
  if (amountIn !== expect.amountIn) {
    return no("build-integrity", `the swap sells ${amountIn}, not ${expect.amountIn}`);
  }
  if (amountOutMin !== expect.minOut) {
    return no(
      "price-floor",
      `the floor about to be signed is ${amountOutMin}, but this buy was judged against ${expect.minOut}. ` +
        "A build carrying a different floor is a different trade.",
    );
  }
  if (!same(to, expect.recipient)) {
    return no("recipient", `the $MERRYMEN would go to ${to}, not the account`);
  }
  if (path.length !== expect.route.path.length || !path.every((a, i) => same(a, expect.route.path[i]!))) {
    return no("asset", `the path is [${path.join(", ")}], not the sealed energy route`);
  }
  if (deadline !== expect.deadline) {
    return no("build-integrity", `the swap's deadline is ${deadline}, not the ${expect.deadline} it was built with`);
  }
  return no("build-integrity", "the swap decodes to the approved terms but is not their canonical encoding (non-canonical encoding)");
}
