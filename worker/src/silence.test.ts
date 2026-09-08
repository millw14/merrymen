/**
 * EVERY WAY AN AGENT CAN DO NOTHING, AND SAY SO.
 *
 * The complaint that started all of this was "no trading is being done", and
 * the hard part was never the trading — it was that a healthy quiet tick and a
 * structurally broken one produce byte-for-byte identical output. An owner
 * cannot tell them apart, and neither could we: the answer took a fleet-wide
 * log sweep to reach, twice.
 *
 * So the rule this file pins is narrow and absolute: WHEREVER AN AGENT
 * PRODUCES NOTHING, SOMETHING MUST SAY WHY. Not a log line — a row, on a
 * surface the owner can reach, deduplicated so 360 ticks do not become 360 of
 * them.
 *
 * Three points had no signal at all. Each is a separate silence with a separate
 * remedy, which is exactly why one sentence could not have covered them:
 *
 *   the feeds are shut          → wait, or trade the always-on side
 *   there is not enough cash    → add funds, or trade smaller
 *   the model looked and held   → nothing to do; this is the agent working
 *   the tick threw             → the agent is broken and looks fine
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { renderWhy } from "./strategies/reasons";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const INDEX = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
const STRATEGIST = codeOf(readFileSync(new URL("./strategist/strategy.ts", import.meta.url), "utf8"));

describe("the three silences each get their own sentence", () => {
  it("AND THEY ARE DIFFERENT SENTENCES, because the remedies are different", () => {
    // The whole reason this is not one reason. Telling an owner whose account
    // is empty that the feeds are stale sends them to wait for Monday instead
    // of to the deposit screen.
    const feeds = renderWhy({ code: "all-legs-stale", legs: 3, paused: 0 });
    const cash = renderWhy({ code: "under-one-buy", cashRaw: 1_000_000n, needRaw: 25_000_000n, vaultRaw: 0n });
    const held = renderWhy({ code: "model-held", held: 4, considered: 4, dropped: 0 });
    assert.match(feeds, /price feeds/);
    assert.match(cash, /Add funds or lower the size per trade/);
    assert.match(held, /A decision, not a quiet tick/);
    assert.equal(new Set([feeds, cash, held]).size, 3);
    // Publishable by the same rule as everything else in that file: counts and
    // configured symbols only, no prose from anywhere else.
    for (const s of [feeds, cash, held]) assert.ok(s.length < 220, "must not truncate on any surface");
  });

  it("a vault that can cover the shortfall changes the advice", () => {
    // The agent fixes this one itself on the next unpark. Telling that owner to
    // add funds would be wrong.
    const self = renderWhy({ code: "under-one-buy", cashRaw: 1_000_000n, needRaw: 25_000_000n, vaultRaw: 50_000_000n });
    assert.match(self, /should clear itself/);
    assert.ok(!/Add funds/.test(self));
  });

  it("and a model that held EVERYTHING reads differently from one that held some", () => {
    assert.match(renderWhy({ code: "model-held", held: 4, considered: 4, dropped: 0 }), /held all of them/);
    assert.match(renderWhy({ code: "model-held", held: 2, considered: 4, dropped: 1 }), /held 2 of them/);
    assert.match(renderWhy({ code: "model-held", held: 2, considered: 4, dropped: 1 }), /1 more was refused/);
  });
});

describe("the rail that is supposed to be the autonomous path", () => {
  it("THE STRATEGIST CAN NOW REPORT AN IDLE WINDOW AT ALL", () => {
    // It returned a bare TradeIntent[], so `idle` — the mechanism built to stop
    // an empty tick reading as a healthy one — was not representable on it. A
    // window where the model held everything wrote zero decision rows, zero
    // events and zero log lines: identical to a window that never opened, to a
    // failed model call, and to a healthy agent between intervals.
    assert.match(STRATEGIST, /Promise<TradeIntent\[\] \| Tick>/);
    assert.match(STRATEGIST, /code: "model-held"/);
    assert.match(STRATEGIST, /return idle \? \{ intents, why: intents\.map\(\(\) => null\), idle \} : intents;/);
  });

  it("but NOT when the model already wrote a thesis", () => {
    // That row IS the agent saying what it decided. Two rows for one silence is
    // the duplication the de-duplication upstream exists to prevent.
    assert.match(STRATEGIST, /intents\.length === 0 && !thesis &&/);
  });

  it("and not when there was nothing to consider in the first place", () => {
    // A window that never opened, or a driver that failed, is a different fact
    // — and the driver failure already writes its own note.
    assert.match(STRATEGIST, /\(actions\.length > 0 \|\| rejected\.length > 0\)/);
  });
});

describe("a broken agent must not look like a quiet one", () => {
  it("A TICK THAT THREW WRITES AN EVENT", () => {
    // The heartbeat is written at the TOP of the tick, before any network call,
    // and setAgentMode rides it — deliberately, so a rate limit cannot get a
    // healthy worker SIGKILLed. The cost is that liveness and correctness came
    // apart: a throw anywhere in the tick ended it silently while the watchdog
    // and the mode chip both went on reporting the agent as fine, and the only
    // trace was a stderr line in a fleet log nobody tails.
    const at = INDEX.indexOf('console.error("[tick]", e)');
    assert.ok(at > 0, "the tick catch must still exist");
    const around = INDEX.slice(at - 400, at + 400);
    assert.match(around, /addEvent\(active\.agentId, "err", `tick failed: /);
  });

  it("and it is deduplicated, because a stuck agent throws every tick", () => {
    // 360 identical rows a day tell nobody anything — this repo has the
    // incident. Same shape as lastLiveBlocker.
    assert.match(INDEX, /let lastTickError = "";/);
    assert.match(INDEX, /msg !== lastTickError/);
  });

  it("and the failure never takes the loop down with it", () => {
    // The event write is best-effort. Losing the record of a failure must not
    // become a second failure.
    const at = INDEX.indexOf('addEvent(active.agentId, "err", `tick failed: ');
    assert.match(INDEX.slice(at, at + 200), /\.catch\(\(\) => \{\}\)/);
  });
});
