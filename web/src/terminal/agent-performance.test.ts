import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { autonomyOf } from "@merrymen/core";
import { loadLive, type LiveAgent, type LiveMine } from "./live";
import { Board } from "./screens/Board";
import { DesktopSidebar } from "./Desktop";
import type { AgentPerformance } from "./agent-performance";

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
  assert.equal(unknown.querySelector(".chg")!.textContent, "Unavailable");
  assert.doesNotMatch(unknown.textContent!, /99\.0%|0\.0%|\$0\.00/);
  const held = rows.find(r => r.textContent!.includes("Held"))!;
  assert.match(held.querySelector(".rank-book")!.textContent!, /Live · Pending/);
  const title = held.querySelector(".rank-value")!.getAttribute("title")!;
  assert.match(title, /Valued .*P&L measured .*pending reconciliation/);
  const gas = rows.find(r => r.textContent!.includes("Gas"))!;
  assert.equal(gas.querySelector(".chg")!.textContent, "Gas accounting unavailable");
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

test("a malformed performance field stays unavailable rather than coercing empty data into zero", async () => {
  const { agents } = await read([row("Malformed", { pnlBps: 9900, performance: {
    book: "live", publicBook: true, pnlBps: "", equityUsdg: "0", pnlUsdg: null,
    equityAt: 1e20, pnlAt: -1, gasComplete: null, held: false,
  } })]);
  const doc = board(agents);
  assert.equal(doc.querySelector(".rank-have")!.textContent, "—");
  assert.equal(doc.querySelector(".chg")!.textContent, "Unavailable");
  assert.match(doc.querySelector(".rank-value")!.getAttribute("title")!, /Valuation time unavailable.*Measured P&L unavailable/);
  assert.doesNotMatch(doc.body.textContent!, /99\.0%|0\.0%|\$0\.00/);
});
