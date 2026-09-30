/**
 * THE CLASS ROUTE'S ENTRY GATE SAYS WHY IT CLOSED.
 *
 * Under a tripped breaker the tick stops asking the class route for entries —
 * every one would be a buy the wall refuses. But it said nothing, and the
 * strategy's own breaker reason is raised only by a strategy that has legs to
 * buy. So for an agent whose class route is the buyer and whose strategy has
 * no legs — Crypto only over an equities basket, with a Pons vault sealed in —
 * the one buyer went silent and the owner was told nothing at all: intents 0,
 * no idle reason, no event (the checker's probe C). The gate now hands the
 * breaker's reason to the idle channel when it is what closed a route that
 * would have looked.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classEntryGate, classRouteLooks, idleAndClassGate } from "./class-entry-gate";
import { breakerResetLine, IdleChannel, modeEmptiedFact, type ShownNotice } from "./idle-notice";
import { makeDipHunter } from "./strategies/dip-hunter";
import { evenKeelTick } from "./strategies/even-keel";
import { renderWhy, type Why } from "./strategies/reasons";
import { steadyBasketTick } from "./strategies/steady-basket";
import { drawdownOf, takeTick, type Snapshot, type Tick } from "./strategies/types";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const CLASS_VAULT = "0x9999999999999999999999999999999999999999";
const QQQ = "0x4444444444444444444444444444444444444444" as const;
const NVDA = "0x5555555555555555555555555555555555555555" as const;
const AGENT = "0xagent";

const TRIPPED = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 875_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });
const CLEAR = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 990_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: 900_000_000n,
  vaultUsdg: 0n,
  holdings: new Map(),
  prices: new Map(),
  pausedTokens: new Set(),
  staleFeeds: new Set(),
  sequencerUp: true,
  spendHeadroomUsdg: 1_000_000_000_000n,
  perTradeCapUsdg: 1_000_000_000_000n,
  ...over,
});

const underOne: Why = { code: "under-one-buy", cashRaw: 1_000_000n, needRaw: 5_000_000n, vaultRaw: 0n };
const breaker: Why = { code: "breaker-tripped", limitBps: 1_000 };

/** The events table as recording sinks, with the desk's rule over it: newest warn among the newest 40. */
function desk() {
  let clock = 1_800_000_000_000;
  let seq = 0;
  const events: { level: string; message: string; atMs: number; id: number }[] = [];
  const rows: { reason: string }[] = [];
  const noticeOf = (): ShownNotice | null => {
    const hit = [...events]
      .sort((a, b) => b.atMs - a.atMs || b.id - a.id)
      .slice(0, 40)
      .find((e) => e.level === "warn" || e.level === "err");
    return hit ? { message: hit.message, atMs: hit.atMs } : null;
  };
  const channel = new IdleChannel({
    addEvent: async (_a, level, message) => {
      events.push({ level, message, atMs: Math.floor(clock / 1000) * 1000, id: ++seq });
    },
    addDecision: async (row) => {
      rows.push(row);
    },
    newDecisionId: () => `d${seq}`,
    shownNotice: async () => noticeOf(),
    now: () => clock,
  });
  return {
    channel,
    events,
    rows,
    said: () => events.map((e) => [e.level, e.message]),
    shows: () => noticeOf()?.message ?? "(no notice)",
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("a tripped breaker that closes the class route is told to the owner", () => {
  it("THE CHECKER'S CASE: no legs, the class route is the buyer — and the owner gets the breaker's warning", async () => {
    const book = snap({ drawdown: TRIPPED });
    // Crypto only over an equities basket: every leg filtered out.
    const tick = takeTick(steadyBasketTick({ legs: [], buyPerTickUsdg: 25_000_000n, idleFloorUsdg: 50_000_000n, swapRouter: ROUTER, vault: ROUTER, usdg: USDG }, book));
    assert.equal(tick.intents.length, 0);
    assert.equal(tick.idle, undefined, "the strategy has no legs, so it has no breaker to report");
    const modeEmptied = modeEmptiedFact("crypto", (mode) => (mode === "all" ? 3 : 0));
    const gate = classEntryGate({
      snap: book,
      routeLooks: classRouteLooks({ paper: false, assetMode: "crypto", vault: CLASS_VAULT }),
      idle: tick.idle,
    });
    assert.equal(gate.propose, false, "no class entry is proposed under the breaker");
    assert.deepEqual(gate.idle, { code: "breaker-tripped", limitBps: 1_000 });

    const events: { level: string; message: string }[] = [];
    const rows: unknown[] = [];
    const ch = new IdleChannel({
      addEvent: async (_a, level, message) => {
        events.push({ level, message });
      },
      addDecision: async (row) => {
        rows.push(row);
      },
      newDecisionId: () => "d",
      shownNotice: async (): Promise<ShownNotice | null> => null,
    });
    await ch.tell({ agentId: "0xagent", strategyName: "steady-basket", idle: gate.idle, modeEmptied });
    assert.deepEqual(events, [{ level: "warn", message: renderWhy(gate.idle!) }], "a warning, at a level the desk shows");
    assert.deepEqual(rows, [], "account state stays off the public feed");
  });

  it("TRIPPED, THE BREAKER'S REASON WINS over any other a strategy gave — with a route or without", () => {
    // Every reason a builtin can go quiet with. Under a tripped breaker none of
    // them is what stops buying on its own: cash added, feeds back, a new day —
    // the wall still refuses every buy.
    const reasons: Why[] = [
      underOne,
      { code: "all-legs-stale", legs: 2, paused: 0 },
      { code: "budget-spent", capRaw: 25_000_000n },
      { code: "ops-spent" },
      { code: "model-held", held: 1, considered: 3, dropped: 0 },
    ];
    for (const idle of reasons) {
      for (const routeLooks of [true, false]) {
        const gate = classEntryGate({ snap: snap({ drawdown: TRIPPED }), routeLooks, idle });
        assert.equal(gate.propose, false);
        assert.deepEqual(gate.idle, breaker, `${idle.code}, routeLooks ${routeLooks}`);
      }
    }
  });

  it("THE CHECKER'S PROBE, even-keel over a stale weekend: tripped, class vault sealed — the breaker at warn, and no post", async () => {
    const book = snap({ drawdown: TRIPPED, staleFeeds: new Set(["QQQ", "NVDA"]) });
    const tick = takeTick(
      evenKeelTick(
        {
          legs: [
            { symbol: "QQQ", token: QQQ },
            { symbol: "NVDA", token: NVDA },
          ],
          swapRouter: ROUTER,
          usdg: USDG,
          maxTradeUsdg: 25_000_000n,
          bandBps: 500,
          seedBudgetUsdg: 100_000_000n,
        },
        book,
      ),
    );
    assert.equal(tick.idle?.code, "all-legs-stale", "the strategy's own reason, as the checker found it");
    const gate = classEntryGate({ snap: book, routeLooks: classRouteLooks({ paper: false, assetMode: "all", vault: CLASS_VAULT }), idle: tick.idle });
    assert.deepEqual(gate.idle, breaker);
    const d = desk();
    await d.channel.tell({ agentId: AGENT, strategyName: "even-keel", idle: gate.idle, modeEmptied: null, drawdown: book.drawdown });
    assert.deepEqual(d.said(), [["warn", renderWhy(breaker)]]);
    assert.deepEqual(d.rows, [], "account state stays off the public feed");
    assert.equal(d.shows(), renderWhy(breaker));
  });

  it("THE CHECKER'S PROBE, dip-hunter under one buy (and with the day's count spent): never 'Add funds' while the breaker refuses every buy", async () => {
    for (const over of [{ cashUsdg: 3_000_000n }, { opsHeadroom: 0 }] as Partial<Snapshot>[]) {
      const book = snap({ drawdown: TRIPPED, ...over });
      const s = makeDipHunter({ legs: [{ symbol: "NVDA", token: NVDA }], swapRouter: ROUTER, usdg: USDG, buyPerTickUsdg: 25_000_000n, minDipBps: 300 });
      const tick = takeTick(await s.tick(book));
      assert.notEqual(tick.idle?.code, "breaker-tripped", "the strategy ranks its own reason first, as the checker found");
      const gate = classEntryGate({ snap: book, routeLooks: classRouteLooks({ paper: false, assetMode: "all", vault: CLASS_VAULT }), idle: tick.idle });
      const d = desk();
      for (let i = 0; i < 50; i++) {
        await d.channel.tell({ agentId: AGENT, strategyName: "dip-hunter", idle: gate.idle, modeEmptied: null, drawdown: book.drawdown });
        d.advance(240_000);
      }
      assert.deepEqual(d.said(), [["warn", renderWhy(breaker)]], JSON.stringify(Object.keys(over)));
      assert.deepEqual(d.rows, []);
      assert.doesNotMatch(d.shows(), /Add funds/);
    }
  });

  it("A ROUTE THAT WOULD NOT HAVE LOOKED is not given a reason it did not have", () => {
    for (const routeLooks of [
      classRouteLooks({ paper: true, assetMode: "crypto", vault: CLASS_VAULT }),
      classRouteLooks({ paper: false, assetMode: "stocks", vault: CLASS_VAULT }),
      classRouteLooks({ paper: false, assetMode: "all", vault: null }),
    ]) {
      const gate = classEntryGate({ snap: snap({ drawdown: TRIPPED }), routeLooks, idle: undefined });
      assert.equal(gate.propose, false);
      assert.equal(gate.idle, undefined);
    }
  });

  it("NOT TRIPPED — or not measured — the route is asked, and the idle reason is the strategy's alone", () => {
    for (const drawdown of [CLEAR, null, undefined]) {
      const gate = classEntryGate({ snap: snap({ drawdown }), routeLooks: true, idle: underOne });
      assert.equal(gate.propose, true, JSON.stringify(drawdown));
      assert.equal(gate.idle, underOne);
      assert.equal(classEntryGate({ snap: snap({ drawdown }), routeLooks: true, idle: undefined }).idle, undefined);
    }
  });
});

/**
 * R3WK-4. index.ts ran the gate, handed tell() the gate's idle and consulted
 * `.propose` before asking the class route for entries — three argument lists
 * in main() that no test reached, so reverting any of them left every test
 * green. idleAndClassGate is those lines; main() calls it and the entries it
 * hands back.
 */
describe("the tick's idle write and the class gate, as main() runs them", () => {
  const entryTick: Tick = { intents: [{ kind: "swap" } as never], why: [null] };
  const spy = () => {
    let calls = 0;
    return {
      propose: async () => {
        calls++;
        return entryTick;
      },
      calls: () => calls,
    };
  };
  const looks = classRouteLooks({ paper: false, assetMode: "crypto", vault: CLASS_VAULT });

  it("TRIPPED, NO LEGS, THE CLASS ROUTE THE BUYER: the owner is told the breaker, and entries are never asked for", async () => {
    const d = desk();
    const book = snap({ drawdown: TRIPPED });
    const gate = await idleAndClassGate({ channel: d.channel, agentId: AGENT, strategyName: "steady-basket", snap: book, routeLooks: looks, idle: undefined, modeEmptied: null });
    assert.deepEqual(d.said(), [["warn", renderWhy(breaker)]], "the gate's reason, not the strategy's silence");
    const s = spy();
    assert.deepEqual(await gate.entries(s.propose), { intents: [], why: [] });
    assert.equal(s.calls(), 0, "no class entry is proposed under the breaker");
  });

  it("TRIPPED WITH A REASON OF ITS OWN: the breaker's is what the owner hears", async () => {
    const d = desk();
    await idleAndClassGate({ channel: d.channel, agentId: AGENT, strategyName: "dip-hunter", snap: snap({ drawdown: TRIPPED }), routeLooks: looks, idle: underOne, modeEmptied: null });
    assert.deepEqual(d.said(), [["warn", renderWhy(breaker)]]);
    assert.deepEqual(d.rows, []);
  });

  it("CLEAR: the strategy's reason is told as it always was, and the class route is asked", async () => {
    const d = desk();
    const gate = await idleAndClassGate({ channel: d.channel, agentId: AGENT, strategyName: "steady-basket", snap: snap({ drawdown: CLEAR }), routeLooks: looks, idle: underOne, modeEmptied: null });
    assert.deepEqual(d.said(), [["ok", renderWhy(underOne)]]);
    assert.equal(d.rows.length, 1);
    const s = spy();
    assert.equal(await gate.entries(s.propose), entryTick);
    assert.equal(s.calls(), 1);
  });

  it("THE BREAKER AS THE TICK MEASURED IT reaches the channel: a trip, then a clear, and the desk says buying resumes", async () => {
    const d = desk();
    await idleAndClassGate({ channel: d.channel, agentId: AGENT, strategyName: "steady-basket", snap: snap({ drawdown: TRIPPED }), routeLooks: looks, idle: undefined, modeEmptied: null });
    d.advance(240_000);
    await idleAndClassGate({ channel: d.channel, agentId: AGENT, strategyName: "steady-basket", snap: snap({ drawdown: CLEAR }), routeLooks: looks, idle: undefined, modeEmptied: null });
    assert.equal(d.shows(), breakerResetLine(null));
  });

  it("the emptied mode rides the same call", async () => {
    const d = desk();
    const fact = modeEmptiedFact("crypto", (mode) => (mode === "all" ? 3 : 0));
    await idleAndClassGate({ channel: d.channel, agentId: AGENT, strategyName: "steady-basket", snap: snap({ drawdown: CLEAR }), routeLooks: false, idle: undefined, modeEmptied: fact });
    assert.equal(d.events.length, 1);
    assert.equal(d.rows[0]!.reason, fact);
  });
});

describe("whether the class route would look at all — proposeClassEntries' own first gates", () => {
  it("live, a coin-admitting mode, and a vault sealed into the grant", () => {
    assert.equal(classRouteLooks({ paper: false, assetMode: "crypto", vault: CLASS_VAULT }), true);
    assert.equal(classRouteLooks({ paper: false, assetMode: "all", vault: CLASS_VAULT }), true);
  });

  it("paper cannot simulate a class fill; stocks-only excludes the route; no vault, no route", () => {
    assert.equal(classRouteLooks({ paper: true, assetMode: "all", vault: CLASS_VAULT }), false);
    assert.equal(classRouteLooks({ paper: false, assetMode: "stocks", vault: CLASS_VAULT }), false);
    assert.equal(classRouteLooks({ paper: false, assetMode: "all", vault: null }), false);
    assert.equal(classRouteLooks({ paper: false, assetMode: "all", vault: undefined }), false);
  });
});

/**
 * TODAY'S ENERGY CLOSES THE CLASS ROUTE'S ENTRIES, AND ONLY THE ENTRIES.
 *
 * A low-energy agent whose new trades for the UTC day are used up asks the
 * class route for no entries — every one would be withheld — while its exits
 * run untouched above this gate. It says nothing through the idle channel:
 * energy has its own once-a-day notice, and a tripped breaker's reason still
 * wins when both are true.
 */
describe("entriesOpen — today's energy", () => {
  const looks = classRouteLooks({ paper: false, assetMode: "crypto", vault: CLASS_VAULT });
  it("CLOSED: nothing proposed, and the strategy's own reason is left exactly as it was", () => {
    assert.deepEqual(classEntryGate({ snap: snap({ drawdown: CLEAR }), routeLooks: looks, idle: underOne, entriesOpen: false }), {
      propose: false,
      idle: underOne,
    });
    assert.deepEqual(classEntryGate({ snap: snap({ drawdown: CLEAR }), routeLooks: looks, idle: undefined, entriesOpen: false }), {
      propose: false,
      idle: undefined,
    });
  });

  it("A TRIPPED BREAKER STILL WINS — its reason, not energy's silence", () => {
    assert.deepEqual(classEntryGate({ snap: snap({ drawdown: TRIPPED }), routeLooks: looks, idle: underOne, entriesOpen: false }), {
      propose: false,
      idle: breaker,
    });
  });

  it("omitted or true: the existing behaviour, unchanged", () => {
    for (const entriesOpen of [undefined, true]) {
      assert.deepEqual(classEntryGate({ snap: snap({ drawdown: CLEAR }), routeLooks: looks, idle: underOne, ...(entriesOpen === undefined ? {} : { entriesOpen }) }), {
        propose: true,
        idle: underOne,
      });
    }
  });

  it("through idleAndClassGate: entries are never asked for, and the channel hears only the strategy", async () => {
    const d = desk();
    const gate = await idleAndClassGate({ channel: d.channel, agentId: AGENT, strategyName: "steady-basket", snap: snap({ drawdown: CLEAR }), routeLooks: looks, idle: underOne, modeEmptied: null, entriesOpen: false });
    assert.deepEqual(d.said(), [["ok", renderWhy(underOne)]], "no energy line through the idle channel");
    let calls = 0;
    assert.deepEqual(await gate.entries(async () => (calls++, { intents: [{ kind: "swap" } as never], why: [null] })), { intents: [], why: [] });
    assert.equal(calls, 0);
  });
});
