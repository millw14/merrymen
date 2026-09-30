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
 *   checkPerpDepositCalls / checkPerpKeyCalls / checkPerpClaimCalls — the
 *   three ON-CHAIN legs of perpetuals on Lighter (docs/perps.md rule 3): post
 *   USDG margin, register the sealed API key, claim a payout home. Same bar as
 *   the energy lane — bytes EQUAL to a canonical re-encoding — for the same
 *   reason, stated at each.
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
  LIGHTER_CHANGE_PUBKEY_ABI,
  LIGHTER_DEPOSIT_ABI,
  LIGHTER_ROUTE_V1,
  LIGHTER_WITHDRAW_PENDING_ABI,
  UNISWAP_SWAP_ROUTER_ABI,
  UNISWAP_V2_ENERGY_ABI,
  energyCallWords,
  pubKeyWords,
  validatePerpPubKey,
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
  | "approval"
  /** The API key about to be registered is not the one the grant sealed (perps). */
  | "key";

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

// ── the perp lanes: Lighter's three on-chain legs ───────────────────────────
//
// WHY THESE ARE FENCED AT ALL. Each leg is ONE permission the wall sealed
// (docs/perps.md rule 3), and a UserOp the wall refuses is refused on chain
// after it was signed and its gas spent. But the fence is not a mirror of the
// wall — it is STRICTER, for three reasons the wall cannot help:
//
//   - the wall admits trailing calldata on every permission (no pin reads past
//     the last pinned word), which the proxy's decoder ignores;
//   - the wall leaves words open that the DECISION did not: the deposit and
//     claim amounts, the key registration's account index;
//   - the wall pins `usdgSpenders` as a ONE_OF, so an approve naming the
//     energy router instead of the proxy passes the wall and strands an
//     allowance nobody meant to grant.
//
// So each lane is PROVENANCE (the exact call count, targets, no value) and
// MEANING (bytes EQUAL to the one canonical encoding of the decided terms),
// and on inequality it decodes only to NAME the rule. The route is the frozen
// LIGHTER_ROUTE_V1 — the only proxy and asset a perp marker can ever seal — so
// an expectation naming any other proxy or token is itself refused: a build
// for a venue the wall never granted is a build nobody authorised.

/** The selectors the wall's three proxy permissions resolve to (abis.ts, perps.test.ts). */
const PERP_DEPOSIT_SELECTOR = "0x8a857083";
const PERP_CHANGE_PUBKEY_SELECTOR = "0x17010c68";
const PERP_WITHDRAW_PENDING_SELECTOR = "0x2f25807e";

const UINT128_MAX = 2n ** 128n - 1n;
const UINT48_MAX = 2n ** 48n - 1n;

/** Selector and 32-byte words of calldata, or null for anything not word-aligned hex. */
function callWords(data: string): { selector: string; words: bigint[] } | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8}([0-9a-fA-F]{64})*$/.test(data)) return null;
  const body = data.slice(10);
  const words: bigint[] = [];
  for (let i = 0; i < body.length; i += 64) words.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return { selector: data.slice(0, 10).toLowerCase(), words };
}

const isAddress = (a: unknown): a is `0x${string}` => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** The expectation names the frozen route's proxy (and, for a deposit, its USDG) — or says why not. */
function offRoute(proxy: unknown, usdg?: unknown): FenceVerdict | null {
  if (!isAddress(proxy) || !same(proxy, LIGHTER_ROUTE_V1.proxy)) {
    return no("build-integrity", `the expected proxy ${String(proxy)} is not the Lighter proxy the wall sealed`);
  }
  if (usdg !== undefined && (!isAddress(usdg) || !same(usdg, LIGHTER_ROUTE_V1.usdg))) {
    return no("asset", `the expected collateral ${String(usdg)} is not USDG, Lighter asset ${LIGHTER_ROUTE_V1.assetIndex}`);
  }
  return null;
}

export interface PerpDepositFenceExpect {
  /** The account itself — the deposit's `_to`, and the Lighter account it credits. */
  account: `0x${string}`;
  /** USDG — LIGHTER_ROUTE_V1.usdg, and nothing else. */
  usdg: `0x${string}`;
  /** The ZkLighter proxy — LIGHTER_ROUTE_V1.proxy, and nothing else. */
  proxy: `0x${string}`;
  /** Micro-USDG the approve allows and the deposit posts — the same number, compared by EQUALITY. */
  amount: bigint;
}

/**
 * Do these calls post EXACTLY the margin that was decided, to THIS account?
 *
 * `[USDG.approve(proxy, amount), proxy.deposit(account, 3, 0, amount)]`, no
 * value, and each leg byte-equal to its canonical encoding.
 *
 * THE `_to` IS THE WHOLE POINT. Lighter keys an account on `_to` and credits
 * whoever it names, whoever paid; a deposit to any other address is a USDG
 * transfer to a stranger's venue account wearing a deposit's clothes. The wall
 * pins it too — this refuses it before it is signed and paid for.
 *
 * THE APPROVE IS EXACT, not a ceiling: an allowance above the deposit is a
 * standing permission the proxy keeps. And its spender must be the PROXY —
 * the wall's USDG approve admits every spender in `usdgSpenders`, so an
 * approve naming the energy router would pass the chain and leave the deposit
 * to revert with an allowance stranded elsewhere.
 */
export function checkPerpDepositCalls(calls: readonly FenceCall[], expect: PerpDepositFenceExpect): FenceVerdict {
  const route = offRoute(expect.proxy, expect.usdg);
  if (route) return route;
  if (!isAddress(expect.account)) return no("recipient", `the expected account ${String(expect.account)} is not an address`);
  if (typeof expect.amount !== "bigint" || expect.amount <= 0n || expect.amount > UINT128_MAX) {
    return no("build-integrity", `a deposit of ${String(expect.amount)} is not an amount anybody decided`);
  }
  if (calls.length !== 2) {
    return no("build-integrity", `expected a USDG approve and a Lighter deposit, got ${calls.length} call(s)`);
  }
  const [approve, deposit] = calls as [FenceCall, FenceCall];
  // `deposit` is PAYABLE — native ETH deposits share the entry point — so a
  // value here is not merely refused by the wall's valueLimit: 0, it is money.
  if (approve.value !== 0n || deposit.value !== 0n) {
    return no("build-integrity", "a margin deposit moves no ETH, and one of these legs carries value");
  }

  // ── leg one: the approval, bounded to this deposit and this proxy ───────
  if (!same(approve.to, expect.usdg)) {
    return no("asset", `the approval is against ${approve.to}, not USDG`);
  }
  let approveArgs: readonly unknown[];
  try {
    // Hex case is not meaning: decode the lowercase form (viem matches the
    // selector case-sensitively), and compare bytes case-insensitively below.
    const d = decodeFunctionData({ abi: erc20Abi, data: approve.data.toLowerCase() as Hex });
    if (d.functionName !== "approve") return no("approval", `the first leg is \`${d.functionName}\`, not an approval`);
    approveArgs = d.args as readonly unknown[];
  } catch {
    return no("approval", "the first leg does not decode as an ERC-20 call");
  }
  const [spender, allowance] = approveArgs as [`0x${string}`, bigint];
  if (!same(spender, expect.proxy)) {
    return no("approval", `the approval names ${spender}, not the Lighter proxy the deposit calls`);
  }
  if (allowance !== expect.amount) {
    return no("approval", `the approval is for ${allowance}, but the deposit posts ${expect.amount}`);
  }
  const canonicalApprove = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [expect.proxy, expect.amount] });
  if (approve.data.toLowerCase() !== canonicalApprove.toLowerCase()) {
    return no("build-integrity", "the approval decodes right but is not its canonical encoding (trailing or re-laid bytes)");
  }

  // ── leg two: the deposit, byte for byte ─────────────────────────────────
  if (!same(deposit.to, expect.proxy)) {
    return no("build-integrity", `the deposit is addressed to ${deposit.to}, not the Lighter proxy`);
  }
  const canonical = encodeFunctionData({
    abi: LIGHTER_DEPOSIT_ABI,
    functionName: "deposit",
    args: [expect.account, LIGHTER_ROUTE_V1.assetIndex, LIGHTER_ROUTE_V1.routePerps, expect.amount],
  });
  if (deposit.data.toLowerCase() !== canonical.toLowerCase()) return namePerpDepositMismatch(deposit.data, expect);

  // The layout the wall pins, on the bytes about to be signed: four static
  // words, `_to` the account, asset 3, route 0 (perps), the amount.
  const w = callWords(canonical);
  if (
    !w ||
    w.selector !== PERP_DEPOSIT_SELECTOR ||
    w.words.length !== 4 ||
    `0x${w.words[0]!.toString(16).padStart(40, "0")}` !== expect.account.toLowerCase() ||
    w.words[1] !== BigInt(LIGHTER_ROUTE_V1.assetIndex) ||
    w.words[2] !== BigInt(LIGHTER_ROUTE_V1.routePerps) ||
    w.words[3] !== expect.amount
  ) {
    return no("build-integrity", "the canonical deposit no longer lays out the four words the wall pins — the chain would refuse it");
  }
  return { ok: true };
}

/** The deposit bytes are not the canonical ones: say which part differs, never "fine". */
function namePerpDepositMismatch(data: Hex, expect: PerpDepositFenceExpect): FenceVerdict {
  if (data.slice(0, 10).toLowerCase() !== PERP_DEPOSIT_SELECTOR) {
    return no("build-integrity", `the deposit leg's selector is ${data.slice(0, 10)}, not the deposit the wall granted`);
  }
  let args: readonly unknown[];
  try {
    args = decodeFunctionData({ abi: LIGHTER_DEPOSIT_ABI, data: data.toLowerCase() as Hex }).args as readonly unknown[];
  } catch {
    return no("build-integrity", "the deposit leg does not decode as Lighter's deposit");
  }
  const [to, assetIndex, routeType, amount] = args as [string, number, number, bigint];
  if (!same(to, expect.account)) {
    return no("recipient", `the deposit would credit ${to}'s Lighter account, not this account's`);
  }
  if (assetIndex !== LIGHTER_ROUTE_V1.assetIndex) {
    return no("asset", `the deposit names Lighter asset ${assetIndex}, not USDG (${LIGHTER_ROUTE_V1.assetIndex})`);
  }
  if (routeType !== LIGHTER_ROUTE_V1.routePerps) {
    return no("asset", `the deposit names route ${routeType}, not perps (${LIGHTER_ROUTE_V1.routePerps}) — route 1 is the spot book nothing here reads`);
  }
  if (amount !== expect.amount) {
    return no("build-integrity", `the deposit posts ${amount}, not the ${expect.amount} the approve allows`);
  }
  return no("build-integrity", "the deposit decodes to the decided terms but is not their canonical encoding (non-canonical encoding)");
}

export interface PerpKeyFenceExpect {
  /** The ZkLighter proxy — LIGHTER_ROUTE_V1.proxy, and nothing else. */
  proxy: `0x${string}`;
  /** addressToAccountIndex(self), read on chain after the first deposit landed. */
  accountIndex: number | bigint;
  /** The route's key index — LIGHTER_ROUTE_V1.apiKeyIndex (16), and nothing else. */
  apiKeyIndex: number;
  /** The key the GRANT sealed (grantPerp(grant).apiPublicKey) — never a key from anywhere else. */
  apiPublicKey: string;
}

/**
 * Does this call register EXACTLY the sealed key, at the route's index, on
 * this account?
 *
 * `[proxy.changePubKey(accountIndex, 16, pk)]`, no value, byte-equal to the
 * canonical encoding — which is what makes the key check real. The wall pins
 * w2 (the offset, 0x60) because the proxy's decoder follows it: calldata
 * whose w4/w5 still hold the sealed words but whose offset points `_pubKey` at
 * bytes past them registers ANY key (measured on 4663 under eth_call). A
 * decoder-based fence would read the relocated key and might even name it; a
 * byte-equality fence refuses every layout but the one.
 *
 * AND THE WORDS THE WALL PINS, asserted on the canonical bytes through the
 * same helper the wall is built from (core pubKeyWords): six words, the key
 * index, the offset 0x60, the length 40, and both key words — w5 RIGHT-padded.
 * If the encoder ever produced another layout, the chain would refuse it after
 * we paid; the fence refuses it first.
 */
export function checkPerpKeyCalls(calls: readonly FenceCall[], expect: PerpKeyFenceExpect): FenceVerdict {
  const route = offRoute(expect.proxy);
  if (route) return route;
  if (expect.apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) {
    return no("key", `the expected key index ${String(expect.apiKeyIndex)} is not the route's ${LIGHTER_ROUTE_V1.apiKeyIndex}`);
  }
  const pk = typeof expect.apiPublicKey === "string" ? validatePerpPubKey(expect.apiPublicKey) : null;
  if (pk === null) return no("key", "the expected key is not a canonical Lighter API public key");
  const idx = typeof expect.accountIndex === "bigint" ? expect.accountIndex : Number.isSafeInteger(expect.accountIndex) ? BigInt(expect.accountIndex) : -1n;
  if (idx < 1n || idx > UINT48_MAX) {
    return no("build-integrity", `account index ${String(expect.accountIndex)} is not a Lighter account (1 … 2^48−1)`);
  }
  if (calls.length !== 1) {
    return no("build-integrity", `expected one changePubKey, got ${calls.length} call(s)`);
  }
  const [call] = calls as [FenceCall];
  if (call.value !== 0n) return no("build-integrity", "registering a key moves no ETH, and this call carries value");
  if (!same(call.to, expect.proxy)) {
    return no("build-integrity", `the key registration is addressed to ${call.to}, not the Lighter proxy`);
  }
  const canonical = encodeFunctionData({
    abi: LIGHTER_CHANGE_PUBKEY_ABI,
    functionName: "changePubKey",
    args: [Number(idx), LIGHTER_ROUTE_V1.apiKeyIndex, pk],
  });
  if (call.data.toLowerCase() !== canonical.toLowerCase()) return namePerpKeyMismatch(call.data, idx, pk);

  const w = callWords(canonical);
  const [w4, w5] = pubKeyWords(pk);
  if (
    !w ||
    w.selector !== PERP_CHANGE_PUBKEY_SELECTOR ||
    w.words.length !== 6 ||
    w.words[0] !== idx ||
    w.words[1] !== BigInt(LIGHTER_ROUTE_V1.apiKeyIndex) ||
    w.words[2] !== 0x60n ||
    w.words[3] !== 40n ||
    w.words[4] !== BigInt(w4) ||
    w.words[5] !== BigInt(w5)
  ) {
    return no("build-integrity", "the canonical changePubKey no longer lays out the six words the wall pins — the chain would refuse it");
  }
  return { ok: true };
}

/** The key registration bytes are not the canonical ones: say which part differs, never "fine". */
function namePerpKeyMismatch(data: Hex, accountIndex: bigint, pk: `0x${string}`): FenceVerdict {
  if (data.slice(0, 10).toLowerCase() !== PERP_CHANGE_PUBKEY_SELECTOR) {
    return no("build-integrity", `the call's selector is ${data.slice(0, 10)}, not the changePubKey the wall granted`);
  }
  let args: readonly unknown[];
  try {
    args = decodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, data: data.toLowerCase() as Hex }).args as readonly unknown[];
  } catch {
    return no("build-integrity", "the call does not decode as Lighter's changePubKey");
  }
  const [acct, keyIndex, key] = args as [number, number, string];
  if (keyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) {
    return no("key", `the call registers at key index ${keyIndex}, not the route's ${LIGHTER_ROUTE_V1.apiKeyIndex}`);
  }
  if (typeof key !== "string" || key.toLowerCase() !== pk) {
    // Never echo the other key in full: it may be somebody's live trading key.
    return no("key", "the call registers a different API key than the one the grant sealed");
  }
  if (BigInt(acct) !== accountIndex) {
    return no("build-integrity", `the call names Lighter account ${acct}, not this account's ${accountIndex}`);
  }
  return no(
    "build-integrity",
    "the call decodes to the sealed key but is not its canonical encoding (a relocated offset, dirty padding or trailing bytes) — non-canonical encoding",
  );
}

export interface PerpClaimFenceExpect {
  /** The ZkLighter proxy — LIGHTER_ROUTE_V1.proxy, and nothing else. */
  proxy: `0x${string}`;
  /** The account itself — the claim's `_owner`, the only address it can pay. */
  account: `0x${string}`;
  /** getPendingBalance(self, 3) as read — micro-USDG at tick 1; a claim for more reverts. */
  amount: bigint;
}

/**
 * Does this call claim EXACTLY the decided payout, to THIS account?
 *
 * `[proxy.withdrawPendingBalance(account, 3, amount)]`, no value, byte-equal to
 * the canonical encoding. The wall leaves the amount open — money coming home
 * is not a risk it needs to bound — but a claim for more than is pending
 * reverts after it was paid for, so the fence holds the amount to the pending
 * figure the decision read.
 */
export function checkPerpClaimCalls(calls: readonly FenceCall[], expect: PerpClaimFenceExpect): FenceVerdict {
  const route = offRoute(expect.proxy);
  if (route) return route;
  if (!isAddress(expect.account)) return no("recipient", `the expected account ${String(expect.account)} is not an address`);
  if (typeof expect.amount !== "bigint" || expect.amount <= 0n || expect.amount > UINT128_MAX) {
    return no("build-integrity", `a claim of ${String(expect.amount)} is not an amount anybody decided`);
  }
  if (calls.length !== 1) {
    return no("build-integrity", `expected one withdrawPendingBalance, got ${calls.length} call(s)`);
  }
  const [call] = calls as [FenceCall];
  if (call.value !== 0n) return no("build-integrity", "a claim moves no ETH out, and this call carries value");
  if (!same(call.to, expect.proxy)) {
    return no("build-integrity", `the claim is addressed to ${call.to}, not the Lighter proxy`);
  }
  const canonical = encodeFunctionData({
    abi: LIGHTER_WITHDRAW_PENDING_ABI,
    functionName: "withdrawPendingBalance",
    args: [expect.account, LIGHTER_ROUTE_V1.assetIndex, expect.amount],
  });
  if (call.data.toLowerCase() !== canonical.toLowerCase()) return namePerpClaimMismatch(call.data, expect);

  const w = callWords(canonical);
  if (
    !w ||
    w.selector !== PERP_WITHDRAW_PENDING_SELECTOR ||
    w.words.length !== 3 ||
    `0x${w.words[0]!.toString(16).padStart(40, "0")}` !== expect.account.toLowerCase() ||
    w.words[1] !== BigInt(LIGHTER_ROUTE_V1.assetIndex) ||
    w.words[2] !== expect.amount
  ) {
    return no("build-integrity", "the canonical claim no longer lays out the three words the wall pins — the chain would refuse it");
  }
  return { ok: true };
}

/** The claim bytes are not the canonical ones: say which part differs, never "fine". */
function namePerpClaimMismatch(data: Hex, expect: PerpClaimFenceExpect): FenceVerdict {
  if (data.slice(0, 10).toLowerCase() !== PERP_WITHDRAW_PENDING_SELECTOR) {
    return no("build-integrity", `the call's selector is ${data.slice(0, 10)}, not the withdrawPendingBalance the wall granted`);
  }
  let args: readonly unknown[];
  try {
    args = decodeFunctionData({ abi: LIGHTER_WITHDRAW_PENDING_ABI, data: data.toLowerCase() as Hex }).args as readonly unknown[];
  } catch {
    return no("build-integrity", "the call does not decode as Lighter's withdrawPendingBalance");
  }
  const [owner, assetIndex, amount] = args as [string, number, bigint];
  if (!same(owner, expect.account)) {
    return no("recipient", `the claim would pay ${owner}, not this account`);
  }
  if (assetIndex !== LIGHTER_ROUTE_V1.assetIndex) {
    return no("asset", `the claim names Lighter asset ${assetIndex}, not USDG (${LIGHTER_ROUTE_V1.assetIndex})`);
  }
  if (amount !== expect.amount) {
    return no("build-integrity", `the claim is for ${amount}, not the ${expect.amount} pending`);
  }
  return no("build-integrity", "the claim decodes to the decided terms but is not their canonical encoding (non-canonical encoding)");
}
