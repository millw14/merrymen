/**
 * What flow facts may say, and the ways each renderer could lie.
 *
 * The validator is the child's side of an IPC wire and trusts nothing; the
 * renderers are what a model (a Brain lens, later) and a public reply (X) get
 * to read, so each rule below is pinned where it would break.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as flowFactsModule from "./flow-facts";
import {
  FLOW_WINDOWS,
  FLOW_X_GLOSS,
  flowFactsOf,
  flowXBands,
  flowXLines,
  flowNumber,
  flowResultOf,
  isFlowFailure,
  renderFlowLens,
  type FlowFacts,
} from "./flow-facts";

const TOKEN = "0x00000000000000000000000000000000000000c1" as const;
const NOW = Date.parse("2026-10-12T02:00:00Z");

function facts(over: Partial<FlowFacts> = {}): FlowFacts {
  return {
    token: TOKEN,
    observedAt: NOW - 12_000,
    windows: [
      { minutes: 5, buyUsd: 412.5, sellUsd: 120.25, buys: 4, sells: 2, buyers: 3, sellers: 2 },
      { minutes: 15, buyUsd: 1388.9, sellUsd: 610, buys: 11, sells: 5, buyers: 8, sellers: 4 },
      { minutes: 60, buyUsd: 5120.75, sellUsd: 2310.4, buys: 40, sells: 18, buyers: 27, sellers: 12 },
    ],
    venues: [{ protocol: "uniswap_v4", family: "uniswap", buyUsd: 4020.5, sellUsd: 1800.4, buys: 31, sells: 13 }],
    largestSells: [{ usd: 512.75, at: NOW / 1000 - 1200, protocol: "uniswap_v4" }],
    creator: { state: "read", windowMin: 60, sells: 0, sellUsd: 0, transfersOut: 0, transferOutUsd: 0 },
    ...over,
  };
}

describe("the failure vocabulary", () => {
  it("is the feeds' own, and nothing else passes for it", () => {
    for (const f of ["unavailable", "budget", "provider-cooldown", "timeout", "network", "invalid-body", "invalid-shape", "invalid-request", "http-429", "http-503"]) {
      assert.ok(isFlowFailure(f), f);
    }
    for (const f of ["", "error", "http-42", "http-999", "timeout ", "Budget", 7, null]) assert.equal(isFlowFailure(f), false, String(f));
  });
});

describe("flowFactsOf — the child trusts nothing on the wire", () => {
  it("a round trip through JSON is the same reading", () => {
    const f = facts();
    assert.deepEqual(flowFactsOf(JSON.parse(JSON.stringify(f))), f);
    assert.deepEqual(flowResultOf({ ok: true, facts: f }), { ok: true, facts: f });
    assert.deepEqual(flowResultOf({ ok: false, failure: "budget" }), { ok: false, failure: "budget" });
  });

  it("one field in the wrong shape rejects the whole reading — a defaulted count is a fabricated one", () => {
    const bad: unknown[] = [
      { ...facts(), token: "0xNOPE" },
      { ...facts(), token: TOKEN.toUpperCase() },
      { ...facts(), observedAt: -1 },
      { ...facts(), windows: facts().windows.slice(0, 2) },
      { ...facts(), windows: [...facts().windows].reverse() },
      { ...facts(), windows: facts().windows.map((w, i) => (i === 0 ? { ...w, buys: 1.5 } : w)) },
      { ...facts(), windows: facts().windows.map((w, i) => (i === 0 ? { ...w, buyUsd: "412" } : w)) },
      { ...facts(), windows: facts().windows.map((w, i) => (i === 0 ? { ...w, sellers: -1 } : w)) },
      { ...facts(), venues: [{ ...facts().venues[0]!, protocol: "Uniswap V4" }] },
      { ...facts(), venues: Array.from({ length: 9 }, () => facts().venues[0]) },
      { ...facts(), largestSells: [{ usd: 5, at: 0, protocol: null }] },
      { ...facts(), creator: { state: "sold" } },
      { ...facts(), creator: { state: "unavailable", failure: "exploded" } },
      { ...facts(), creator: { state: "read", windowMin: 60, sells: "1", sellUsd: 0, transfersOut: 0, transferOutUsd: 0 } },
    ];
    for (const b of bad) assert.equal(flowFactsOf(b), null, JSON.stringify(b).slice(0, 120));
    assert.equal(flowResultOf({ ok: true }), null);
    assert.equal(flowResultOf({ ok: false, failure: "nope" }), null);
  });

  it("null stays null: an unknown is carried as unknown", () => {
    const f = facts({ windows: facts().windows.map((w) => ({ ...w, buyers: null })) });
    assert.deepEqual(flowFactsOf(JSON.parse(JSON.stringify(f)))?.windows.map((w) => w.buyers), [null, null, null]);
  });

  it("flowNumber reads numbers and numeric strings, and nothing negative, infinite or absurd", () => {
    assert.equal(flowNumber("12.5"), 12.5);
    assert.equal(flowNumber(3, true), 3);
    for (const v of ["-1", "1e400", Infinity, NaN, "12abc", "", null, undefined, {}, 2e12]) assert.equal(flowNumber(v), null, String(v));
    assert.equal(flowNumber(2.5, true), null);
  });
});

describe("renderFlowLens — attribution first, labelled, never a verdict from absence", () => {
  it("opens with whose data this is and that it is not a forecast, then one JSON object, then what it is not", () => {
    const text = renderFlowLens({ ok: true, facts: facts() }, NOW)!;
    const [first, body, last] = text.split("\n");
    assert.match(first!, /^Source: an on-chain indexer's record of DEX trades.*Indexer data, not a forecast\.$/);
    assert.match(last!, /^WHAT THIS IS NOT:/);
    const j = JSON.parse(body!) as { ageSec: number; windows: Record<string, { netUsd: number; buyers: number }>; launcher: { state: string; basis: string } };
    assert.equal(j.ageSec, 12);
    assert.deepEqual(Object.keys(j.windows), FLOW_WINDOWS.map((m) => `${m}m`));
    assert.equal(j.windows["60m"]!.netUsd, 2810, "net flow, whole dollars from $100");
    assert.equal(j.windows["5m"]!.netUsd, 292, "412.50 - 120.25");
    assert.equal(j.launcher.state, "read");
    assert.equal(j.launcher.basis, "launchpad factory's launch record", "labelled by where the address came from, never 'the creator's wallet'");
    assert.ok(text.length <= 1200);
  });

  it("names no vendor, and carries no address, hash or wallet", () => {
    const text = renderFlowLens({ ok: true, facts: facts() }, NOW)!;
    assert.doesNotMatch(text, /bitquery/i);
    assert.doesNotMatch(text, /0x[0-9a-f]{6,}/i, "the token itself is not in the block: Brain names instruments, code maps addresses");
  });

  it("renders NOTHING for a failure or an hour with no indexed trades — absence is not a verdict", () => {
    assert.equal(renderFlowLens({ ok: false, failure: "budget" }, NOW), null);
    const silent = facts({ windows: FLOW_WINDOWS.map((minutes) => ({ minutes, buyUsd: 0, sellUsd: 0, buys: 0, sells: 0, buyers: 0, sellers: 0 })), venues: [], largestSells: [] });
    assert.equal(renderFlowLens({ ok: true, facts: silent }, NOW), null);
  });

  it("an unknown is null in the block, never zero", () => {
    const text = renderFlowLens({ ok: true, facts: facts({ windows: facts().windows.map((w) => (w.minutes === 15 ? { ...w, sellUsd: null } : w)) }) }, NOW)!;
    const j = JSON.parse(text.split("\n")[1]!) as { windows: Record<string, { sellUsd: number | null; netUsd: number | null }> };
    assert.equal(j.windows["15m"]!.sellUsd, null);
    assert.equal(j.windows["15m"]!.netUsd, null, "a net of an unknown is unknown");
  });

  it("a launcher that cannot be known says so, and is never read as 'did not sell'", () => {
    const nd = JSON.parse(renderFlowLens({ ok: true, facts: facts({ creator: { state: "not-derivable" } }) }, NOW)!.split("\n")[1]!) as { launcher: unknown };
    assert.deepEqual(nd.launcher, { state: "not-derivable" });
    const un = JSON.parse(renderFlowLens({ ok: true, facts: facts({ creator: { state: "unavailable", failure: "timeout" } }) }, NOW)!.split("\n")[1]!) as { launcher: unknown };
    assert.deepEqual(un.launcher, { state: "unknown" });
    assert.doesNotMatch(renderFlowLens({ ok: true, facts: facts() }, NOW)!, /creator|wallet/i);
  });
});

describe("flowXLines — what an X answer may paraphrase: bands, never figures", () => {
  const hourOf = (w: Partial<FlowFacts["windows"][number]>, quarter: Partial<FlowFacts["windows"][number]> = {}) =>
    facts({
      windows: [
        { minutes: 5, buyUsd: 10, sellUsd: 10, buys: 1, sells: 1, buyers: 1, sellers: 1 },
        { minutes: 15, buyUsd: 300, sellUsd: 300, buys: 3, sells: 3, buyers: 3, sellers: 3, ...quarter },
        { minutes: 60, buyUsd: 1000, sellUsd: 1000, buys: 10, sells: 10, buyers: 10, sellers: 10, ...w },
      ],
      largestSells: [],
    });

  it("every gloss is digit-free, attributed, and names no wallet, address or vendor", () => {
    assert.ok(FLOW_X_GLOSS.size >= 13);
    for (const [band, glosses] of FLOW_X_GLOSS) {
      assert.ok(glosses.length >= 2, `${band} has a second wording, so two accounts are not handed one sentence`);
      for (const g of glosses) {
        assert.doesNotMatch(g, /\p{N}/u, `${band}: ${g}`);
        assert.match(g, /on-chain data/, "every line keeps its attribution");
        assert.doesNotMatch(g, /0x|wallet|creator|bitquery|indexer|\$|%|sold|selling/i, `${band}: ${g}`);
        assert.ok(g.length <= 120, `${band} is one short line`);
      }
    }
  });

  it("no figure ever leaves: a reading full of numbers renders lines with none", () => {
    const loud = facts({
      largestSells: [{ usd: 1_900, at: NOW / 1000 - 60, protocol: "uniswap_v4" }],
      creator: { state: "read", windowMin: 60, sells: 4, sellUsd: 9_000, transfersOut: 2, transferOutUsd: 100 },
      windows: [
        { minutes: 5, buyUsd: 100, sellUsd: 2_000, buys: 1, sells: 9, buyers: 1, sellers: 7 },
        { minutes: 15, buyUsd: 200, sellUsd: 2_500, buys: 2, sells: 12, buyers: 2, sellers: 9 },
        { minutes: 60, buyUsd: 300, sellUsd: 3_000, buys: 3, sells: 14, buyers: 2, sellers: 10 },
      ],
    });
    for (const seed of ["", "a|b", "tenant|token", "zz"]) {
      const lines = flowXLines({ ok: true, facts: loud }, seed);
      assert.ok(lines.length >= 4);
      for (const l of lines) assert.doesNotMatch(l, /\p{N}/u, l);
    }
    assert.deepEqual(flowXBands({ ok: true, facts: loud }), ["sells-lead", "pace-up", "buyers-narrow", "one-big-sell", "launcher-sells"]);
  });

  it("the hour's balance falls in one band, by quote-side dollars", () => {
    const band = (buy: number, sell: number) => flowXBands({ ok: true, facts: hourOf({ buyUsd: buy, sellUsd: sell }) })[0];
    assert.equal(band(700, 300), "buys-lead");
    assert.equal(band(600, 400), "buys-edge");
    assert.equal(band(500, 500), "even");
    assert.equal(band(400, 600), "sells-edge");
    assert.equal(band(300, 700), "sells-lead");
    assert.equal(band(20, 10), "light", "a few dollars either way is not a balance");
  });

  it("pace, breadth and one big sell are said only past their edges", () => {
    assert.deepEqual(flowXBands({ ok: true, facts: hourOf({}) }), ["even"]);
    assert.ok(flowXBands({ ok: true, facts: hourOf({}, { buyUsd: 700, sellUsd: 600 }) }).includes("pace-up"));
    assert.ok(flowXBands({ ok: true, facts: hourOf({}, { buyUsd: 20, sellUsd: 20 }) }).includes("pace-down"));
    assert.ok(flowXBands({ ok: true, facts: hourOf({ buyers: 2 }) }).includes("buyers-narrow"));
    assert.ok(flowXBands({ ok: true, facts: hourOf({ buyers: 40 }) }).includes("buyers-broad"));
    const big = { ...hourOf({}), largestSells: [{ usd: 600, at: NOW / 1000 - 60, protocol: null }] };
    assert.ok(flowXBands({ ok: true, facts: big }).includes("one-big-sell"));
    const alone = { ...hourOf({ sells: 1 }), largestSells: [{ usd: 1000, at: NOW / 1000 - 60, protocol: null }] };
    assert.ok(!flowXBands({ ok: true, facts: alone }).includes("one-big-sell"), "the only sell is not one sell among many");
    assert.deepEqual(flowXBands({ ok: true, facts: hourOf({ buyUsd: null }) }), [], "an unknown is not a band");
  });

  it("what the launch record's address did is said; that it did nothing is never said", () => {
    const withLauncher = (creator: FlowFacts["creator"]) => flowXBands({ ok: true, facts: { ...hourOf({}), creator } });
    assert.ok(withLauncher({ state: "read", windowMin: 60, sells: 2, sellUsd: 830, transfersOut: 3, transferOutUsd: 1210 }).includes("launcher-sells"));
    assert.ok(withLauncher({ state: "read", windowMin: 60, sells: 0, sellUsd: 0, transfersOut: 1, transferOutUsd: 50 }).includes("launcher-moved"));
    for (const creator of [
      { state: "read" as const, windowMin: 60, sells: 0, sellUsd: 0, transfersOut: 0, transferOutUsd: 0 },
      { state: "read" as const, windowMin: 60, sells: null, sellUsd: null, transfersOut: null, transferOutUsd: null },
      { state: "not-derivable" as const },
      { state: "unavailable" as const, failure: "timeout" as const },
    ]) {
      const lines = flowXLines({ ok: true, facts: { ...hourOf({}), creator } });
      assert.ok(lines.every((l) => !/launch/.test(l)), JSON.stringify(creator));
    }
  });

  it("nothing to say is an empty list, never 'no activity'", () => {
    assert.deepEqual(flowXLines({ ok: false, failure: "provider-cooldown" }), []);
    const silent = facts({ windows: FLOW_WINDOWS.map((minutes) => ({ minutes, buyUsd: 0, sellUsd: 0, buys: 0, sells: 0, buyers: 0, sellers: 0 })) });
    assert.deepEqual(flowXLines({ ok: true, facts: silent }), []);
  });

  it("the wording is drawn by seed: stable for one seed, and varied across them", () => {
    const r = { ok: true as const, facts: facts() };
    assert.deepEqual(flowXLines(r, "one|coin"), flowXLines(r, "one|coin"));
    const seen = new Set(Array.from({ length: 16 }, (_, i) => flowXLines(r, `tenant${String.fromCharCode(97 + i)}|coin`)[0]));
    assert.equal(seen.size, 2, "both wordings of the band are in use");
  });

  it("the numeric renderer for X is gone: figures go to the Brain lens only", () => {
    assert.equal("flowFactLines" in flowFactsModule, false);
  });

  it("the lane's parsed fixture renders end to end", async () => {
    const { parseTokenFlow } = await import("./venues/bitquery-lane");
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const data = (JSON.parse(readFileSync(path.join(HERE, "venues", "testdata", "bitquery-lane", "token-flow.json"), "utf8")) as { data: unknown }).data;
    const read = parseTokenFlow(data)!;
    const f: FlowFacts = { token: TOKEN, observedAt: NOW, ...read, creator: { state: "not-derivable" } };
    assert.deepEqual(flowFactsOf(JSON.parse(JSON.stringify(f))), f, "what the lane produces is what the wire accepts");
    assert.ok(renderFlowLens({ ok: true, facts: f }, NOW));
  });
});
