import assert from "node:assert/strict";
import { PolicyFlags } from "@zerodev/permissions";
import { ParamCondition } from "@zerodev/permissions/policies";
import { encodeFunctionData, pad } from "viem";
import test from "node:test";
import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  UNISWAP,
  UNISWAP_SWAP_ROUTER_ABI,
  PONS_SELFTRADE_ABI, V4SELFSWAP_ABI,
  allowedSpenders,
  buildCallPermissions,
  buildWallPolicies,
  grantHasMultihop,
  grantHasNativeSwap,
  GRANT_NATIVE_SWAP,
  NATIVE_SWAP_VALUE_LIMIT_WEI,
  WALL_POLICY_FLAG,
  usableExtraTokens,
  type GrantCaps,
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
  // Nothing may authorise sending native value — EXCEPT the router rule, the
  // wall's one deliberate exception. Auto-convert is a native-input swap, and
  // a native-input swap without msg.value does not exist. The ceiling is the
  // sealed NATIVE_SWAP_VALUE_LIMIT_WEI, not an open gate.
  for (const p of list) {
    if (p.target.toLowerCase() === UNISWAP.swapRouter02.toLowerCase()) {
      assert.equal(p.valueLimit, NATIVE_SWAP_VALUE_LIMIT_WEI, "the router rule carries exactly the sealed native-value ceiling");
    } else {
      assert.equal(p.valueLimit, 0n, `${p.target} must not be allowed to move native ETH`);
    }
  }
  // ...and the router rule's tokenIn admits WETH (how a native-input swap is
  // recognized) while tokenOut stays the plain asset set.
  const [routerRule] = find(UNISWAP.swapRouter02, "exactInputSingle");
  const legs = routerRule!.args as unknown as { value: string[] }[];
  assert.ok(
    legs[0]!.value.map((a) => a.toLowerCase()).includes(CASH.WETH.toLowerCase()),
    "tokenIn must admit WETH — the native-input marker",
  );
  assert.ok(
    !legs[1]!.value.map((a) => a.toLowerCase()).includes(CASH.WETH.toLowerCase()),
    "tokenOut must NOT admit WETH beyond the asset set — converts only ever produce allowlisted assets",
  );
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
  // The two legs DELIBERATELY differ by one entry: tokenIn adds WETH, the
  // marker a native-input auto-convert swap carries (msg.value + tokenIn =
  // WETH). tokenOut stays the plain asset set — a convert only ever produces
  // an allowlisted asset, so the widen is on what may be spent, never received.
  const tokenIn = new Set(legs[0]!.value.map((a) => a.toLowerCase()));
  const tokenOut = new Set(legs[1]!.value.map((a) => a.toLowerCase()));
  assert.ok(tokenIn.has(CASH.WETH.toLowerCase()), "tokenIn admits WETH for the native-input convert");
  assert.ok(!tokenOut.has(CASH.WETH.toLowerCase()), "tokenOut must not admit WETH");
  assert.deepEqual(
    [...tokenIn].filter((a) => a !== CASH.WETH.toLowerCase()).sort(),
    [...tokenOut].sort(),
    "minus WETH, tokenIn must be exactly tokenOut — the widen is one entry, not a new set",
  );
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

  // And together, because forwarding one is what made the other's absence invisible.
  const both = call({ caps: CAPS, smartAccount: SELF, v4AdapterAddress: V4, ponsAdapterAddress: PONS });
  assert.ok(both.includes(V4) && both.includes(PONS), "both adapters must reach the chain");

  // The wrapper must agree with the function it wraps — no path may be looser.
  const direct = buildCallPermissions(CAPS, SELF, { v4AdapterAddress: V4, ponsAdapterAddress: PONS }).map((p) =>
    p.target.toLowerCase(),
  );
  assert.deepEqual(both, direct, "buildWallPolicies must mirror buildCallPermissions exactly");
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
  for (const opts of [{}, { extraTokens: [CUSTOM] }]) {
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
      // tokenIn (leg 0) deliberately adds WETH — the native-input auto-convert
      // marker. tokenOut (leg 1) must remain EXACTLY the approve set.
      const expected = i === 0 ? [...approved, CASH.WETH.toLowerCase()] : [...approved];
      assert.deepEqual(
        [...pinned].sort(),
        expected.sort(),
        `leg ${i} must be the approve set${i === 0 ? " plus WETH" : ""} and nothing else`,
      );
    }
  }
});

test("the native-swap marker is minted only when the wall can actually convert", () => {
  // Marker and permission move together — the GRANT_V4 lockstep rule. The new
  // wall carries the WETH pin + valueLimit by default, so the signer mints
  // GRANT_NATIVE_SWAP unconditionally; the reader is grantHasNativeSwap.
  assert.equal(grantHasNativeSwap({ grantFeatures: [GRANT_NATIVE_SWAP] }), true);
  assert.equal(grantHasNativeSwap({ grantFeatures: [] }), false);
  assert.equal(grantHasNativeSwap(null), false);
  // And a pre-change grant (no marker) is exactly what the worker gates on.
  assert.equal(grantHasNativeSwap({ grantFeatures: ["tradeable-v2"] }), false);
});
