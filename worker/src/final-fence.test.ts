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

// ── the energy lane ─────────────────────────────────────────────────────────
//
// Fed from the REAL builder (venues/uniswap-v2-energy.ts), for the reason the
// header gives: the pass case is the production shape, and every refusal is a
// mutation of it, one field at a time.
import { ENERGY_ROUTE_V1, ENERGY_SWAP_SELECTOR, UNISWAP_V2_ENERGY_ABI } from "../../packages/core/src/index";
import { checkEnergySwapCalls, type EnergyFenceExpect } from "./final-fence";
import { buildEnergyCalls } from "./venues/uniswap-v2-energy";

const E_IN = 10_000_000n;
const E_MIN = 21_000_000_000_000_000_000_000n;
const E_DEADLINE = 1_800_000_180n;
const eExpect: EnergyFenceExpect = { route: ENERGY_ROUTE_V1, recipient: ME, amountIn: E_IN, minOut: E_MIN, deadline: E_DEADLINE };
const eCalls = (): FenceCall[] =>
  buildEnergyCalls({ route: ENERGY_ROUTE_V1, amountIn: E_IN, minOut: E_MIN, recipient: ME, deadline: E_DEADLINE }) as FenceCall[];
const eSwap = (args: { amountIn?: bigint; minOut?: bigint; path?: readonly `0x${string}`[]; to?: `0x${string}`; deadline?: bigint }) =>
  encodeFunctionData({
    abi: UNISWAP_V2_ENERGY_ABI,
    functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [args.amountIn ?? E_IN, args.minOut ?? E_MIN, [...(args.path ?? ENERGY_ROUTE_V1.path)], args.to ?? ME, args.deadline ?? E_DEADLINE],
  });
const withEnergySwap = (data: `0x${string}`): FenceCall[] => {
  const [a, s] = eCalls();
  return [a!, { ...s!, data }];
};
const eRule = (calls: FenceCall[]) => {
  const v = checkEnergySwapCalls(calls, eExpect);
  return v.ok ? "ok" : v.rule;
};
const [USDG_E, VIRTUAL_E, MERRY_E] = ENERGY_ROUTE_V1.path;

test("ENERGY: the real builder's output passes", () => {
  assert.deepEqual(checkEnergySwapCalls(eCalls(), eExpect), { ok: true });
  // Case never matters — only the bytes do.
  const [a, s] = eCalls();
  assert.deepEqual(checkEnergySwapCalls([a!, { ...s!, data: s!.data.toUpperCase().replace("0X", "0x") as `0x${string}` }], eExpect), { ok: true });
});

test("ENERGY PROVENANCE: count, value, and the approval bound to this buy", () => {
  const [a, s] = eCalls();
  assert.equal(eRule([s!]), "build-integrity");
  assert.equal(eRule([a!, s!, s!]), "build-integrity");
  assert.equal(eRule([{ ...a!, value: 1n }, s!]), "build-integrity");
  assert.equal(eRule([a!, { ...s!, value: 1n }]), "build-integrity");
  assert.equal(eRule([{ ...a!, to: QQQ }, s!]), "asset");
  const approve = (spender: `0x${string}`, amount: bigint) =>
    ({ ...a!, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) }) as FenceCall;
  assert.equal(eRule([approve(ROUTER, E_IN), s!]), "approval", "the v3 router is not the energy router");
  assert.equal(eRule([approve(ENERGY_ROUTE_V1.router, E_IN + 1n), s!]), "approval", "a ceiling above the buy is a standing permission");
  assert.equal(eRule([approve(ENERGY_ROUTE_V1.router, E_IN - 1n), s!]), "approval");
  assert.equal(
    eRule([{ ...a!, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ENERGY_ROUTE_V1.router, E_IN] }) }, s!]),
    "approval",
  );
  assert.equal(eRule([{ ...a!, data: `${a!.data}${"00".repeat(32)}` as `0x${string}` }, s!]), "build-integrity", "trailing bytes on the approve");
});

test("ENERGY MEANING: the swap's target, selector, floor, recipient and path", () => {
  const [a, s] = eCalls();
  assert.equal(eRule([a!, { ...s!, to: ROUTER }]), "build-integrity", "addressed anywhere but the energy router");
  // The NON fee-on-transfer variant: it would revert on every honest fill, and
  // the wall never granted it.
  const plain = `0x38ed1739${s!.data.slice(10)}` as `0x${string}`;
  assert.equal(eRule(withEnergySwap(plain)), "build-integrity");
  // The floor, in EITHER direction — a higher floor is a different trade.
  assert.equal(eRule(withEnergySwap(eSwap({ minOut: E_MIN - 1n }))), "price-floor");
  assert.equal(eRule(withEnergySwap(eSwap({ minOut: E_MIN + 1n }))), "price-floor");
  assert.equal(eRule(withEnergySwap(eSwap({ minOut: 0n }))), "price-floor");
  assert.equal(eRule(withEnergySwap(eSwap({ to: THIEF }))), "recipient");
  // The path: two hops buys VIRTUAL, four adds an unpinned hop, and a swapped
  // middle token is somebody else's pair.
  assert.equal(eRule(withEnergySwap(eSwap({ path: [USDG_E, VIRTUAL_E] }))), "asset");
  assert.equal(eRule(withEnergySwap(eSwap({ path: [USDG_E, VIRTUAL_E, MERRY_E, QQQ] }))), "asset");
  assert.equal(eRule(withEnergySwap(eSwap({ path: [USDG_E, WETH, MERRY_E] }))), "asset");
  assert.equal(eRule(withEnergySwap(eSwap({ path: [USDG_E, VIRTUAL_E, QQQ] }))), "asset");
  assert.equal(eRule(withEnergySwap(eSwap({ deadline: E_DEADLINE + 1n }))), "build-integrity", "a deadline nobody built");
  assert.equal(eRule(withEnergySwap(eSwap({ amountIn: E_IN + 1n }))), "build-integrity", "the swap sells more than the approve");
});

test("ENERGY: STRICTER THAN THE WALL — calldata that decodes right but is not canonical is refused", () => {
  const [, s] = eCalls();
  // 32 trailing bytes: the wall ignores them and so would the router.
  assert.equal(eRule(withEnergySwap(`${s!.data}${"00".repeat(32)}` as `0x${string}`)), "build-integrity");
  // The path relocated to 0xc0 behind a padding word: every value decodes
  // exactly as approved (viem follows the offset), but it is not the layout the
  // wall's w2 pin describes, and nothing we sign may be anything but the one.
  const body = s!.data.slice(10);
  const words = body.match(/.{64}/g)!;
  const relocated = [words[0], words[1], (0xc0).toString(16).padStart(64, "0"), words[3], words[4], "0".repeat(64), ...words.slice(5)];
  const reLaid = `${ENERGY_SWAP_SELECTOR}${relocated.join("")}` as `0x${string}`;
  assert.equal(eRule(withEnergySwap(reLaid)), "build-integrity");
  const v = checkEnergySwapCalls(withEnergySwap(reLaid), eExpect);
  assert.match(!v.ok ? v.detail : "", /non-canonical encoding/);
});

test("ENERGY: the lanes never cross — the v3 fence refuses energy calls, the energy fence refuses v3 calls", () => {
  const v3 = checkV3SwapCalls(eCalls(), { ...expect, router: ENERGY_ROUTE_V1.router, tokenIn: USDG_E, tokenOut: MERRY_E, amountIn: E_IN, minOut: E_MIN });
  assert.equal(v3.ok, false);
  const single = buildTradeCalls({
    quote: { amountOut: 1_000_000_000_000_000_000n, fee: 3000, gasEstimate: 100_000n },
    tokenIn: USDG_E,
    tokenOut: MERRY_E,
    recipient: ME,
    amountIn: E_IN,
    minAmountOut: E_MIN,
    deadline: Number(E_DEADLINE),
  } as Parameters<typeof buildTradeCalls>[0]) as FenceCall[];
  assert.equal(checkEnergySwapCalls(single, eExpect).ok, false);
});

// ── the perp lanes: Lighter's three on-chain legs ───────────────────────────
//
// Fed from the REAL builders (perps/onboard.ts), for the reason the header
// gives: the pass case is the production shape, and every refusal is a
// mutation of it, one field at a time.
import {
  LIGHTER_CHANGE_PUBKEY_ABI,
  LIGHTER_DEPOSIT_ABI,
  LIGHTER_ROUTE_V1,
  LIGHTER_WITHDRAW_PENDING_ABI,
  pubKeyWords,
  type PerpGrant,
} from "../../packages/core/src/index";
import { checkPerpClaimCalls, checkPerpDepositCalls, checkPerpKeyCalls, type PerpClaimFenceExpect, type PerpDepositFenceExpect, type PerpKeyFenceExpect } from "./final-fence";
import { buildClaimCalls, buildDepositCalls, buildKeyCalls } from "./perps/onboard";

// Two canonical API keys: five little-endian Goldilocks limbs each, all < p.
const PK = `0x${("01" + "00".repeat(7)).repeat(5)}` as `0x${string}`;
const PK_OTHER = `0x${("02" + "00".repeat(7)).repeat(5)}` as `0x${string}`;
const PERP: PerpGrant = { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: PK };
const L_PROXY = LIGHTER_ROUTE_V1.proxy;
const L_USDG = LIGHTER_ROUTE_V1.usdg;
const IDX = 22_149;
const DEP = 12_500_000n;
const CLAIM = 7_000_001n;

const dExpect: PerpDepositFenceExpect = { account: ME, usdg: L_USDG, proxy: L_PROXY, amount: DEP };
const kExpect: PerpKeyFenceExpect = { proxy: L_PROXY, accountIndex: IDX, apiKeyIndex: 16, apiPublicKey: PK };
const cExpect: PerpClaimFenceExpect = { proxy: L_PROXY, account: ME, amount: CLAIM };
const dCalls = (): FenceCall[] => buildDepositCalls({ perp: PERP, account: ME, amountMicro: DEP }) as FenceCall[];
const kCalls = (): FenceCall[] => buildKeyCalls({ perp: PERP, accountIndex: IDX }) as FenceCall[];
const cCalls = (): FenceCall[] => buildClaimCalls({ perp: PERP, account: ME, amountMicro: CLAIM }) as FenceCall[];
const ruleOf = (v: ReturnType<typeof checkPerpDepositCalls>) => (v.ok ? "ok" : v.rule);
const dRule = (calls: FenceCall[], e: PerpDepositFenceExpect = dExpect) => ruleOf(checkPerpDepositCalls(calls, e));
const kRule = (calls: FenceCall[], e: PerpKeyFenceExpect = kExpect) => ruleOf(checkPerpKeyCalls(calls, e));
const cRule = (calls: FenceCall[], e: PerpClaimFenceExpect = cExpect) => ruleOf(checkPerpClaimCalls(calls, e));
const deposit = (to: `0x${string}`, asset: number, route: number, amount: bigint) =>
  encodeFunctionData({ abi: LIGHTER_DEPOSIT_ABI, functionName: "deposit", args: [to, asset, route, amount] });
const withDeposit = (data: `0x${string}`): FenceCall[] => {
  const [a, d] = dCalls();
  return [a!, { ...d!, data }];
};
const upper = (d: `0x${string}`) => `0x${d.slice(2).toUpperCase()}` as `0x${string}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");

test("PERP DEPOSIT: the real builder's output passes, whatever the hex case", () => {
  assert.deepEqual(checkPerpDepositCalls(dCalls(), dExpect), { ok: true });
  const [a, d] = dCalls();
  assert.deepEqual(checkPerpDepositCalls([{ ...a!, data: upper(a!.data) }, { ...d!, data: upper(d!.data) }], dExpect), { ok: true });
  // …and the expectation's address case never matters either.
  assert.deepEqual(checkPerpDepositCalls(dCalls(), { ...dExpect, account: ME.toUpperCase().replace("0X", "0x") as `0x${string}` }), { ok: true });
});

test("PERP DEPOSIT PROVENANCE: count, value, and an approval bound to this deposit and this proxy", () => {
  const [a, d] = dCalls();
  assert.equal(dRule([d!]), "build-integrity", "no approve");
  assert.equal(dRule([a!, d!, d!]), "build-integrity", "an extra call");
  assert.equal(dRule([a!, d!, { to: THIEF, value: 0n, data: "0x" }]), "build-integrity", "an extra call anywhere");
  assert.equal(dRule([{ ...a!, value: 1n }, d!]), "build-integrity");
  // `deposit` is payable: value here is ETH posted to the venue, not a typo.
  assert.equal(dRule([a!, { ...d!, value: 1n }]), "build-integrity");
  assert.equal(dRule([{ ...a!, to: QQQ }, d!]), "asset", "an approve on another token");
  const approve = (spender: `0x${string}`, amount: bigint) =>
    ({ ...a!, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) }) as FenceCall;
  // The wall's USDG approve admits every spender in usdgSpenders — the energy
  // router passes the chain. Only this fence refuses it.
  assert.equal(dRule([approve(ENERGY_ROUTE_V1.router, DEP), d!]), "approval", "the energy router is not the proxy");
  assert.equal(dRule([approve(THIEF, DEP), d!]), "approval", "the wrong spender");
  assert.equal(dRule([approve(L_PROXY, DEP + 1n), d!]), "approval", "a ceiling above the deposit is a standing permission");
  assert.equal(dRule([approve(L_PROXY, DEP - 1n), d!]), "approval");
  assert.equal(dRule([approve(L_PROXY, 2n ** 256n - 1n), d!]), "approval", "infinite");
  assert.equal(
    dRule([{ ...a!, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [L_PROXY, DEP] }) }, d!]),
    "approval",
    "a transfer to the proxy is not a deposit",
  );
  assert.equal(dRule([{ ...a!, data: `${a!.data}${"00".repeat(32)}` as `0x${string}` }, d!]), "build-integrity", "trailing bytes on the approve");
});

test("PERP DEPOSIT MEANING: `_to`, asset, route, amount and target — each one moved alone", () => {
  const [a, d] = dCalls();
  // THE ONE THAT MATTERS MOST: Lighter credits whoever `_to` names.
  assert.equal(dRule(withDeposit(deposit(THIEF, 3, 0, DEP))), "recipient", "a stranger's venue account");
  assert.equal(dRule(withDeposit(deposit(ME, 2, 0, DEP))), "asset", "another Lighter asset");
  assert.equal(dRule(withDeposit(deposit(ME, 3, 1, DEP))), "asset", "route 1 is Lighter's spot book");
  assert.equal(dRule(withDeposit(deposit(ME, 3, 0, DEP + 1n))), "build-integrity", "posts more than the approve allows");
  assert.equal(dRule(withDeposit(deposit(ME, 3, 0, DEP - 1n))), "build-integrity");
  assert.equal(dRule([a!, { ...d!, to: THIEF }]), "build-integrity", "addressed anywhere but the proxy");
  assert.equal(dRule(withDeposit(`0xd20191bd${d!.data.slice(10)}` as `0x${string}`)), "build-integrity", "the owner's withdraw selector");
  assert.equal(dRule(withDeposit(`${d!.data}${"00".repeat(32)}` as `0x${string}`)), "build-integrity", "trailing bytes");
  const v = checkPerpDepositCalls(withDeposit(`${d!.data}${"00".repeat(32)}` as `0x${string}`), dExpect);
  assert.match(!v.ok ? v.detail : "", /non-canonical encoding/);
});

test("PERP DEPOSIT: an expectation off the sealed route is itself refused", () => {
  assert.equal(dRule(dCalls(), { ...dExpect, proxy: THIEF }), "build-integrity");
  assert.equal(dRule(dCalls(), { ...dExpect, usdg: QQQ }), "asset");
  assert.equal(dRule(dCalls(), { ...dExpect, amount: 0n }), "build-integrity");
  assert.equal(dRule(dCalls(), { ...dExpect, account: "0x1234" as `0x${string}` }), "recipient");
});

test("PERP KEY: the real builder's output passes, index as number or bigint, any hex case", () => {
  assert.deepEqual(checkPerpKeyCalls(kCalls(), kExpect), { ok: true });
  assert.deepEqual(checkPerpKeyCalls(buildKeyCalls({ perp: PERP, accountIndex: BigInt(IDX) }) as FenceCall[], { ...kExpect, accountIndex: BigInt(IDX) }), { ok: true });
  const [c] = kCalls();
  assert.deepEqual(checkPerpKeyCalls([{ ...c!, data: upper(c!.data) }], { ...kExpect, apiPublicKey: PK.toUpperCase().replace("0X", "0x") }), { ok: true });
  // The words the wall pins, read straight off the builder's bytes.
  const words = c!.data.slice(10).match(/.{64}/g)!;
  const [w4, w5] = pubKeyWords(PK);
  assert.deepEqual(words, [word(BigInt(IDX)), word(16n), word(0x60n), word(40n), w4.slice(2), w5.slice(2)]);
});

test("PERP KEY: a different key, a different index, a different account — and the relocated offset", () => {
  const [c] = kCalls();
  const other = encodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, functionName: "changePubKey", args: [IDX, 16, PK_OTHER] });
  assert.equal(kRule([{ ...c!, data: other }]), "key", "a key the grant never sealed");
  const v = checkPerpKeyCalls([{ ...c!, data: other }], kExpect);
  assert.doesNotMatch(!v.ok ? v.detail : "", new RegExp(PK_OTHER.slice(2)), "never echoes somebody's key");
  // The fence holds the builder to the SEALED key: a grant sealing another key
  // refuses these bytes even though they are well formed.
  assert.equal(kRule(kCalls(), { ...kExpect, apiPublicKey: PK_OTHER }), "key");
  const reserved = encodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, functionName: "changePubKey", args: [IDX, 3, PK] });
  assert.equal(kRule([{ ...c!, data: reserved }]), "key", "index 3 is the owner's Robinhood Wallet session");
  const elsewhere = encodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, functionName: "changePubKey", args: [IDX + 1, 16, PK] });
  assert.equal(kRule([{ ...c!, data: elsewhere }]), "build-integrity", "another Lighter account");
  // THE ATTACK THE WALL'S OFFSET PIN EXISTS FOR: w3..w5 still hold the sealed
  // words, but w2 points the decoder at a second key past them. The decoder
  // registers the second key; byte equality refuses the whole layout and the
  // decode names the key it would really register.
  const [w4, w5] = pubKeyWords(PK);
  const [o4, o5] = pubKeyWords(PK_OTHER);
  const relocated = `0x17010c68${[word(BigInt(IDX)), word(16n), word(0xc0n), word(40n), w4.slice(2), w5.slice(2), word(40n), o4.slice(2), o5.slice(2)].join("")}` as `0x${string}`;
  assert.equal(kRule([{ ...c!, data: relocated }]), "key");
  // The same relocation pointing at the SEALED key still is not the one layout.
  const reLaid = `0x17010c68${[word(BigInt(IDX)), word(16n), word(0x80n), "0".repeat(64), word(40n), w4.slice(2), w5.slice(2)].join("")}` as `0x${string}`;
  assert.equal(kRule([{ ...c!, data: reLaid }]), "build-integrity");
  // Dirty padding after the 40 key bytes, and trailing bytes: the decoder
  // reads the sealed key from both, and neither is the canonical encoding.
  const dirty = `${c!.data.slice(0, -2)}01` as `0x${string}`;
  assert.equal(kRule([{ ...c!, data: dirty }]), "build-integrity");
  assert.match((() => { const r = checkPerpKeyCalls([{ ...c!, data: dirty }], kExpect); return r.ok ? "" : r.detail; })(), /non-canonical encoding/);
  assert.equal(kRule([{ ...c!, data: `${c!.data}${"00".repeat(32)}` as `0x${string}` }]), "build-integrity");
});

test("PERP KEY PROVENANCE: one call, no value, the proxy, and an expectation that names the route's key", () => {
  const [c] = kCalls();
  assert.equal(kRule([]), "build-integrity");
  assert.equal(kRule([c!, c!]), "build-integrity", "an extra call");
  assert.equal(kRule([{ ...c!, value: 1n }]), "build-integrity");
  assert.equal(kRule([{ ...c!, to: THIEF }]), "build-integrity");
  assert.equal(kRule([{ ...c!, data: `0x2f25807e${c!.data.slice(10)}` as `0x${string}` }]), "build-integrity", "another proxy selector");
  assert.equal(kRule(kCalls(), { ...kExpect, apiKeyIndex: 15 }), "key");
  assert.equal(kRule(kCalls(), { ...kExpect, apiPublicKey: `0x${"ff".repeat(40)}` }), "key", "limbs ≥ p: not a key the contract accepts");
  assert.equal(kRule(kCalls(), { ...kExpect, accountIndex: 0 }), "build-integrity", "account 0 is 'no account'");
  assert.equal(kRule(kCalls(), { ...kExpect, accountIndex: 2 ** 48 }), "build-integrity");
  assert.equal(kRule(kCalls(), { ...kExpect, proxy: THIEF }), "build-integrity");
});

test("PERP CLAIM: the real builder's output passes; `_owner`, asset and amount each refused alone", () => {
  assert.deepEqual(checkPerpClaimCalls(cCalls(), cExpect), { ok: true });
  const [c] = cCalls();
  assert.deepEqual(checkPerpClaimCalls([{ ...c!, data: upper(c!.data) }], cExpect), { ok: true });
  const claim = (owner: `0x${string}`, asset: number, amount: bigint) =>
    [{ ...c!, data: encodeFunctionData({ abi: LIGHTER_WITHDRAW_PENDING_ABI, functionName: "withdrawPendingBalance", args: [owner, asset, amount] }) }];
  assert.equal(cRule(claim(THIEF, 3, CLAIM)), "recipient", "the proxy pays `_owner`, whoever called");
  assert.equal(cRule(claim(ME, 0, CLAIM)), "asset");
  assert.equal(cRule(claim(ME, 3, CLAIM + 1n)), "build-integrity", "more than is pending reverts after it was paid for");
  assert.equal(cRule(claim(ME, 3, CLAIM - 1n)), "build-integrity");
  assert.equal(cRule([{ ...c!, data: `${c!.data}${"00".repeat(32)}` as `0x${string}` }]), "build-integrity", "trailing bytes");
  assert.equal(cRule([{ ...c!, value: 1n }]), "build-integrity");
  assert.equal(cRule([c!, c!]), "build-integrity", "an extra call");
  assert.equal(cRule([{ ...c!, to: THIEF }]), "build-integrity");
  assert.equal(cRule(cCalls(), { ...cExpect, amount: 0n }), "build-integrity");
  assert.equal(cRule(cCalls(), { ...cExpect, proxy: ENERGY_ROUTE_V1.router }), "build-integrity");
  // A hand-laid claim whose amount word is dirty above uint128 does not decode.
  const dirty = `0x2f25807e${word(BigInt(ME))}${word(3n)}${"01" + word(CLAIM).slice(2)}` as `0x${string}`;
  assert.equal(cRule([{ ...c!, data: dirty }]), "build-integrity");
});

test("PERP: the lanes never cross — each fence refuses the others' calls, and the swap fences refuse all three", () => {
  assert.equal(checkPerpDepositCalls(kCalls(), dExpect).ok, false);
  assert.equal(checkPerpDepositCalls(cCalls(), dExpect).ok, false);
  assert.equal(checkPerpKeyCalls(dCalls(), kExpect).ok, false);
  assert.equal(checkPerpKeyCalls(cCalls(), kExpect).ok, false);
  assert.equal(checkPerpClaimCalls(kCalls(), cExpect).ok, false);
  assert.equal(checkPerpClaimCalls(dCalls(), cExpect).ok, false);
  // A deposit is an approve + one more call, like a swap: neither swap fence
  // may mistake it for one.
  assert.equal(checkV3SwapCalls(dCalls(), { ...expect, router: L_PROXY, tokenIn: L_USDG, amountIn: DEP }).ok, false);
  assert.equal(checkEnergySwapCalls(dCalls(), { ...eExpect, amountIn: DEP }).ok, false);
  // And no perp fence passes a swap.
  assert.equal(checkPerpDepositCalls(eCalls(), { ...dExpect, amount: E_IN }).ok, false);
});
