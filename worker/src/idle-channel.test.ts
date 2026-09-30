/**
 * THE TICK'S IDLE WRITE, EXECUTED — and the owner's notice kept current.
 *
 * The idle block in index.ts's main() held `lastIdleReason` and wrote what
 * idleNotice decided, and nothing booted it: the checker reverted the change
 * gate, published the owner's remedy sentence as the post, and put the breaker
 * back at "ok", and every test in the repo still passed. IdleChannel is that
 * block, whole, with the store's writers injected — so these run the real
 * thing into recording sinks.
 *
 * And the second half: a reason that cannot be a post is told to the owner as
 * a WARNING, once per change. But the desk notice, the rail and the Android
 * app show only the newest warn among the newest 40 events (web
 * api/feed/route.ts LIMIT 40, newest first; terminal/live.ts and Core.kt take
 * the first warn). One warning written at the moment the breaker tripped is
 * replaced by the next warn anyone writes, or aged out by the running
 * commentary, and for the rest of a long trip the owner reads a stale, false
 * reason or nothing at all. The desk here is that rule over a recorded table.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classRouteLooks, idleAndClassGate } from "./class-entry-gate";
import { breakerResetLine, IdleChannel, MODE_EMPTIED_REMEDY, RESTATE_AFTER_MS, withEarlier, type ShownNotice } from "./idle-notice";
import { makeLlmStrategist } from "./strategist/strategy";
import { evenKeelTick } from "./strategies/even-keel";
import { renderWhy, type Why } from "./strategies/reasons";
import { steadyBasketTick, type SteadyBasketConfig } from "./strategies/steady-basket";
import { makeTrencher, TRENCHER_DEFAULTS } from "./strategies/trencher";
import { drawdownOf, takeTick, type Snapshot } from "./strategies/types";
import { weekendGapTick } from "./strategies/weekend-gap";
import { publicationSourceFor } from "./thesis-policy";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const QQQ = "0x4444444444444444444444444444444444444444" as const;
const NVDA = "0x5555555555555555555555555555555555555555" as const;
const AGENT = "0xagent";
const TICK_MS = 240_000;

const TRIPPED = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 875_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });
const CLEAR = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 990_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });

const basket: SteadyBasketConfig = {
  legs: [
    { symbol: "QQQ", token: QQQ, weightBps: 5000 },
    { symbol: "NVDA", token: NVDA, weightBps: 5000 },
  ],
  buyPerTickUsdg: 25_000_000n,
  idleFloorUsdg: 50_000_000n,
  swapRouter: ROUTER,
  vault: VAULT,
  usdg: USDG,
};

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

type Ev = { agentId: string; level: string; message: string; atMs: number; id: number };

/**
 * The events table and the decisions table as recording sinks, and the desk's
 * own rule over them: newest first by (created_at, id), the newest 40, the
 * first warn or err.
 */
function desk(opts: { shown?: "unreadable" | "throws" } = {}) {
  const read = { shown: opts.shown as "unreadable" | "throws" | undefined, dropWrites: false };
  let clock = 1_800_000_000_000;
  let seq = 0;
  let ids = 0;
  const events: Ev[] = [];
  const rows: { id: string; agent_id: string; source: string; reason: string }[] = [];
  const noticeOf = (agentId: string): ShownNotice | null => {
    const newest = events
      .filter((e) => e.agentId === agentId)
      .sort((a, b) => b.atMs - a.atMs || b.id - a.id)
      .slice(0, 40);
    const hit = newest.find((e) => (e.level === "warn" || e.level === "err") && !!e.message);
    return hit ? { message: hit.message, atMs: hit.atMs } : null;
  };
  const write = (level: string, message: string, agentId = AGENT) => {
    // created_at is whole seconds, as the table stores it.
    events.push({ agentId, level, message, atMs: Math.floor(clock / 1000) * 1000, id: ++seq });
  };
  const sinks = {
    // store.addEvent swallows a failed insert; dropWrites is that failure.
    addEvent: async (agentId: string, level: "ok" | "warn", message: string) => {
      if (!read.dropWrites) write(level, message, agentId);
    },
    addDecision: async (row: { id: string; agent_id: string; source: string; reason: string }) => {
      rows.push(row);
    },
    newDecisionId: () => `d${++ids}`,
    shownNotice: async (agentId: string): Promise<ShownNotice | null | undefined> => {
      if (read.shown === "unreadable") return undefined;
      if (read.shown === "throws") throw new Error("database is locked");
      return noticeOf(agentId);
    },
    now: () => clock,
  };
  return {
    sinks,
    events,
    rows,
    /** What the desk notice reads right now. */
    shows: () => noticeOf(AGENT)?.message ?? "(no notice)",
    /** Somebody else's line: a trenchNotice warn, a strategist note. */
    write,
    advance: (ms: number) => {
      clock += ms;
    },
    warns: (message: string) => events.filter((e) => e.level === "warn" && e.message === message).length,
    /** Warn lines that lead with this sentence — said alone, or carrying another warn after it. */
    leads: (head: string) => events.filter((e) => e.level === "warn" && (e.message === head || e.message.startsWith(`${head}. `))).length,
    /** Switch the desk's read while the test runs: readable (undefined), unreadable, or throwing. */
    read,
  };
}

describe("the idle write, executed", () => {
  it("A TRIPPED BREAKER IS ONE WARNING AND NO ROW — the basket's own idle reason on a tripped book", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const idle = takeTick(steadyBasketTick(basket, snap({ drawdown: TRIPPED }))).idle;
    assert.equal(idle?.code, "breaker-tripped");
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle, modeEmptied: null });
    assert.deepEqual(
      d.events.map((e) => [e.level, e.message]),
      [["warn", renderWhy(idle!)]],
    );
    assert.deepEqual(d.rows, [], "account state stays off the public feed");
    assert.equal(d.shows(), renderWhy(idle!));
  });

  it("A REASON THAT POSTS: its event at ok, and a view row in the PUBLIC register — never the owner's remedy", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "llm-strategist(anthropic:claude-opus-4)", idle: underOne, modeEmptied: null });
    assert.deepEqual(
      d.events.map((e) => [e.level, e.message]),
      [["ok", renderWhy(underOne)]],
    );
    assert.match(d.events[0]!.message, /Add funds or lower the size per trade/, "the owner's copy keeps its remedy");
    assert.equal(d.rows.length, 1);
    const row = d.rows[0]!;
    assert.equal(row.reason, renderWhy(underOne, "public"));
    assert.doesNotMatch(row.reason, /Add funds/, "a remedy is advice to the owner, not a post");
    assert.equal(row.source, publicationSourceFor("llm-strategist(anthropic:claude-opus-4)"));
    assert.equal(row.agent_id, AGENT);
    assert.equal(row.id, "d1", "the store's own id");
    assert.deepEqual(Object.keys(row).sort(), ["agent_id", "id", "reason", "source"], "no action, no symbol, no size: a view");
  });

  it("ONCE PER CHANGE: a second identical tick writes nothing — no event, no row", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    for (let i = 0; i < 5; i++) {
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
      d.advance(TICK_MS);
    }
    assert.equal(d.events.length, 1);
    assert.equal(d.rows.length, 1);
  });

  it("a tick that traded clears it, so the same reason afterwards is said again", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null });
    assert.equal(d.events.length, 1, "a tick with intents says nothing here");
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
    assert.equal(d.events.length, 2);
    assert.equal(d.rows.length, 2);
  });

  it("AN EMPTIED MODE: the remedy to the owner, the plain fact to the feed — and a strategy's own reason wins", async () => {
    const fact = "nothing in your basket is a coin, and your asset mode is Crypto only — so there is nothing to trade";
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: fact });
    assert.deepEqual(d.events.map((e) => [e.level, e.message]), [["ok", `${fact}. ${MODE_EMPTIED_REMEDY}`]]);
    assert.equal(d.rows[0]!.reason, fact);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: fact });
    assert.equal(d.events.at(-1)!.message, renderWhy(underOne));
  });
});

describe("the owner's notice stays current while the breaker is tripped", () => {
  it("A LATER WARN REPLACES THE BREAKER ON THE DESK: once it has had its time, the breaker is said again", async () => {
    // The checker's probe A: a fast Trencher, one transient discovery failure
    // after the trip, then hundreds of healthy braked ticks.
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const trencher = makeTrencher({
      cfg: TRENCHER_DEFAULTS,
      brainRequired: true,
      candidates: async () => [],
      open: async () => [],
      liquidityOf: () => null,
      swapRouter: ROUTER,
      usdgToken: USDG,
    });
    const tick = async () => {
      const t = takeTick(await trencher.tick(snap({ drawdown: TRIPPED })));
      await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: t.idle, modeEmptied: null });
      d.advance(TICK_MS);
    };
    await tick();
    const sentence = renderWhy(breaker);
    assert.equal(d.shows(), sentence);
    const failure = "Trencher: Autonomous discovery could not verify its pool or custody data. Retrying; no new token authorized.";
    d.write("warn", failure);
    await tick();
    assert.equal(d.shows(), failure, "a newer notice gets its time on the desk");
    for (let i = 0; i < 500; i++) await tick();
    assert.equal(
      d.shows(),
      withEarlier(sentence, failure),
      "and then the reason that still stands leads the notice again — carrying the line it is written over, never burying it",
    );
    assert.equal(d.leads(sentence), 2, "said again once — not once a tick");
    assert.deepEqual(d.rows, []);
  });

  it("THE RUNNING COMMENTARY AGES IT OUT OF THE NEWEST 40: said again at once, since the desk would show nothing", async () => {
    // The checker's probe B: a strategist holding under the breaker notes
    // "N buy proposal(s) withheld" at ok every window.
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    let clock = 0;
    const strategist = makeLlmStrategist({
      driver: { name: "stub", propose: async () => ({ actions: [{ action: "buy", symbol: "NVDA", sizeUsdg: 5, reason: "dip" }] }) } as never,
      universe: { legs: new Map([["NVDA", NVDA]]), swapRouter: ROUTER, usdg: USDG, maxPerActionUsdg: 10_000_000n, maxActionsPerTick: 4 },
      decisionIntervalMs: 30 * 60_000,
      now: () => clock,
      onNote: (level, message) => d.write(level, message),
    });
    const held = snap({
      drawdown: TRIPPED,
      holdings: new Map([["NVDA", { token: NVDA, rawBalance: 10n ** 18n, valueUsdg: 50_000_000n, costUsdg: 60_000_000n, priceStale: false }]]) as never,
    });
    const sentence = renderWhy(breaker);
    for (let tick = 0; tick < 2_000; tick++) {
      clock = tick * TICK_MS;
      const t = takeTick(await strategist.tick(held));
      await ch.tell({ agentId: AGENT, strategyName: "llm-strategist", idle: t.idle, modeEmptied: null });
      assert.equal(d.shows(), sentence, `tick ${tick}: the desk shows ${d.shows()}`);
      d.advance(TICK_MS);
    }
    assert.ok(d.warns(sentence) > 1, "restated as the notes pushed it out");
    assert.ok(d.warns(sentence) <= 1 + Math.ceil(d.events.length / 40), `${d.warns(sentence)} warnings for ${d.events.length} events`);
  });

  it("A NOTICE THE DESK STILL SHOWS IS NOT REPEATED — a long trip with nothing else said is one warning", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    for (let i = 0; i < 1_000; i++) {
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null });
      d.advance(TICK_MS);
    }
    assert.equal(d.events.length, 1);
  });

  it("A WARN WRITTEN EVERY TICK IS ITSELF CURRENT: the breaker waits for it rather than alternate with it", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const sentence = renderWhy(breaker);
    await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    for (let i = 0; i < 100; i++) {
      d.advance(TICK_MS);
      d.write("warn", "Trencher: Autonomous discovery could not verify its pool or custody data. Retrying; no new token authorized.");
      await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    }
    assert.equal(d.leads(sentence), 1, "no event storm while somebody else is warning");
    // …and once the other line stops, the breaker comes back — with it.
    for (let i = 0; i < 5; i++) {
      d.advance(TICK_MS);
      await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    }
    assert.equal(
      d.shows(),
      withEarlier(sentence, "Trencher: Autonomous discovery could not verify its pool or custody data. Retrying; no new token authorized."),
    );
  });

  it("the grace is measured from the notice that replaced it", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const sentence = renderWhy(breaker);
    await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    d.advance(3 * 60 * 60_000);
    d.write("warn", "something newer");
    d.advance(RESTATE_AFTER_MS - 1_000);
    await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    assert.equal(d.shows(), "something newer", "not before it has had its time");
    d.advance(1_000);
    await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    assert.equal(d.shows(), withEarlier(sentence, "something newer"));
  });

  it("A REASON THAT POSTS IS NEVER RESTATED — its view row would repeat, and the owner meets it as the post", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
    for (let i = 0; i < 45; i++) d.write("ok", `note ${i}`);
    d.write("warn", "something else");
    for (let i = 0; i < 20; i++) {
      d.advance(TICK_MS);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
    }
    assert.equal(d.events.filter((e) => e.message === renderWhy(underOne)).length, 1);
    assert.equal(d.rows.length, 1);
  });

  it("AN UNREADABLE DESK IS NO REASON TO WRITE, and never a throw into the tick", async () => {
    for (const shown of ["unreadable", "throws"] as const) {
      const d = desk({ shown });
      const ch = new IdleChannel(d.sinks);
      await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
      for (let i = 0; i < 45; i++) d.write("ok", `note ${i}`);
      for (let i = 0; i < 10; i++) {
        d.advance(TICK_MS);
        await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
      }
      assert.equal(d.warns(renderWhy(breaker)), 1, shown);
    }
  });

  it("a breaker that clears and trips again is a new warning, as before — and each reset is said", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.warns(renderWhy(breaker)), 2);
    assert.equal(d.shows(), renderWhy(breaker), "tripped again: the breaker is the notice");
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.equal(d.warns(breakerResetLine(null)), 2);
    assert.equal(d.shows(), breakerResetLine(null));
  });
});

/**
 * R3WK-1. The restatement keeps the breaker as the newest warn right up to the
 * moment it clears — and then nothing replaced it. The desk, the rail and
 * Android went on showing "nothing bought — the breaker refuses buys until it
 * recovers" after it had recovered, until forty newer events pushed it out,
 * and for an agent that writes little after a reset, indefinitely.
 */
describe("when the breaker resets, the owner's notice says buying resumed", () => {
  const sentence = renderWhy(breaker);

  it("THE CHECKER'S PROBE: a long trip, restated as the commentary aged it out, then the reset — the breaker is never the notice again", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    let clock = 0;
    const strategist = makeLlmStrategist({
      driver: { name: "stub", propose: async () => ({ actions: [{ action: "buy", symbol: "NVDA", sizeUsdg: 5, reason: "dip" }] }) } as never,
      universe: { legs: new Map([["NVDA", NVDA]]), swapRouter: ROUTER, usdg: USDG, maxPerActionUsdg: 10_000_000n, maxActionsPerTick: 4 },
      decisionIntervalMs: 30 * 60_000,
      now: () => clock,
      onNote: (level, message) => d.write(level, message),
    });
    const holdings = new Map([["NVDA", { token: NVDA, rawBalance: 10n ** 18n, valueUsdg: 50_000_000n, costUsdg: 60_000_000n, priceStale: false }]]) as never;
    let tick = 0;
    for (; tick < 700; tick++) {
      clock = tick * TICK_MS;
      const t = takeTick(await strategist.tick(snap({ drawdown: TRIPPED, holdings })));
      await ch.tell({ agentId: AGENT, strategyName: "llm-strategist", idle: t.idle, modeEmptied: null, drawdown: TRIPPED });
      d.advance(TICK_MS);
    }
    assert.equal(d.shows(), sentence, "at the reset the breaker is the notice — restated all trip long");
    assert.ok(d.warns(sentence) > 1, "and it was restated as the notes aged it out");
    const eventsAtReset = d.events.length;
    // Recovered: the model's buys go through, one ok fill line per buy.
    for (let k = 0; k < 400; k++, tick++) {
      clock = tick * TICK_MS;
      const t = takeTick(await strategist.tick(snap({ drawdown: CLEAR, holdings })));
      if (t.intents.length) d.write("ok", `simulated ✓ fill ${k}`);
      await ch.tell({ agentId: AGENT, strategyName: "llm-strategist", idle: t.idle, modeEmptied: null, drawdown: CLEAR });
      if (k === 0) assert.equal(d.shows(), breakerResetLine(null), "the first tick after the reset says so");
      assert.ok(!d.shows().startsWith(sentence), `tick ${k} after the reset: the desk still shows the breaker`);
      d.advance(TICK_MS);
    }
    assert.equal(
      d.events.slice(eventsAtReset).filter((e) => e.level === "warn").map((e) => e.message).join(" | "),
      breakerResetLine(null),
      "one line at the reset, and nothing warned after it",
    );
  });

  it("the reset line says buying resumes, and does not repeat the breaker's claim", () => {
    assert.match(breakerResetLine(null), /buying resumes/);
    assert.match(breakerResetLine("nothing bought — the cash on hand is short of one buy"), /no longer stops buying/);
    for (const line of [breakerResetLine(null), breakerResetLine("x")]) {
      assert.doesNotMatch(line, /refuses buys until it recovers/);
      assert.match(line, /breaker has reset/);
    }
  });

  it("TRIP, RESTATE, CLEAR: the reset line — and nothing written after it, even once the commentary ages it out", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    for (let i = 0; i < 45; i++) d.write("ok", `note ${i}`);
    d.advance(TICK_MS);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.warns(sentence), 2, "restated once it aged out");
    d.advance(TICK_MS);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.equal(d.shows(), breakerResetLine(null));
    const written = d.events.length;
    for (let i = 0; i < 50; i++) {
      d.advance(TICK_MS);
      if (i % 10 === 0) for (let j = 0; j < 45; j++) d.write("ok", `note ${i}.${j}`);
      const before = d.events.length;
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
      assert.equal(d.events.length, before, `tick ${i}: the channel wrote after the reset`);
    }
    assert.ok(d.events.length > written, "the notes did land");
    assert.equal(d.warns(breakerResetLine(null)), 1);
    assert.equal(d.shows(), "(no notice)", "aged out, and nothing false put back");
  });

  it("A REASON THAT TAKES OVER AT THE RESET: the breaker is taken down, the reason is told as it always was", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    d.advance(TICK_MS);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null, drawdown: CLEAR });
    assert.deepEqual(
      d.events.map((e) => [e.level, e.message]),
      [
        ["warn", sentence],
        ["warn", breakerResetLine(renderWhy(underOne))],
        ["ok", renderWhy(underOne)],
      ],
    );
    assert.equal(d.shows(), breakerResetLine(renderWhy(underOne)));
    assert.equal(d.rows.length, 1, "the reason's view row, as before");
    assert.equal(d.rows[0]!.reason, renderWhy(underOne, "public"));
    // That reset line is the channel's own too: tripped again, it is written over, not carried.
    d.advance(TICK_MS);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.shows(), sentence);
  });

  it("AN UNMEASURED BREAKER IS NOT A RESET, and neither is one still tripped", async () => {
    const unread = [
      null,
      undefined,
      TRIPPED,
      // At the limit is tripped: checkPolicy refuses at bps >= limit.
      { bps: 1_000, limitBps: 1_000 },
      // Figures nobody could read are not a recovery.
      { bps: Number.NEGATIVE_INFINITY, limitBps: 1_000 },
      { bps: 0, limitBps: Number.POSITIVE_INFINITY },
      { bps: Number.NaN, limitBps: 1_000 },
    ];
    for (const drawdown of unread) {
      const d = desk();
      const ch = new IdleChannel(d.sinks);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
      for (let i = 0; i < 10; i++) {
        d.advance(TICK_MS);
        // A book that could not be totalled, or a tick that sold: no reason, and no measured recovery.
        await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown });
      }
      assert.equal(d.warns(breakerResetLine(null)), 0, JSON.stringify(drawdown));
      assert.equal(d.shows(), sentence, JSON.stringify(drawdown));
      d.advance(TICK_MS);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
      assert.equal(d.shows(), breakerResetLine(null), `measured clear after ${JSON.stringify(drawdown)}`);
    }
  });

  it("A TICK STILL GIVING THE BREAKER'S REASON is not its reset, whatever the figure says", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    for (let i = 0; i < 5; i++) {
      d.advance(TICK_MS);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: CLEAR });
    }
    assert.deepEqual(d.events.map((e) => e.message), [sentence]);
  });

  it("AN UNREADABLE DESK DEFERS THE RESET LINE — it is said on the first tick that can read, once", async () => {
    for (const shown of ["unreadable", "throws"] as const) {
      const d = desk();
      const ch = new IdleChannel(d.sinks);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
      d.read.shown = shown;
      for (let i = 0; i < 3; i++) {
        d.advance(TICK_MS);
        await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
      }
      assert.equal(d.events.length, 1, `${shown}: nothing written on a guess`);
      d.read.shown = undefined;
      for (let i = 0; i < 3; i++) {
        d.advance(TICK_MS);
        await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
      }
      assert.equal(d.warns(breakerResetLine(null)), 1, shown);
      assert.equal(d.shows(), breakerResetLine(null), shown);
    }
  });

  it("A REASON THAT POSTS IS NOT THE BREAKER, nothing to take back — and a reset is this agent's only", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    // Told a reason that posts — not the breaker — so a clear tick has nothing to take down.
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null, drawdown: CLEAR });
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.deepEqual(d.events.map((e) => [e.level, e.message]), [["ok", renderWhy(underOne)]]);
    d.events.length = 0;
    // Told for this agent; a clear tick for another agent is not its reset.
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    await ch.tell({ agentId: "0xother", strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.deepEqual(d.events.map((e) => [e.agentId, e.message]), [[AGENT, sentence]]);
  });
});

/**
 * R4WK-1. The reset line says "buying resumes" — and nothing took it down when
 * the breaker tripped again on a tick that gave no reason. The class gate gives
 * the breaker's reason only when something would have bought, and two builtins
 * go quiet while tripped: even-keel invested and in band, weekend-gap while it
 * holds. So the desk said buying resumes for the whole of the second trip,
 * while the wall refused every buy. A trip is now told on the tick that
 * measures it, whatever reason the tick gives — which is also the only rule a
 * restarted process can keep, since it cannot know what an earlier one left.
 */
describe("a measured trip is told, whatever reason the tick gives", () => {
  const sentence = renderWhy(breaker);
  const paper = classRouteLooks({ paper: true, assetMode: "all", vault: VAULT });
  const hold = (q: bigint, n: bigint) =>
    new Map([
      ["QQQ", { token: QQQ, rawBalance: 10n ** 18n, valueUsdg: q, costUsdg: q, priceStale: false }],
      ["NVDA", { token: NVDA, rawBalance: 10n ** 18n, valueUsdg: n, costUsdg: n, priceStale: false }],
    ]) as never;

  it("THE CHECKER'S PROBE, even-keel in paper, invested and in band: trip, reset, re-trip — the desk never says buying resumes while tripped", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const keel = {
      legs: [
        { symbol: "QQQ", token: QQQ },
        { symbol: "NVDA", token: NVDA },
      ],
      swapRouter: ROUTER,
      usdg: USDG,
      maxTradeUsdg: 25_000_000n,
      bandBps: 500,
      seedBudgetUsdg: 100_000_000n,
    };
    const run = async (holdings: never, drawdown: Snapshot["drawdown"], stale = false) => {
      const s = snap({ cashUsdg: 100_000_000n, holdings, drawdown, staleFeeds: new Set(stale ? ["QQQ", "NVDA"] : []) });
      const t = takeTick(evenKeelTick(keel, s));
      await idleAndClassGate({ channel: ch, agentId: AGENT, strategyName: "even-keel", snap: s, routeLooks: paper, idle: t.idle, modeEmptied: null });
      d.advance(TICK_MS);
      return t;
    };
    // Tripped over a stale weekend: the gate turns all-legs-stale into the breaker.
    assert.equal((await run(hold(400_000_000n, 400_000_000n), TRIPPED, true)).idle?.code, "all-legs-stale");
    assert.equal(d.shows(), sentence);
    await run(hold(400_000_000n, 400_000_000n), CLEAR);
    assert.equal(d.shows(), breakerResetLine(null));
    // The market falls across the board: tripped again, every leg still in band, and the strategy says nothing.
    for (let i = 0; i < 360; i++) {
      assert.equal((await run(hold(350_000_000n, 350_000_000n), TRIPPED)).idle, undefined, "even-keel in band gives no reason");
      assert.equal(d.shows(), sentence, `re-tripped tick ${i}: the desk shows ${d.shows().slice(0, 70)}`);
    }
    assert.equal(d.warns(sentence), 2, "the re-trip is told once, not once a tick");
    await run(hold(400_000_000n, 400_000_000n), CLEAR);
    assert.equal(d.shows(), breakerResetLine(null), "and its reset is said in turn");
    assert.equal(d.warns(breakerResetLine(null)), 2);
  });

  it("THE CHECKER'S PROBE, weekend-gap: told at the close, reset, then tripped while it holds — the breaker, not the reset", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const gap = { legs: [{ symbol: "QQQ", token: QQQ, weightBps: 10_000 }], enterBudgetUsdg: 50_000_000n, swapRouter: ROUTER, usdg: USDG };
    const run = async (over: Partial<Snapshot>) => {
      const s = snap({ cashUsdg: 100_000_000n, staleFeeds: new Set(["QQQ"]), ...over });
      const t = takeTick(weekendGapTick(gap, s));
      await idleAndClassGate({ channel: ch, agentId: AGENT, strategyName: "weekend-gap", snap: s, routeLooks: paper, idle: t.idle, modeEmptied: null });
      d.advance(TICK_MS);
      return t;
    };
    assert.equal((await run({ drawdown: TRIPPED })).idle?.code, "breaker-tripped", "flat at the close: the entry is withheld, and said");
    assert.equal((await run({ drawdown: CLEAR })).intents.length, 1, "recovered at the next close: it enters");
    assert.equal(d.shows(), breakerResetLine(null));
    const held = new Map([["QQQ", { token: QQQ, rawBalance: 10n ** 18n, valueUsdg: 40_000_000n, costUsdg: 50_000_000n, priceStale: true }]]) as never;
    for (let i = 0; i < 100; i++) {
      assert.equal((await run({ drawdown: TRIPPED, holdings: held })).idle, undefined, "holding, it has nothing to withhold");
      assert.equal(d.shows(), sentence, `holding, tripped, tick ${i}`);
    }
    assert.equal(d.warns(sentence), 2);
  });

  it("A SILENT TRIP IS TOLD ONCE, its reset said, each re-trip told again — and a tick that could not measure the book is neither", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const quiet = (drawdown: Snapshot["drawdown"]) => ch.tell({ agentId: AGENT, strategyName: "even-keel", idle: undefined, modeEmptied: null, drawdown });
    for (let trip = 1; trip <= 3; trip++) {
      for (let i = 0; i < 5; i++) {
        await quiet(TRIPPED);
        assert.equal(d.shows(), sentence, `trip ${trip}, tick ${i}`);
        d.advance(TICK_MS);
      }
      assert.equal(d.warns(sentence), trip, "once a trip, not once a tick");
      await quiet(null);
      assert.equal(d.shows(), sentence, "unmeasured is not a reset");
      await quiet(CLEAR);
      assert.equal(d.shows(), breakerResetLine(null));
      for (const drawdown of [null, undefined, { bps: Number.NaN, limitBps: 1_000 }, { bps: Number.POSITIVE_INFINITY, limitBps: 1_000 }, { bps: 2_000, limitBps: Number.NaN }]) {
        await quiet(drawdown);
      }
      assert.equal(d.shows(), breakerResetLine(null), "unmeasured is not a re-trip either");
      assert.equal(d.warns(breakerResetLine(null)), trip);
    }
    // At the limit is tripped: checkPolicy refuses at bps >= limit.
    await quiet({ bps: 1_000, limitBps: 1_000 });
    assert.equal(d.shows(), sentence);
    assert.deepEqual(d.rows, [], "account state stays off the public feed");
    assert.ok(d.events.every((e) => e.level === "warn"));
  });

  it("ON A DESK IT CANNOT READ, the trip is still said — alone, and once — as a change always is", async () => {
    for (const shown of ["unreadable", "throws"] as const) {
      const d = desk({ shown });
      const ch = new IdleChannel(d.sinks);
      d.write("warn", "an older line");
      for (let i = 0; i < 3; i++) {
        await ch.tell({ agentId: AGENT, strategyName: "even-keel", idle: undefined, modeEmptied: null, drawdown: TRIPPED });
        d.advance(TICK_MS);
      }
      assert.deepEqual(
        d.events.map((e) => [e.level, e.message]),
        [
          ["warn", "an older line"],
          ["warn", sentence],
        ],
        shown,
      );
    }
  });

  it("A RE-TRIP THE TICK GIVES THE BREAKER'S REASON FOR is said once, not twice", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: undefined, modeEmptied: null, drawdown: TRIPPED });
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.deepEqual(d.events.map((e) => e.message), [sentence, breakerResetLine(null), sentence]);
  });

  it("ANOTHER AGENT'S TRIP is not this one's, and this one's re-trip is still told", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "even-keel", idle: undefined, modeEmptied: null, drawdown: TRIPPED });
    await ch.tell({ agentId: AGENT, strategyName: "even-keel", idle: undefined, modeEmptied: null, drawdown: TRIPPED });
    assert.deepEqual(d.events.map((e) => [e.agentId, e.message]), [[AGENT, sentence]]);
    await ch.tell({ agentId: "0xother", strategyName: "even-keel", idle: undefined, modeEmptied: null, drawdown: TRIPPED });
    assert.deepEqual(d.events.map((e) => [e.agentId, e.message]).at(-1), ["0xother", sentence]);
  });

  it("A TRIP THAT STANDS ACROSS A REDEPLOY is told by the new process on its first tripped tick, whatever its reason, and its reset follows — though the new process cannot see a line the old one wrote", async () => {
    // A hosted child reads its OWN table (store.ownerNotice), which a redeploy
    // wipes; the desk reads the shared one the mirror copies it into, which
    // keeps every line. The old process left either the breaker or its reset.
    for (const left of ["breaker", "reset"] as const) {
      let clock = 1_800_000_000_000;
      let seq = 0;
      type Row = { level: string; message: string; atMs: number; id: number };
      let child: Row[] = [];
      const shared: Row[] = [];
      const noticeOf = (rows: Row[]): ShownNotice | null => {
        const hit = [...rows]
          .sort((a, b) => b.atMs - a.atMs || b.id - a.id)
          .slice(0, 40)
          .find((e) => e.level === "warn" || e.level === "err");
        return hit ? { message: hit.message, atMs: hit.atMs } : null;
      };
      const boot = () =>
        new IdleChannel({
          addEvent: async (_agent, level, message) => {
            const row = { level, message, atMs: Math.floor(clock / 1000) * 1000, id: ++seq };
            child.push(row);
            shared.push({ ...row });
          },
          addDecision: async () => {},
          newDecisionId: () => "d",
          shownNotice: async () => noticeOf(child),
          now: () => clock,
        });
      const keel = (ch: IdleChannel, drawdown: Snapshot["drawdown"], idle?: Why) =>
        ch.tell({ agentId: AGENT, strategyName: "even-keel", idle, modeEmptied: null, drawdown }).then(() => void (clock += TICK_MS));
      const before = boot();
      await keel(before, TRIPPED, breaker);
      if (left === "reset") await keel(before, CLEAR);
      assert.equal(noticeOf(shared)?.message, left === "breaker" ? sentence : breakerResetLine(null));
      child = [];
      const after = boot();
      for (let i = 0; i < 20; i++) {
        await keel(after, TRIPPED);
        assert.equal(noticeOf(shared)?.message, sentence, `${left}: tripped tick ${i} after the redeploy`);
      }
      for (let i = 0; i < 20; i++) await keel(after, CLEAR);
      assert.equal(noticeOf(shared)?.message, breakerResetLine(null), `${left}: the desk after the recovery`);
      assert.equal(child.filter((e) => e.message === sentence).length, 1, `${left}: told once after the redeploy`);
    }
  });

  it("A TRIP THAT STANDS ACROSS A RESTART whose old line the new process CAN see: said again, never nested in it — keeping what it carried", async () => {
    const blocker = "NOT trading for real yet: your trading key is not active yet.";
    for (const carried of [false, true]) {
      const d = desk();
      const before = new IdleChannel(d.sinks);
      await before.tell({ agentId: AGENT, strategyName: "even-keel", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
      if (carried) {
        d.write("warn", blocker);
        d.advance(RESTATE_AFTER_MS);
        await before.tell({ agentId: AGENT, strategyName: "even-keel", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
      }
      d.advance(TICK_MS);
      const after = new IdleChannel(d.sinks);
      for (let i = 0; i < 10; i++) {
        await after.tell({ agentId: AGENT, strategyName: "even-keel", idle: undefined, modeEmptied: null, drawdown: TRIPPED });
        d.advance(TICK_MS);
      }
      assert.equal(d.shows(), withEarlier(sentence, carried ? blocker : null), `carried: ${carried}`);
      assert.equal(d.leads(sentence), carried ? 3 : 2, `carried: ${carried}`);
      await after.tell({ agentId: AGENT, strategyName: "even-keel", idle: undefined, modeEmptied: null, drawdown: CLEAR });
      assert.equal(d.shows(), withEarlier(breakerResetLine(null), carried ? blocker : null), `carried: ${carried}`);
    }
  });
});

/**
 * R3WK-2. The restatement wrote the breaker over whatever warn had held the
 * desk for ten minutes — including one that is still standing but was written
 * once per change (the live-rail blocker, a per-key refusal, a Trencher
 * notice), which never says itself again. So the covered line was gone for the
 * rest of the trip. Now the restatement carries it: the breaker leads, and the
 * line it was written over stays on the notice after it.
 */
describe("the restatement never buries another warn", () => {
  const sentence = renderWhy(breaker);
  const blocker =
    "NOT trading for real yet: your trading key is not active yet — the agent has no permission to trade with. " +
    "Fills below are simulated at live prices until that is fixed. Live trading is a switch in Settings, and it stays off until you turn it on.";

  it("THE CHECKER'S PROBE: a warn written once after the trip is on the notice every tick of the trip — and after the reset", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    d.advance(TICK_MS);
    d.write("warn", blocker);
    let led = 0;
    for (let i = 0; i < 360; i++) {
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
      assert.ok(d.shows().includes(blocker), `tick ${i}: the blocker was buried — the desk shows ${d.shows().slice(0, 60)}`);
      if (d.shows().startsWith(sentence)) led++;
      d.advance(TICK_MS);
    }
    assert.ok(led >= 355, `the breaker led the notice on ${led}/360 ticks`);
    assert.equal(d.shows(), withEarlier(sentence, blocker));
    assert.equal(d.leads(sentence), 2, "restated once, not once a tick");
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.equal(d.shows(), withEarlier(breakerResetLine(null), blocker), "the reset takes the breaker down and keeps the blocker");
  });

  it("A WARN THAT COVERED OURS is the one carried — never a chain of every line before it", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    d.write("warn", "first other line");
    d.advance(RESTATE_AFTER_MS);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.shows(), withEarlier(sentence, "first other line"));
    d.write("warn", "second other line");
    d.advance(RESTATE_AFTER_MS);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.shows(), withEarlier(sentence, "second other line"));
    // Our own carried line on the desk for hours is not covered, and is not said again.
    for (let i = 0; i < 100; i++) {
      d.advance(TICK_MS);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    }
    assert.equal(d.leads(sentence), 3);
  });

  it("AGED OUT, NOTHING TO CARRY: said again alone", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    d.write("warn", "an older line");
    d.advance(RESTATE_AFTER_MS);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.shows(), withEarlier(sentence, "an older line"));
    for (let i = 0; i < 45; i++) d.write("ok", `note ${i}`);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.shows(), sentence, "the carried line aged out with ours; nothing is dug back up");
  });

  it("THE RESET CARRIES a warn somebody else wrote over the breaker, too", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    d.write("warn", blocker);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.equal(d.shows(), withEarlier(breakerResetLine(null), blocker));
  });

  it("A TICK THAT COULD NOT MEASURE THE BREAKER, then the breaker again: what our line carried is still carried", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    d.write("warn", blocker);
    d.advance(RESTATE_AFTER_MS);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.shows(), withEarlier(sentence, blocker));
    // A book that could not be totalled: no breaker reason this tick, so the next one is a change.
    d.advance(TICK_MS);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: null });
    d.advance(TICK_MS);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.leads(sentence), 3, "said again, as a change");
    assert.equal(d.shows(), withEarlier(sentence, blocker), "and the blocker rode with it");
  });

  it("THE TRIP ITSELF keeps a warn that stands on the desk — and on a desk it cannot read, it is still said, alone", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    d.write("warn", blocker);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.shows(), withEarlier(sentence, blocker));
    for (const shown of ["unreadable", "throws"] as const) {
      const u = desk({ shown });
      const cu = new IdleChannel(u.sinks);
      u.write("warn", blocker);
      await cu.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
      assert.deepEqual(
        u.events.map((e) => [e.level, e.message]),
        [
          ["warn", blocker],
          ["warn", sentence],
        ],
        `${shown}: a change is said even unread`,
      );
    }
  });

  it("R4WK-3, THE CHECKER'S PROBE: a line written once rides no further than the reset — a breaker flapping at its limit does not keep it on the desk", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const once = "Trencher: Autonomous discovery could not verify its pool or custody data. Retrying; no new token authorized.";
    d.write("warn", once);
    let carried = 0;
    let fills = 0;
    let deskAlone = 0;
    for (let i = 0; i < 400; i++) {
      const tripped = i % 4 < 2;
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: tripped ? breaker : null, modeEmptied: null, drawdown: tripped ? TRIPPED : CLEAR });
      if (!tripped) for (let k = 0; k < 3; k++, fills++) d.write("ok", `fill ${i}.${k}`);
      if (d.shows().includes(once)) carried++;
      if (fills < 40) deskAlone++;
      d.advance(TICK_MS);
    }
    assert.ok(carried <= deskAlone, `on the notice ${carried} ticks; the desk alone would have shown it ${deskAlone}`);
    assert.equal(carried, 4, "through the first trip and the reset that ended it, and no further");
    assert.equal(d.shows(), breakerResetLine(null));
  });

  it("A LINE WRITTEN OVER OUR RESET LINE CARRIES NOTHING OF IT — the trip that covered the carried line has ended", async () => {
    for (const idle of [breaker, undefined]) {
      const d = desk();
      const ch = new IdleChannel(d.sinks);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
      d.write("warn", blocker);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
      assert.equal(d.shows(), withEarlier(breakerResetLine(null), blocker), "the reset keeps what the trip carried");
      d.advance(TICK_MS);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle, modeEmptied: null, drawdown: TRIPPED });
      assert.equal(d.shows(), sentence, `re-tripped ${idle ? "with" : "without"} the breaker's reason`);
      // A line somebody else wrote over our reset is theirs, and is carried as ever.
      d.advance(TICK_MS);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
      d.write("warn", "a newer line");
      d.advance(TICK_MS);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle, modeEmptied: null, drawdown: TRIPPED });
      assert.equal(d.shows(), withEarlier(sentence, "a newer line"));
    }
  });

  it("withEarlier: the head alone when there is nothing to carry", () => {
    assert.equal(withEarlier("head", null), "head");
    assert.equal(withEarlier("head", "tail"), "head. Also from earlier: tail");
  });
});

/**
 * A worker restarted mid-trip — a redeploy, the watchdog — starts a new
 * channel with no memory, over the same desk. The lines an earlier process left
 * there are still the channel's own, read from their words.
 */
describe("across a restart, the lines on the desk are still the channel's own", () => {
  const sentence = renderWhy(breaker);
  const blocker = "NOT trading for real yet: your trading key is not active yet.";

  it("THE FIRST BREAKER LINE AFTER A RESTART does not carry the old one — the same sentence twice", async () => {
    for (const carried of [false, true]) {
      const d = desk();
      const before = new IdleChannel(d.sinks);
      await before.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
      if (carried) {
        d.write("warn", blocker);
        d.advance(RESTATE_AFTER_MS);
        await before.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
      }
      d.advance(TICK_MS);
      const after = new IdleChannel(d.sinks);
      await after.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
      assert.equal(d.shows(), withEarlier(sentence, carried ? blocker : null), `carried: ${carried}`);
      // …and the restarted channel does not count its predecessor's line as covering it.
      for (let i = 0; i < 20; i++) {
        d.advance(TICK_MS);
        await after.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
      }
      assert.equal(d.leads(sentence), carried ? 3 : 2, `carried: ${carried}`);
    }
  });

  it("A TRIP THAT CLEARED ACROSS A RESTART is not guessed at: the new process reads nothing for a leftover and writes nothing", async () => {
    // What the owner sees: the old line stands until a newer warn covers it or
    // the newest 40 events pass it by. The new process's own table — the only
    // one it can read — is empty after a hosted redeploy, so a look there would
    // find nothing exactly when it matters.
    const d = desk();
    const before = new IdleChannel(d.sinks);
    await before.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    let reads = 0;
    const after = new IdleChannel({ ...d.sinks, shownNotice: async (a: string) => (reads++, d.sinks.shownNotice(a)) });
    for (let i = 0; i < 10; i++) {
      d.advance(TICK_MS);
      await after.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    }
    assert.equal(reads, 0, "the desk is not read on a guess");
    assert.deepEqual(d.events.map((e) => e.message), [sentence]);
  });

  it("A BREAKER LINE UNDER ANOTHER LIMIT is still the breaker's — the new trip's line is written over it, not after it", async () => {
    const d = desk();
    const old = renderWhy({ code: "breaker-tripped", limitBps: 1_250 });
    d.write("warn", old);
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: undefined, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.shows(), sentence);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.equal(d.shows(), breakerResetLine(null));
  });

  it("A RESTART WITH NO BREAKER STANDING says nothing, and reads nothing", async () => {
    const d = desk();
    let reads = 0;
    const counted = { ...d.sinks, shownNotice: async (a: string) => (reads++, d.sinks.shownNotice(a)) };
    d.write("warn", blocker);
    d.write("warn", withEarlier("the drawdown breaker has reset", null) + " (not ours: a lookalike)");
    const ch = new IdleChannel(counted);
    for (let i = 0; i < 10; i++) {
      d.advance(TICK_MS);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    }
    assert.equal(d.events.length, 2, "nothing written");
    assert.equal(reads, 0, "the desk is not read for a leftover");
  });

  it("OUR OWN RESET LINE on the desk while the breaker stands is not the breaker — a lost write is made good", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.equal(d.shows(), breakerResetLine(null));
    // Tripped again, and the insert is lost: the desk still says buying resumes.
    d.read.dropWrites = true;
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    d.read.dropWrites = false;
    assert.equal(d.shows(), breakerResetLine(null));
    for (let i = 0; i < 4; i++) {
      d.advance(RESTATE_AFTER_MS);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    }
    assert.equal(d.shows(), sentence, "the standing breaker is said again, over our own stale line, carrying nothing of it");
    assert.equal(d.leads(sentence), 2);
  });

  it("A RESET ALREADY SAID before the restart is not said again", async () => {
    const d = desk();
    const before = new IdleChannel(d.sinks);
    await before.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    await before.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    const after = new IdleChannel(d.sinks);
    await after.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null, drawdown: CLEAR });
    assert.deepEqual(d.events.map((e) => e.message), [sentence, breakerResetLine(null)]);
  });

  it("a line that merely starts like ours is somebody else's", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    // The breaker's opening words, then something else: not ours, so carried whole.
    const lookalike = `${sentence} — and a longer sentence nobody here wrote`;
    d.write("warn", lookalike);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d.shows(), withEarlier(sentence, lookalike));
    // The breaker's words around something that is not a figure: not ours either.
    const d2 = desk();
    const ch2 = new IdleChannel(d2.sinks);
    const noFigure = sentence.replace("10%", "most of it%");
    assert.notEqual(noFigure, sentence);
    d2.write("warn", noFigure);
    await ch2.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null, drawdown: TRIPPED });
    assert.equal(d2.shows(), withEarlier(sentence, noFigure));
  });
});
