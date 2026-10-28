import assert from "node:assert/strict";
import { PolicyFlags } from "@zerodev/permissions";
import { CallPolicyVersion, ParamCondition, toCallPolicy } from "@zerodev/permissions/policies";
import { decodeFunctionData, encodeFunctionData, pad, toFunctionSelector, type Hex } from "viem";
import test from "node:test";
import {
  CASH,
  ENERGY_ROUTE_V1,
  ENERGY_SWAP_SELECTOR,
  MERRYMEN_TOKEN,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  UNISWAP,
  UNISWAP_SWAP_ROUTER_ABI,
  UNISWAP_V2_ENERGY_ABI,
  VIRTUAL_TOKEN,
  PONS_SELFTRADE_ABI, V4SELFSWAP_ABI,
  allowedSpenders,
  buildCallPermissions,
  buildWallPolicies,
  energyCallWords,
  grantHasMultihop,
  WALL_POLICY_FLAG,
  usableExtraTokens,
  type GrantCaps,
  GRANT_PERP_LIGHTER,
  LIGHTER_ROUTE_V1,
  LIGHTER_DEPOSIT_ABI,
  LIGHTER_CHANGE_PUBKEY_ABI,
  LIGHTER_WITHDRAW_PENDING_ABI,
  grantWallOptions,
  perpFits,
  pubKeyWords,
} from "../../packages/core/src/index";

/**
 * THE WALL, PINNED.
 *
 * These assertions are a specification, not a snapshot. The permission list moved
 * out of the dashboard so a phone could sign the same grant, and the danger in
 * that move is silent: drop one entry, loosen one condition, reorder the args of
 * an approve, and nothing throws — grants just start carrying powers their owners
 * did not agree to, and only for the people who signed after the change.
 *
 * So each expectation below was read off the ORIGINAL dashboard implementation and
 * written down independently. If a future edit widens the wall, this fails and
 * says which entry.
 */

const CAPS: GrantCaps = {
  perTradeUsdg: 50,
  dailyUsdg: 500,
  expiryDays: 14,
  maxDrawdownPct: 10,
  maxOpsPerDay: 48,
};

/** USDG is 6dp — the units a cap is actually expressed in on-chain. */
const usdg = (v: number) => BigInt(Math.round(v * 1e6));

type Perm = ReturnType<typeof buildCallPermissions>[number] & {
  target: string;
  functionName?: string;
  args?: unknown[];
};

/** The agent's own account — what the wall pins swap/vault destinations to. */
const SELF = "0x00000000000000000000000000000000000000a9" as const;
/**
 * Two REAL Lighter API public keys, from the official signer (lighter-go v1.0.9
 * WASM) in the spike — the same vectors perps.test.ts proves `pubKeyWords`
 * against. Real keys rather than invented bytes, because the wall refuses a
 * key the contract would reject and these are what the contract accepts.
 */
const PERP_PK = "0x2427c4493c2df1a3ecdd750f1398b865e5428907c41065f0612cb3fa6b5ea0d7ac00465b07f3acd7" as const;
const PERP_PK_OTHER = "0x3fba6f2e6d1cc97965c00bcb9032ffbd408f77cfb929db0a49d4abd0b090426efb651217ad43f02d" as const;
const perms = () => buildCallPermissions(CAPS, SELF) as unknown as Perm[];
const find = (target: string, fn?: string) =>
  perms().filter((p) => p.target.toLowerCase() === target.toLowerCase() && (fn === undefined || p.functionName === fn));

test("the default spenders exclude Rialto and Permit2, and universalRouter is never one", () => {
  // Rialto is opt-in: an approved spender can pull whatever it was approved
  // for, and the stock approvals carry no amount condition, so listing an
  // unused router is a standing licence over every share the agent holds.
  const s = allowedSpenders().map((a) => a.toLowerCase());
  assert.deepEqual(s, [UNISWAP.swapRouter02.toLowerCase(), MORPHO.steakhouseUsdgVault.toLowerCase()]);
  assert.equal(
    allowedSpenders(true)[0]!.toLowerCase(),
    RIALTO.routerSnapshot.toLowerCase(),
    "opting in adds Rialto, and only then",
  );
  // Permit2 is exactly the standing licence the comment above describes, and it
  // used to be here unconditionally. It only earns its place alongside the v4
  // CALL permissions, so it rides the same opt-in.
  assert.equal(s.includes(UNISWAP.permit2.toLowerCase()), false, "Permit2 is not a default spender");
  assert.equal(
    allowedSpenders(false, true).map((a) => a.toLowerCase()).includes(UNISWAP.permit2.toLowerCase()),
    true,
    "opting into v4 adds Permit2, and only then",
  );
  // v4 never pulls tokens directly — Permit2 does, on the router's behalf. Approving
  // the router itself would skip even that indirection.
  assert.equal(
    allowedSpenders(true, true).map((a) => a.toLowerCase()).includes(UNISWAP.universalRouter.toLowerCase()),
    false,
    "the UniversalRouter must never be an approved spender, on any setting",
  );
});

test("the v4 drain path is absent by default and arrives only as a set", () => {
  // THE REGRESSION THIS PINS. These two permissions were granted
  // unconditionally while Permit2 was an unconditional spender and the stock
  // approvals carry no amount condition. That chain — approve(stock, permit2,
  // unbounded) -> permit2.approve(stock, universalRouter, max, max) ->
  // execute(<opaque inputs naming any recipient>) — moved the entire non-USDG
  // book anywhere, in one UserOp, past a wall the front page says the chain
  // enforces. The execute permission's own comment claimed Permit2 was "only
  // ever granted one trade's worth, expiring"; that described what the worker
  // encodes, not what the policy allows.
  assert.equal(find(UNISWAP.permit2).length, 0, "no Permit2 permission by default");
  assert.equal(find(UNISWAP.universalRouter).length, 0, "no UniversalRouter permission by default");

  const v4 = buildCallPermissions(CAPS, SELF, { allowUniswapV4: true }) as unknown as Perm[];
  const p2 = v4.filter((p) => p.target.toLowerCase() === UNISWAP.permit2.toLowerCase());
  const ur = v4.filter((p) => p.target.toLowerCase() === UNISWAP.universalRouter.toLowerCase());
  assert.equal(p2.length, 1, "opting in adds the Permit2 approve");
  assert.equal(ur.length, 1, "opting in adds the UniversalRouter execute");
  // And they must arrive TOGETHER with the spender, because each alone is inert
  // and granting them piecemeal is how this became a hole in the first place.
  assert.equal(
    allowedSpenders(false, true).map((a) => a.toLowerCase()).includes(UNISWAP.permit2.toLowerCase()),
    true,
    "the call permission and the spender entry are one decision",
  );
  // Still true when opted in: the router's calldata is opaque, so this really is
  // "call anything on this contract" — which is why it is not the default.
  assert.equal(ur[0]!.args, undefined, "execute stays unconstrainable — that is the point of making it opt-in");
});

test("USDG approve is capped at ONE TRADE and restricted to the allowed spenders", () => {
  const [p] = find(CASH.USDG, "approve");
  assert.ok(p, "USDG approve permission must exist");
  const [spender, amount] = p.args as [{ condition: number; value: string[] }, { condition: number; value: bigint }];
  // Two by default — the swap router and the vault. Rialto and Permit2 are each
  // opt-in, and every entry here is a standing licence, so the list growing
  // silently is exactly the regression this asserts against.
  assert.equal(spender.value.length, 2, "the two default spenders — Rialto and Permit2 are opt-in");
  // The cap is per TRADE, not per day. Using dailyUsdg here would let one approval
  // authorise ten trades' worth.
  assert.equal(amount.value, usdg(CAPS.perTradeUsdg));
});

test("by DEFAULT there is no way to send USDG out at all", () => {
  // The recipient used to be free-form, which left the per-call amount as the
  // only on-chain bound — and the daily USDG cap lives off-chain, in the very
  // worker that would be compromised. The real ceiling was therefore
  // perTradeUsdg x maxOpsPerDay per day until expiry (2,400/day at the default
  // preset): "bounded" only in that draining took a fortnight.
  assert.equal(find(CASH.USDG, "transfer").length, 0, "no registered address, no power to send");
});

test("registering withdrawal addresses pins the recipient to exactly those", () => {
  const A = "0x1111111111111111111111111111111111111111" as const;
  const B = "0x2222222222222222222222222222222222222222" as const;
  const list = buildCallPermissions(CAPS, SELF, {
    // Duplicated and mixed-case on purpose: a repeat must not bloat the policy
    // and a case difference must not read as a second address.
    withdrawalAddresses: [A, B, A, B.toUpperCase() as typeof B],
  }) as unknown as Perm[];
  const p = list.find((x) => x.target.toLowerCase() === CASH.USDG.toLowerCase() && x.functionName === "transfer");
  assert.ok(p, "registering an address grants the transfer permission");
  const [recipient, amount] = p.args as [{ condition: number; value: string[] }, { value: bigint }];
  assert.equal(recipient.condition, ParamCondition.ONE_OF);
  assert.deepEqual(recipient.value, [A, B]);
  // The amount cap still applies on top of the destination pin.
  assert.equal(amount.value, usdg(CAPS.perTradeUsdg));
});

test("every tradeable stock token can be approved, so nothing can be bought but not sold", () => {
  const tradeable = STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol));
  assert.ok(tradeable.length > 0, "sanity: there are tradeable tokens");
  for (const t of tradeable) {
    const [p] = find(t.address, "approve");
    assert.ok(p, `${t.symbol} must be approvable or the agent could buy it and never sell`);
    // No amount condition on purpose: share counts are 18dp and not comparable to
    // a USDG cap. Asserted so nobody "tightens" it into a broken policy.
    assert.equal((p.args as unknown[])[1], null, `${t.symbol} approve must have no amount condition`);
  }
});

test("Permit2, WHEN opted into, may only ever grant an allowance to the UniversalRouter", () => {
  const optedIn = buildCallPermissions(CAPS, SELF, { allowUniswapV4: true }) as unknown as Perm[];
  const p = optedIn.find(
    (x) => x.target.toLowerCase() === UNISWAP.permit2.toLowerCase() && x.functionName === "approve",
  );
  assert.ok(p, "permit2 approve permission must exist once opted in");
  const args = p.args as [null, { condition: number; value: string }, null, null];
  // Without this EQUAL condition, this single permission would let the session key
  // hand ANY spender an allowance on ANY token — strictly more power than trading.
  assert.equal(args[1].value.toLowerCase(), UNISWAP.universalRouter.toLowerCase());
});

test("the vault deposit is capped, the withdrawal is not — but BOTH land in our own account", () => {
  const [dep] = find(MORPHO.steakhouseUsdgVault, "deposit");
  const [wd] = find(MORPHO.steakhouseUsdgVault, "withdraw");
  assert.ok(dep && wd);

  // deposit(assets, receiver): size capped at the daily limit...
  assert.equal((dep.args as [{ value: bigint }, unknown])[0].value, usdg(CAPS.dailyUsdg));
  // ...and the SHARES come to us. Unpinned, the agent could spend the owner's
  // USDG and mint the vault position to someone else.
  assert.deepEqual((dep.args as [unknown, { condition: number; value: string }])[1], {
    condition: ParamCondition.EQUAL,
    value: SELF,
  });

  // withdraw(assets, receiver, owner): size deliberately unbounded — money
  // coming home is not a risk. But this test used to assert `wd.args ===
  // undefined` ON PURPOSE, with a comment about money coming home, while the
  // policy let the session key send the entire vault position ANYWHERE in one
  // uncapped call. The comment described the intent; the policy permitted the
  // opposite. "Coming home" is now enforced rather than assumed.
  const wdArgs = wd.args as [null, { condition: number; value: string }, null];
  assert.equal(wdArgs[0], null, "size stays unbounded");
  assert.deepEqual(wdArgs[1], { condition: ParamCondition.EQUAL, value: SELF });
  assert.equal(wdArgs[2], null, "owner is unconstrained — it can only be us anyway");
});

test("MULTI-HOP IS GONE, and the packed path is why it cannot come back", () => {
  // It used to be granted with `args: [null, null, self]` — recipient pinned at
  // word 2, both tokens open. That was defensible only while its single-hop
  // sibling was equally open. Once `exactInputSingle` pinned both token legs,
  // this became the loosest door in the wall: the output token lives inside a
  // packed `path`, so the drain the single-hop pin closes was one selector away.
  assert.equal(find(UNISWAP.swapRouter02, "exactInput").length, 0, "no multi-hop permission");

  // AND THE PATH IS UNCONSTRAINABLE — which is why the answer is removal rather
  // than a tighter rule. Proven against viem's encoder: the output token is not
  // right-aligned in any word, and its word index MOVES with the hop count, so
  // no fixed-offset ONE_OF can ever name it.
  const OTHER = "0x00000000000000000000000000000000000000ff" as const;
  const path = `0x${CASH.USDG.slice(2)}000bb8${CASH.WETH.slice(2)}000bb8${OTHER.slice(2)}` as `0x${string}`;
  const calldata = encodeFunctionData({
    abi: UNISWAP_SWAP_ROUTER_ABI,
    functionName: "exactInput",
    args: [{ path, recipient: SELF, amountIn: 1_000_000n, amountOutMinimum: 0n }],
  });
  const body = `0x${calldata.slice(10)}`;
  const wordAt = (i: number) => `0x${body.slice(2 + i * 64, 2 + (i + 1) * 64)}`;
  assert.equal(BigInt(wordAt(5)), 66n, "3 hops = 20+3+20+3+20 bytes of path");
  const tail = OTHER.slice(2).toLowerCase();
  assert.ok(
    ![6, 7, 8].some((i) => wordAt(i).toLowerCase().endsWith(tail)),
    "the output token is not right-aligned in any word — a ONE_OF rule cannot match it",
  );

  // Marker and permission move together. A wall that no longer grants the route
  // must not hand out a marker that tells the worker to build it.
  assert.equal(grantHasMultihop({ grantFeatures: ["tradeable-v2"] }), false);
});


test("the router is narrowed to ONE entrypoint, and Rialto is absent by default", () => {
  // ONE, not two. `exactInput` (multi-hop) was dropped: its packed `path` hides
  // the output token and cannot be constrained at the pinned policy version,
  // which made it the loosest door once exactInputSingle pinned both legs.
  assert.equal(find(UNISWAP.swapRouter02, "exactInputSingle").length, 1);
  assert.equal(find(UNISWAP.swapRouter02, "exactInput").length, 0);
  assert.equal(find(UNISWAP.swapRouter02).length, 1, "and nothing else on that router");
  // The UniversalRouter is absent entirely by default — see the v4 test above.
  // When opted in it is narrowed to `execute` and no further, because there is
  // no further: its arguments are opaque bytes.
  assert.equal(find(UNISWAP.universalRouter).length, 0);
  const v4 = buildCallPermissions(CAPS, SELF, { allowUniswapV4: true }) as unknown as Perm[];
  assert.equal(
    v4.filter((p) => p.target.toLowerCase() === UNISWAP.universalRouter.toLowerCase() && p.functionName === "execute")
      .length,
    1,
  );
  // Rialto's calldata comes from a quote API, so there is no shape to
  // constrain — the permission is effectively "call anything on this
  // contract". It needs an integrator key to work at all, so the default wall
  // simply doesn't carry it.
  assert.equal(find(RIALTO.routerSnapshot).length, 0);

  const optedIn = buildCallPermissions(CAPS, SELF, { allowRialto: true }) as unknown as Perm[];
  const rialto = optedIn.find((p) => p.target.toLowerCase() === RIALTO.routerSnapshot.toLowerCase());
  assert.ok(rialto, "opting in adds it");
  assert.equal(rialto.functionName, undefined, "still unconstrainable — that is the point of making it opt-in");
});

test("owner-added tokens are validated and de-duplicated before becoming policy", () => {
  const builtinAddr = STOCK_TOKENS[0]!.address;
  const usable = usableExtraTokens([
    { address: builtinAddr, symbol: "DUP", decimals: 18 } as never, // already covered
    { address: "0xnothex", symbol: "BAD", decimals: 18 } as never, // malformed
    { address: "0x1111111111111111111111111111111111111111", symbol: "OK", decimals: 18 } as never,
    { address: "0x1111111111111111111111111111111111111111", symbol: "OK", decimals: 18 } as never, // repeat
  ]);
  assert.equal(usable.length, 1, "only the one valid, non-duplicate token survives");
  assert.equal(usable[0]!.symbol, "OK");
});

test("the wall carries exactly the expected permission set — no more, no less", () => {
  const list = perms();
  const stockCount = STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).length;
  // DEFAULT wall: 1 USDG approve + N stock approves + swapRouter02 ×1
  // (exactInputSingle only) + vault deposit + vault withdraw. No USDG transfer,
  // no Rialto and no v4 — all three are opt-in. The count dropped from
  // stockCount + 6 when Permit2 and the UniversalRouter stopped being granted
  // unconditionally, rose to +6 when multi-hop was granted rather than
  // quoted-and-reverted, and fell to +4 when multi-hop was dropped again —
  // its packed path could not be constrained, which made it the widest door
  // left once exactInputSingle pinned both token legs.
  assert.equal(list.length, stockCount + 4, "an unexpected permission count means something was added or lost");
  // ...and each opt-in adds exactly the entries it should, never more.
  const withXfer = buildCallPermissions(CAPS, SELF, { withdrawalAddresses: [SELF] });
  const withRialto = buildCallPermissions(CAPS, SELF, { allowRialto: true });
  const withV4 = buildCallPermissions(CAPS, SELF, { allowUniswapV4: true });
  assert.equal(withXfer.length, list.length + 1);
  assert.equal(withRialto.length, list.length + 1);
  assert.equal(withV4.length, list.length + 2, "v4 is a PAIR — Permit2 approve plus UniversalRouter execute");
  // Nothing may authorise sending native value.
  for (const p of list) assert.equal(p.valueLimit, 0n, `${p.target} must not be allowed to move native ETH`);

  // THE ENERGY BUY adds exactly ONE permission and exactly ONE spender entry,
  // and the spender entry lands in the USDG approve and nowhere else. The
  // stock and extra approves carry no amount condition, so the router joining
  // THEIR ONE_OF would be an uncapped allowance over the whole book — inert
  // only while Router02 pulls from msg.sender alone, which is an argument, not
  // a construction. An owner extra rides along to prove the extras are spared
  // too, and $MERRYMEN is listed as an extra to prove it is refused.
  const CUSTOM = { symbol: "MEME", address: "0x00000000000000000000000000000000000000dd" as const, decimals: 18 };
  const MERRY = { symbol: "MERRYMEN", address: MERRYMEN_TOKEN.address, decimals: 18 };
  const plain = buildCallPermissions(CAPS, SELF, { extraTokens: [CUSTOM, MERRY] }) as unknown as Perm[];
  const withEnergy = buildCallPermissions(CAPS, SELF, { extraTokens: [CUSTOM, MERRY], energyBuy: true }) as unknown as Perm[];
  assert.equal(withEnergy.length, plain.length + 1, "the energy buy is ONE permission");
  for (const p of withEnergy) assert.equal(p.valueLimit, 0n, `${p.target} must not be allowed to move native ETH`);
  const router = ENERGY_ROUTE_V1.router.toLowerCase();
  const spendersOf = (l: Perm[], target: string) => {
    const p = l.find((x) => x.target.toLowerCase() === target.toLowerCase() && x.functionName === "approve");
    assert.ok(p, `${target} must have an approve`);
    return ((p.args as { value: string[] }[])[0]!.value).map((a) => a.toLowerCase());
  };
  assert.deepEqual(
    spendersOf(withEnergy, CASH.USDG),
    [...spendersOf(plain, CASH.USDG), router],
    "the USDG approve grows by exactly the router",
  );
  const approvesOf = (l: Perm[]) => l.filter((p) => p.functionName === "approve").map((p) => p.target.toLowerCase());
  assert.deepEqual(approvesOf(withEnergy), approvesOf(plain), "no new approve permission — only a wider USDG spender list");
  for (const target of approvesOf(withEnergy).filter((t) => t !== CASH.USDG.toLowerCase())) {
    assert.deepEqual(spendersOf(withEnergy, target), spendersOf(plain, target), `${target}'s approve must not change`);
    assert.ok(!spendersOf(withEnergy, target).includes(router), `${target} must never name the energy router`);
  }
  assert.ok(
    !approvesOf(withEnergy).includes(MERRYMEN_TOKEN.address.toLowerCase()),
    "$MERRYMEN has no approve anywhere — the reserve is buy-only",
  );
  const [single] = withEnergy.filter(
    (p) => p.target.toLowerCase() === UNISWAP.swapRouter02.toLowerCase() && p.functionName === "exactInputSingle",
  );
  for (const leg of (single!.args as { value?: string[] }[]).slice(0, 2)) {
    assert.ok(
      !leg.value!.map((a) => a.toLowerCase()).includes(MERRYMEN_TOKEN.address.toLowerCase()),
      "$MERRYMEN is not a v3 leg either — the energy route is its only way in",
    );
  }
});

test("the wall carries a hard expiry and a call policy — and NO rate limit", () => {
  const now = 1_800_000_000;
  const { policies, expiresAt } = buildWallPolicies({ caps: CAPS, smartAccount: SELF, now });
  assert.equal(expiresAt, now + CAPS.expiryDays * 86_400);

  // TWO, not three. This asserted three while the middle one was a pointer into
  // empty space, and the count passing was part of why nobody looked: a test
  // can only check that a policy was CONSTRUCTED, never that the contract it
  // names exists. eth_getCode on 2026-08-30 returned 0 bytes for
  // RATE_LIMIT_POLICY_CONTRACT on mainnet 4663 AND testnet 46630, while the
  // timestamp and call policies both carry real bytecode.
  //
  // So maxOpsPerDay is enforced by the WORKER only, alongside the daily total
  // and the drawdown breaker, and the on-chain ceiling is per-trade until
  // expiry. WALL_POLICY_CONTRACTS + the arm-time probe are what make a future
  // undeployed singleton a refusal instead of a mystery.
  assert.equal(policies.length, 2, "expiry + call policy; the rate limit is gone because it was never there");
});

test("the session key may EXECUTE but may not SIGN (the ERC-1271 hole)", () => {
  // Every other assertion in this file is about a CALL policy, and a call
  // policy governs UserOp calls only — it says nothing about signatures. The
  // permission validator implements signMessage and signTypedData, so on the
  // library default (FOR_ALL_VALIDATION) the session key can mint ERC-1271
  // signatures the account honours. That bypasses the wall rather than
  // stretching it: Permit2 is an approved spender and the stock approvals
  // carry no amount condition, so a SIGNED permitTransferFrom — submitted by
  // anyone, from their own EOA — drains tokens with no UserOp, no rate limit,
  // and no trace in the ledger.
  //
  // This costs merrymen nothing: the whole trading path is UserOps, and v4
  // authorises Permit2 with a CALL (venues/uniswap-v4.ts), not a signed permit.
  assert.equal(WALL_POLICY_FLAG, PolicyFlags.NOT_FOR_VALIDATE_SIG);
  assert.notEqual(
    WALL_POLICY_FLAG,
    PolicyFlags.FOR_ALL_VALIDATION,
    "the library default lets the session key sign — never ship it",
  );
});

test("the swap recipient is pinned to our own account, at the RIGHT calldata offset", () => {
  const [swap] = find(UNISWAP.swapRouter02, "exactInputSingle");
  assert.ok(swap);
  const args = swap.args as (null | { condition: number; value: string })[];

  // Seven entries for a ONE-parameter function, because the call policy maps
  // args[i] to calldata offset i*32 with no ABI arity check, and
  // ExactInputSingleParams is an all-static tuple encoded INLINE as seven
  // consecutive words. Index 3 is `recipient`.
  assert.equal(args.length, 7);
  assert.deepEqual(args[3], { condition: ParamCondition.EQUAL, value: SELF });

  // BOTH TOKEN LEGS ARE PINNED, and this is the assertion that used to say the
  // opposite. It read `for (const i of [0, 1, 2, 4, 5, 6]) assert.equal(args[i],
  // null)` — enshrining the hole: with tokenOut open, a stolen key could
  // approve a stock (the amount is deliberately uncapped) and swap the entire
  // balance into a token it had just minted, in ONE UserOp. The recipient pin
  // was satisfied throughout: the account duly received the worthless token.
  const legs = [args[0], args[1]] as unknown as { condition: number; value: string[] }[];
  for (const [i, leg] of legs.entries()) {
    assert.equal(leg?.condition, ParamCondition.ONE_OF, `token leg ${i} must be an allowlist`);
    assert.ok(
      leg.value.map((a) => a.toLowerCase()).includes(CASH.USDG.toLowerCase()),
      `token leg ${i} must admit USDG`,
    );
    assert.ok(
      !leg.value.map((a) => a.toLowerCase()).includes("0x00000000000000000000000000000000000000ff"),
      `token leg ${i} must not admit a token nobody named`,
    );
  }
  // The two legs are built from the SAME list the approve permissions use, so
  // what a key may approve and what it may swap into cannot drift apart.
  assert.deepEqual(legs[0]!.value, legs[1]!.value, "both legs share one allowlist");
  for (const i of [2, 4, 5, 6]) assert.equal(args[i], null, `arg ${i} must stay unconstrained`);

  // AND PROVE THE OFFSET, against viem's encoder rather than against the
  // reasoning above. If SwapRouter02's struct ever gains a dynamic member or
  // reorders its fields, the inline layout shifts and args[3] would silently
  // constrain the WRONG word — a policy that looks strict and isn't. This
  // fails loudly instead.
  const OTHER = "0x00000000000000000000000000000000000000ff" as const;
  const calldata = encodeFunctionData({
    abi: UNISWAP_SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: CASH.USDG as `0x${string}`,
        tokenOut: OTHER,
        fee: 3000,
        recipient: SELF,
        amountIn: 1_000_000n,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  // Skip the 4-byte selector, then read word 3 (the policy's offset 3*32).
  const body = `0x${calldata.slice(10)}`;
  const wordAt = (i: number) => `0x${body.slice(2 + i * 64, 2 + (i + 1) * 64)}`;
  assert.equal(
    wordAt(3).toLowerCase(),
    pad(SELF, { size: 32 }).toLowerCase(),
    "offset 3*32 must be `recipient` — if this fails the tuple layout moved and the pin is aimed at the wrong field",
  );

  // AND THE TOKEN LEGS, for the same reason and with more at stake: a ONE_OF
  // aimed at the wrong word is an allowlist that permits everything while
  // reading as strict. Words 0 and 1 must be tokenIn and tokenOut.
  assert.equal(
    wordAt(0).toLowerCase(),
    pad(CASH.USDG as `0x${string}`, { size: 32 }).toLowerCase(),
    "offset 0 must be `tokenIn`",
  );
  assert.equal(
    wordAt(1).toLowerCase(),
    pad(OTHER, { size: 32 }).toLowerCase(),
    "offset 1 must be `tokenOut`",
  );
  // The neighbour too, so a shift in either direction fails rather than aliases.
  assert.equal(BigInt(wordAt(2)), 3000n, "word 2 is the fee tier");
});

test("the V4 ADAPTER opt-in: one permission, both legs pinned to the owner's asset list, at proven offsets", () => {
  const ADAPTER = "0x00000000000000000000000000000000000000d4" as const;
  const CUSTOM = { symbol: "WIF", address: "0x00000000000000000000000000000000000000e7", decimals: 9 } as const;

  // Absent by default — the closed position, like every opt-in here.
  assert.equal(find(ADAPTER).length, 0, "no adapter permission without the opt-in");

  const withAdapter = buildCallPermissions(CAPS, SELF, {
    v4AdapterAddress: ADAPTER,
    extraTokens: [CUSTOM],
  }) as unknown as Perm[];
  const mine = withAdapter.filter((p) => p.target.toLowerCase() === ADAPTER);
  assert.equal(mine.length, 1, "exactly one call permission on the adapter");
  const [swap] = mine;
  assert.equal(swap!.functionName, "swapExactIn");
  assert.equal(swap!.valueLimit, 0n);

  // The adapter joined the SPENDER set, so the existing approves can name it —
  // zero new approve entries. Check the USDG approve's ONE_OF actually grew.
  const usdgApprove = withAdapter.find(
    (p) => p.target.toLowerCase() === CASH.USDG.toLowerCase() && p.functionName === "approve",
  )!;
  const spenderCond = (usdgApprove.args as { value: string[] }[])[0]!;
  assert.ok(
    spenderCond.value.map((a) => a.toLowerCase()).includes(ADAPTER),
    "the adapter must be an allowed spender, or it can never pull tokenIn",
  );

  // BOTH LEGS PINNED — the strictness v3 never had. tokenIn and tokenOut are
  // ONE_OF over USDG + tradeable stocks + the owner's extras, derived in the
  // same call as the approve targets so the two sets cannot drift. This is
  // what turns "a stolen key swaps the bankroll into a token it minted for
  // gas" into "both legs must be assets the OWNER named".
  const args = swap!.args as (null | { condition: number; value: string | string[] })[];
  assert.equal(args.length, 8, "eight declared args, eight policy slots — all static, no pointer words");
  for (const i of [0, 1] as const) {
    const cond = args[i] as { condition: number; value: string[] };
    assert.equal(cond.condition, ParamCondition.ONE_OF, `arg ${i} must be pinned`);
    const set = cond.value.map((a) => a.toLowerCase());
    assert.ok(set.includes(CASH.USDG.toLowerCase()), "cash is an asset");
    assert.ok(set.includes(CUSTOM.address.toLowerCase()), "the owner's own token is an asset");
    assert.ok(!set.includes("0x00000000000000000000000000000000000000ff"), "an unnamed token is not");
  }
  for (const i of [2, 3, 4, 5, 6, 7]) assert.equal(args[i], null, `arg ${i} stays unconstrained — see wall.ts for why each`);

  // AND PROVE THE OFFSETS against viem's encoder, not against the reasoning.
  // All eight params are static, so this is the one signature where the flat
  // args[i] -> word i mapping is EXACT — but that is precisely the claim that
  // must fail loudly if the contract's signature ever changes shape.
  const calldata = encodeFunctionData({
    abi: V4SELFSWAP_ABI,
    functionName: "swapExactIn",
    args: [
      CASH.USDG as `0x${string}`,
      CUSTOM.address as `0x${string}`,
      3000,
      60,
      "0x00000000000000000000000000000000000000aa",
      1_000_000n,
      999n,
      1_800_000_000n,
    ],
  });
  const body = calldata.slice(10);
  const word = (i: number) => `0x${body.slice(i * 64, (i + 1) * 64)}`;
  assert.equal(word(0).toLowerCase(), pad(CASH.USDG as `0x${string}`, { size: 32 }).toLowerCase(), "word 0 = tokenIn");
  assert.equal(word(1).toLowerCase(), pad(CUSTOM.address as `0x${string}`, { size: 32 }).toLowerCase(), "word 1 = tokenOut");
  assert.equal(
    word(4).toLowerCase(),
    pad("0x00000000000000000000000000000000000000aa", { size: 32 }).toLowerCase(),
    "word 4 = hooks",
  );
  assert.equal(BigInt(word(5)), 1_000_000n, "word 5 = amountIn");
  assert.equal(BigInt(word(6)), 999n, "word 6 = minAmountOut");
  assert.equal(BigInt(word(7)), 1_800_000_000n, "word 7 = deadline");
});

test("the adapter opt-in is INDEPENDENT of the legacy v4 route, and a junk address throws", () => {
  const ADAPTER = "0x00000000000000000000000000000000000000d4" as const;
  const base = perms().length;

  // Adapter alone: +1 permission (its call), no Permit2, no UniversalRouter.
  const adapterOnly = buildCallPermissions(CAPS, SELF, { v4AdapterAddress: ADAPTER }) as unknown as Perm[];
  assert.equal(adapterOnly.length, base + 1);
  assert.equal(
    adapterOnly.filter((p) => p.target.toLowerCase() === UNISWAP.universalRouter.toLowerCase()).length,
    0,
    "the adapter route does not smuggle the UniversalRouter back in",
  );

  // Legacy flag alone: unchanged from before the adapter existed (+3).
  const legacy = buildCallPermissions(CAPS, SELF, { allowUniswapV4: true }) as unknown as Perm[];
  assert.equal(legacy.length, base + 2, "the legacy Permit2+UniversalRouter set is untouched");

  // Both: strictly additive, no interference.
  const both = buildCallPermissions(CAPS, SELF, {
    v4AdapterAddress: ADAPTER,
    allowUniswapV4: true,
  }) as unknown as Perm[];
  assert.equal(both.length, base + 3);

  // A malformed address must throw at build time — a permission whose target
  // is garbage is a route that looks granted and can never match, sealed into
  // a signature nobody can amend.
  for (const bad of ["0x1234", "not-an-address", ""]) {
    assert.throws(
      () => buildCallPermissions(CAPS, SELF, { v4AdapterAddress: bad as never }),
      /not an address/,
      `"${bad}" must be refused before it becomes policy`,
    );
  }
});

test("the PONS ADAPTER opt-in: one permission, both asset legs pinned, curve deliberately not, at proven offsets", () => {
  const PONS = "0x00000000000000000000000000000000000000d5" as const;
  const CUSTOM = { symbol: "WIF", address: "0x00000000000000000000000000000000000000e7", decimals: 9 } as const;

  // Absent by default — the closed position, like every opt-in here.
  assert.equal(find(PONS).length, 0, "no Pons permission without the opt-in");

  const withPons = buildCallPermissions(CAPS, SELF, {
    ponsAdapterAddress: PONS,
    extraTokens: [CUSTOM],
  }) as unknown as Perm[];
  const mine = withPons.filter((p) => p.target.toLowerCase() === PONS);
  assert.equal(mine.length, 1, "exactly one call permission on the adapter");
  const [trade] = mine;
  assert.equal(trade!.functionName, "tradeExactIn");
  // NOT covered by the default-wall loop above, which only walks perms() — an
  // opt-in permission needs its own assertion or the invariant has a hole.
  // Load-bearing here specifically: the adapter is non-payable, which is the
  // whole reason native-quoted curves are out of reach.
  assert.equal(trade!.valueLimit, 0n, "granting Pons must not become the first permission that moves native ETH");

  // The adapter joined the SPENDER set, so the existing approves can name it —
  // zero new approve entries, exactly as the v4 adapter did.
  const usdgApprove = withPons.find(
    (p) => p.target.toLowerCase() === CASH.USDG.toLowerCase() && p.functionName === "approve",
  )!;
  const spenderCond = (usdgApprove.args as { value: string[] }[])[0]!;
  assert.ok(
    spenderCond.value.map((a) => a.toLowerCase()).includes(PONS),
    "the adapter must be an allowed spender, or it can never pull assetIn",
  );

  const args = trade!.args as (null | { condition: number; value: string | string[] })[];
  assert.equal(args.length, 6, "six declared args, six policy slots — all static, no pointer words");

  // THE CURVE IS UNPINNED, AND THAT IS THE DESIGN. A buy goes to a per-token
  // address (~475 new ones an hour), so any ONE_OF over word 0 is stale
  // tomorrow or unbounded today. Asserted rather than left to a reader's
  // assumption: if someone later "tightens" this, the test says why not to.
  assert.equal(args[0], null, "the curve cannot be pinned — see wall.ts");

  // BOTH ASSET LEGS PINNED, from the same list the approves cover, so the
  // trade set and the approve set cannot drift inside one grant.
  for (const i of [1, 2] as const) {
    const cond = args[i] as { condition: number; value: string[] };
    assert.equal(cond.condition, ParamCondition.ONE_OF, `arg ${i} must be pinned`);
    const set = cond.value.map((a) => a.toLowerCase());
    assert.ok(set.includes(CASH.USDG.toLowerCase()), "cash is an asset");
    assert.ok(set.includes(CUSTOM.address.toLowerCase()), "the owner's own token is an asset");
    assert.ok(!set.includes("0x00000000000000000000000000000000000000ff"), "an unnamed token is not");
  }
  for (const i of [3, 4, 5]) assert.equal(args[i], null, `arg ${i} stays unconstrained — see wall.ts for why each`);

  // AND PROVE THE OFFSETS against viem's encoder, not against the reasoning.
  // There is no ABI arity check in the policy layer: a wrong-length args array
  // builds rules over garbage silently, and this is the only thing that catches
  // it. All six params are static, so the flat args[i] -> word i mapping is
  // exact — which is the claim that must fail loudly if the contract's
  // signature ever grows a struct or a `bytes`.
  const calldata = encodeFunctionData({
    abi: PONS_SELFTRADE_ABI,
    functionName: "tradeExactIn",
    args: [
      "0x00000000000000000000000000000000000000cc",
      CASH.USDG as `0x${string}`,
      CUSTOM.address as `0x${string}`,
      1_000_000n,
      999n,
      1_800_000_000n,
    ],
  });
  const body = calldata.slice(10);
  const word = (i: number) => `0x${body.slice(i * 64, (i + 1) * 64)}`;
  assert.equal(
    word(0).toLowerCase(),
    pad("0x00000000000000000000000000000000000000cc", { size: 32 }).toLowerCase(),
    "word 0 = curve",
  );
  assert.equal(word(1).toLowerCase(), pad(CASH.USDG as `0x${string}`, { size: 32 }).toLowerCase(), "word 1 = assetIn");
  assert.equal(word(2).toLowerCase(), pad(CUSTOM.address as `0x${string}`, { size: 32 }).toLowerCase(), "word 2 = assetOut");
  assert.equal(BigInt(word(3)), 1_000_000n, "word 3 = amountIn");
  assert.equal(BigInt(word(4)), 999n, "word 4 = minAmountOut");
  assert.equal(BigInt(word(5)), 1_800_000_000n, "word 5 = deadline");
});

test("the Pons opt-in is INDEPENDENT of the v4 adapter, and a junk address throws", () => {
  const PONS = "0x00000000000000000000000000000000000000d5" as const;
  const V4 = "0x00000000000000000000000000000000000000d4" as const;
  const base = perms().length;

  // Each alone adds exactly its own call permission, and neither implies the
  // other. Two venues, two risks, two decisions — one flag granting both would
  // make the owner's only choice all-or-nothing.
  assert.equal(buildCallPermissions(CAPS, SELF, { ponsAdapterAddress: PONS }).length, base + 1);
  assert.equal(buildCallPermissions(CAPS, SELF, { v4AdapterAddress: V4 }).length, base + 1);
  assert.equal(
    buildCallPermissions(CAPS, SELF, { ponsAdapterAddress: PONS, v4AdapterAddress: V4 }).length,
    base + 2,
    "both opt-ins are additive, not overlapping",
  );

  // A malformed address must throw rather than be sealed into a signature: a
  // policy that can never match is a bricked route that looks granted.
  assert.throws(
    () => buildCallPermissions(CAPS, SELF, { ponsAdapterAddress: "0xnope" as never }),
    /ponsAdapterAddress is not an address/,
  );
});

/**
 * EVERY ADAPTER REACHES THE CHAIN — the assertion that was missing.
 *
 * `buildWallPolicies` forwarded `v4AdapterAddress` to `buildCallPermissions` and
 * silently dropped `ponsAdapterAddress`. It type-checked, because the function's
 * argument is an intersection with `WallOptions`: the field was accepted at the
 * call site and discarded one line later.
 *
 * That is the precise failure this whole file exists to prevent, and every other
 * Pons assertion here missed it by calling `buildCallPermissions` DIRECTLY —
 * bypassing the wrapper that both signers actually use. The one existing
 * `buildWallPolicies` test passes no adapters at all and counts policies.
 *
 * A grant signed through that path would carry the `pons-adapter` marker and a
 * sealed address over a call policy containing no `tradeExactIn` permission and
 * no adapter in the approve spender set. `grantPonsAdapter` would return the
 * address, `limitsFromGrant` would allow the target, `checkPolicy` would pass,
 * the arm-time liveness check would pass — and both calls would revert at the
 * wall. A mirror looser than the chain.
 *
 * So this asserts the WRAPPER, for both adapters, forever.
 */
test("buildWallPolicies forwards EVERY adapter into the call policy", () => {
  const V4 = "0x00000000000000000000000000000000000000d4" as const;
  const PONS = "0x00000000000000000000000000000000000000d5" as const;

  const call = (opts: Parameters<typeof buildWallPolicies>[0]) => {
    const { policies } = buildWallPolicies(opts);
    // The call policy is the LAST, and its permissions live under policyParams
    // — the zerodev policy object exposes only getPolicyData/getPolicyInfoInBytes
    // /policyParams, so reading `.permissions` off the top level silently yields
    // an empty list and this test would pass for the wrong reason.
    //
    // Indexed from the end deliberately. This read `policies[2]` until the
    // rate-limit policy was removed, and a positional index into a list whose
    // length is itself under test is a second thing to remember to change.
    const p = policies[policies.length - 1] as unknown as { policyParams?: { permissions?: { target: string }[] } };
    const perms = p.policyParams?.permissions ?? [];
    assert.ok(perms.length > 0, "the call policy must expose its permissions, or this test proves nothing");
    return perms.map((x) => x.target.toLowerCase());
  };

  const bare = call({ caps: CAPS, smartAccount: SELF });
  assert.ok(!bare.includes(V4), "no adapter asked for, none granted");
  assert.ok(!bare.includes(PONS), "no adapter asked for, none granted");

  // Each one alone must reach the permission list.
  assert.ok(
    call({ caps: CAPS, smartAccount: SELF, v4AdapterAddress: V4 }).includes(V4),
    "v4AdapterAddress must survive buildWallPolicies",
  );
  assert.ok(
    call({ caps: CAPS, smartAccount: SELF, ponsAdapterAddress: PONS }).includes(PONS),
    "ponsAdapterAddress must survive buildWallPolicies — it did not, and the grant still carried the marker",
  );

  // THE ENERGY BUY, the same trap with a boolean: a signer mints GRANT_ENERGY
  // off `wallOpts.energyBuy`, so a wrapper that dropped the flag would seal a
  // marker over a wall with no router permission.
  const ROUTER = ENERGY_ROUTE_V1.router.toLowerCase();
  assert.ok(!bare.includes(ROUTER), "no energy buy asked for, none granted");
  assert.ok(
    call({ caps: CAPS, smartAccount: SELF, energyBuy: true }).includes(ROUTER),
    "energyBuy must survive buildWallPolicies",
  );

  // And together, because forwarding one is what made the other's absence invisible.
  const both = call({ caps: CAPS, smartAccount: SELF, v4AdapterAddress: V4, ponsAdapterAddress: PONS, energyBuy: true });
  assert.ok(both.includes(V4) && both.includes(PONS), "both adapters must reach the chain");
  assert.ok(both.includes(ROUTER), "and the energy router with them");

  // The wrapper must agree with the function it wraps — no path may be looser.
  const direct = buildCallPermissions(CAPS, SELF, { v4AdapterAddress: V4, ponsAdapterAddress: PONS, energyBuy: true }).map(
    (p) => p.target.toLowerCase(),
  );
  assert.deepEqual(both, direct, "buildWallPolicies must mirror buildCallPermissions exactly");

  // Not only the target: the router must reach the USDG approve's spender
  // list through the wrapper too, or the swap could never pull its input.
  const { policies } = buildWallPolicies({ caps: CAPS, smartAccount: SELF, energyBuy: true });
  const callPolicy = policies[policies.length - 1] as unknown as {
    policyParams: { permissions: { target: string; functionName?: string; args?: { value?: unknown }[] }[] };
  };
  const usdgApprove = callPolicy.policyParams.permissions.find(
    (p) => p.target.toLowerCase() === CASH.USDG.toLowerCase() && p.functionName === "approve",
  )!;
  assert.ok(
    (usdgApprove.args![0]!.value as string[]).map((a) => a.toLowerCase()).includes(ROUTER),
    "the energy router must be a USDG spender in the wall the signer actually seals",
  );

  // PERPS, the fifth time the same trap could be sprung — and the one where a
  // dropped field costs most: a grant carrying `perp-lighter-v1` and a sealed
  // key over a wall that can neither deposit, register the key, nor claim home.
  const PROXY = LIGHTER_ROUTE_V1.proxy.toLowerCase();
  const perpLighter = { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_PK };
  assert.ok(!bare.includes(PROXY), "no perps asked for, none granted");
  const perpPolicies = buildWallPolicies({ caps: CAPS, smartAccount: SELF, perpLighter }).policies;
  const perpCall = perpPolicies[perpPolicies.length - 1] as unknown as {
    policyParams: { permissions: { target: string; functionName?: string; args?: { value?: unknown }[] }[] };
  };
  const onProxy = perpCall.policyParams.permissions.filter((p) => p.target.toLowerCase() === PROXY);
  assert.deepEqual(
    onProxy.map((p) => p.functionName),
    ["deposit", "changePubKey", "withdrawPendingBalance"],
    "perpLighter must survive buildWallPolicies — all three proxy permissions",
  );
  const perpApprove = perpCall.policyParams.permissions.find(
    (p) => p.target.toLowerCase() === CASH.USDG.toLowerCase() && p.functionName === "approve",
  )!;
  assert.ok(
    (perpApprove.args![0]!.value as string[]).map((a) => a.toLowerCase()).includes(PROXY),
    "and the proxy must be a USDG spender in the wall the signer actually seals",
  );
  // Byte-level, not just targets: the wrapper's permissions are the direct
  // builder's, rule for rule, key word for key word.
  const everything = { v4AdapterAddress: V4, ponsAdapterAddress: PONS, energyBuy: true, perpLighter } as const;
  const wrapped = buildWallPolicies({ caps: CAPS, smartAccount: SELF, ...everything }).policies;
  const direct2 = toCallPolicy({
    policyVersion: CallPolicyVersion.V0_0_4,
    permissions: buildCallPermissions(CAPS, SELF, everything) as never,
  });
  const last = wrapped[wrapped.length - 1]!;
  assert.equal(last.getPolicyData(), direct2.getPolicyData(), "buildWallPolicies must seal exactly buildCallPermissions' wall");
});

test("the swap's pinned asset set IS the approve set — they cannot drift", () => {
  // THE INVARIANT BEHIND 1.1. Pinning `tokenIn`/`tokenOut` is only worth
  // anything if the pinned list is the same list the approves cover. Pin a
  // narrower set and legitimate sells die on-chain with an opaque revert; pin a
  // wider one and the pin stops meaning what its comment says.
  //
  // wall.ts builds both from the single `adapterAssets` const, in one call, so
  // they cannot drift by construction — but "by construction" is a claim about
  // code that a later refactor can quietly break. This asserts the OUTPUT,
  // which is the only thing the chain sees.
  const CUSTOM = {
    address: "0x00000000000000000000000000000000000000dd" as const,
    symbol: "MEME",
    decimals: 18,
  };
  // The energy buy is in the loop because it is the one opt-in that touches an
  // APPROVE: it widens the USDG spender list. It must not add an approve target
  // (the set) nor a swap leg — $MERRYMEN is reached only by its own pinned route.
  for (const opts of [
    {},
    { extraTokens: [CUSTOM] },
    { energyBuy: true },
    { extraTokens: [CUSTOM, { symbol: "MERRYMEN", address: MERRYMEN_TOKEN.address, decimals: 18 }], energyBuy: true },
  ]) {
    const list = buildCallPermissions(CAPS, SELF, opts) as unknown as Perm[];
    const approved = new Set(
      list.filter((p) => p.functionName === "approve").map((p) => p.target.toLowerCase()),
    );
    const swap = list.find(
      (p) => p.target.toLowerCase() === UNISWAP.swapRouter02.toLowerCase() && p.functionName === "exactInputSingle",
    )!;
    const legs = swap.args as unknown as { condition: number; value: string[] }[];
    for (const i of [0, 1] as const) {
      const pinned = new Set(legs[i]!.value.map((a) => a.toLowerCase()));
      assert.deepEqual(
        [...pinned].sort(),
        [...approved].sort(),
        `leg ${i} must be exactly the set of tokens this grant can approve`,
      );
    }
  }
});

/**
 * THE CLASS ROUTE — the only door in this wall to a token nobody enumerated.
 *
 * Three permissions, granted together or not at all. The reason they cannot be
 * split is EVM semantics rather than tidiness: a vault address is a CREATE2
 * prediction and the contract does not exist until the factory is called, and a
 * CALL to a codeless address SUCCEEDS with empty returndata. So a wall carrying
 * `buy`/`sell` without `deploy` would approve USDG, no-op the buy, and report a
 * landed trade that bought nothing — every tick, forever.
 */
const CLASS_VAULT = "0x00000000000000000000000000000000000000c0" as const;
const CLASS_FACTORY = "0x00000000000000000000000000000000000000fa" as const;
const classOpts = {
  ponsClassVaultAddress: CLASS_VAULT,
  ponsClassVaultFactoryAddress: CLASS_FACTORY,
};

test("a class grant carries buy, sell AND deploy — three, not two", () => {
  const list = buildCallPermissions(CAPS, SELF, classOpts);
  const base = buildCallPermissions(CAPS, SELF, {});
  assert.equal(list.length, base.length + 3, "the class route is exactly three permissions");

  const onVault = list.filter((p) => p.target.toLowerCase() === CLASS_VAULT);
  assert.deepEqual(
    onVault.map((p) => p.functionName).sort(),
    ["buy", "sell"],
    "the vault gets buy and sell, and nothing else — sweep is an OWNER action",
  );
  const onFactory = list.filter((p) => p.target.toLowerCase() === CLASS_FACTORY);
  assert.equal(onFactory.length, 1);
  assert.equal(onFactory[0]!.functionName, "deploy");
});

test("the vault's permitted SELECTORS are exactly two, and setQuoteCaps is not one", () => {
  /**
   * THE PRE-DEPLOY GATE PonsClassVaultV2 ASKS FOR BY NAME.
   *
   * The test above enumerates function NAMES, which is the right shape and
   * catches an added permission — but it names only what must be PRESENT. The
   * contract's own header explains why that is not enough: `owner` IS the smart
   * account, so a compromised session key's calls arrive as `msg.sender ==
   * owner` and the contract's NotOwner check stops a stranger EOA and nothing
   * more. The only thing keeping `setQuoteCaps` out of a session key's reach is
   * THE WALL NOT NAMING IT. v1's header claimed such a pin existed before it
   * did; this is it, and it exists before v2 is deployed.
   *
   * BY SELECTOR, not by name, and derived rather than pasted. A rename in the
   * .sol that kept the same arguments would keep the same four bytes and slip
   * past a name check; a name check also cannot see a permission whose ABI entry
   * was edited. The selector is what the policy actually compares.
   */
  const list = buildCallPermissions(CAPS, SELF, classOpts);
  const onVault = list.filter((p) => p.target.toLowerCase() === CLASS_VAULT);

  const selectorOf = (p: (typeof onVault)[number]) => {
    const item = (p.abi as readonly { type: string; name?: string }[]).find(
      (a) => a.type === "function" && a.name === p.functionName,
    );
    assert.ok(item, `${p.functionName} must exist in the ABI the wall pins it with`);
    return toFunctionSelector(item as never);
  };
  const granted = onVault.map(selectorOf).sort();
  assert.deepEqual(
    granted,
    [
      toFunctionSelector("function buy(address,address,uint256,uint256,uint256)"),
      toFunctionSelector("function sell(address,uint256,uint256,uint256)"),
    ].sort(),
    "the vault answers exactly buy and sell to a session key",
  );

  // AND WHAT MUST STAY ABSENT, named one by one so the reason survives:
  //
  //   setQuoteCaps — rewrites the ceilings this wall exists to respect. A key
  //     that can raise its own cap has no cap. It is an OWNER action.
  //   sweep        — moves a token into the ACCOUNT, where it cannot be sold for
  //     want of the very approve this whole design avoids. Also owner-only.
  //   setSpendCap  — v1's single-ceiling setter, kept here because a wall built
  //     against a v1 ABI must not reach it either.
  for (const [name, sig] of [
    ["setQuoteCaps", "function setQuoteCaps(address[],uint256[])"],
    ["sweep", "function sweep(address)"],
    ["setSpendCap", "function setSpendCap(uint256)"],
  ] as const) {
    assert.ok(
      !granted.includes(toFunctionSelector(sig)),
      `the session key must never reach ${name} — it is an owner action`,
    );
  }
});

test("a vault with no factory is REFUSED, not silently granted", () => {
  // Two of three is a key that can reach a vault it can never create.
  assert.throws(
    () => buildCallPermissions(CAPS, SELF, { ponsClassVaultAddress: CLASS_VAULT }),
    /factory/i,
  );
});

test("deploy is pinned to THIS account, so it can create exactly one contract", () => {
  // Deployment is permissionless, so this pin is not about privilege. Left
  // unpinned, a compromised key could burn the account's gas creating vaults
  // for strangers, repeatedly, inside the ops cap. Pinned, the only contract
  // this permission can produce is the vault the wall already names as a target.
  const deploy = buildCallPermissions(CAPS, SELF, classOpts).find(
    (p) => p.functionName === "deploy",
  )!;
  assert.deepEqual(deploy.args, [{ condition: ParamCondition.EQUAL, value: SELF }]);
  assert.equal(deploy.valueLimit, 0n);
});

test("the class BUY pins its funding leg and nothing else", () => {
  // The class token is not an argument to either call — that is what makes this
  // expressible at all. `buy` names the FUNDING asset, which stays enumerated;
  // the token is derived from the curve inside the contract.
  const buy = buildCallPermissions(CAPS, SELF, classOpts).find((p) => p.functionName === "buy")!;
  const args = buy.args!;
  assert.equal(args.length, 5, "curve, quoteAsset, quoteIn, minTokensOut, deadline");
  assert.equal(args[0], null, "the curve is unpinnable — a new address per launch");
  assert.equal(
    (args[1] as { condition: number }).condition,
    ParamCondition.ONE_OF,
    "the funding leg must stay inside the sealed asset set",
  );
  for (const i of [2, 3, 4]) assert.equal(args[i], null);
  assert.equal(buy.valueLimit, 0n, "keeps native value out of the class route");
});

test("the class SELL constrains nothing, because the vault already does", () => {
  // It can only sell what it holds and can only pay its own owner, so there is
  // nothing here a policy could usefully bound. Stated by assertion rather than
  // left to be inferred from an empty-looking args list.
  const sell = buildCallPermissions(CAPS, SELF, classOpts).find((p) => p.functionName === "sell")!;
  assert.deepEqual(sell.args, [null, null, null, null]);
  assert.equal(sell.valueLimit, 0n);
});

test("the vault is an approve SPENDER; the factory is not", () => {
  // The vault must be nameable so the account's capped USDG approve can fund a
  // buy. The factory pulls nothing and must never appear — an approve spender is
  // a standing licence, and this one would be granted for no reason at all.
  const spenders = allowedSpenders(false, false, undefined, undefined, CLASS_VAULT).map((a) =>
    a.toLowerCase(),
  );
  assert.ok(spenders.includes(CLASS_VAULT));
  assert.ok(!spenders.includes(CLASS_FACTORY));
});

test("no class option means no class permission, which is every grant today", () => {
  const list = buildCallPermissions(CAPS, SELF, {});
  for (const p of list) {
    assert.notEqual(p.target.toLowerCase(), CLASS_VAULT);
    assert.notEqual(p.target.toLowerCase(), CLASS_FACTORY);
  }
});

/**
 * THE ENERGY BUY — one permission, six EQUAL pins, on a FIVE-parameter
 * function with a DYNAMIC array argument.
 *
 * Every other offset proof in this file is over static words. This one is not,
 * which is exactly why it gets the most evidence: the pins only mean what the
 * comment says if (a) the library places args[i] at offset i*32 even past the
 * ABI's arity, (b) the values it encodes byte-equal what viem's encoder puts in
 * those words, and (c) no calldata that satisfies the pins can decode to a
 * different path or recipient. (a) and (b) are proven here against the real
 * library and the real encoder; (c) by the adversarial test that follows.
 */
const ROUTE = ENERGY_ROUTE_V1;
const ENERGY_FN = "swapExactTokensForTokensSupportingFeeOnTransferTokens" as const;
const EVIL = "0x00000000000000000000000000000000000e0111" as const;
const energyPerm = (opts: Parameters<typeof buildCallPermissions>[2] = {}) => {
  const list = buildCallPermissions(CAPS, SELF, { ...opts, energyBuy: true }) as unknown as Perm[];
  const mine = list.filter((p) => p.target.toLowerCase() === ROUTE.router.toLowerCase());
  assert.equal(mine.length, 1, "exactly one permission on the energy router");
  return mine[0]!;
};
const encodeEnergy = (amountIn: bigint, minOut: bigint, path: readonly `0x${string}`[], to: `0x${string}`, deadline: bigint) =>
  encodeFunctionData({ abi: UNISWAP_V2_ENERGY_ABI, functionName: ENERGY_FN, args: [amountIn, minOut, path as `0x${string}`[], to, deadline] });
/** Word i of a calldata body, as the 32-byte hex the policy compares. */
const wordHex = (data: Hex, i: number) => `0x${data.slice(10 + i * 64, 10 + (i + 1) * 64)}`.toLowerCase();

test("ENERGY BUY opt-in: absent by default, one pinned permission when sealed, at proven offsets", () => {
  // CLOSED by default — like every opt-in here, and more than most: a signer
  // seals it only on 4663 and only when the wall still fits (energyBuyFits).
  assert.equal(find(ROUTE.router).length, 0, "no energy permission without the opt-in");
  const [usdgApprove] = find(CASH.USDG, "approve");
  assert.equal((usdgApprove!.args as { value: string[] }[])[0]!.value.length, 2, "and the USDG approve keeps its two spenders");

  const p = energyPerm();
  assert.equal(p.functionName, ENERGY_FN);
  assert.equal(p.valueLimit, 0n, "the energy buy moves no native value");
  const args = p.args as (null | { condition: number; value: unknown })[];
  assert.equal(args.length, 9, "nine words for five parameters: the array's length and elements are words 5..8");

  // The conditions, word by word: EQ on 2, 3, 5, 6, 7, 8 and nothing else.
  assert.deepEqual(
    args.map((a) => (a === null ? null : a.condition)),
    [null, null, ParamCondition.EQUAL, ParamCondition.EQUAL, null, ParamCondition.EQUAL, ParamCondition.EQUAL, ParamCondition.EQUAL, ParamCondition.EQUAL],
  );
  assert.equal(args[2]!.value, 0xa0n);
  assert.deepEqual(args[3], { condition: ParamCondition.EQUAL, value: SELF });
  assert.equal(args[5]!.value, 3n);
  assert.deepEqual([args[6]!.value, args[7]!.value, args[8]!.value], [...ROUTE.path]);
  // BIGINT, NEVER A DECIMAL STRING. The library encodes a non-hex value with
  // toHex, and toHex("160") is the UTF-8 bytes 0x313630 — a pin that can never
  // match and reads as strict. Nothing type-checks this, so it is asserted.
  assert.equal(typeof args[2]!.value, "bigint", "w2 must be a bigint");
  assert.equal(typeof args[5]!.value, "bigint", "w5 must be a bigint");
  for (const i of [6, 7, 8]) assert.match(String(args[i]!.value), /^0x[0-9a-f]{40}$/, `w${i} must be a hex address`);
  // The route is the one the marker names, and it is the registry's today.
  assert.deepEqual([...ROUTE.path], [CASH.USDG.toLowerCase(), VIRTUAL_TOKEN, MERRYMEN_TOKEN.address.toLowerCase()]);
  assert.equal(ROUTE.router, UNISWAP.v2Router02.toLowerCase());

  // (b) PROVE THE WORDS against viem's encoder.
  const DEADLINE = 1_800_000_000n;
  const data = encodeEnergy(1_000_000n, 999n, ROUTE.path, SELF, DEADLINE);
  assert.equal(data.slice(0, 10), ENERGY_SWAP_SELECTOR, "selector 0x5c11d795");
  assert.equal(data.length, 10 + 9 * 64, "exactly nine words: five head words, then the array's length and three elements");
  const words = energyCallWords(data);
  assert.ok(words, "the shared word reader must read an honest energy call");
  assert.equal(words.words.length, 9);
  for (const i of [2, 3, 5, 6, 7, 8]) {
    const v = args[i]!.value as bigint | `0x${string}`;
    const expected = typeof v === "bigint" ? pad(`0x${v.toString(16)}`, { size: 32 }) : pad(v, { size: 32 });
    assert.equal(wordHex(data, i), expected.toLowerCase(), `word ${i} must be exactly what the pin compares`);
  }
  assert.equal(words.words[0], 1_000_000n, "word 0 = amountIn");
  assert.equal(words.words[1], 999n, "word 1 = amountOutMin");
  assert.equal(words.words[4], DEADLINE, "word 4 = deadline");

  // (a) PROVE THE LIBRARY'S OFFSETS AND ENCODING of words past the ABI's
  // arity: run the permission through toCallPolicy — the function both signers
  // seal with — and read the rules it actually encodes.
  const policy = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: [p] as never });
  const [encoded] = (policy.policyParams as unknown as { permissions: { selector: Hex; rules: EnergyRule[] }[] }).permissions;
  assert.equal(encoded!.selector.toLowerCase(), ENERGY_SWAP_SELECTOR, "the library resolves the selector from the one-function ABI");
  assert.equal(encoded!.rules.length, 6, "six rules — w0, w1 and w4 are open");
  const pinned = [2, 3, 5, 6, 7, 8];
  for (const [k, rule] of encoded!.rules.entries()) {
    const i = pinned[k]!;
    assert.equal(rule.offset, i * 32, `rule ${k} must sit at word ${i}`);
    assert.equal(rule.condition, ParamCondition.EQUAL);
    assert.equal(rule.params.length, 1);
    assert.equal(rule.params[0]!.toLowerCase(), wordHex(data, i), `rule ${k}'s param must byte-equal viem's word ${i}`);
  }
});

/** A call-policy rule as @zerodev/permissions encodes it for V0_0_4. */
type EnergyRule = { condition: number; offset: number; params: Hex[] };

/**
 * A MODEL OF CallPolicy V0_0_4's check, faithful to the contract rather than to
 * our intent: the permission is keyed by selector, each rule reads
 * `bytes32(data[4 + offset : 4 + offset + 32])` and compares it as a whole
 * word, and an out-of-range slice REVERTS — which for the account is a refusal.
 */
function callPolicyAdmits(rules: readonly EnergyRule[], selector: string, data: Hex): boolean {
  if (data.slice(0, 10).toLowerCase() !== selector.toLowerCase()) return false;
  const bytes = (data.length - 2) / 2;
  for (const r of rules) {
    const start = 4 + r.offset;
    if (start + 32 > bytes) return false; // calldata slice out of range: the policy reverts
    const w = BigInt(`0x${data.slice(2 + start * 2, 2 + (start + 32) * 2)}`);
    const p = r.params.map((x) => BigInt(x));
    switch (r.condition) {
      case ParamCondition.EQUAL: if (w !== p[0]) return false; break;
      case ParamCondition.GREATER_THAN: if (!(w > p[0]!)) return false; break;
      case ParamCondition.LESS_THAN: if (!(w < p[0]!)) return false; break;
      case ParamCondition.GREATER_THAN_OR_EQUAL: if (!(w >= p[0]!)) return false; break;
      case ParamCondition.LESS_THAN_OR_EQUAL: if (!(w <= p[0]!)) return false; break;
      case ParamCondition.NOT_EQUAL: if (w === p[0]) return false; break;
      case ParamCondition.ONE_OF: if (!p.includes(w)) return false; break;
      default: return false; // not modelled: refuse rather than guess
    }
  }
  return true;
}

/** What Router02 would actually execute, per viem's decoder (null = it would revert decoding). */
function decodedEnergy(data: Hex): { path: string[]; to: string } | null {
  try {
    const d = decodeFunctionData({ abi: UNISWAP_V2_ENERGY_ABI, data });
    const [, , path, to] = d.args as unknown as [bigint, bigint, string[], string, bigint];
    return { path: path.map((a) => a.toLowerCase()), to: to.toLowerCase() };
  } catch {
    return null;
  }
}

const hexWord = (v: bigint) => v.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
const withWords = (data: Hex, edits: Record<number, string>, append: string[] = []) => {
  const body = data.slice(10).match(/.{64}/g)!;
  for (const [i, w] of Object.entries(edits)) body[Number(i)] = w;
  return `${data.slice(0, 10)}${body.join("")}${append.join("")}` as Hex;
};

test("ENERGY BUY adversarial: every counterexample is refused, and every pin is load-bearing", () => {
  const p = energyPerm();
  const policy = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: [p] as never });
  const [encoded] = (policy.policyParams as unknown as { permissions: { selector: Hex; rules: EnergyRule[] }[] }).permissions;
  const rules = encoded!.rules;
  const sel = encoded!.selector;
  const admits = (data: Hex) => callPolicyAdmits(rules, sel, data);
  /** The same policy with ONE pin removed — to prove that pin is what refuses. */
  const admitsWithout = (word: number, data: Hex) => callPolicyAdmits(rules.filter((r) => r.offset !== word * 32), sel, data);
  const PATH = [...ROUTE.path];
  const canonical = encodeEnergy(1_000_000n, 999n, ROUTE.path, SELF, 1_800_000_000n);
  assert.ok(admits(canonical), "the honest call is admitted");
  assert.deepEqual(decodedEnergy(canonical), { path: PATH, to: SELF });

  // w2 — THE ARRAY RELOCATED. The head points at 0x120; words 5..8 still hold
  // the pinned decoy, and the array the router actually reads sits after them
  // and ends in a token nobody named.
  const relocated = withWords(canonical, { 2: hexWord(0x120n) }, [hexWord(3n), addrWord(CASH.USDG), addrWord(VIRTUAL_TOKEN), addrWord(EVIL)]);
  assert.equal(admits(relocated), false, "w2 = 0x120 must be refused");
  assert.equal(admitsWithout(2, relocated), true, "premise: without the w2 pin this passes every other pin");
  assert.equal(decodedEnergy(relocated)!.path[2], EVIL, "…and the router would buy the attacker's token");

  // w5 — LENGTH 2 buys VIRTUAL. A trailing word keeps the w8 slice in range,
  // so the refusal is the length pin, not the calldata being short.
  const two = `${encodeEnergy(1_000_000n, 0n, [ROUTE.path[0], ROUTE.path[1]], SELF, 1_800_000_000n)}${addrWord(ROUTE.path[2])}` as Hex;
  assert.equal(admits(two), false, "path length 2 must be refused");
  assert.equal(admitsWithout(5, two), true, "premise: the length pin is what refuses it");
  assert.deepEqual(decodedEnergy(two)!.path, [ROUTE.path[0], ROUTE.path[1]], "…it would buy VIRTUAL");

  // w5 — LENGTH 4 appends an unpinned hop into a pair the attacker seeded.
  const four = encodeEnergy(1_000_000n, 0n, [...ROUTE.path, EVIL], SELF, 1_800_000_000n);
  assert.equal(admits(four), false, "path length 4 must be refused");
  assert.equal(admitsWithout(5, four), true, "premise: the length pin is what refuses it");
  assert.equal(decodedEnergy(four)!.path[3], EVIL);

  // w3 — THE RECIPIENT.
  const elsewhere = encodeEnergy(1_000_000n, 0n, ROUTE.path, EVIL, 1_800_000_000n);
  assert.equal(admits(elsewhere), false, "to = EVIL must be refused");
  assert.equal(admitsWithout(3, elsewhere), true, "premise: the recipient pin is what refuses it");

  // w3 — DIRTY HIGH BITS. A masking decoder reads the low 20 bytes and sees
  // SELF; EQUAL compares the whole word and does not.
  const dirty = withWords(canonical, { 3: `ff${addrWord(SELF).slice(2)}` });
  assert.equal(admits(dirty), false, "a dirty high byte in `to` must be refused");
  assert.equal(admitsWithout(3, dirty), true, "premise: only the full-word pin catches it");

  // w7 — THE MIDDLE HOP, which pins the intermediate pair.
  const middle = encodeEnergy(1_000_000n, 0n, [ROUTE.path[0], EVIL, ROUTE.path[2]], SELF, 1_800_000_000n);
  assert.equal(admits(middle), false, "a swapped path[1] must be refused");
  assert.equal(admitsWithout(7, middle), true, "premise: the middle-hop pin is what refuses it");

  // w6 and w8 — either end of the route.
  for (const [w, path] of [
    [6, [EVIL, ROUTE.path[1], ROUTE.path[2]]],
    [8, [ROUTE.path[0], ROUTE.path[1], EVIL]],
  ] as const) {
    const swapped = encodeEnergy(1_000_000n, 0n, path, SELF, 1_800_000_000n);
    assert.equal(admits(swapped), false, `a swapped word ${w} must be refused`);
    assert.equal(admitsWithout(w, swapped), true, `premise: the w${w} pin is what refuses it`);
  }

  // TRUNCATED: 291 bytes cannot hold word 8, and the slice reverts.
  assert.equal((canonical.length - 2) / 2, 292, "the honest call is 4 + 9 × 32 bytes");
  assert.equal(admits(canonical.slice(0, -2) as Hex), false, "291 bytes must be refused");

  // ACCEPTED: arbitrary amountIn, amountOutMin and deadline, and trailing
  // bytes the router never reads — all still the fixed path, to SELF.
  const open = withWords(canonical, { 0: "f".repeat(64), 1: "0".repeat(64), 4: hexWord(1n) }, ["ab".repeat(32), "cd".repeat(7)]);
  assert.equal(admits(open), true, "open words and trailing data are admitted");
  assert.deepEqual(decodedEnergy(open), { path: PATH, to: SELF }, "…and still decode to the one route, into this account");

  // AND A FUZZ, seeded so a failure reproduces: from the honest call, randomise
  // the open words, sometimes corrupt a pinned word with a random or small value
  // (small numbers are what offsets and lengths look like), sometimes append a
  // tail, sometimes truncate. Everything the policy admits must decode to the
  // fixed path and to SELF; nothing may decode to anything else.
  let seed = 0x5c11d795;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randWord = () => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  let admitted = 0;
  let refused = 0;
  let decoded = 0;
  for (let n = 0; n < 4_000; n++) {
    const edits: Record<number, string> = { 0: randWord(), 1: randWord(), 4: randWord() };
    for (const i of [2, 3, 5, 6, 7, 8]) {
      const r = rand();
      if (r < 0.05) edits[i] = randWord();
      else if (r < 0.1) edits[i] = hexWord(BigInt(Math.floor(rand() * 0x200)));
    }
    const tail = Array.from({ length: Math.floor(rand() * 5) }, () =>
      rand() < 0.3 ? hexWord(BigInt(Math.floor(rand() * 0x200))) : randWord(),
    );
    let data = withWords(canonical, edits, tail);
    if (rand() < 0.05) data = data.slice(0, data.length - 2 * (1 + Math.floor(rand() * 40))) as Hex;
    if (!admits(data)) {
      refused++;
      continue;
    }
    admitted++;
    const d = decodedEnergy(data);
    if (d === null) continue; // the router's own decoder would revert: nothing moves
    decoded++;
    assert.deepEqual(d, { path: PATH, to: SELF }, `admitted calldata decoded to something else: ${data}`);
  }
  assert.ok(admitted > 1_000, `the fuzz must exercise admitted calls (${admitted})`);
  assert.ok(decoded > 1_000, `and admitted calls must actually decode, or the check above is vacuous (${decoded})`);
  assert.ok(refused > 100, `and refused ones (${refused})`);
});

test("$MERRYMEN is never an owner extra — no approve, no swap leg, no curve leg, on any venue", () => {
  // The energy reserve's safety case is that NOTHING in the wall can spend it.
  // As an ordinary extra it would get an uncapped approve to every spender and
  // a place in curveAssets, where the Pons adapter's unpinnable curve and open
  // minAmountOut could take the whole balance for one wei.
  const lower = { symbol: "MERRYMEN", address: MERRYMEN_TOKEN.address.toLowerCase() as `0x${string}`, decimals: 18 };
  const upper = { ...lower, address: `0x${MERRYMEN_TOKEN.address.slice(2).toUpperCase()}` as `0x${string}` };
  const OK = { symbol: "OK", address: "0x1111111111111111111111111111111111111111" as const, decimals: 18 };
  const usable = usableExtraTokens([lower, upper, OK]);
  assert.deepEqual(usable.map((t) => t.symbol), ["OK"], "$MERRYMEN is dropped in any case; the owner's other token survives");

  const MERRY = MERRYMEN_TOKEN.address.toLowerCase();
  const list = buildCallPermissions(CAPS, SELF, {
    extraTokens: [lower, upper, OK],
    v4AdapterAddress: "0x00000000000000000000000000000000000000d4",
    ponsAdapterAddress: "0x00000000000000000000000000000000000000d5",
    ...classOpts,
    energyBuy: true,
  }) as unknown as Perm[];
  assert.ok(
    !list.some((p) => p.target.toLowerCase() === MERRY),
    "no permission of any kind targets $MERRYMEN — above all, no approve",
  );
  // Every ONE_OF in the wall — swap legs, adapter legs, curve legs, the class
  // funding leg — must leave it out. Only the energy route's own EQUAL pin names it.
  for (const p of list) {
    for (const [i, a] of ((p.args ?? []) as (null | { condition: number; value: unknown })[]).entries()) {
      if (a?.condition !== ParamCondition.ONE_OF) continue;
      assert.ok(
        !(a.value as string[]).map((x) => x.toLowerCase()).includes(MERRY),
        `${p.target}.${p.functionName} arg ${i} must not admit $MERRYMEN`,
      );
    }
  }
  const named = list.filter((p) =>
    ((p.args ?? []) as (null | { condition: number; value: unknown })[]).some(
      (a) => a?.condition === ParamCondition.EQUAL && String(a.value).toLowerCase() === MERRY,
    ),
  );
  assert.deepEqual(named.map((p) => p.functionName), [ENERGY_FN], "only the energy route names $MERRYMEN, as its output");
});

/**
 * PERPETUALS ON LIGHTER — docs/perps.md rule 3: the wall grows by exactly four
 * sealed things, on 4663 only, and only by re-signing.
 *
 * The same three kinds of evidence as the energy buy, for the same reason:
 * (a) the library places args[i] at offset i*32 past the ABI's arity, (b) each
 * pin byte-equals the word viem's encoder writes there, and (c) no calldata
 * that satisfies the pins can decode to a different key, index, account or
 * asset. changePubKey gets the most, because its `bytes` argument is dynamic
 * and its offset word is the one an attacker would move.
 */
const PROXY = LIGHTER_ROUTE_V1.proxy.toLowerCase();
const PERP = { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_PK } as const;
const perpPerms = (opts: Parameters<typeof buildCallPermissions>[2] = {}) =>
  buildCallPermissions(CAPS, SELF, { ...opts, perpLighter: PERP }) as unknown as Perm[];
const onProxy = (list: Perm[], fn: string) => {
  const mine = list.filter((p) => p.target.toLowerCase() === PROXY && p.functionName === fn);
  assert.equal(mine.length, 1, `exactly one ${fn} permission on the proxy`);
  return mine[0]!;
};
/** The rules @zerodev/permissions actually encodes for one permission — what the signature is made over. */
const encodedRules = (p: Perm) => {
  const policy = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: [p] as never });
  const [encoded] = (policy.policyParams as unknown as { permissions: { selector: Hex; rules: EnergyRule[] }[] }).permissions;
  return encoded!;
};
const spendersOfApprove = (list: Perm[], target: string) => {
  const p = list.find((x) => x.target.toLowerCase() === target.toLowerCase() && x.functionName === "approve");
  assert.ok(p, `${target} must have an approve`);
  return ((p.args as { value: string[] }[])[0]!.value).map((a) => a.toLowerCase());
};

test("PERPS opt-in: absent by default; three proxy permissions and ONE spender entry when sealed; no native value", () => {
  // CLOSED by default, and the bare wall is byte-for-byte the one every grant
  // already carries (wall-release.test.ts pins its fingerprint unchanged).
  assert.equal(find(LIGHTER_ROUTE_V1.proxy).length, 0, "no proxy permission without the opt-in");
  for (const p of perms()) {
    for (const a of (p.args ?? []) as (null | { value?: unknown })[]) {
      const v = a?.value;
      const values = Array.isArray(v) ? v : [v];
      assert.ok(!values.map((x) => String(x).toLowerCase()).includes(PROXY), `${p.target}.${p.functionName} must not name the proxy`);
    }
  }

  const CUSTOM = { symbol: "MEME", address: "0x00000000000000000000000000000000000000dd" as const, decimals: 18 };
  const plain = buildCallPermissions(CAPS, SELF, { extraTokens: [CUSTOM] }) as unknown as Perm[];
  const withPerps = perpPerms({ extraTokens: [CUSTOM] });
  assert.equal(withPerps.length, plain.length + 3, "perps are exactly THREE permissions: deposit, changePubKey, claim");
  assert.deepEqual(
    withPerps.filter((p) => p.target.toLowerCase() === PROXY).map((p) => p.functionName),
    ["deposit", "changePubKey", "withdrawPendingBalance"],
  );
  for (const p of withPerps) assert.equal(p.valueLimit, 0n, `${p.target}.${p.functionName} must not be allowed to move native ETH`);

  // NOT on-chain withdraw, createOrder or cancelAllOrders — the owner's escape
  // hatches. A session key with cancelAllOrders could strip the venue stops.
  for (const fn of ["withdraw", "createOrder", "cancelAllOrders"]) {
    assert.ok(!withPerps.some((p) => p.target.toLowerCase() === PROXY && p.functionName === fn), `${fn} must never be granted`);
  }

  // THE PROXY IS A SPENDER IN THE USDG APPROVE'S ONE_OF AND NOWHERE ELSE. The
  // stock and extra approves carry no amount condition; the proxy joining
  // their ONE_OF would be an uncapped allowance over the whole book, held by a
  // contract whose upgrades skip their notice period.
  assert.deepEqual(
    spendersOfApprove(withPerps, CASH.USDG),
    [...spendersOfApprove(plain, CASH.USDG), PROXY],
    "the USDG approve grows by exactly the proxy",
  );
  const approvesOf = (l: Perm[]) => l.filter((p) => p.functionName === "approve").map((p) => p.target.toLowerCase());
  assert.deepEqual(approvesOf(withPerps), approvesOf(plain), "no new approve permission — only a wider USDG spender list");
  for (const target of approvesOf(withPerps).filter((t) => t !== CASH.USDG.toLowerCase())) {
    assert.deepEqual(spendersOfApprove(withPerps, target), spendersOfApprove(plain, target), `${target}'s approve must not change`);
    assert.ok(!spendersOfApprove(withPerps, target).includes(PROXY), `${target} must never name the proxy`);
  }
  // …and the USDG approve's amount cap is unchanged: the proxy pulls under the
  // same per-trade ceiling as every other spender.
  const usdgApprove = withPerps.find((p) => p.target.toLowerCase() === CASH.USDG.toLowerCase() && p.functionName === "approve")!;
  assert.deepEqual((usdgApprove.args as unknown[])[1], { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdg(CAPS.perTradeUsdg) });

  // With the energy buy too: both spender entries, the router first, and still
  // exactly one USDG approve.
  const both = perpPerms({ energyBuy: true });
  assert.deepEqual(
    spendersOfApprove(both, CASH.USDG),
    [...spendersOfApprove(perms(), CASH.USDG), ENERGY_ROUTE_V1.router.toLowerCase(), PROXY],
  );
  assert.equal(both.filter((p) => p.functionName === "approve" && p.target.toLowerCase() === CASH.USDG.toLowerCase()).length, 1);
});

test("PERPS deposit: all four words pinned — this account, USDG, perps, ≤ one trade — at proven offsets", () => {
  const p = onProxy(perpPerms(), "deposit");
  const args = p.args as ({ condition: number; value: unknown } | null)[];
  assert.equal(args.length, 4);
  assert.deepEqual(args[0], { condition: ParamCondition.EQUAL, value: SELF }, "w0 _to is this account");
  assert.deepEqual(args[1], { condition: ParamCondition.EQUAL, value: 3n }, "w1 asset 3 — USDG");
  assert.deepEqual(args[2], { condition: ParamCondition.EQUAL, value: 0n }, "w2 route 0 — perps, never spot");
  assert.deepEqual(args[3], { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdg(CAPS.perTradeUsdg) }, "w3 ≤ perTradeUsdg");
  for (const i of [1, 2, 3]) assert.equal(typeof args[i]!.value, "bigint", `w${i} must be a bigint, never a decimal string`);

  // (b) against viem's encoder — the calldata the worker will build.
  const AMOUNT = 12_345_678n;
  const data = encodeFunctionData({ abi: LIGHTER_DEPOSIT_ABI, functionName: "deposit", args: [SELF, 3, 0, AMOUNT] });
  assert.equal(data.slice(0, 10), "0x8a857083", "the deployed deposit selector");
  assert.equal((data.length - 10) / 64, 4, "four static words");
  // (a) the library's rules: offsets 0..96, params byte-equal to viem's words
  // (the LTE bound compared to the cap, not to this amount).
  const enc = encodedRules(p);
  assert.equal(enc.selector.toLowerCase(), "0x8a857083");
  assert.deepEqual(enc.rules.map((r) => r.offset), [0, 32, 64, 96]);
  for (const i of [0, 1, 2]) assert.equal(enc.rules[i]!.params[0]!.toLowerCase(), wordHex(data, i), `rule ${i} must byte-equal viem's word ${i}`);
  assert.equal(BigInt(enc.rules[3]!.params[0]!), usdg(CAPS.perTradeUsdg));
  assert.equal(BigInt(wordHex(data, 3)), AMOUNT, "word 3 is the amount");

  // (c) the model refuses each pinned word moved, and admits the honest call.
  const admits = (d: Hex) => callPolicyAdmits(enc.rules, enc.selector, d);
  const deposit = (to: `0x${string}`, asset: number, route: number, amount: bigint) =>
    encodeFunctionData({ abi: LIGHTER_DEPOSIT_ABI, functionName: "deposit", args: [to, asset, route, amount] });
  assert.ok(admits(data), "the honest deposit is admitted");
  assert.equal(admits(deposit(EVIL, 3, 0, AMOUNT)), false, "crediting someone else's venue account is refused");
  assert.equal(admits(deposit(SELF, 2, 0, AMOUNT)), false, "another asset is refused");
  assert.equal(admits(deposit(SELF, 3, 1, AMOUNT)), false, "the spot route is refused");
  assert.equal(admits(deposit(SELF, 3, 0, usdg(CAPS.perTradeUsdg) + 1n)), false, "one base unit over the cap is refused");
  assert.ok(admits(deposit(SELF, 3, 0, usdg(CAPS.perTradeUsdg))), "exactly the cap is admitted");
  assert.equal(admits(withWords(data, { 0: `ff${addrWord(SELF).slice(2)}` })), false, "a dirty high byte in `_to` is refused — EQUAL is the whole word");
});

/** What the proxy would register, per viem's decoder (null = it would revert decoding). */
function decodedPubKey(data: Hex): { keyIndex: number; pubKey: string } | null {
  try {
    const d = decodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, data });
    const [, keyIndex, pubKey] = d.args as unknown as [number, number, string];
    return { keyIndex: Number(keyIndex), pubKey: pubKey.toLowerCase() };
  } catch {
    return null;
  }
}

test("PERPS changePubKey: ONE key at ONE index — six args for three parameters, at proven offsets", () => {
  const p = onProxy(perpPerms(), "changePubKey");
  const args = p.args as ({ condition: number; value: unknown } | null)[];
  assert.equal(args.length, 6, "six words: account, index, offset, length and the key's two words");
  assert.equal(args[0], null, "w0 the account index is OPEN — it does not exist until the first deposit lands");
  const [w4, w5] = pubKeyWords(PERP_PK);
  assert.deepEqual(args.slice(1), [
    { condition: ParamCondition.EQUAL, value: 16n },
    { condition: ParamCondition.EQUAL, value: 0x60n },
    { condition: ParamCondition.EQUAL, value: 40n },
    { condition: ParamCondition.EQUAL, value: w4 },
    { condition: ParamCondition.EQUAL, value: w5 },
  ]);
  // FULL 32-BYTE WORDS. The library LEFT-pads anything shorter, so an 8-byte
  // tail here would pin 0x00…<tail> — a word the encoder never writes.
  for (const v of [w4, w5]) assert.match(v, /^0x[0-9a-f]{64}$/);
  assert.ok(w5.endsWith("0".repeat(48)), "w5 is RIGHT-padded, as ABI bytes are");

  for (const pk of [PERP_PK, PERP_PK_OTHER]) {
    const perm = onProxy(buildCallPermissions(CAPS, SELF, { perpLighter: { apiKeyIndex: 16, apiPublicKey: pk } }) as unknown as Perm[], "changePubKey");
    const data = encodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, functionName: "changePubKey", args: [22149, 16, pk] });
    assert.equal(data.slice(0, 10), "0x17010c68", "the deployed changePubKey selector");
    assert.equal((data.length - 2) / 2, 196, "4 + 6 × 32 bytes");
    const enc = encodedRules(perm);
    assert.equal(enc.selector.toLowerCase(), "0x17010c68");
    assert.equal(enc.rules.length, 5, "five rules — w0 is open");
    assert.deepEqual(enc.rules.map((r) => r.offset), [32, 64, 96, 128, 160]);
    for (const [k, rule] of enc.rules.entries()) {
      assert.equal(rule.condition, ParamCondition.EQUAL);
      assert.equal(rule.params[0]!.toLowerCase(), wordHex(data, k + 1), `rule ${k} must byte-equal viem's word ${k + 1}`);
    }
    assert.ok(callPolicyAdmits(enc.rules, enc.selector, data), "the honest registration is admitted");
    assert.deepEqual(decodedPubKey(data), { keyIndex: 16, pubKey: pk });
  }
});

test("PERPS changePubKey adversarial: every counterexample is refused, and every pin is load-bearing", () => {
  const enc = encodedRules(onProxy(perpPerms(), "changePubKey"));
  const admits = (d: Hex) => callPolicyAdmits(enc.rules, enc.selector, d);
  const admitsWithout = (word: number, d: Hex) => callPolicyAdmits(enc.rules.filter((r) => r.offset !== word * 32), enc.selector, d);
  const cpk = (acct: number, idx: number, pk: `0x${string}`) =>
    encodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, functionName: "changePubKey", args: [acct, idx, pk] });
  const honest = cpk(22149, 16, PERP_PK);
  const SEALED = { keyIndex: 16, pubKey: PERP_PK };
  assert.ok(admits(honest));

  // ANOTHER KEY — refused at w4 (and w5); the key pins are what refuse it.
  const other = cpk(22149, 16, PERP_PK_OTHER);
  assert.equal(admits(other), false, "registering any other key must be refused");
  assert.equal(callPolicyAdmits(enc.rules.filter((r) => r.offset < 128), enc.selector, other), true, "premise: only the key pins refuse it");

  // ANOTHER INDEX — the owner's own Robinhood Wallet session lives at 0..3.
  const idx0 = cpk(22149, 0, PERP_PK);
  assert.equal(admits(idx0), false, "the sealed key at another index must be refused");
  assert.equal(admitsWithout(1, idx0), true, "premise: the index pin is what refuses it");

  // W2 RELOCATED — THE LOAD-BEARING OFFSET PIN. The head says the key lives at
  // 0xc0; w3..w5 still hold the sealed decoy, and the bytes the proxy would
  // actually register sit after them. Measured on 4663 under eth_call: the
  // deployed decoder follows w2, and only this pin refuses the call.
  const [ow4, ow5] = pubKeyWords(PERP_PK_OTHER);
  const relocated = withWords(honest, { 2: hexWord(0xc0n) }, [hexWord(40n), ow4.slice(2), ow5.slice(2)]);
  assert.equal(admits(relocated), false, "w2 = 0xc0 must be refused");
  assert.equal(admitsWithout(2, relocated), true, "premise: without the w2 pin this passes every other pin");
  assert.deepEqual(decodedPubKey(relocated), { keyIndex: 16, pubKey: PERP_PK_OTHER }, "…and the proxy would register the attacker's key");
  // And w2 = 0x80, the relocation the spike measured: refused at word 2.
  assert.equal(admits(withWords(honest, { 2: hexWord(0x80n) })), false, "w2 = 0x80 must be refused");

  // W3 — A SHORTER LENGTH registers a prefix nobody sealed.
  const short = withWords(honest, { 3: hexWord(32n) });
  assert.equal(admits(short), false, "length 32 must be refused");
  assert.equal(admitsWithout(3, short), true, "premise: the length pin is what refuses it");

  // DIRTY W5 PADDING — EQUAL compares the whole word, so bytes after the key's
  // tail are refused even though the decoder would ignore them.
  const dirty = withWords(honest, { 5: `${w5Of(PERP_PK).slice(2, 18)}${"ab".repeat(24)}` });
  assert.equal(admits(dirty), false, "dirty padding in w5 must be refused");
  assert.equal(admitsWithout(5, dirty), true, "premise: only the full-word w5 pin catches it");

  // TRUNCATED: 195 bytes cannot hold word 5, and the slice reverts.
  assert.equal(admits(honest.slice(0, -2) as Hex), false, "195 bytes must be refused");

  // ACCEPTED: any account index (w0 is open by necessity) and trailing bytes
  // the decoder never reads — and every one still registers the SEALED key.
  for (const acct of [1, 22149, 281_474_976_710_655]) {
    const d = cpk(acct, 16, PERP_PK);
    assert.ok(admits(d), `account index ${acct} is admitted`);
    assert.deepEqual(decodedPubKey(d), SEALED);
  }
  const trailing = withWords(honest, {}, ["cd".repeat(32), hexWord(40n), ow4.slice(2), ow5.slice(2)]);
  assert.equal(admits(trailing), true, "trailing junk is admitted — no pin reads past w5");
  assert.deepEqual(decodedPubKey(trailing), SEALED, "…and it still decodes to the sealed key, never the trailing one");

  // THE LEFT-PADDED TAIL NEVER MATCHES. Had the wall passed w5 as the bare 8
  // bytes pk[32:40], the library would left-pad it into a word no honest
  // encoding contains: a permission that reads as strict and registers nothing.
  const tail = `0x${PERP_PK.slice(2 + 64)}` as `0x${string}`;
  assert.equal(tail.length, 18, "8 bytes");
  const honestPerm = onProxy(perpPerms(), "changePubKey");
  const leftPadded = {
    ...honestPerm,
    args: [...(honestPerm.args as unknown[]).slice(0, 5), { condition: ParamCondition.EQUAL, value: tail }],
  } as unknown as Perm;
  const bad = encodedRules(leftPadded);
  assert.equal(bad.rules[4]!.params[0]!.toLowerCase(), pad(tail, { size: 32 }).toLowerCase(), "the library left-pads");
  for (const pk of [PERP_PK, PERP_PK_OTHER]) {
    for (const acct of [1, 22149]) {
      assert.equal(callPolicyAdmits(bad.rules, bad.selector, cpk(acct, 16, pk)), false, "a left-padded tail matches no honest call");
    }
  }

  // AND A FUZZ, seeded: randomise the open word, sometimes corrupt a pinned one
  // (small numbers are what offsets and lengths look like), sometimes append a
  // tail, sometimes truncate. Everything admitted that decodes must register
  // the sealed key at the sealed index; nothing may decode to anything else.
  let seed = 0x17010c68;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randWord = () => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  let admitted = 0;
  let refused = 0;
  let decoded = 0;
  for (let n = 0; n < 4_000; n++) {
    // w0 mostly a plausible uint48, sometimes a whole random word (which the
    // proxy's decoder rejects — measured — and viem may or may not).
    const edits: Record<number, string> = { 0: rand() < 0.7 ? hexWord(BigInt(Math.floor(rand() * 2 ** 40))) : randWord() };
    for (const i of [1, 2, 3, 4, 5]) {
      const r = rand();
      if (r < 0.05) edits[i] = randWord();
      else if (r < 0.1) edits[i] = hexWord(BigInt(Math.floor(rand() * 0x200)));
    }
    const tail = Array.from({ length: Math.floor(rand() * 5) }, () =>
      rand() < 0.3 ? hexWord(BigInt(Math.floor(rand() * 0x200))) : randWord(),
    );
    let data = withWords(honest, edits, tail);
    if (rand() < 0.05) data = data.slice(0, data.length - 2 * (1 + Math.floor(rand() * 40))) as Hex;
    if (!admits(data)) {
      refused++;
      continue;
    }
    admitted++;
    const d = decodedPubKey(data);
    if (d === null) continue;
    decoded++;
    assert.deepEqual(d, SEALED, `admitted calldata registered something else: ${data}`);
  }
  assert.ok(admitted > 1_000, `the fuzz must exercise admitted calls (${admitted})`);
  assert.ok(decoded > 1_000, `and admitted calls must actually decode, or the check above is vacuous (${decoded})`);
  assert.ok(refused > 100, `and refused ones (${refused})`);
});

/** The honest w5 of a key: its last 8 bytes, right-padded. */
function w5Of(pk: `0x${string}`): `0x${string}` {
  return pubKeyWords(pk)[1];
}

test("PERPS withdrawPendingBalance: pays THIS account, asset 3, any amount — at proven offsets", () => {
  const p = onProxy(perpPerms(), "withdrawPendingBalance");
  const args = p.args as ({ condition: number; value: unknown } | null)[];
  assert.deepEqual(args, [
    { condition: ParamCondition.EQUAL, value: SELF },
    { condition: ParamCondition.EQUAL, value: 3n },
    null,
  ]);
  const data = encodeFunctionData({ abi: LIGHTER_WITHDRAW_PENDING_ABI, functionName: "withdrawPendingBalance", args: [SELF, 3, 8_085_000_000n] });
  assert.equal(data.slice(0, 10), "0x2f25807e", "the deployed claim selector");
  const enc = encodedRules(p);
  assert.deepEqual(enc.rules.map((r) => r.offset), [0, 32], "two rules — the amount is open");
  for (const [i, r] of enc.rules.entries()) assert.equal(r.params[0]!.toLowerCase(), wordHex(data, i));
  const admits = (d: Hex) => callPolicyAdmits(enc.rules, enc.selector, d);
  assert.ok(admits(data));
  const claim = (owner: `0x${string}`, asset: number) =>
    encodeFunctionData({ abi: LIGHTER_WITHDRAW_PENDING_ABI, functionName: "withdrawPendingBalance", args: [owner, asset, 1n] });
  assert.equal(admits(claim(EVIL, 3)), false, "a claim paying anyone else is refused");
  assert.equal(admits(claim(SELF, 0)), false, "another asset is refused");
});

test("PERPS off 4663 carry no perp permission: perpFits says no, and a rebuild seals none", () => {
  // The chain is not an input to buildCallPermissions, exactly as for the
  // energy buy — so the two doors that can set `perpLighter` are what gate it.
  const grant = (chainId: number) => ({
    chainId,
    grantFeatures: ["tradeable-v2", GRANT_PERP_LIGHTER],
    perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: 16, apiPublicKey: PERP_PK, apiKeySealed: "sealed" },
  });
  for (const chainId of [46630, 1, 8453]) {
    assert.equal(perpFits(CAPS, SELF, chainId, true, {}), false, `perpFits on ${chainId}`);
    assert.equal(perpFits(CAPS, SELF, chainId, false, { perpLighter: PERP }), false, `perpFits on ${chainId}, key in hand`);
    const opts = grantWallOptions(grant(chainId));
    assert.equal(opts.perpLighter, undefined, `a ${chainId} grant carrying the marker rebuilds no perps`);
    const wall = buildCallPermissions(CAPS, SELF, opts) as unknown as Perm[];
    assert.ok(!wall.some((p) => p.target.toLowerCase() === PROXY), `no proxy permission on ${chainId}`);
    assert.ok(!spendersOfApprove(wall, CASH.USDG).includes(PROXY), `no proxy spender on ${chainId}`);
  }
  // On 4663 the same grant rebuilds exactly the wall a signer seals, and the
  // sealed private-key blob never reaches the options.
  const opts = grantWallOptions(grant(4663));
  assert.deepEqual(opts.perpLighter, PERP);
  assert.ok(!JSON.stringify(opts).includes("sealed"), "apiKeySealed never enters the wall's inputs");
  assert.deepEqual(
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: buildCallPermissions(CAPS, SELF, opts) as never }).getPolicyData(),
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: buildCallPermissions(CAPS, SELF, { ...opts, perpLighter: PERP }) as never }).getPolicyData(),
  );
  assert.ok(perpFits(CAPS, SELF, 4663, true, {}), "the default wall has room for perps on mainnet");
});

test("PERPS refuse a key the contract would reject, or an index the route does not name — without echoing the key", () => {
  const build = (perpLighter: unknown) => () => buildCallPermissions(CAPS, SELF, { perpLighter } as never);
  const LIMBS_OVER_P = `0x${"f".repeat(80)}`; // every limb 2^64 − 1 ≥ p: not a field element
  for (const bad of [
    `0x${"0".repeat(80)}`, // all zero
    LIMBS_OVER_P,
    PERP_PK.slice(0, -2), // 39 bytes
    `${PERP_PK}00`, // 41 bytes
    "not hex",
    42,
  ]) {
    assert.throws(build({ apiKeyIndex: 16, apiPublicKey: bad }), (e: Error) => {
      assert.match(e.message, /not a canonical Lighter API public key/);
      if (typeof bad === "string" && bad.length >= 20) {
        assert.ok(!e.message.includes(bad.slice(2, 20)), "the refusal must not echo what it was given");
      }
      return true;
    });
  }
  for (const idx of [0, 3, 157, 255, 17, -1, 16.5]) {
    assert.throws(build({ apiKeyIndex: idx, apiPublicKey: PERP_PK }), /route's key index 16/, `index ${idx}`);
  }
  // Absent and null are both the closed default.
  assert.equal(buildCallPermissions(CAPS, SELF, { perpLighter: undefined }).length, perms().length);
  assert.equal(buildCallPermissions(CAPS, SELF, { perpLighter: null } as never).length, perms().length);
  // Any case of a canonical key seals the same lowercase words.
  const upper = `0x${PERP_PK.slice(2).toUpperCase()}` as `0x${string}`;
  assert.deepEqual(
    onProxy(buildCallPermissions(CAPS, SELF, { perpLighter: { apiKeyIndex: 16, apiPublicKey: upper } }) as unknown as Perm[], "changePubKey").args,
    onProxy(perpPerms(), "changePubKey").args,
  );
});
