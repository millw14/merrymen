/**
 * THE LIGHTER LEG OF RECOVERY (docs/perps.md rule 13, "Surfaces → Recover").
 *
 * What must hold, and why each is here:
 *   - an agent that never deposited costs one eth_call and reads as a KNOWN
 *     none — Lighter's API is never asked;
 *   - anything unread is unread: the venue's standing is "unknown", the
 *     disclosure says it is not an empty account, and no surface is handed a
 *     reason to say "nothing left to recover";
 *   - open positions get an unwind offered WITHOUT a close (createOrder is off
 *     until the mainnet checklist proves it), and the owner is told their
 *     stops go with it;
 *   - a pending balance becomes a claim, as its own operation;
 *   - the throwaway key is canonical and random;
 *   - the calls go cancel → key change → withdraw (21126), in one UserOp,
 *     proven on the operation actually submitted to a bundler;
 *   - the module stays free of node built-ins, so the browser and phones can
 *     run the disclosure.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  parseAbi,
  toFunctionSelector,
} from "viem";
import {
  GOLDILOCKS_P,
  LIGHTER_CHANGE_PUBKEY_ABI,
  LIGHTER_OWNER_RECOVER_ABI,
  LIGHTER_ROUTE_V1,
  LIGHTER_WITHDRAW_PENDING_ABI,
  robinhoodChain,
  validatePerpPubKey,
} from "../../packages/core/src/index";
import {
  ownerFromPrivateKey,
  planVenueSteps,
  readRecoverVenue,
  recoverVenueStep,
  ecgfp5Decodes,
  throwawayLighterKey,
  venueClaimCall,
  venueDisclosure,
  venueStanding,
  venueUnwindCalls,
  type LighterChainReader,
  type RecoverVenue,
  type VenueFetch,
} from "./recover";

const FIXTURES = path.join(import.meta.dirname, "perps", "fixtures");
const fixture = (f: string) => JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) as Record<string, unknown>;

/** The account the captured fixtures belong to (account 22149, two isolated positions, 0.329402 USDG cross). */
const SELF = "0x8e93b78ef08d5e36da2e2473cd9027f8c286c176" as const;
const MASTER = 22149;
/** synthetic.apikeys.json's key at index 16. */
const AGENT_KEY = `0x${"0100000000000000".repeat(5)}` as `0x${string}`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The 22149 capture with its cross collateral (and nothing else) replaced. */
function account22149(over: { collateral?: string; orders?: number } = {}) {
  const f = fixture("account.22149.isolated.json") as { accounts: Record<string, unknown>[] };
  const a = { ...f.accounts[0]! };
  if (over.collateral !== undefined) a.collateral = over.collateral;
  if (over.orders !== undefined) a.total_order_count = over.orders;
  return { ...f, accounts: [a] };
}

/** An account with no positions at all, in the venue's shape. */
function flatAccount(opts: { collateral?: string; orders?: number } = {}) {
  return {
    code: 200,
    total: 1,
    accounts: [
      {
        code: 0,
        account_type: 0,
        index: MASTER,
        account_index: MASTER,
        l1_address: SELF,
        total_order_count: opts.orders ?? 0,
        pending_order_count: 0,
        status: 1,
        collateral: opts.collateral ?? "0.000000",
        transaction_time: 1_790_694_641_487_929,
        positions: [],
        assets: [{ symbol: "USDG", asset_id: 3, balance: "0.000000", locked_balance: "0.000000" }],
        total_asset_value: "0",
        shares: [],
        pending_unlocks: [],
      },
    ],
  };
}

interface FakeVenue {
  account?: () => Response;
  apikeys?: () => Response;
  list?: () => Response;
  down?: boolean;
}

/** A fake of Lighter's public API from the captured fixtures. Records every request. */
function lighter(v: FakeVenue = {}) {
  const calls: { url: URL; method: string }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push({ url: u, method: init?.method ?? "GET" });
    if (v.down) throw new TypeError("fetch failed");
    switch (u.pathname) {
      case "/api/v1/orderBookDetails":
        return json(200, fixture("orderBookDetails.perp.json"));
      case "/api/v1/accountsByL1Address":
        return (v.list ?? (() => json(200, fixture("synthetic.accountsByL1Address.json"))))();
      case "/api/v1/account":
        return (v.account ?? (() => json(200, account22149())))();
      case "/api/v1/withdrawalDelay":
        return json(200, fixture("withdrawalDelay.json"));
      case "/api/v1/apikeys":
        return (v.apikeys ?? (() => json(200, fixture("synthetic.apikeys.json"))))();
      default:
        return json(404, { code: 404, message: "unexpected path in test" });
    }
  }) as VenueFetch;
  return { fetch, calls };
}

function contract(a: { index?: bigint | number; pending?: bigint; throws?: "index" | "pending" } = {}) {
  const calls: string[] = [];
  const read: LighterChainReader = async (fn) => {
    calls.push(fn);
    if (fn === "addressToAccountIndex") {
      if (a.throws === "index") throw new Error("rpc down");
      return a.index ?? MASTER;
    }
    if (a.throws === "pending") throw new Error("rpc down");
    return a.pending ?? 0n;
  };
  return { read, calls };
}

const read = (c: ReturnType<typeof contract>, l: ReturnType<typeof lighter>, chainId: number = LIGHTER_ROUTE_V1.chainId) =>
  readRecoverVenue({ smartAccount: SELF, chainId, chainRead: c.read, agentPerpPubKey: AGENT_KEY, fetch: l.fetch });

const asAccount = (v: RecoverVenue) => {
  assert.equal(v.kind, "account");
  return v as Extract<RecoverVenue, { kind: "account" }>;
};

describe("the venue group — what is at Lighter", () => {
  it("NO VENUE ACCOUNT: a known none, one eth_call, and Lighter is never asked", async () => {
    const c = contract({ index: 0n });
    const l = lighter();
    const v = await read(c, l);
    assert.deepEqual(v, { kind: "none" });
    assert.equal(venueStanding(v), "nothing");
    assert.deepEqual(c.calls, ["addressToAccountIndex"]);
    assert.equal(l.calls.length, 0, "an agent that never deposited must not cost a single venue request");
    const d = venueDisclosure(v);
    assert.equal(d.offers.length, 0);
    assert.equal(d.groups.length, 0);
  });

  it("OFF CHAIN 4663: nothing to read and nothing there — not even an eth_call", async () => {
    const c = contract();
    const l = lighter();
    const v = await read(c, l, 46630);
    assert.deepEqual(v, { kind: "elsewhere", chainId: 46630 });
    assert.equal(venueStanding(v), "nothing");
    assert.equal(c.calls.length + l.calls.length, 0);
  });

  it("THE CONTRACT UNREAD: unknown — never 'nothing', never 'empty'", async () => {
    const v = await read(contract({ throws: "index" }), lighter());
    assert.equal(v.kind, "unreadable");
    assert.equal(venueStanding(v), "unknown");
    const d = venueDisclosure(v);
    assert.equal(d.standing, "unknown");
    assert.match(d.headline, /could not be read/);
    assert.match(d.groups[0]!.lines[0]!, /NOT an empty account/);
    assert.doesNotMatch(JSON.stringify(d), /reads empty|nothing left|nothing to recover/i);
  });

  it("LIGHTER DOWN: every venue field unread, no unwind built from guesses, and still no 'empty'", async () => {
    const l = lighter({ down: true });
    const v = asAccount(await read(contract({ pending: 0n }), l));
    assert.equal(v.account.read, false);
    assert.equal(v.otherAccounts.read, false);
    assert.equal(v.keySlot.read, false);
    assert.equal(v.withdrawalDelaySec.read, false);
    assert.equal(v.unwind, null, "an unwind needs the account read: the 21126 precondition and the amount would be guesses");
    assert.match(v.notOffered.join(" "), /cannot be read/);
    assert.equal(venueStanding(v), "unknown");
    const d = venueDisclosure(v);
    assert.match(d.headline, /could not be read in full/);
    assert.match(d.groups[0]!.lines.join(" "), /NOT an empty account/);
    assert.doesNotMatch(JSON.stringify(d), /reads empty/);
    for (const c of l.calls) assert.equal(c.method, "GET", "the disclosure only ever GETs");
  });

  it("A HOST FETCH THAT NEVER ANSWERS (and ignores its abort signal) cannot hang the plan", async () => {
    const never = (() => new Promise<Response>(() => {})) as unknown as VenueFetch;
    const t0 = Date.now();
    const v = asAccount(
      await readRecoverVenue({ smartAccount: SELF, chainId: LIGHTER_ROUTE_V1.chainId, chainRead: contract().read, fetch: never, timeoutMs: 50 }),
    );
    assert.ok(Date.now() - t0 < 5_000, "every read ends at its deadline");
    assert.equal(v.account.read, false);
    assert.match((v.account as { why: string }).why, /did not answer in time/);
    assert.equal(venueStanding(v), "unknown");
  });

  it("an answer that does not parse is unread, not zero", async () => {
    const v = asAccount(await read(contract(), lighter({ account: () => json(200, { code: 200, accounts: [{ index: MASTER }] }) })));
    assert.equal(v.account.read, false);
    assert.equal(venueStanding(v), "unknown");
  });

  it("OPEN POSITIONS: disclosed exactly, and the unwind is offered WITHOUT a close", async () => {
    const v = asAccount(await read(contract(), lighter()));
    assert.equal(v.accountIndex, MASTER);
    assert.ok(v.account.read);
    const a = v.account.value;
    assert.equal(a.collateralMicro, 329_402n);
    assert.equal(a.positions.length, 2);
    assert.deepEqual(a.positions.map((p) => p.market).sort(), ["NVDA-PERP", "QQQ-PERP"].sort());
    assert.equal(venueStanding(v), "holds");
    assert.ok(v.keySlot.read && v.keySlot.value.state === "key" && v.keySlot.value.agents === true, "the agent's key is recognised");

    assert.ok(v.unwind);
    assert.deepEqual(v.unwind!.calls, ["cancelAllOrders", "changePubKey", "withdraw"]);
    assert.equal(v.unwind!.withdrawMicro, 329_402n, "the free cross collateral, exactly");
    assert.equal(v.unwind!.positionsLeftOpen, 2, "their stops are cancelled with everything else — said, not hidden");

    const d = venueDisclosure(v, { gasWei: 10n ** 15n });
    assert.equal(d.standing, "holds");
    const unwind = d.offers.find((o) => o.kind === "unwind")!;
    assert.ok(unwind);
    assert.equal(unwind.confirmWord, "unwind anyway", "stripping stops asks for a different word");
    assert.doesNotMatch(JSON.stringify(unwind), /createOrder/, "no close is offered");
    assert.match(unwind.warnings.join(" "), /NO stop/);
    assert.match(unwind.warnings.join(" "), /merrymen kill/);
    assert.match(unwind.warnings.join(" "), /21126/);
    assert.match(unwind.warnings.join(" "), /does not durably revoke/);
    assert.match(d.notes.join(" "), /createOrder/, "why positions cannot be closed from here is said");
    assert.match(d.notes.join(" "), /about 19 min/, "the delay is the live one (1114 s)");
    assert.deepEqual(unwind.approved, { kind: "unwind", accountIndex: MASTER, calls: ["cancelAllOrders", "changePubKey", "withdraw"], positionsLeftOpen: 2 });
    const text = JSON.stringify(d);
    assert.match(text, /0\.329402 USDG cross collateral/);
    assert.match(text, /NVDA-PERP long 3\.9685/);
  });

  it("PENDING BALANCE: a claim is offered, as its own step", async () => {
    const v = asAccount(await read(contract({ pending: 5_000_000n }), lighter({ account: () => json(200, flatAccount()) })));
    assert.deepEqual(v.claim, { kind: "claim", accountIndex: MASTER, amountMicro: 5_000_000n });
    assert.equal(venueStanding(v), "holds", "money waiting on the contract is not nothing");
    const d = venueDisclosure(v);
    const claim = d.offers.find((o) => o.kind === "claim")!;
    assert.ok(claim);
    assert.equal(claim.confirmWord, "claim");
    assert.match(claim.lines[0]!, /5 USDG/);
    assert.match(claim.warnings.join(" "), /relayer/);
    assert.match(JSON.stringify(d.groups), /5 USDG claimable into this smart account/);
  });

  it("A PENDING BALANCE UNREAD is unknown, even over an empty account", async () => {
    const v = asAccount(await read(contract({ throws: "pending" }), lighter({ account: () => json(200, flatAccount()) })));
    assert.equal(v.pendingMicro.read, false);
    assert.equal(v.claim, null);
    assert.equal(venueStanding(v), "unknown");
  });

  it("an empty account with nothing pending and no sub-accounts is the ONE state that reads empty", async () => {
    const v = asAccount(
      await read(contract(), lighter({ account: () => json(200, flatAccount()), apikeys: () => json(400, { code: 21109, message: "api key not found" }) })),
    );
    assert.equal(venueStanding(v), "nothing");
    assert.ok(v.keySlot.read && v.keySlot.value.state === "empty", "21109 is an empty slot on the venue's word");
    assert.equal(v.unwind, null);
    assert.equal(v.claim, null);
    assert.match(venueDisclosure(v).headline, /reads empty/);
  });
});

describe("which steps are honest to offer (21126 and friends)", () => {
  const key = { read: true as const, value: { state: "key" as const, publicKey: AGENT_KEY, agents: true } };
  const acct = (o: Partial<{ C: bigint; positions: number; cross: number; orders: number }>) => ({
    read: true as const,
    value: {
      collateralMicro: o.C ?? 0n,
      isolatedMarginMicro: 0n,
      unrealizedMicro: 0n,
      positions: Array.from({ length: o.positions ?? 0 }, (_, i) => ({
        market: `M${i}-PERP`,
        marketId: i,
        side: "long" as const,
        size: "1",
        marginMode: (i < (o.cross ?? 0) ? "cross" : "isolated") as "cross" | "isolated",
        marginMicro: 1n,
        unrealizedMicro: 0n,
        liqPrice: null,
        stopsResting: 1,
      })),
      crossPositions: o.cross ?? 0,
      orders: o.orders ?? 0,
      poolShareCount: 0,
      spotBalanceCount: 0,
    },
  });
  const none = { read: true as const, value: 0n };

  it("ZERO CROSS COLLATERAL: no key change (it would fail at the venue), and no cancel-only over open positions", () => {
    const s = planVenueSteps({ accountIndex: 7, account: acct({ C: 0n, positions: 2, orders: 2 }), pendingMicro: none, keySlot: key });
    assert.equal(s.unwind, null, "cancelling alone would strip the stops while the key stays live");
    assert.match(s.notOffered.join(" "), /21126/);
    assert.match(s.notOffered.join(" "), /not cancelled/);
  });

  it("zero cross collateral, no positions, resting orders: cancel only", () => {
    const s = planVenueSteps({ accountIndex: 7, account: acct({ C: 0n, orders: 3 }), pendingMicro: none, keySlot: key });
    assert.deepEqual(s.unwind?.calls, ["cancelAllOrders"]);
    assert.equal(s.unwind?.positionsLeftOpen, 0);
  });

  it("the withdrawal always comes AFTER the key change — the rotation needs C > 0 when it runs", () => {
    const s = planVenueSteps({ accountIndex: 7, account: acct({ C: 12_000_000n }), pendingMicro: none, keySlot: key });
    assert.deepEqual(s.unwind?.calls, ["cancelAllOrders", "changePubKey", "withdraw"]);
    assert.equal(s.unwind?.withdrawMicro, 12_000_000n);
  });

  it("an empty key slot is not rotated; its collateral is still withdrawn", () => {
    const s = planVenueSteps({ accountIndex: 7, account: acct({ C: 3_000_000n }), pendingMicro: none, keySlot: { read: true, value: { state: "empty" } } });
    assert.deepEqual(s.unwind?.calls, ["withdraw"]);
  });

  it("an UNREAD key slot is rotated anyway — revoking whatever is there costs nothing", () => {
    const s = planVenueSteps({ accountIndex: 7, account: acct({ C: 3_000_000n }), pendingMicro: none, keySlot: { read: false, why: "down" } });
    assert.deepEqual(s.unwind?.calls, ["cancelAllOrders", "changePubKey", "withdraw"]);
  });

  it("cross collateral backing a CROSS position is not free and is not withdrawn", () => {
    const s = planVenueSteps({ accountIndex: 7, account: acct({ C: 3_000_000n, positions: 1, cross: 1 }), pendingMicro: none, keySlot: key });
    assert.deepEqual(s.unwind?.calls, ["cancelAllOrders", "changePubKey"]);
    assert.equal(s.unwind?.withdrawMicro, 0n);
    assert.match(s.notOffered.join(" "), /not free/);
  });

  it("nothing to do is no unwind", () => {
    const s = planVenueSteps({ accountIndex: 7, account: acct({}), pendingMicro: none, keySlot: { read: true, value: { state: "empty" } } });
    assert.equal(s.unwind, null);
  });
});

describe("the throwaway key", () => {
  it("is canonical — five little-endian limbs, each < p, not all zero — and fresh every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const k = throwawayLighterKey();
      assert.equal(validatePerpPubKey(k), k, "the contract's own check must accept it");
      assert.match(k, /^0x[0-9a-f]{80}$/);
      seen.add(k);
    }
    assert.equal(seen.size, 200);
  });

  it("rejection-samples a limb ≥ p rather than reducing it", () => {
    // p as 8 little-endian bytes, then p − 1: the first draw must be refused.
    const le = (v: bigint) => Uint8Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
    // [p − 1, 3, 2, 3, 4] decodes to a curve point (below), so it is taken as drawn.
    const draws = [le(GOLDILOCKS_P), le(GOLDILOCKS_P - 1n), le(3n), le(2n), le(3n), le(4n)];
    let n = 0;
    const k = throwawayLighterKey(() => draws[n++] ?? le(5n));
    assert.equal(n, 6, "one refused draw, then one per limb");
    assert.equal(k.slice(2, 18), "00000000ffffffff", "limb 0 is p − 1, little-endian");
    assert.equal(validatePerpPubKey(k), k);
  });

  /**
   * Public keys made by the official lighter-go v1.0.9 signer (worker
   * vendor/lighter, generateApiKey), private halves discarded. Every one is a
   * point encoding, so a decodability check that let any of them fail would
   * be wrong — and a wrong check passing all twelve by luck is a 1-in-4096 event.
   */
  const SIGNER_KEYS = [
    "0xb84732d67b292429afbd2751fdf7f7d53521113fd3c316ece6e29646996e0b5f85bc51fcac9d795b",
    "0xc331c18c444705c514adefb7936b1b3fb0224d6157f01d37ffdc138d26e02bf53ef282dd2ea623f6",
    "0xd16f3ee03a0cfe180ad890ed798f31f135a9ec6b054236c2829bea512f6889ce7dab63804a766603",
    "0x6e8ce0989cfd8ff3fb14f17b089132a35cf1c300262f9a25ca2f1ea998768537feaf06c12c9802eb",
    "0xa5815d29c1f10ca8658d3fa4ab2aa4020d4f3d0cd2fd6e63fa68115646728a334a6c3d867fc8a243",
    "0xfad80123580d5406f48e38f43efde932aadb632e8aa256ae3c455454f7cd025dd757b3cdf3e82d68",
    "0x532eab3cae225ab8587947f81441283eff267f4e003827b5eb52cfd8493894b48a06054a7a30efb8",
    "0x49462b72347cf3f347d870e0521f53ac686a40174ace5965fc04f2647fe550fc156bda4f66c46470",
    "0x12fa75bdcd55eaf7211c19f75db16d758c170494ae0b02c95456a90514025e806b116d5c263e673e",
    "0x119c5a2ad2b77a6ad8eb54fa43b9ea9ecfa1eaa60fea0d78770a656d0e69e859b95191dbe6ef6984",
    "0x70734846e675258b03ce8984a618470bf50ee91d2f03a67653a708ef59568bfab3497341383686b5",
    "0x293fcc008a7d5438cf415577e7e8becf393f5496ee346e24274cb29dda20b583b6fa083d1dbd5217",
  ];

  it("THE DECODABILITY CHECK: every key the official signer makes decodes; about half of random canonical values do not", () => {
    for (const k of SIGNER_KEYS) assert.equal(ecgfp5Decodes(k), true, k);
    let decoding = 0;
    for (let i = 0; i < 400; i++) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(40));
      for (let l = 0; l < 5; l++) bytes[l * 8 + 7] = bytes[l * 8 + 7]! & 0x7f; // keep each limb < p
      const hex = `0x${Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")}`;
      if (ecgfp5Decodes(hex)) decoding++;
    }
    assert.ok(decoding > 140 && decoding < 260, `${decoding}/400 decode — the check must split canonical values roughly in half`);
    assert.equal(ecgfp5Decodes("0x" + "00".repeat(40)), false, "the zero key is not a key");
    assert.equal(ecgfp5Decodes("0x1234"), false);
  });

  it("A THROWAWAY ALWAYS DECODES, so the key change is never refused for its encoding while the withdrawal beside it lands", () => {
    for (let i = 0; i < 100; i++) assert.equal(ecgfp5Decodes(throwawayLighterKey()), true);
    // [p − 1, 1, 2, 3, 4] is canonical but does not decode: it is skipped, never sent.
    const le = (v: bigint) => Uint8Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
    const draws = [le(GOLDILOCKS_P - 1n), le(1n), le(2n), le(3n), le(4n), le(GOLDILOCKS_P - 1n), le(3n), le(2n), le(3n), le(4n)];
    let n = 0;
    const k = throwawayLighterKey(() => draws[n++] ?? le(5n));
    assert.equal(n, 10, "the non-decoding key was drawn and refused, then the next one taken");
    assert.equal(k.slice(18, 34), "0300000000000000");
    // A source that never yields a decoding key is refused, not looped on forever.
    assert.throws(() => throwawayLighterKey(() => le(1n)), /never produced a key that decodes/);
  });

  it("a broken random source is refused, never turned into the zero key", () => {
    assert.throws(() => throwawayLighterKey(() => new Uint8Array(8)), /zero key/);
    assert.throws(() => throwawayLighterKey(() => new Uint8Array(8).fill(0xff)), /canonical limb/);
  });
});

describe("the calls, in order", () => {
  const KEY = throwawayLighterKey();

  it("cancel → key change → withdraw, each to the proxy with zero value and the pinned arguments", () => {
    const calls = venueUnwindCalls({ accountIndex: MASTER, calls: ["cancelAllOrders", "changePubKey", "withdraw"], withdrawMicro: 329_402n }, KEY);
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.to, LIGHTER_ROUTE_V1.proxy);
      assert.equal(c.value, 0n);
    }
    const cancel = decodeFunctionData({ abi: LIGHTER_OWNER_RECOVER_ABI, data: calls[0]!.data });
    assert.equal(cancel.functionName, "cancelAllOrders");
    assert.deepEqual(cancel.args, [MASTER]);
    const cpk = decodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, data: calls[1]!.data });
    assert.equal(cpk.functionName, "changePubKey");
    assert.deepEqual(cpk.args, [MASTER, LIGHTER_ROUTE_V1.apiKeyIndex, KEY]);
    const w = decodeFunctionData({ abi: LIGHTER_OWNER_RECOVER_ABI, data: calls[2]!.data });
    assert.equal(w.functionName, "withdraw");
    assert.deepEqual(w.args, [MASTER, LIGHTER_ROUTE_V1.assetIndex, LIGHTER_ROUTE_V1.routePerps, 329_402n]);
  });

  it("any other order is refused, not re-sorted", () => {
    assert.throws(
      () => venueUnwindCalls({ accountIndex: MASTER, calls: ["withdraw", "changePubKey"], withdrawMicro: 1n }, KEY),
      /in that order/,
    );
    assert.throws(
      () => venueUnwindCalls({ accountIndex: MASTER, calls: ["changePubKey"], withdrawMicro: 0n }, null),
      /canonical fresh key/,
    );
  });

  it("the claim pays only the account itself", () => {
    const c = venueClaimCall(SELF, 5_000_000n);
    const d = decodeFunctionData({ abi: LIGHTER_WITHDRAW_PENDING_ABI, data: c.data });
    assert.equal(d.functionName, "withdrawPendingBalance");
    assert.deepEqual([d.args[0].toLowerCase(), d.args[1], d.args[2]], [SELF, LIGHTER_ROUTE_V1.assetIndex, 5_000_000n]);
    assert.equal(c.to, LIGHTER_ROUTE_V1.proxy);
  });
});

// ── the operation actually submitted ────────────────────────────────────────

/**
 * recoverVenueStep, unmodified, against a stubbed chain and bundler (the
 * recover-client.test.ts technique: viem's transports and the Kernel SDK use
 * the global fetch, so a stubbed fetch is the one seam that reaches them).
 * The UserOp's callData is decoded the way Kernel encodes a batch.
 */
describe("recoverVenueStep — the ONE sudo UserOp", () => {
  const OWNER_KEY = ("0x" + "42".repeat(32)) as `0x${string}`;
  const RPC = "https://rpc.recover-venue.test";
  const BUNDLER = "https://bundler.recover-venue.test";
  const SENDER_ADDRESS_RESULT = parseAbi(["error SenderAddressResult(address sender)"]);
  const UINT256 = parseAbi(["function f() view returns (uint256)"]);
  const UINT48 = parseAbi(["function f() view returns (uint48)"]);
  const UINT128 = parseAbi(["function f() view returns (uint128)"]);
  const SEL = {
    getSenderAddress: "0x9b249f69",
    getNonce: "0x35567e1a",
    addressToAccountIndex: toFunctionSelector("addressToAccountIndex(address)"),
    getPendingBalance: toFunctionSelector("getPendingBalance(address,uint16)"),
  };
  const hex = (n: bigint) => `0x${n.toString(16)}`;
  const submitted: { callData?: string }[] = [];
  let pending = 0n;

  function answer(method: string, params: unknown[]): { result?: unknown; error?: unknown } {
    if (method === "eth_sendUserOperation") {
      submitted.push(params[0] as { callData?: string });
      return { result: `0x${"ab".repeat(32)}` };
    }
    if (method === "eth_estimateUserOperationGas") {
      return { result: { preVerificationGas: hex(60_000n), verificationGasLimit: hex(300_000n), callGasLimit: hex(400_000n) } };
    }
    if (method === "eth_getUserOperationReceipt") {
      return {
        result: {
          userOpHash: `0x${"ab".repeat(32)}`, sender: SELF, nonce: "0x0", actualGasCost: "0x1", actualGasUsed: "0x1",
          success: true, logs: [],
          receipt: {
            transactionHash: `0x${"cd".repeat(32)}`, blockHash: `0x${"ef".repeat(32)}`, blockNumber: "0x1",
            transactionIndex: "0x0", from: SELF, to: SELF, cumulativeGasUsed: "0x1", gasUsed: "0x1",
            effectiveGasPrice: "0x1", status: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`,
            contractAddress: null, type: "0x2",
          },
        },
      };
    }
    if (method === "eth_supportedEntryPoints") return { result: ["0x0000000071727De22E5E9d8BAf0edAc6f37da032"] };
    if (method === "eth_chainId") return { result: hex(4663n) };
    if (method === "eth_getCode") return { result: "0x" };
    if (method === "eth_getBalance") return { result: hex(10n ** 15n) };
    if (method === "eth_gasPrice") return { result: hex(1_000_000_000n) };
    if (method === "eth_maxPriorityFeePerGas") return { result: "0x1" };
    if (method === "eth_blockNumber") return { result: "0x1" };
    if (method === "eth_estimateGas") return { result: hex(500_000n) };
    if (method === "eth_getTransactionCount") return { result: "0x0" };
    if (method === "eth_getBlockByNumber") {
      return { result: { number: "0x1", baseFeePerGas: "0x1", timestamp: "0x1", hash: `0x${"ef".repeat(32)}` } };
    }
    if (method === "eth_call") {
      const data = String((params[0] as { data?: string }).data ?? "").toLowerCase();
      if (data.startsWith(SEL.getSenderAddress)) {
        return {
          error: {
            code: 3,
            message: "execution reverted",
            data: encodeErrorResult({ abi: SENDER_ADDRESS_RESULT, errorName: "SenderAddressResult", args: [SELF] }),
          },
        };
      }
      if (data.startsWith(SEL.addressToAccountIndex)) return { result: encodeFunctionResult({ abi: UINT48, result: MASTER }) };
      if (data.startsWith(SEL.getPendingBalance)) return { result: encodeFunctionResult({ abi: UINT128, result: pending }) };
      if (data.startsWith(SEL.getNonce)) return { result: encodeFunctionResult({ abi: UINT256, result: 0n }) };
      return { result: "0x" };
    }
    return { error: { code: -32601, message: `unstubbed ${method}` } };
  }

  const realFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(RPC) && !url.startsWith(BUNDLER)) throw new Error(`unexpected fetch in test: ${url}`);
      const parsed = JSON.parse(String(init?.body)) as unknown;
      const batch = (Array.isArray(parsed) ? parsed : [parsed]) as { id: number; method: string; params: unknown[] }[];
      const out = batch.map(({ id, method, params }) => ({ jsonrpc: "2.0", id, ...answer(method, params ?? []) }));
      return json(200, Array.isArray(parsed) ? out : out[0]);
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  const EXECUTE_ABI = parseAbi(["function execute(bytes32 execMode, bytes executionCalldata)"]);
  /** The Kernel batch inside a submitted UserOp: [{ target, value, callData }] in execution order. */
  function batchOf(callData: string) {
    const exec = decodeFunctionData({ abi: EXECUTE_ABI, data: callData as `0x${string}` });
    const [mode, inner] = exec.args as [`0x${string}`, `0x${string}`];
    if (mode.slice(2, 4) === "00") {
      // SINGLE: packed to(20) ++ value(32) ++ data
      return [{ target: `0x${inner.slice(2, 42)}`, value: BigInt(`0x${inner.slice(42, 106)}`), callData: `0x${inner.slice(106)}` as `0x${string}` }];
    }
    const [calls] = decodeAbiParameters(
      [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
      inner,
    );
    return calls as readonly { target: string; value: bigint; callData: `0x${string}` }[];
  }

  const FRESH = throwawayLighterKey();
  const step = (approved: Parameters<typeof recoverVenueStep>[0]["approved"]) =>
    recoverVenueStep({
      chain: robinhoodChain,
      owner: ownerFromPrivateKey(OWNER_KEY),
      bundlerUrl: BUNDLER,
      rpcUrl: RPC,
      expectedSmartAccount: SELF,
      agentPerpPubKey: AGENT_KEY,
      approved,
      venueFetch: lighter().fetch,
      freshKey: () => FRESH,
    });

  it("THE UNWIND: cancelAllOrders, changePubKey(idx, 16, throwaway), withdraw(idx, 3, 0, C) — one operation, that order", async () => {
    submitted.length = 0;
    pending = 0n;
    const r = await step({ kind: "unwind", accountIndex: MASTER, calls: ["cancelAllOrders", "changePubKey", "withdraw"], positionsLeftOpen: 2 });
    assert.equal(submitted.length, 1, "exactly one UserOp");
    const calls = batchOf(String(submitted[0]!.callData));
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.target.toLowerCase(), LIGHTER_ROUTE_V1.proxy);
      assert.equal(c.value, 0n);
    }
    const names = calls.map((c) => {
      try {
        return decodeFunctionData({ abi: LIGHTER_OWNER_RECOVER_ABI, data: c.callData }).functionName;
      } catch {
        return decodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, data: c.callData }).functionName;
      }
    });
    assert.deepEqual(names, ["cancelAllOrders", "changePubKey", "withdraw"], "the withdrawal must follow the key change (21126)");
    const cpk = decodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, data: calls[1]!.callData });
    assert.deepEqual(cpk.args, [MASTER, LIGHTER_ROUTE_V1.apiKeyIndex, FRESH]);
    const w = decodeFunctionData({ abi: LIGHTER_OWNER_RECOVER_ABI, data: calls[2]!.callData });
    assert.deepEqual(w.args, [MASTER, 3, 0, 329_402n]);

    assert.equal(r.rotatedTo, FRESH);
    assert.equal(r.replacedPubKey, AGENT_KEY, "the key it replaced, for the rotation journal");
    assert.equal(r.withdrawRequestedMicro, 329_402n);
    assert.equal(r.positionsLeftOpen, 2);
    assert.deepEqual(r.calls, ["cancelAllOrders", "changePubKey", "withdraw"]);
  });

  it("REFUSED before signing when more positions would lose their stops than the owner approved", async () => {
    submitted.length = 0;
    await assert.rejects(
      step({ kind: "unwind", accountIndex: MASTER, calls: ["cancelAllOrders", "changePubKey", "withdraw"], positionsLeftOpen: 0 }),
      /would now lose their stops.*Nothing has been signed/s,
    );
    assert.equal(submitted.length, 0);
  });

  it("REFUSED when what is possible now is not what was approved", async () => {
    submitted.length = 0;
    await assert.rejects(
      step({ kind: "unwind", accountIndex: MASTER, calls: ["cancelAllOrders", "changePubKey"], positionsLeftOpen: 2 }),
      /approved unwind was/,
    );
    await assert.rejects(step({ kind: "unwind", accountIndex: 1, calls: ["cancelAllOrders"], positionsLeftOpen: 2 }), /approved Lighter account/);
    assert.equal(submitted.length, 0);
  });

  it("THE CLAIM: one call, withdrawPendingBalance(self, 3, pending as re-read)", async () => {
    submitted.length = 0;
    pending = 7_250_000n;
    const r = await step({ kind: "claim", accountIndex: MASTER });
    const calls = batchOf(String(submitted[0]!.callData));
    assert.equal(calls.length, 1);
    const d = decodeFunctionData({ abi: LIGHTER_WITHDRAW_PENDING_ABI, data: calls[0]!.callData });
    assert.equal(d.args[0].toLowerCase(), SELF);
    assert.equal(d.args[2], 7_250_000n);
    assert.equal(r.claimedMicro, 7_250_000n);
    assert.equal(r.rotatedTo, null);
  });

  it("a claim with nothing pending any more is refused, with the likely reason", async () => {
    submitted.length = 0;
    pending = 0n;
    await assert.rejects(step({ kind: "claim", accountIndex: MASTER }), /relayer has most likely claimed/);
    assert.equal(submitted.length, 0);
  });
});

describe("portability — the disclosure runs where the recovery engine runs", () => {
  it("recover.ts and the venue parsers import no node built-ins and use no Buffer", () => {
    for (const f of ["./recover.ts", "./perps/markets.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      assert.doesNotMatch(src, /from\s+["']node:/, `${f} must stay browser-portable`);
      assert.doesNotMatch(src, /\bBuffer\./, `${f} must not use Buffer (browsers and JSContext have none)`);
      assert.doesNotMatch(src, /from\s+["']\.\/perps\/api["']/, `${f} must not import the node-only venue client`);
    }
  });
});
