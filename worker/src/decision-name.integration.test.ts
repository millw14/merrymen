/**
 * AN EXIT IS STILL NAMED AFTER A REDEPLOY WIPED THE LEDGER ITS BUY WAS IN.
 *
 * The writer's first fix looked the name up in the child's own `decisions`
 * table — the name its buy used. That table is WIPED BY EVERY REDEPLOY
 * (index.ts and orchestrator.ts both say so), and the default Trencher holds a
 * coin for up to three days. So for a coin bought before the latest deploy
 * every exit and every review written afterwards went out unnamed again, and
 * the reader's fallback only looks inside its own 24h window — the feed went
 * back to "sell TA151B4A9E1B 5.01 USDG", the live defect this was meant to fix.
 *
 * What survives a redeploy is the coin itself: its contract's own `symbol()`,
 * which is the word the tape's pool label was built from. These drive the real
 * store, empty as a redeploy leaves it, and the real resolver the tick calls.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { StockToken } from "../../packages/core/src/index";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-decision-name-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
const { ChainCoinNames, makeDecisionNamer, warmHeldNames } = await import("./decision-name");
const { intentDecisionRow } = await import("./decision-row");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}

after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0x7777777777777777777777777777777777777777";
const HELD = "0x00000000000000000000000000a151b4a9e1b000" as `0x${string}`;
const COIN = `T${HELD.slice(-11).toUpperCase()}`;

/** How discovery labels a held coin the tape no longer qualifies: its own id. */
const forgotten = (over: Partial<StockToken> = {}): StockToken => ({
  symbol: COIN,
  name: COIN,
  address: HELD,
  decimals: 18,
  kind: "memecoin",
  chainlinkFeed: null,
  ...over,
} as StockToken);

const NVDA: StockToken = {
  symbol: "NVDA",
  name: "NVIDIA",
  address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  chainlinkFeed: null,
  kind: "stock",
} as StockToken;

/** A chain that answers `symbol()` from a table, and counts what it was asked. */
const chainOf = (answers: Record<string, string | Error>, opts: { delayMs?: number } = {}) => {
  const asked: string[] = [];
  const names = new ChainCoinNames(async (address) => {
    asked.push(address.toLowerCase());
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const a = answers[address.toLowerCase()];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error("execution reverted");
    return a;
  }, { retryMs: 60_000 });
  return { asked, names };
};

const namer = (watch: StockToken[], chain: InstanceType<typeof ChainCoinNames>) =>
  makeDecisionNamer({ watchTokens: () => watch, ledger: store.displayNameFor, chain });

/** Let a read that has already answered land. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

/** What discovery does for a held coin: start the read before any decision needs it. */
const warmed = async (names: InstanceType<typeof ChainCoinNames>, ...tokens: StockToken[]) => {
  for (const t of tokens) names.warm(t);
  await settle();
};

describe("after a redeploy, the coin names itself", () => {
  it("AN EXIT WRITTEN INTO AN EMPTY LEDGER, FOR A COIN THE TAPE FORGOT, CARRIES THE COIN'S OWN NAME", async () => {
    const { names } = chainOf({ [HELD]: "CASHCAT" });
    assert.equal(await store.displayNameFor(AGENT, COIN, null), null, "the ledger has nothing — as a redeploy leaves it");
    await warmed(names, forgotten());
    assert.equal(await namer([forgotten()], names)(AGENT, COIN), "CASHCAT");
  });

  it("UNWARMED, the first decision goes out unnamed rather than wait — and its read names the next", async () => {
    const { names, asked } = chainOf({ [HELD]: "CASHCAT" });
    const n = namer([forgotten()], names);
    assert.equal(await n(AGENT, COIN), null);
    assert.deepEqual(asked, [HELD]);
    await settle();
    assert.equal(await n(AGENT, COIN), "CASHCAT");
    assert.deepEqual(asked, [HELD], "answered once, remembered");
  });

  it("the tape's own name still wins, and the chain is not asked", async () => {
    const { names, asked } = chainOf({ [HELD]: "CASHCAT" });
    assert.equal(await namer([forgotten({ name: "KITTY / WETH 1%" })], names)(AGENT, COIN), "KITTY");
    assert.deepEqual(asked, []);
  });

  it("the name this agent's buy used comes before the chain's — the feed says what the buy said", async () => {
    await store.addDecision({ id: "named-buy", agent_id: AGENT, source: "brain", symbol: COIN, action: "buy", display_name: "CASHCAT" });
    const { names, asked } = chainOf({ [HELD]: "RENAMED" });
    assert.equal(await namer([forgotten()], names)(AGENT, COIN), "CASHCAT");
    assert.deepEqual(asked, [], "a ledger hit costs no chain read");
  });
});

describe("the chain's answer is display text somebody else wrote", () => {
  const other = "0x00000000000000000000000000bbbbbbbbbbb000" as `0x${string}`;
  const otherId = `T${other.slice(-11).toUpperCase()}`;
  const tok = forgotten({ symbol: otherId, name: otherId, address: other });

  it("SANITISED like the tape's: an address, or nothing readable, is no name", async () => {
    for (const raw of ["0x00000000000000000000000000bbbbbbbbbbb000", "   ", "$$", otherId]) {
      const { names, asked } = chainOf({ [other]: raw });
      await warmed(names, tok);
      assert.equal(asked.length, 1, "the read happened, so its answer is what is judged");
      assert.equal(await namer([tok], names)(AGENT + "0", otherId), null, JSON.stringify(raw));
    }
    const { names } = chainOf({ [other]: "  Pepe<script>  " });
    await warmed(names, tok);
    assert.equal(await namer([tok], names)(AGENT + "0", otherId), "Pepescript");
  });

  it("A STOCK IS NEVER LOOKED UP — its ticker is its name", async () => {
    const { names, asked } = chainOf({ [NVDA.address.toLowerCase()]: "Something Else" });
    assert.equal(await namer([NVDA], names)(AGENT, "NVDA"), null);
    assert.deepEqual(asked, []);
  });

  it("a coin outside the watch set has no address to ask about, and no name", async () => {
    const { names, asked } = chainOf({});
    assert.equal(await namer([], names)(AGENT, "TFFFFFFFFFFF"), null);
    assert.deepEqual(asked, []);
  });

  it("ONLY AN ADDRESS-DERIVED ID IS LOOKED UP — a coin with a readable ticker already has its word", async () => {
    const cate = forgotten({ symbol: "CATE", name: "CATE", address: "0x00000000000000000000000000eeeeeeeeeee000" as `0x${string}` });
    const { names, asked } = chainOf({ [cate.address.toLowerCase()]: "CATECOIN" });
    assert.equal(await namer([cate], names)(AGENT, "CATE"), null);
    assert.deepEqual(asked, []);
  });

  it("the cache never reads a stock, even asked directly", async () => {
    const { names, asked } = chainOf({ [NVDA.address.toLowerCase()]: "Something Else" });
    assert.equal(names.peek(NVDA), null);
    names.warm(NVDA);
    await settle();
    assert.equal(names.peek(NVDA), null);
    assert.deepEqual(asked, []);
  });
});

describe("a name never costs a trade", () => {
  const slow = "0x00000000000000000000000000ccccccccccc000" as `0x${string}`;
  const slowId = `T${slow.slice(-11).toUpperCase()}`;
  const tok = forgotten({ symbol: slowId, name: slowId, address: slow });

  it("A FAILED READ IS NO NAME, not a throw — and it is not retried on every decision", async () => {
    const { names, asked } = chainOf({ [slow]: new Error("rpc down") });
    const n = namer([tok], names);
    assert.equal(await n(AGENT, slowId), null);
    await settle();
    assert.equal(await n(AGENT, slowId), null);
    await settle();
    assert.equal(await n(AGENT, slowId), null);
    assert.equal(asked.length, 1, "one read per retry window, not one per decision");
  });

  it("A FAILED READ IS ASKED AGAIN once its window has passed", async () => {
    let clock = 1_000_000;
    let up = false;
    const asked: string[] = [];
    const names = new ChainCoinNames(async (address) => {
      asked.push(address);
      if (!up) throw new Error("rpc down");
      return "PHOENIX";
    }, { retryMs: 60_000, now: () => clock });
    names.warm(tok);
    await settle();
    clock += 59_000;
    up = true;
    assert.equal(names.peek(tok), null);
    await settle();
    assert.equal(asked.length, 1, "still inside the window");
    clock += 2_000;
    assert.equal(names.peek(tok), null, "the retry starts now and is not waited for");
    await settle();
    assert.equal(names.peek(tok), "PHOENIX");
    assert.equal(asked.length, 2);
  });

  it("A SLOW READ IS NO NAME, AND NO WAIT — its late answer is kept for the next decision", async () => {
    const { names } = chainOf({ [slow]: "TURTLE" }, { delayMs: 1_000 });
    const n = namer([tok], names);
    const started = Date.now();
    assert.equal(await n(AGENT, slowId), null);
    assert.ok(Date.now() - started < 200, "the decision did not wait for the chain");
    await new Promise((r) => setTimeout(r, 1_200));
    assert.equal(await n(AGENT, slowId), "TURTLE");
  });

  it("A READ THAT NEVER SETTLES does not hold the coin's slot forever", async () => {
    let clock = 5_000_000;
    const asked: string[] = [];
    const names = new ChainCoinNames((address) => {
      asked.push(address);
      return asked.length === 1 ? new Promise<unknown>(() => {}) : Promise.resolve("UNSTUCK");
    }, { staleMs: 30_000, now: () => clock });
    names.warm(tok);
    await settle();
    names.warm(tok);
    await settle();
    assert.equal(asked.length, 1, "in flight, and not stale yet");
    clock += 31_000;
    names.warm(tok);
    await settle();
    assert.equal(asked.length, 2);
    assert.equal(names.peek(tok), "UNSTUCK");
  });

  it("A READER THAT THROWS AT ONCE is a failed read, not an exception out of the decision", async () => {
    const names = new ChainCoinNames(() => {
      throw new Error("client not configured");
    });
    assert.doesNotThrow(() => names.warm(tok));
    await settle();
    assert.equal(await namer([tok], names)(AGENT, slowId), null);
  });

  it("NOTHING HERE THROWS INTO THE WRITER — not the chain step, and not the resolver", async () => {
    const lost = "0x00000000000000000000000000fffffffffff000" as `0x${string}`;
    const id = `T${lost.slice(-11).toUpperCase()}`;
    assert.equal(await store.displayNameFor(AGENT, id, null, async () => { throw new Error("rpc down"); }), null);
    const broken = makeDecisionNamer({
      watchTokens: () => { throw new Error("watch set unreadable"); },
      ledger: store.displayNameFor,
      chain: chainOf({}).names,
    });
    assert.equal(await broken(AGENT, id), null);
    const ledgerDown = makeDecisionNamer({
      watchTokens: () => [forgotten({ symbol: id, name: id, address: lost })],
      ledger: async () => { throw new Error("database is locked"); },
      chain: chainOf({}).names,
    });
    assert.equal(await ledgerDown(AGENT, id), null);
  });

  it("CONCURRENT ASKS SHARE ONE READ", async () => {
    const coin = "0x00000000000000000000000000abcabcabcab000" as `0x${string}`;
    const tok = forgotten({ symbol: `T${coin.slice(-11).toUpperCase()}`, name: "x", address: coin });
    const { names, asked } = chainOf({ [coin]: "SHARED" }, { delayMs: 10 });
    assert.deepEqual([names.peek(tok), names.peek(tok), names.peek(tok)], [null, null, null]);
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual([names.peek(tok), names.peek(tok), names.peek(tok)], ["SHARED", "SHARED", "SHARED"]);
    assert.equal(asked.length, 1);
  });

  it("ONE READ PER COIN: an answer is remembered, and concurrent asks share it", async () => {
    const coin = "0x00000000000000000000000000ddddddddddd000" as `0x${string}`;
    const id = `T${coin.slice(-11).toUpperCase()}`;
    const { names, asked } = chainOf({ [coin]: "DOGWIF" });
    const tok = forgotten({ symbol: id, name: id, address: coin });
    const n = namer([tok], names);
    const [a, b] = await Promise.all([n(AGENT, id), n(AGENT, id)]);
    assert.equal(a, null, "no answer yet, and no wait for one");
    assert.equal(b, null);
    await settle();
    assert.equal(await n(AGENT, id), "DOGWIF");
    assert.equal(await n(AGENT, id), "DOGWIF");
    names.warm(tok);
    await settle();
    assert.equal(asked.length, 1);
  });
});

describe("a name read is never on the send path", () => {
  // A mainnet RPC that has not answered: a name is display text, and an exit
  // that waits on it is a stop that fires late. The probe that found this had
  // three exits in one tick wait 4.5s between them for names, and the next
  // tick wait again for the same coin while its read was still in flight.
  const coins = [
    "0x00000000000000000000000000111111111a1000",
    "0x00000000000000000000000000222222222b2000",
    "0x00000000000000000000000000333333333c3000",
  ] as `0x${string}`[];
  const toks = coins.map((a) => forgotten({ symbol: `T${a.slice(-11).toUpperCase()}`, name: `T${a.slice(-11).toUpperCase()}`, address: a }));
  const flush = () => new Promise((r) => setImmediate(r));

  it("THREE EXITS IN ONE TICK DO NOT WAIT FOR A READ THAT HAS NOT ANSWERED — and neither does the next tick", async () => {
    let answer!: (v: unknown) => void;
    const hanging = new Promise<unknown>((r) => {
      answer = r;
    });
    const asked: string[] = [];
    // The production bounds, not a test-sized timeout: the defect was the bound.
    const names = new ChainCoinNames((address) => {
      asked.push(address.toLowerCase());
      return hanging;
    });
    const n = namer(toks, names);
    const started = Date.now();
    for (const t of toks) assert.equal(await n(AGENT, t.symbol), null, "no name yet, and no wait for one");
    assert.ok(Date.now() - started < 250, `three exits waited ${Date.now() - started}ms for names`);
    const again = Date.now();
    assert.equal(await n(AGENT, toks[0]!.symbol), null);
    assert.ok(Date.now() - again < 100, `the next tick waited ${Date.now() - again}ms again`);
    assert.equal(asked.length, 3, "one read per coin, still in flight — not a second one");
    answer("LATECAT");
    await flush();
    await flush();
    assert.equal(await n(AGENT, toks[0]!.symbol), "LATECAT", "the late answer names the next row");
  });
});

describe("discovery starts the reads for what is held", () => {
  const heldAddr = "0x00000000000000000000000000444444444d4000" as `0x${string}`;
  const tapeAddr = "0x00000000000000000000000000555555555e5000" as `0x${string}`;
  const heldTok = forgotten({ symbol: `T${heldAddr.slice(-11).toUpperCase()}`, name: `T${heldAddr.slice(-11).toUpperCase()}`, address: heldAddr });
  const tapeTok = forgotten({ symbol: `T${tapeAddr.slice(-11).toUpperCase()}`, name: "FRESH / WETH 1%", address: tapeAddr });

  it("A HELD COIN'S READ STARTS AT DISCOVERY, so its first exit after a redeploy is named", async () => {
    const { names, asked } = chainOf({ [heldAddr]: "HODLCAT", [tapeAddr]: "FRESH" });
    // The vault reports its holdings checksummed; the token list is lower-case.
    warmHeldNames(names, { tokens: [heldTok, tapeTok], held: [heldAddr.toUpperCase().replace("0X", "0x")] });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(asked, [heldAddr], "held coins only — a pool nobody bought has the tape's label");
    assert.equal(await namer([heldTok], names)(AGENT, heldTok.symbol), "HODLCAT", "the exit waits for nothing and is named");
  });

  it("NEVER THROWS into discovery's handler, whose failure path tells the owner discovery failed", async () => {
    const { names, asked } = chainOf({});
    const broken = { symbol: "TBROKEN00000", kind: "memecoin" } as unknown as StockToken;
    assert.doesNotThrow(() => warmHeldNames(names, { tokens: [broken, heldTok], held: [heldAddr] }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(asked, [heldAddr], "a malformed row costs its own name, not the next coin's");
    assert.doesNotThrow(() => warmHeldNames(names, { tokens: [heldTok], held: [null as unknown as string] }));
    assert.doesNotThrow(() => warmHeldNames({ warm: () => { throw new Error("boom"); } }, { tokens: [heldTok], held: [heldAddr] }));
  });
});

describe("the row ensureDecision stamps a trade with, executed", () => {
  // ensureDecision (index.ts) writes this row before any trade the tick sends
  // may execute. It was assembled inline in main(), which no test boots: the
  // checker put the name back on the ledger alone and every test passed.
  const readRow = async (id: string) => {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
    try {
      const r = raw.prepare("SELECT symbol, display_name, action, size_usdg, reason, provenance, source, evidence_json FROM decisions WHERE id = ?").get(id);
      return r ? { ...r } : undefined;
    } finally {
      raw.close();
    }
  };
  const exitAddr = "0x00000000000000000000000000666666666f6000" as `0x${string}`;
  const exitId = `T${exitAddr.slice(-11).toUpperCase()}`;
  const exitTok = forgotten({ symbol: exitId, name: exitId, address: exitAddr });

  it("A STOP ON A COIN THE TAPE FORGOT, AFTER A REDEPLOY, IS WRITTEN WITH THE COIN'S OWN NAME", async () => {
    const { names } = chainOf({ [exitAddr]: "STOPCAT" });
    await warmed(names, exitTok);
    await store.addDecision(
      await intentDecisionRow({
        id: "row-stop",
        agentId: AGENT,
        source: "strategy:trencher",
        reason: "stop",
        described: { action: "sell", symbol: exitId, sizeUsdg: 4.2 },
        known: { whyCode: "stop-floor" },
        name: namer([exitTok], names),
      }),
    );
    assert.deepEqual(await readRow("row-stop"), {
      symbol: exitId,
      display_name: "STOPCAT",
      action: "sell",
      size_usdg: 4.2,
      reason: "stop",
      provenance: "hard-risk-exit",
      source: "strategy:trencher",
      evidence_json: null,
    });
  });

  it("THE NAME IS ASKED FOR THE ROW'S OWN SYMBOL — the producer's, when it knows one the intent cannot say", async () => {
    // A class token is in no watch list, so describeIntent finds no symbol for
    // it; the class route passes the one it built the intent with.
    const asked: string[] = [];
    const r = await intentDecisionRow({
      id: "row-class",
      agentId: AGENT,
      source: "class-route",
      described: { action: "buy", sizeUsdg: 5 },
      known: { symbol: "TCLASS000001", action: "sell", evidence: "{\"band\":1}", provenance: "deterministic-strategy" },
      name: async (_a, s) => {
        asked.push(s);
        return s === "TCLASS000001" ? "CLASSY" : null;
      },
    });
    assert.deepEqual(asked, ["TCLASS000001"]);
    assert.equal(r.display_name, "CLASSY");
    assert.equal(r.symbol, "TCLASS000001");
    assert.equal(r.action, "sell", "the producer knows which side it is on");
    assert.equal(r.evidence_json, "{\"band\":1}");
    assert.equal(r.provenance, "deterministic-strategy");
    // And where the description does name something, the producer's own
    // symbol still wins — it built the intent.
    const both = await intentDecisionRow({
      id: "row-both",
      agentId: AGENT,
      source: "class-route",
      described: { action: "buy", symbol: "TDESCRIBED01", sizeUsdg: 5 },
      known: { symbol: "TCLASS000001" },
      name: async (_a, s) => {
        asked.push(s);
        return null;
      },
    });
    assert.equal(both.symbol, "TCLASS000001");
    assert.equal(asked.at(-1), "TCLASS000001");
    const plain = await intentDecisionRow({
      id: "row-plain",
      agentId: AGENT,
      source: "chat",
      described: { action: "buy", symbol: "NVDA", sizeUsdg: 5 },
      name: async (_a, s) => {
        asked.push(s);
        return null;
      },
    });
    assert.equal(asked.at(-1), "NVDA");
    assert.equal(plain.symbol, "NVDA");
    assert.equal(plain.provenance, "owner-command");
    assert.equal(plain.evidence_json, null);
    assert.equal(plain.display_name, null);
  });

  it("A NAME NOBODY HAS YET IS NO WAIT, and a namer that throws costs the name — never the trade", async () => {
    const names = new ChainCoinNames(() => new Promise<unknown>(() => {}));
    const started = Date.now();
    const r = await intentDecisionRow({
      id: "row-hang",
      agentId: AGENT,
      source: "strategy:trencher",
      described: { action: "sell", symbol: exitId, sizeUsdg: 1 },
      known: { whyCode: "trench-exit" },
      name: makeDecisionNamer({ watchTokens: () => [exitTok], ledger: async (_a, _s, _t, chain) => (chain ? chain() : null), chain: names }),
    });
    assert.ok(Date.now() - started < 100, `the row waited ${Date.now() - started}ms for a name`);
    assert.equal(r.display_name, null);
    assert.equal(r.provenance, "hard-risk-exit");
    const thrown = await intentDecisionRow({
      id: "row-throw",
      agentId: AGENT,
      source: "strategy:trencher",
      described: { action: "sell", symbol: exitId, sizeUsdg: 1 },
      name: async () => {
        throw new Error("namer broke");
      },
    });
    assert.equal(thrown.display_name, null);
    assert.equal(thrown.action, "sell");
  });
});
