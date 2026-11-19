import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  chartWindows,
  defaultWindow,
  fetchOwnBook,
  glanceOfHow,
  growthWindow,
  saveBook,
  statsParts,
  thesisOfHow,
  topTradeFigures,
} from "./profile-view";
import { json } from "./test-dom";
import type { ProfileTrade } from "@/lib/profile-trades";

describe("how an agent decides, as the profile may say it", () => {
  it("a published strategy is named, not 'Its own rules'", () => {
    // App mapped every profile to {id:"custom"} and thesis "", so every agent —
    // a Trencher, a steady basket, a strategist — read "Its own rules".
    const g = glanceOfHow({ kind: "strategy", name: "trencher" });
    assert.equal(g.id, "trencher");
    assert.equal(g.known, undefined, "a strategy read from its decisions is the real one");
    assert.match(thesisOfHow({ kind: "strategy", name: "trencher" }), /newly launched/);
    assert.equal(glanceOfHow({ kind: "strategy", name: "steady-basket" }).id, "steady-basket");
  });

  it("a model-driven agent is the strategist, and says which model when it may", () => {
    assert.equal(glanceOfHow({ kind: "model", provider: "groq", model: "qwen/qwen3.8-27b" }).id, "llm-strategist");
    assert.equal(thesisOfHow({ kind: "model", provider: "groq", model: "qwen/qwen3.8-27b" }), "Reads the market and decides each trade with qwen/qwen3.8-27b via groq.");
    assert.equal(thesisOfHow({ kind: "model", provider: null, model: null }), "Reads the market and decides each trade with a language model.");
  });

  it("nothing published is unpublished — never a guessed rulebook", () => {
    for (const how of [null, undefined, { kind: "strategy" as const, name: "my-secret-file" }]) {
      const g = glanceOfHow(how);
      assert.equal(g.known, false);
      assert.equal(thesisOfHow(how), "", "the page prints its own 'hasn't shared' line");
    }
  });
});

const H = 3_600;
const NOW = 10_000 * H;
const pts = (hoursAgo: number[], g = (i: number) => 1 + i / 100) => hoursAgo.map((h, i) => ({ at: NOW - h * H, g: g(i) }));

describe("the chart's windows", () => {
  it("ALL is the whole series, and is the default, so the chart covers what the headline does", () => {
    const p = pts([24 * 40, 24 * 20, 5, 0]);
    assert.deepEqual(growthWindow(p, "ALL", NOW, true), { state: "ok", values: [1, 1.01, 1.02, 1.03], from: p[0]!.at });
    assert.equal(defaultWindow(p, true, NOW), "ALL");
  });

  it("a window measures from the last reading at or before its start", () => {
    // 30h, 20h, 5h, now: 24H starts from the 30h reading — the book's value
    // twenty-four hours ago as last observed — not from the first one inside.
    const p = pts([30, 20, 5, 0]);
    assert.deepEqual(growthWindow(p, "24H", NOW, true), { state: "ok", values: [1, 1.01, 1.02, 1.03], from: NOW - 30 * H });
    const q = pts([60, 30, 20, 5, 0]);
    assert.deepEqual(growthWindow(q, "24H", NOW, true), { state: "ok", values: [1.01, 1.02, 1.03, 1.04], from: NOW - 30 * H });
  });

  it("a window the history does not reach is not offered: a 9-hour book has no '24H'", () => {
    const p = pts([9, 4, 0]);
    assert.deepEqual(growthWindow(p, "24H", NOW, true), { state: "short" });
    assert.deepEqual(
      chartWindows(p, true, NOW).map((w) => [w.id, w.available]),
      [["24H", false], ["7D", false], ["30D", false], ["ALL", true]],
    );
  });

  it("no reading inside the window is said, not drawn flat", () => {
    const p = pts([50, 40]);
    assert.deepEqual(growthWindow(p, "24H", NOW, true), { state: "empty" });
  });

  it("a capped read has no ALL, and the default falls back to the longest window it can back", () => {
    const p = pts([24 * 35, 24 * 10, 1, 0]);
    assert.deepEqual(growthWindow(p, "ALL", NOW, false), { state: "partial" });
    assert.equal(chartWindows(p, false, NOW).find((w) => w.id === "ALL")!.available, false);
    assert.equal(defaultWindow(p, false, NOW), "30D");
  });

  it("the right-hand end of every window is the newest reading", () => {
    const p = pts([24 * 40, 24 * 8, 30, 3, 0]);
    for (const w of ["24H", "7D", "30D", "ALL"] as const) {
      const s = growthWindow(p, w, NOW, true);
      assert.equal(s.state, "ok");
      if (s.state === "ok") assert.equal(s.values.at(-1), p.at(-1)!.g, w);
    }
  });
});

describe("the stats line", () => {
  it("says what was read, in the agent's book, and leaves the rest out", () => {
    const joined = Date.UTC(2026, 8, 14, 12) / 1000;
    const parts = statsParts({ tradeCount: 12, tradeCountFloor: false, avgHoldSec: 3 * H + 20 * 60, joinedAt: joined, paper: false, gasless: false });
    assert.deepEqual(parts.slice(0, 2), ["12 trades", "avg hold 3h 20m"]);
    assert.match(parts[2]!, /^Joined .*14.*2026$/, "a date, from the identity's own createdAt");
    assert.equal(parts.length, 3);
    assert.deepEqual(statsParts({ tradeCount: 1, tradeCountFloor: false, avgHoldSec: null, joinedAt: null, paper: true, gasless: false }), ["1 paper trade"]);
    assert.deepEqual(statsParts({ tradeCount: 5_000, tradeCountFloor: true, avgHoldSec: null, joinedAt: null, paper: false, gasless: false }), ["5,000+ trades"]);
    assert.deepEqual(statsParts({ tradeCount: null, tradeCountFloor: false, avgHoldSec: null, joinedAt: null, paper: false, gasless: false }), []);
  });

  it("gasless is said only when it was measured", () => {
    assert.deepEqual(statsParts({ tradeCount: 3, tradeCountFloor: false, avgHoldSec: null, joinedAt: null, paper: false, gasless: true }), ["3 trades", "Gasless: every trade sponsored"]);
    // A paper book's trades cost nobody gas, so "sponsored" would be a claim about nothing.
    assert.deepEqual(statsParts({ tradeCount: 3, tradeCountFloor: false, avgHoldSec: null, joinedAt: null, paper: true, gasless: true }), ["3 paper trades"]);
  });
});

describe("a top trade", () => {
  const trade = (over: Partial<ProfileTrade>): ProfileTrade => ({
    id: "1", action: "sell", symbol: "CASHCAT", displayName: null, at: 0, paper: false, sizeUsdg: null, realizedPnlUsdg: null, realizedPnlBps: 4_210, ...over,
  });
  it("prints its return, and dollars only when the server sent them AND the viewer may see them", () => {
    assert.deepEqual(topTradeFigures(trade({}), true), { pct: "+42.1%", usd: null, tone: "up" });
    assert.deepEqual(topTradeFigures(trade({ realizedPnlUsdg: 3.1 }), true), { pct: "+42.1%", usd: "+$3.10", tone: "up" });
    assert.deepEqual(topTradeFigures(trade({ realizedPnlBps: -500, realizedPnlUsdg: -0.4 }), true), { pct: "−5.0%", usd: "−$0.40", tone: "down" });
  });

  it("a private book's dollars are refused here too, whatever the row carries", () => {
    // The server nulls them, but the swaps table on the same page refuses a
    // private dollar it was handed anyway — two rules on one page was one
    // server line away from printing a private book's P&L.
    assert.deepEqual(topTradeFigures(trade({ realizedPnlUsdg: 3.1 }), false), { pct: "+42.1%", usd: null, tone: "up" });
  });
});

describe("the owner's switch for the public book", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("sends a real boolean and reports success", async () => {
    let sent: unknown;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return json({ ok: true }); }) as typeof fetch;
    assert.deepEqual(await saveBook(true), { ok: true });
    assert.deepEqual(sent, { publicBook: true });
  });

  it("A SERVER THAT DROPPED THE FIELD DID NOT SAVE IT, whatever {ok:true} says", async () => {
    // An older build returns ok and lists the key it ignored. Reporting that as
    // saved is exactly the silent drop that kept every book private.
    globalThis.fetch = (async () => json({ ok: true, ignored: ["publicBook"] })) as typeof fetch;
    const r = await saveBook(true);
    assert.equal(r.ok, false);
  });

  it("a refusal or an outage is said in words, never swallowed", async () => {
    globalThis.fetch = (async () => json({ errors: ["not signed in"] }, 401)) as typeof fetch;
    assert.deepEqual(await saveBook(true), { ok: false, message: "not signed in" });
    globalThis.fetch = (async () => { throw new TypeError("failed"); }) as typeof fetch;
    const r = await saveBook(false);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.message, /Can't reach merrymen/);
  });
});

describe("the owner's own read, as the page takes it", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const answer = (over: Record<string, unknown> = {}, figures: Record<string, unknown> = {}) => ({
    recentTrades: [], activityRead: true, topTrades: [], topTradesRead: true, figuresRead: true,
    figures: { book: "live", equityUsdg: 103, equityAt: 3_000, pnlUsdg: 2, pnlAt: 3_000, underReview: false, pnlEstimated: false, ...figures },
    ...over,
  });
  const read = async (body: unknown, status = 200) => {
    globalThis.fetch = (async () => json(body, status)) as typeof fetch;
    return fetchOwnBook("shogun");
  };

  it("carries the owner's current value and dollar P&L, as sent", async () => {
    assert.deepEqual((await read(answer()))!.figures,
      { book: "live", equityUsdg: 103, equityAt: 3_000, held: false, pnlUsdg: 2, pnlAt: 3_000, underReview: false, pnlEstimated: false });
    assert.equal((await read(answer({}, { pnlEstimated: true })))!.figures!.pnlEstimated, true);
    // A held value says so, as its own read did; anything but `true` is not held.
    assert.equal((await read(answer({}, { held: true })))!.figures!.held, true);
    assert.equal((await read(answer({}, { held: "yes" })))!.figures!.held, false);
  });

  it("figures the server could not read, or an older server that sent none, are null — never zero", async () => {
    assert.equal((await read(answer({ figuresRead: false })))!.figures, null, "said unread, whatever rides beside it");
    const older = (await read({ recentTrades: [], activityRead: true, topTrades: [], topTradesRead: true }))!;
    assert.equal(older.figures, null);
    assert.deepEqual(older.recentTrades, [], "and the trades it did send still count");
    assert.equal(await read({ error: "Agent not found" }, 404), null, "a refusal is no owner's view at all");
  });

  it("a malformed figure is unread, and a malformed book refuses all of them", async () => {
    for (const figures of [null, "103", [], { book: "spot" }, { book: undefined }]) {
      assert.equal((await read(answer({ figures })))!.figures, null, JSON.stringify(figures));
    }
    const bad = (await read(answer({}, { equityUsdg: "103", pnlUsdg: {} })))!.figures!;
    assert.deepEqual([bad.equityUsdg, bad.pnlUsdg], [null, null], "a string is not a number");
    // A dollar figure that cannot say when it was measured is not printed.
    const untimed = (await read(answer({}, { equityAt: null, pnlAt: -1 })))!.figures!;
    assert.deepEqual([untimed.equityUsdg, untimed.pnlUsdg], [null, null]);
    // A return under review carries no dollar P&L and no estimate, even if sent.
    const review = (await read(answer({}, { underReview: true, pnlEstimated: true })))!.figures!;
    assert.deepEqual([review.underReview, review.pnlUsdg, review.pnlEstimated, review.equityUsdg], [true, null, false, 103]);
    // No valuation yet: unknown, as a published book's would be.
    const none = (await read(answer({}, { book: null, equityUsdg: null, equityAt: null, pnlUsdg: null, pnlAt: null })))!.figures!;
    assert.deepEqual([none.book, none.equityUsdg, none.pnlUsdg], [null, null, null]);
  });
});
