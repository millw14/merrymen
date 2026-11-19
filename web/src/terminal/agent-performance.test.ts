import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { autonomyOf } from "@merrymen/core";
import { loadLive, type LiveAgent, type LiveMine } from "./live";
import { Board } from "./screens/Board";
import { DesktopSidebar } from "./Desktop";
import { performanceOf, type AgentPerformance } from "./agent-performance";
import type { OwnFigures } from "@/lib/read-agent";
import { fullDateTime } from "@/lib/format";

(globalThis as unknown as { React: typeof React }).React = React;
const noop = () => {};
const performance = (over: Partial<AgentPerformance> = {}): AgentPerformance => ({
  book: "live", equityUsdg: 1125, equityAt: 1_790_000_100, pnlUsdg: 125,
  pnlBps: 1250, pnlAt: 1_790_000_100, publicBook: true, gasComplete: true, held: false, ...over,
});
const row = (name: string, over: Record<string, unknown> = {}) => ({
  slug: name.toLowerCase(), name, handle: null, mode: "live", landed: 3, filledPaper: 0,
  pnlBps: 0, paperPnlBps: 0, curve: [777], performance: performance(), ...over,
});

async function read(rows: Record<string, unknown>[]) {
  const original = globalThis.fetch;
  globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes("/api/leaderboard")
    ? { source: "sqlite", agents: rows }
    : { tokens: [], theses: [], rows: [], assets: [], quotes: [] }));
  try { return await loadLive(); }
  finally { globalThis.fetch = original; }
}

function board(agents: LiveAgent[], preview = false) {
  return new JSDOM(renderToStaticMarkup(React.createElement(Board, {
    agents, preview, theses: [], mine: null, onProfile: noop, onDesk: noop,
  }))).window.document;
}

test("the real leaderboard mapping renders current value and measured P&L, with paper distinct from live", async () => {
  const live = await read([
    row("Gain"),
    row("Loss", { performance: performance({ equityUsdg: 975, pnlUsdg: -25, pnlBps: -250 }) }),
    // This agent last beat idle; its actual persisted valuation is still paper.
    row("Julian", { mode: "idle", filledPaper: 24, landed: 0, pnlBps: null,
      performance: performance({ book: "paper", equityUsdg: 999.961086, pnlUsdg: -0.038914, pnlBps: -0.38914, gasComplete: null }) }),
    row("Zero", { performance: performance({ equityUsdg: 0, pnlUsdg: 0, pnlBps: 0 }) }),
  ]);
  for (const preview of [false, true]) {
    const doc = board(live.agents, preview);
    const rows = [...doc.querySelectorAll(".rank")];
    const gain = rows.find(r => r.textContent!.includes("Gain"))!;
    assert.equal(gain.querySelector(".rank-have")!.textContent, "$1,125.00");
    assert.equal(gain.querySelector(".chg")!.textContent, "+12.5%");
    assert.equal(gain.querySelector(".rank-pnl")!.textContent, "+$125.00 P&L");
    const loss = rows.find(r => r.textContent!.includes("Loss"))!;
    assert.equal(loss.querySelector(".chg")!.textContent, "−2.5%");
    assert.equal(loss.querySelector(".rank-pnl")!.textContent, "−$25.00 P&L");
    const julian = rows.find(r => r.textContent!.includes("Julian"))!;
    assert.equal(julian.querySelector(".chg")!.textContent, "−0.0039%");
    assert.equal(julian.querySelector(".rank-book")!.textContent, "Paper");
    assert.equal(julian.querySelector(".n")!.textContent, "—", "paper return does not give a live rank");
    const zero = rows.find(r => r.textContent!.includes("Zero"))!;
    assert.equal(zero.querySelector(".rank-have")!.textContent, "$0.00");
    assert.equal(zero.querySelector(".chg")!.textContent, "0.0%");
    assert.equal(zero.querySelector(".chg")!.className, "chg ", "a measured zero has no gain/loss direction");
  }
});

test("private, unknown, held and older-server data do not manufacture an amount or fall back to a legacy return", async () => {
  const live = await read([
    row("Private", { performance: performance({ publicBook: false, equityUsdg: 9876, pnlUsdg: 5432 }) }),
    row("Unknown", { pnlBps: 9900, performance: performance({ equityUsdg: null, pnlUsdg: null, pnlBps: null }) }),
    row("Held", { performance: performance({ held: true, equityAt: 1_790_000_200, pnlAt: 1_790_000_100 }) }),
    row("Gas", { performance: performance({ pnlUsdg: null, pnlBps: null, gasComplete: false }) }),
    row("Nodeposit", { pnlBps: null, unrankedWhy: "no-deposit", performance: performance({ pnlUsdg: null, pnlBps: null, valuation: "current", fills: 3, fillsAtMark: 3 }) }),
    row("Approx", { pnlBps: null, unrankedWhy: "gas-pending", performance: performance({ pnlUsdg: 12.5, pnlBps: 1250, gasComplete: false, pnlEstimated: true }) }),
    row("Legacy", { performance: undefined, pnlBps: 25 }),
  ]);
  assert.equal(live.agents[0]!.performance!.equityUsdg, null, "private dollars are discarded at the mapping boundary");
  assert.equal(live.agents[0]!.performance!.pnlUsdg, null);
  const doc = board(live.agents);
  const rows = [...doc.querySelectorAll(".rank")];
  const privateRow = rows.find(r => r.textContent!.includes("Private"))!;
  assert.equal(privateRow.querySelector(".rank-have")!.textContent, "Private");
  assert.equal(privateRow.querySelector(".rank-pnl"), null);
  assert.doesNotMatch(privateRow.outerHTML, /9876|5432/);
  const unknown = rows.find(r => r.textContent!.includes("Unknown"))!;
  assert.equal(unknown.querySelector(".rank-have")!.textContent, "—");
  assert.equal(unknown.querySelector(".chg")!.textContent, "Awaiting valuation");
  assert.doesNotMatch(unknown.textContent!, /99\.0%|0\.0%|\$0\.00/);
  const held = rows.find(r => r.textContent!.includes("Held"))!;
  assert.equal(held.querySelector(".rank-book")!.textContent, "Live", "pending is in the title, not under the figure");
  const title = held.querySelector(".rank-value")!.getAttribute("title")!;
  assert.match(title, /Valued .*P&L measured .*pending reconciliation/);
  const gas = rows.find(r => r.textContent!.includes("Gas"))!;
  assert.equal(gas.querySelector(".chg")!.textContent, "Awaiting valuation");
  assert.doesNotMatch(gas.textContent!, /Gas accounting/);
  // A withheld return says the server's reason, not "awaiting".
  assert.equal(rows.find(r => r.textContent!.includes("Nodeposit"))!.querySelector(".chg")!.textContent, "no deposit");
  // A return with some gas off the record is printed, marked approximate.
  const approx = rows.find(r => r.textContent!.includes("Approx"))!;
  assert.equal(approx.querySelector(".chg")!.textContent, "≈ +12.5%");
  assert.match(approx.querySelector(".rank-pnl")!.textContent!, /^≈ \+\$12\.50 P&L$/);
  assert.equal(approx.querySelector(".n")!.textContent, "—", "an approximate return is never ranked");
  const legacy = rows.find(r => r.textContent!.includes("Legacy"))!;
  assert.equal(legacy.querySelector(".rank-have")!.textContent, "—", "the old curve is never reused as current equity");
  assert.equal(legacy.querySelector(".chg")!.textContent, "+0.3%");
});

test("desktop discovery cards keep the same value, precise return and private-dollar boundary", async () => {
  const { agents } = await read([
    row("Julian", { performance: performance({ book: "paper", pnlBps: -0.38914, pnlUsdg: -0.038914 }) }),
    row("Private", { performance: performance({ publicBook: false, equityUsdg: 9876, pnlUsdg: 5432 }) }),
  ]);
  const mine: LiveMine = { name: "Mine", slug: "mine", handle: null, owner: "you", mode: null, equity: null, glance: { id: "custom", label: "" },
    autonomy: autonomyOf({ mode: null, liveBlocker: null }), moves: [], thesis: null, chg24: null };
  const html = renderToStaticMarkup(React.createElement(DesktopSidebar, {
    agents, mine, tokens: [], theses: [], screen: { kind: "tab", tab: "home" }, section: "agents", onSection: noop,
    onScreen: noop, onTab: noop, reads: { market: "ok", board: "ok", theses: "ok", discoveries: "ok", mine: "ok" },
  }));
  const doc = new JSDOM(html).window.document;
  const cards = [...doc.querySelectorAll(".sidebar-agent-performance")];
  assert.match(cards[0]!.textContent!, /\$1,125\.00Paper−0\.0039%−\$0\.04 P&L/);
  assert.match(cards[1]!.textContent!, /PrivateLive\+12\.5%/);
  assert.doesNotMatch(cards[1]!.outerHTML, /9876|5432|\$/);
});

test("retired accounts are listed under their count with their frozen final returns, private dollars withheld", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes("/api/leaderboard")
    ? { source: "sqlite", agents: [row("Alive")], retired: 3, retiredAgents: [
      { slug: "ghost", name: "Ghost", book: "live", pnlBps: 420, pnlUsdg: 4.2, estimated: true, trades: 7, lastValuedAt: 1_790_000_100 },
      { slug: null, name: "Robin", book: "paper", pnlBps: -150, pnlUsdg: null, estimated: false, trades: 2, lastValuedAt: null },
      { slug: null, name: "Robin", book: null, pnlBps: null, pnlUsdg: null, estimated: false, trades: 0, lastValuedAt: null },
    ] }
    : { tokens: [], theses: [], rows: [], assets: [], quotes: [] }));
  let live;
  try { live = await loadLive(); } finally { globalThis.fetch = original; }
  assert.equal(live.retiredAgents.length, 3);
  const doc = new JSDOM(renderToStaticMarkup(React.createElement(Board, {
    agents: live.agents, retired: live.retired, retiredAgents: live.retiredAgents,
    theses: [], mine: null, onProfile: noop, onDesk: noop,
  }))).window.document;
  assert.match(doc.querySelector(".board-retired summary")!.textContent!, /Retired accounts \(3\)/);
  const rows = [...doc.querySelectorAll(".board-retired-list .rank")];
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.querySelector(".chg")!.textContent, "≈ +4.2%");
  assert.match(rows[0]!.querySelector(".rank-pnl")!.textContent!, /≈ \+\$4\.20 P&L/);
  assert.equal(rows[1]!.querySelector(".chg")!.textContent, "−1.5%");
  assert.equal(rows[1]!.querySelector(".rank-pnl"), null);
  assert.equal(rows[1]!.querySelector("button")!.hasAttribute("disabled"), true, "an unlinked account has no profile");
  assert.equal(rows[2]!.querySelector(".chg")!.textContent, "No trades");
});

test("a malformed performance field stays unavailable rather than coercing empty data into zero", async () => {
  const { agents } = await read([row("Malformed", { pnlBps: 9900, performance: {
    book: "live", publicBook: true, pnlBps: "", equityUsdg: "0", pnlUsdg: null,
    equityAt: 1e20, pnlAt: -1, gasComplete: null, held: false,
  } })]);
  const doc = board(agents);
  assert.equal(doc.querySelector(".rank-have")!.textContent, "—");
  assert.equal(doc.querySelector(".chg")!.textContent, "Awaiting valuation");
  assert.match(doc.querySelector(".rank-value")!.getAttribute("title")!, /Valuation time unavailable.*Measured P&L unavailable/);
  assert.doesNotMatch(doc.body.textContent!, /99\.0%|0\.0%|\$0\.00/);
});

test("a row silent since the recovery hold is stamped by nothing but its own facts: when it was last valued, and nothing about expiry", async () => {
  // A named agent with a good key, quiet since 10-04: the board keeps it, as
  // it keeps any quiet worker, and no calendar rule stamps it. A flag an
  // older server still sends is not read, so it cannot stamp the row either.
  const { agents } = await read([
    row("Quiet", { mode: "paper", performance: performance({ book: "paper", publicBook: false, equityAt: 1_791_083_000 }) }),
    row("Flagged", { mode: "idle", notRunning: true, performance: performance({ equityAt: 1_791_083_000 }) }),
    row("Unvalued", { mode: "paper", notRunning: true, performance: undefined, pnlBps: null }),
    row("Running"),
  ]);
  for (const preview of [false, true]) {
    const doc = board(agents, preview);
    const rows = [...doc.querySelectorAll(".rank")];
    for (const r of rows) assert.doesNotMatch(r.textContent!, /Not running|Last valued/);
    const quiet = rows.find(r => r.textContent!.includes("Quiet"))!;
    assert.match(quiet.querySelector(".rank-value")!.getAttribute("title")!, /^Paper portfolio\. Valued \S/, "when it was last measured stays on the row");
    assert.equal(quiet.querySelector(".rank-have")!.textContent, "Private", "a private book stays private");
    // An idle row the board lists is said to be inactive, as it was before the hold.
    const flagged = rows.find(r => r.textContent!.includes("Flagged"))!;
    assert.ok([...flagged.querySelectorAll(".tag")].some(t => t.textContent === "Inactive"));
    assert.doesNotMatch(rows.find(r => r.textContent!.includes("Unvalued"))!.querySelector(".rank-value")!.getAttribute("title")!, /Valued \S/, "no time is invented for an unvalued book");
    assert.doesNotMatch(doc.body.textContent!, /expire|re-?sign|renew/i);
  }
});

test("the owner's own figures replace Private on their own view, by the published book's rules — and only there", () => {
  // "Why can't he see his balance": the owner's own private book read
  // "Private". Their session-checked figures are the dollars; the return and
  // its state stay the public read's, one rule for every viewer.
  const priv = (over: Partial<AgentPerformance> = {}, agent: Partial<LiveAgent> = {}) => ({
    slug: "shogun", name: "Shogun", handle: null, mode: "live", pnlBps: 1250, curve: [], landed: 3,
    performance: performance({ publicBook: false, equityUsdg: null, pnlUsdg: null, fills: 3, fillsAtMark: 3, valuation: "current", ...over }),
    ...agent,
  }) as LiveAgent;
  const own = (over: Partial<OwnFigures> = {}): OwnFigures => ({
    book: "live", equityUsdg: 1125, equityAt: 1_790_000_100, held: false, pnlUsdg: 125, pnlAt: 1_790_000_100, underReview: false, pnlEstimated: false, ...over,
  });

  // Nobody passes figures but the owner's view: a stranger, the board, a read
  // pending or refused all keep "Private".
  for (const none of [undefined, null]) {
    const f = performanceOf(priv(), undefined, none);
    assert.deepEqual([f.value, f.pnl, f.ownerOnly], ["Private", null, false]);
  }

  const mine = performanceOf(priv(), undefined, own());
  assert.deepEqual([mine.value, mine.pnl, mine.ownerOnly, mine.bps, mine.state], ["$1,125.00", "+$125.00", true, 1250, null]);
  assert.equal(performanceOf(priv(), undefined, own({ pnlUsdg: -0.004 })).pnl, "−$0.00400", "a sub-cent loss is not $0.00");
  assert.equal(performanceOf(priv(), undefined, own({ pnlEstimated: true })).pnl, "≈ +$125.00", "an estimate says so");

  // Unknown is never zero: a figure the owner's read could not give is "—".
  const unread = performanceOf(priv(), undefined, own({ equityUsdg: null, pnlUsdg: null }));
  assert.deepEqual([unread.value, unread.pnl, unread.ownerOnly], ["—", null, false]);
  assert.equal(performanceOf(priv(), undefined, own({ equityUsdg: 0, pnlUsdg: 0 })).value, "$0.00", "a measured zero is a zero");

  // Money of another book is not printed under this book's label.
  assert.equal(performanceOf(priv(), undefined, own({ book: "paper" })).value, "Private");

  // A review hold withholds the dollar P&L, from either read; the value stays.
  const held = performanceOf(priv({ underReview: true, pnlBps: null }, { pnlBps: null }), undefined, own());
  assert.deepEqual([held.state, held.pnl, held.value], ["Return under review", null, "$1,125.00"]);
  const ownHeld = performanceOf(priv(), undefined, own({ underReview: true }));
  assert.deepEqual([ownHeld.pnl, ownHeld.value], [null, "$1,125.00"]);
  // So does any state that replaces the return: no flat dollar for a book that never traded.
  const never = performanceOf(priv({ pnlBps: 0, fills: 0, fillsAtMark: 0, book: "paper" }, { pnlBps: null, mode: "paper" }), undefined, own({ book: "paper", pnlUsdg: 0 }));
  assert.deepEqual([never.state, never.pnl, never.value], ["No trades yet", null, "$1,125.00"]);

  // A published book prints its own figures, whatever else is passed.
  const pub = performanceOf(priv({ publicBook: true, equityUsdg: 900, pnlUsdg: -100 }), undefined, own());
  assert.deepEqual([pub.value, pub.pnl, pub.ownerOnly], ["$900.00", "−$100.00", false]);
});

test("the owner's figures keep their own read's held flag and time, and their dollars sit only beside the return they were measured with", () => {
  // The owner's read lands a moment after the public one, so a worker mark can
  // arrive between them. A published book's value, held flag, valuation time,
  // dollar P&L and percentage all come from one read; the owner's page must
  // never pair a value with another read's "Pending reconciliation" or time,
  // or print a dollar P&L beside a percentage of another valuation.
  const now = 1_790_010_000;
  const priv = (over: Partial<AgentPerformance> = {}) => ({
    slug: "shogun", name: "Shogun", handle: null, mode: "live", pnlBps: 1250, curve: [], landed: 3,
    performance: performance({ publicBook: false, equityUsdg: null, pnlUsdg: null, fills: 3, fillsAtMark: 3, valuation: "current", ...over }),
  }) as unknown as LiveAgent;
  const pub = (over: Partial<AgentPerformance> = {}) => ({ ...priv({ publicBook: true, ...over }) }) as LiveAgent;
  const own = (over: Partial<OwnFigures> = {}): OwnFigures => ({
    book: "live", equityUsdg: 1125, equityAt: now - 60, held: false, pnlUsdg: 125, pnlAt: now - 60, underReview: false, pnlEstimated: false, ...over,
  });
  const valued = (at: number) => `Valued ${fullDateTime(at * 1000)}`;

  // A newer, unheld mark landed after the public read: the reviewer's case.
  const newer = performanceOf(
    priv({ held: true, equityAt: now - 60, pnlAt: now - 300, pnlBps: 1250 }), now,
    own({ equityUsdg: 1300, equityAt: now - 5, held: false, pnlUsdg: 300, pnlAt: now - 5 }),
  );
  assert.equal(newer.value, "$1,300.00");
  assert.equal(newer.held, false, "the owner's value is not held, whatever the older public mark was");
  assert.ok(newer.title.includes(valued(now - 5)), newer.title);
  assert.doesNotMatch(newer.title, /pending reconciliation/);
  assert.equal(newer.pnl, null, "no dollars beside a percentage of another valuation");
  assert.equal(newer.bps, 1250, "the percentage stays the public read's");
  assert.equal(newer.ownerOnly, true);

  // The owner's read trails: an older, held mark. Its own flag and time go with it.
  const older = performanceOf(
    priv({ held: false, equityAt: now - 5, pnlAt: now - 5 }), now,
    own({ equityUsdg: 1100, equityAt: now - 60, held: true, pnlAt: now - 300 }),
  );
  assert.deepEqual([older.value, older.held, older.pnl], ["$1,100.00", true, null]);
  assert.ok(older.title.includes(valued(now - 60)) && /pending reconciliation/.test(older.title), older.title);

  // A held mark newer than the measured one, with the same measured valuation
  // in both reads: the dollars stand, and the value says it is pending.
  const pending = performanceOf(priv({ pnlAt: now - 300 }), now, own({ equityAt: now - 5, held: true, pnlAt: now - 300 }));
  assert.deepEqual([pending.value, pending.pnl, pending.held], ["$1,125.00", "+$125.00", true]);

  // "as of" follows the value shown: a stale public time does not stamp a fresh owner value, nor the reverse.
  const stale = now - 2 * 60 * 60;
  assert.equal(performanceOf(priv({ equityAt: stale }), now, own({ equityAt: now - 5 })).asOf, null);
  assert.match(performanceOf(priv({ equityAt: now - 5 }), now, own({ equityAt: stale })).asOf ?? "", /^as of /);

  // ONE SNAPSHOT, OWNER VS PUBLISHED: a live book with unpriced gas whose only
  // figure is the dollar P&L (no percentage on a net contribution of zero or
  // less). The private read says nothing is estimated, because it carries no
  // figure (book-performance.ts); the owner's read and the published read do.
  const snapshot = { equityAt: now - 60, pnlAt: now - 60, held: false, gasComplete: false, pnlBps: null };
  const ownerView = performanceOf({ ...priv({ ...snapshot, pnlEstimated: false }), pnlBps: null } as LiveAgent, now,
    own({ equityUsdg: 120, pnlUsdg: 49.5, pnlEstimated: true }));
  const published = performanceOf({ ...pub({ ...snapshot, equityUsdg: 120, pnlUsdg: 49.5, pnlEstimated: true }), pnlBps: null } as LiveAgent, now);
  assert.deepEqual(
    [ownerView.value, ownerView.pnl, ownerView.held, ownerView.estimated, ownerView.gasIncomplete, ownerView.title, ownerView.asOf],
    [published.value, published.pnl, published.held, published.estimated, published.gasIncomplete, published.title, published.asOf],
  );
  assert.equal(ownerView.pnl, "≈ +$49.50");
  assert.match(ownerView.title, /Approximate: some gas costs are not on record yet/);
  // The owner's estimate counts only beside the dollars it qualifies: from
  // another valuation, it is neither printed nor said.
  const elsewhere = performanceOf({ ...priv({ ...snapshot, pnlEstimated: false }), pnlBps: null } as LiveAgent, now,
    own({ equityUsdg: 120, pnlUsdg: 49.5, pnlEstimated: true, pnlAt: now - 5 }));
  assert.deepEqual([elsewhere.pnl, elsewhere.estimated], [null, false]);
  assert.match(elsewhere.title, /Some gas costs are not on record yet\.?$/);

  // A stranger's view of the same private read is unchanged by all of this.
  const stranger = performanceOf(priv({ held: true, equityAt: now - 60 }), now);
  assert.deepEqual([stranger.value, stranger.held, stranger.ownerOnly], ["Private", true, false]);
  assert.ok(stranger.title.includes(valued(now - 60)));
});
