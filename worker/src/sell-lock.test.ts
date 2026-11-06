/**
 * THE SIMULATED SALE, driven over viem's own client and error objects.
 *
 * Every test here talks to a fake chain through viem's `custom` transport, the
 * way positions.test.ts does, so the calls, state overrides, multicalls and the
 * error chains a revert or a 429 produce are viem's own — not a hand-written
 * stand-in for `client.call`. The fake models just enough of an ERC-20 for the
 * question: balances in a mapping at a chosen slot (overridable, like a real
 * node), and a transfer rule per token.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  HttpRequestError,
  keccak256,
  multicall3Abi,
  parseAbi,
  TimeoutError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { robinhoodChain } from "../../packages/core/src/chain";
import { CASH, UNISWAP } from "../../packages/core/src/index";
import {
  CONTROL_RECIPIENT,
  SELL_CHECK_TTL_MS,
  SellLockGate,
  balanceSlotCandidates,
  chainReverted,
  findBalanceSlot,
  sellRefusal,
  simulateSell,
} from "./sell-lock";

const FACTORY_ABI = parseAbi(["function getPool(address a, address b, uint24 fee) view returns (address)"]);
const MULTICALL3 = robinhoodChain.contracts.multicall3.address.toLowerCase();
const V3_FACTORY = getAddress(UNISWAP.v3Factory);
const V4_PM = getAddress(UNISWAP.v4PoolManager);
const USDG = getAddress(CASH.USDG);
const WETH = getAddress(CASH.WETH);

/** How a fake token treats a transfer from anyone but its deployer. */
type Rule = "clean" | "pool-locked" | "all-locked" | "false-to-pool" | "no-return";

interface FakeToken {
  address: Address;
  /** Solidity mapping slot of `_balances`, or "transform" for a balance no slot override can set. */
  layout: bigint | "transform";
  deployer: Address;
  pools: Set<string>;
  rule: Rule;
  balances: Map<string, bigint>;
}

const revert = () => Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
const rateLimited = () => new HttpRequestError({ url: "https://rpc.example", status: 429, body: {} });

type Overrides = Record<string, { stateDiff?: Record<string, Hex> }>;

/** A just-big-enough chain: ERC-20s, the v3 factory's getPool, and Multicall3. */
class FakeChain {
  readonly tokens = new Map<string, FakeToken>();
  readonly v3 = new Map<string, Address>();
  /** Every eth_call, in order: target, function, sender, and whether storage was overridden. */
  readonly log: { to: string; fn: string; from?: string; overridden: boolean; recipient?: string }[] = [];
  /** Return an error to throw for this call, or null to answer it. */
  fail: (c: { to: string; fn: string; recipient?: string }) => Error | null = () => null;

  token(t: Partial<FakeToken> & Pick<FakeToken, "address">): FakeToken {
    const full: FakeToken = { layout: 0n, deployer: getAddress("0x00000000000000000000000000000000000d3910"), pools: new Set(), rule: "clean", balances: new Map(), ...t };
    this.tokens.set(full.address.toLowerCase(), full);
    return full;
  }

  pool(a: Address, b: Address, fee: number, pool: Address): void {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
    this.v3.set(`${x}|${y}|${fee}`, pool);
    for (const t of [a, b]) this.tokens.get(t.toLowerCase())?.pools.add(pool.toLowerCase());
  }

  client(): PublicClient {
    return createPublicClient({
      chain: robinhoodChain,
      // retryCount 0, as every production read client is (rpc-governor.ts):
      // viem's default of 3 would ask each revert four times.
      transport: custom({
        request: async ({ method, params }: { method: string; params: unknown }) => {
          if (method !== "eth_call") throw new Error(`unexpected ${method}`);
          const [tx, , overrides] = params as [{ to: string; from?: string; data: Hex }, unknown, Overrides | undefined];
          return this.call(tx.to.toLowerCase(), tx.from?.toLowerCase(), tx.data, overrides ?? {});
        },
      }, { retryCount: 0 }),
    }) as unknown as PublicClient;
  }

  private call(to: string, from: string | undefined, data: Hex, overrides: Overrides): Hex {
    if (to === MULTICALL3) {
      const { args } = decodeFunctionData({ abi: multicall3Abi, data });
      const calls = (args as unknown as [readonly { target: Address; callData: Hex }[]])[0];
      this.log.push({ to, fn: "aggregate3", overridden: false });
      const e = this.fail({ to, fn: "aggregate3" });
      if (e) throw e;
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: calls.map((c) => {
          try {
            return { success: true, returnData: this.call(c.target.toLowerCase(), MULTICALL3, c.callData, overrides) };
          } catch {
            return { success: false, returnData: "0x" as Hex };
          }
        }),
      });
    }
    if (to === V3_FACTORY.toLowerCase()) {
      const { args } = decodeFunctionData({ abi: FACTORY_ABI, data });
      const [a, b, fee] = args as [Address, Address, number];
      const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
      this.log.push({ to, fn: "getPool", from, overridden: false });
      const e = this.fail({ to, fn: "getPool" });
      if (e) throw e;
      return encodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPool", result: this.v3.get(`${x}|${y}|${fee}`) ?? "0x0000000000000000000000000000000000000000" });
    }
    const t = this.tokens.get(to);
    if (!t) throw revert();
    const diff = Object.fromEntries(
      Object.entries(overrides[getAddress(to)]?.stateDiff ?? overrides[to]?.stateDiff ?? {}).map(([k, v]) => [k.toLowerCase(), BigInt(v)]),
    );
    const slotOf = (h: string) =>
      t.layout === "transform" ? null : keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(h), t.layout])).toLowerCase();
    const balanceOf = (h: string) => {
      const s = slotOf(h);
      if (s && diff[s] !== undefined) return diff[s]!;
      const real = t.balances.get(h.toLowerCase()) ?? 0n;
      // A reflection-style balance: derived, so no slot echoes what was written.
      return t.layout === "transform" ? real * 3n + 1n : real;
    };
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
    const recipient = functionName === "transfer" ? String((args as readonly unknown[])[0]).toLowerCase() : undefined;
    this.log.push({ to, fn: functionName, from, overridden: Object.keys(diff).length > 0, ...(recipient ? { recipient } : {}) });
    const e = this.fail({ to, fn: functionName, ...(recipient ? { recipient } : {}) });
    if (e) throw e;
    if (functionName === "balanceOf") {
      return encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: balanceOf(String((args as readonly unknown[])[0])) });
    }
    if (functionName === "transfer") {
      const [dest, amount] = args as [Address, bigint];
      const sender = from ?? "";
      if (balanceOf(sender) < amount) throw revert();
      const toPool = t.pools.has(dest.toLowerCase());
      const deployer = sender === t.deployer.toLowerCase();
      if (!deployer && t.rule === "pool-locked" && toPool) throw revert();
      if (!deployer && t.rule === "all-locked") throw revert();
      if (!deployer && t.rule === "false-to-pool" && toPool) return encodeFunctionResult({ abi: erc20Abi, functionName: "transfer", result: false });
      if (t.rule === "no-return") return "0x";
      return encodeFunctionResult({ abi: erc20Abi, functionName: "transfer", result: true });
    }
    throw revert();
  }
}

const ONE = 10n ** 18n;
const COIN = getAddress("0x00000000000000000000000000000000000c01e1");
const POOL = getAddress("0x00000000000000000000000000000000000f001e");
const HOLDER = getAddress("0x00000000000000000000000000000000000a11ce");

function chainWith(rule: Rule, layout: bigint | "transform" = 0n): { chain: FakeChain; token: FakeToken } {
  const chain = new FakeChain();
  const token = chain.token({ address: COIN, rule, layout });
  chain.pool(WETH, COIN, 10000, POOL);
  return { chain, token };
}

describe("balanceSlotCandidates", () => {
  it("covers a plain mapping at 0, the upgradeable 51, and the namespaced and seeded layouts, each once", () => {
    const c = balanceSlotCandidates(HOLDER);
    const at = (i: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [HOLDER, i]));
    assert.equal(c[0], at(0n), "OpenZeppelin v4's slot 0 is asked first");
    assert.ok(c.includes(at(51n)), "ERC20Upgradeable's _balances behind Initializable and Context (this chain's WETH)");
    assert.equal(new Set(c).size, c.length, "no slot is marked twice");
    assert.ok(c.length > 64 && c.length < 128, `a bounded list, got ${c.length}`);
  });
});

describe("chainReverted — only the chain's own answer is a revert", () => {
  const errorOf = async (e: Error): Promise<unknown> => {
    const c = createPublicClient({ chain: robinhoodChain, transport: custom({ async request() { throw e; } }, { retryCount: 0 }) });
    try {
      await c.call({ to: COIN, data: "0x" });
    } catch (err) {
      return err;
    }
    throw new Error("expected the call to throw");
  };
  it("a revert, as a node reports it (code 3, or -32000 'execution reverted'), is one", async () => {
    assert.equal(chainReverted(await errorOf(revert())), true);
    assert.equal(chainReverted(await errorOf(Object.assign(new Error("execution reverted"), { code: -32000 }))), true);
  });
  for (const [name, e] of [
    ["an HTTP 429", rateLimited()],
    ["an HTTP 503", new HttpRequestError({ url: "https://rpc.example", status: 503, body: {} })],
    ["a timeout", new TimeoutError({ body: {}, url: "https://rpc.example" })],
    ["a JSON-RPC limit exceeded (-32005)", Object.assign(new Error("limit exceeded"), { code: -32005 })],
    ["a provider that will not take a state override", Object.assign(new Error("invalid params"), { code: -32602 })],
  ] as const) {
    it(`${name} is NOT — it is our request failing, and it must never read as a lock`, async () => {
      assert.equal(chainReverted(await errorOf(e)), false);
    });
  }
});

describe("simulateSell", () => {
  it("A CLEAN COIN SELLS: the sale is from the holder, into the pool, with the holder handed a balance", async () => {
    const { chain } = chainWith("clean");
    const r = await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: 5n * ONE });
    assert.equal(r.verdict, "sellable");
    const sale = chain.log.find((l) => l.fn === "transfer");
    assert.ok(sale, "a transfer was simulated");
    assert.equal(sale.from, HOLDER.toLowerCase(), "from the account that would hold it");
    assert.equal(sale.recipient, POOL.toLowerCase(), "into the pool it would sell into");
    assert.equal(sale.overridden, true, "the holder holds none, so the balance came from a state override");
  });

  it("GATO'S SHAPE IS LOCKED: the sale into the pool reverts while a plain transfer goes through", async () => {
    const { chain } = chainWith("pool-locked");
    const r = await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: 5n * ONE });
    assert.equal(r.verdict, "locked");
    assert.equal(r.verdict === "locked" && r.pool, POOL);
    assert.deepEqual(chain.log.filter((l) => l.fn === "transfer").map((l) => l.recipient), [POOL.toLowerCase(), CONTROL_RECIPIENT.toLowerCase()]);
  });

  it("…and the deployer itself could sell it, which is exactly why the holder must not be the deployer", async () => {
    const { chain, token } = chainWith("pool-locked");
    const r = await simulateSell(chain.client(), { token: COIN, holder: token.deployer, pools: [POOL], amount: 5n * ONE });
    assert.equal(r.verdict, "sellable");
  });

  it("a coin that answers `false` to the pool is locked too, as the vault's own _call would refuse it", async () => {
    const { chain } = chainWith("false-to-pool");
    assert.equal((await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE })).verdict, "locked");
  });

  it("a transfer with no return data (USDT-style) is a transfer that went through", async () => {
    const { chain } = chainWith("no-return");
    assert.equal((await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE })).verdict, "sellable");
  });

  it("A COIN THAT REFUSES EVERY TRANSFER IS UNKNOWN, not locked — a sale could not be shown, and that refuses the buy all the same", async () => {
    const { chain } = chainWith("all-locked");
    const r = await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE });
    assert.equal(r.verdict, "unknown");
    assert.equal(r.verdict === "unknown" && r.transient, false);
    assert.ok(sellRefusal(r, "X"), "and unknown refuses");
  });

  it("a balance kept where no slot override can set it is unknown, and no sale is simulated on a guess", async () => {
    const { chain } = chainWith("clean", "transform");
    const r = await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE });
    assert.equal(r.verdict, "unknown");
    assert.equal(r.verdict === "unknown" && r.transient, false);
    assert.equal(chain.log.some((l) => l.fn === "transfer"), false);
  });

  it("finds an upgradeable token's balance at slot 51", async () => {
    const { chain } = chainWith("pool-locked", 51n);
    const found = await findBalanceSlot(chain.client(), COIN, HOLDER);
    assert.equal(found.ok, true);
    assert.equal((await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE })).verdict, "locked");
  });

  it("no pool to sell into is unknown", async () => {
    const { chain } = chainWith("clean");
    assert.equal((await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [], amount: ONE })).verdict, "unknown");
  });

  it("A 429 ON THE SALE IS UNKNOWN AND TRANSIENT — never sellable, never locked", async () => {
    const { chain } = chainWith("clean");
    chain.fail = (c) => (c.fn === "transfer" ? rateLimited() : null);
    const r = await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE });
    assert.equal(r.verdict, "unknown");
    assert.equal(r.verdict === "unknown" && r.transient, true);
  });

  it("A 429 ON THE CONTROL IS UNKNOWN, not locked: a lock is only ever written on two answers from the chain", async () => {
    const { chain } = chainWith("pool-locked");
    chain.fail = (c) => (c.recipient === CONTROL_RECIPIENT.toLowerCase() ? rateLimited() : null);
    const r = await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE });
    assert.equal(r.verdict, "unknown");
  });

  it("a failed balance read while finding the slot is unknown and transient", async () => {
    const { chain } = chainWith("clean");
    chain.fail = (c) => (c.fn === "balanceOf" ? new TimeoutError({ body: {}, url: "https://rpc.example" }) : null);
    const r = await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE });
    assert.equal(r.verdict === "unknown" && r.transient, true);
  });

  it("A COIN ALREADY HELD IS ASKED ABOUT ON THE CHAIN'S OWN STATE: nothing is overridden", async () => {
    const { chain, token } = chainWith("pool-locked");
    token.balances.set(HOLDER.toLowerCase(), 7n * ONE);
    const r = await simulateSell(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: 7n * ONE, heldRaw: 7n * ONE });
    assert.equal(r.verdict, "locked");
    assert.equal(chain.log.some((l) => l.overridden), false);
    assert.equal(chain.log.some((l) => l.fn === "balanceOf"), false, "and no slot is looked for");
  });
});

describe("sellRefusal", () => {
  it("only a sellable answer lets a buy through, and each refusal names the coin", () => {
    assert.equal(sellRefusal({ verdict: "sellable" }, "MOON"), null);
    const locked = sellRefusal({ verdict: "locked", pool: POOL, detail: "a test sale into its pool was refused" }, "GATO");
    assert.equal(locked?.rule, "sell-locked");
    assert.match(locked?.detail ?? "", /^not buying GATO: /);
    const unknown = sellRefusal({ verdict: "unknown", transient: true, detail: "a test sale could not be run (HTTP 429)" }, "MOON");
    assert.equal(unknown?.rule, "sell-unverified");
    assert.match(unknown?.detail ?? "", /^not buying MOON: /);
  });
});

describe("SellLockGate — cached, shared, bounded", () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };
  const sales = (c: FakeChain) => c.log.filter((l) => l.fn === "transfer").length;
  const reads = (c: FakeChain) => c.log.filter((l) => l.fn === "balanceOf").length;

  it("a sellable answer is believed for its window and asked again after it", async () => {
    const { chain } = chainWith("clean");
    const k = clock();
    const gate = new SellLockGate({ now: k.now });
    const ask = () => gate.check(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE });
    assert.equal((await ask()).verdict, "sellable");
    assert.equal((await ask()).verdict, "sellable");
    assert.equal(sales(chain), 1, "the second ask was the cache");
    k.advance(SELL_CHECK_TTL_MS.sellable + 1);
    await ask();
    assert.equal(sales(chain), 2, "after the window it simulates again");
    assert.equal(reads(chain), 2, "but the balance slot was found once (two reads), not again");
  });

  it("a lock is believed for hours; a failed read for a minute", async () => {
    const { chain } = chainWith("pool-locked");
    const k = clock();
    const gate = new SellLockGate({ now: k.now });
    const ask = () => gate.check(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE });
    assert.equal((await ask()).verdict, "locked");
    k.advance(SELL_CHECK_TTL_MS.locked - 1);
    const before = chain.log.length;
    assert.equal((await ask()).verdict, "locked");
    assert.equal(chain.log.length, before, "no chain read inside the lock's window");

    const flaky = chainWith("clean").chain;
    flaky.fail = (c) => (c.fn === "transfer" ? rateLimited() : null);
    const g2 = new SellLockGate({ now: k.now });
    const ask2 = () => g2.check(flaky.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE });
    assert.equal((await ask2()).verdict, "unknown");
    await ask2();
    assert.equal(sales(flaky), 1, "a failed read is not retried inside its minute");
    flaky.fail = () => null;
    k.advance(SELL_CHECK_TTL_MS.unknownTransient + 1);
    assert.equal((await ask2()).verdict, "sellable", "and is asked again after it");
  });

  it("asks for the same coin at the same moment share one simulation", async () => {
    const { chain } = chainWith("clean");
    const gate = new SellLockGate();
    const req = { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE };
    const out = await Promise.all([gate.check(chain.client(), req), gate.check(chain.client(), req), gate.check(chain.client(), req)]);
    assert.deepEqual(out.map((o) => o.verdict), ["sellable", "sellable", "sellable"]);
    assert.equal(sales(chain), 1);
  });

  it("refusalFor answers from the cache alone — any holder, any pool — and forgets with the window", async () => {
    const { chain } = chainWith("pool-locked");
    const k = clock();
    const gate = new SellLockGate({ now: k.now });
    assert.equal(gate.refusalFor(COIN), null, "nothing asked, nothing known");
    await gate.check(chain.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE });
    const before = chain.log.length;
    assert.equal(gate.refusalFor(COIN.toUpperCase().replace("0X", "0x"))?.verdict, "locked");
    assert.equal(chain.log.length, before, "no read");
    k.advance(SELL_CHECK_TTL_MS.locked + 1);
    assert.equal(gate.refusalFor(COIN), null);
    const clean = chainWith("clean").chain;
    const g2 = new SellLockGate();
    await g2.check(clean.client(), { token: COIN, holder: HOLDER, pools: [POOL], amount: ONE });
    assert.equal(g2.refusalFor(COIN), null, "a sellable answer is not a refusal");
  });

  it("checkEntry sells into the LAST hop of a bridged route, the direct pool otherwise, the PoolManager for v4", async () => {
    const chain = new FakeChain();
    chain.token({ address: COIN });
    const direct = getAddress("0x00000000000000000000000000000000000d1ec7");
    chain.pool(WETH, COIN, 100, POOL);
    chain.pool(USDG, COIN, 3000, direct);
    const gate = new SellLockGate();
    const venue = { v3Factory: V3_FACTORY, v4PoolManager: V4_PM };
    const bridged = await gate.routePool(chain.client(), { tokenIn: USDG, token: COIN, fee: 500, path: { tokens: [USDG, WETH, COIN], fees: [500, 100] } }, venue);
    assert.deepEqual(bridged, { ok: true, pool: POOL });
    assert.deepEqual(await gate.routePool(chain.client(), { tokenIn: USDG, token: COIN, fee: 3000 }, venue), { ok: true, pool: direct });
    assert.deepEqual(await gate.routePool(chain.client(), { tokenIn: USDG, token: COIN, fee: 3000, v4: { key: {} } }, venue), { ok: true, pool: V4_PM });
    const getPools = chain.log.filter((l) => l.fn === "getPool").length;
    await gate.routePool(chain.client(), { tokenIn: USDG, token: COIN, fee: 3000 }, venue);
    assert.equal(chain.log.filter((l) => l.fn === "getPool").length, getPools, "a pool address, once read, is kept");
    assert.equal((await gate.checkEntry(chain.client(), { route: { tokenIn: USDG, token: COIN, fee: 3000 }, holder: HOLDER, amount: ONE, venue })).verdict, "sellable");
  });

  it("a pool that cannot be read refuses the buy, and the candidate list hears of it", async () => {
    const { chain } = chainWith("clean");
    chain.fail = (c) => (c.fn === "getPool" ? rateLimited() : null);
    const gate = new SellLockGate();
    const r = await gate.checkEntry(chain.client(), {
      route: { tokenIn: USDG, token: COIN, fee: 10000, path: { tokens: [USDG, WETH, COIN], fees: [100, 10000] } },
      holder: HOLDER,
      amount: ONE,
      venue: { v3Factory: V3_FACTORY, v4PoolManager: V4_PM },
    });
    assert.equal(r.verdict, "unknown");
    assert.equal(gate.refusalFor(COIN)?.verdict, "unknown");
  });

  it("canonicalPools finds every pool a held coin could sell into in one multicall, and a failed read is not 'none'", async () => {
    const { chain } = chainWith("clean");
    const gate = new SellLockGate();
    const venue = { v3Factory: V3_FACTORY, quotes: [USDG, WETH], fees: [100, 500, 3000, 10000] };
    assert.deepEqual(await gate.canonicalPools(chain.client(), COIN, venue), { ok: true, pools: [POOL] });
    assert.equal(chain.log.filter((l) => l.fn === "aggregate3").length, 1);
    await gate.canonicalPools(chain.client(), COIN, venue);
    assert.equal(chain.log.filter((l) => l.fn === "aggregate3").length, 1, "kept for its window");
    const down = chainWith("clean").chain;
    down.fail = (c) => (c.fn === "aggregate3" ? rateLimited() : null);
    assert.equal((await new SellLockGate().canonicalPools(down.client(), COIN, venue)).ok, false);
  });
});

/**
 * PROBE: GATO AS IT STANDS ON CHAIN, over a stubbed transport.
 *
 * The real addresses (the token, its only pool, the bridge, the factory), and
 * the one behaviour that matters, as measured on Robinhood Chain's public RPC
 * on 2026-11-06: a transfer into 0xd97ffa83…0d56 reverts for any holder but
 * the deployer, and to any other address it goes through. The live run of the
 * same module (scratch probe, read-only) returned `locked` with this pool named.
 */
describe("PROBE: GATO, the coin Shogun bought", () => {
  const GATO = getAddress("0x436b01e41314d4B010EDd24CF7c997a7D111C0aB");
  const GATO_POOL = getAddress("0xd97ffa831A40116877918FeC2C430b77D10f0d56");
  const VAULT = getAddress("0x00000000000000000000000000000000002ca2b5");
  const ACCOUNT = getAddress("0x00000000000000000000000000000000008e93ba");
  const gato = () => {
    const chain = new FakeChain();
    const token = chain.token({ address: GATO, rule: "pool-locked", layout: 0n });
    chain.pool(WETH, GATO, 100, GATO_POOL);
    token.balances.set(VAULT.toLowerCase(), 2_842_330_000_000_000_000_000n);
    return chain;
  };

  it("the ENTRY GATE refuses the buy by name — from an account that holds none of it, along the route the quoter chose", async () => {
    const chain = gato();
    const gate = new SellLockGate();
    const check = await gate.checkEntry(chain.client(), {
      route: { tokenIn: USDG, token: GATO, fee: 100, path: { tokens: [USDG, WETH, GATO], fees: [100, 100] } },
      holder: VAULT,
      amount: 2_842_330_000_000_000_000_000n,
      venue: { v3Factory: V3_FACTORY, v4PoolManager: V4_PM },
    });
    assert.equal(check.verdict, "locked");
    const refusal = sellRefusal(check, "GATO");
    assert.equal(refusal?.rule, "sell-locked");
    assert.match(refusal?.detail ?? "", /not buying GATO: a test sale into its pool 0xd97ffa831A40116877918FeC2C430b77D10f0d56 was refused/);
    assert.equal(gate.refusalFor(GATO)?.verdict, "locked", "and the Trencher's candidate list skips it from here on");
    // The same from the smart account, which holds none: the override, not a holding, made the question askable.
    assert.equal((await new SellLockGate().checkEntry(chain.client(), {
      route: { tokenIn: USDG, token: GATO, fee: 100, path: { tokens: [USDG, WETH, GATO], fees: [100, 100] } },
      holder: ACCOUNT,
      amount: ONE,
      venue: { v3Factory: V3_FACTORY, v4PoolManager: V4_PM },
    })).verdict, "locked");
  });

  it("the HELD question (the vault's own 2,842 GATO, no override) says locked too", async () => {
    const chain = gato();
    const gate = new SellLockGate();
    const pools = await gate.canonicalPools(chain.client(), GATO, { v3Factory: V3_FACTORY, quotes: [USDG, WETH], fees: [100, 500, 3000, 10000] });
    assert.deepEqual(pools, { ok: true, pools: [GATO_POOL] });
    const held = 2_842_330_000_000_000_000_000n;
    assert.equal((await gate.check(chain.client(), { token: GATO, holder: VAULT, pools: [GATO_POOL], amount: held, heldRaw: held })).verdict, "locked");
  });
});

/**
 * THE WIRING, read from SOURCE as the repo's other wiring tests do: the gate
 * is a property of where it is called, and an import proves nothing about that.
 */
describe("index.ts wiring", () => {
  const SRC = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  it("THE BUY PATH: after the route is priced and the impact judged, before minOut and any build — buys of memecoins only, never an exit", () => {
    const at = SRC.indexOf("sellLock.checkEntry(active.client");
    assert.ok(at > 0, "the gate is called");
    const impact = SRC.lastIndexOf("judgeImpact({ bps: impact", at);
    const build = SRC.indexOf("buildTrencherCalls({", at);
    const minOut = SRC.indexOf("const minOut = minOutWithSlippage(quote.amountOut", at);
    assert.ok(impact > 0 && impact < at, "after the impact guard");
    assert.ok(minOut > at && build > minOut, "before minOut and the build");
    const block = SRC.slice(SRC.lastIndexOf("{\n", at - 600), SRC.indexOf("const minOut = minOutWithSlippage(quote.amountOut", at));
    assert.match(block, /!isExit &&/, "never on an exit");
    assert.match(block, /t\.kind === "memecoin"/, "memecoins (and the Trencher vault's coins) only");
    assert.match(block, /intent\.custody === "trencher" \? grantTrencher\(active\.grant\)!\.vault : executor\.address/, "from the account that would hold it");
    assert.match(block, /reject_rule: refusal\.rule/, "refused by name");
    assert.match(block, /return;/, "and nothing is built after a refusal");
  });
  it("THE CANDIDATE LIST skips what the buy path turned back, on both Trencher paths, without a chain read", () => {
    const fn = SRC.slice(SRC.indexOf("async function trenchCandidates()"), SRC.indexOf("Open trench positions, with the baseline"));
    assert.equal(fn.match(/sellLock\.refusalFor\(/g)?.length, 2);
    assert.doesNotMatch(fn, /sellLock\.check/);
  });
});
