/**
 * THE BOARD'S ORDER: ranked live returns, then every other row that shows a
 * return (paper included), then the rows with none to show.
 *
 * With no live return ranked (every live book waiting on its gas cost), the
 * board used to keep the server's order, live books first, and the Home
 * preview's five rows showed no figure while the paper books' returns sat
 * further down. These tests read agents through the real wire mapping, as the
 * app does, and render the real board for the preview.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { loadLive, pctBps, type LiveAgent } from "./live";
import type { AgentPerformance } from "./agent-performance";
import { boardOrder } from "./board-order";

(globalThis as unknown as { React: typeof React }).React = React;
let Board: typeof import("./screens/Board").Board;

before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>");
  Object.assign(globalThis, { window: boot.window, document: boot.window.document });
  ({ Board } = await import("./screens/Board"));
  Reflect.deleteProperty(globalThis, "window"); Reflect.deleteProperty(globalThis, "document"); boot.window.close();
});

const noop = () => {};
const NOW = Math.floor(Date.now() / 1000);
const performance = (over: Partial<AgentPerformance> = {}): AgentPerformance => ({
  book: "live", equityUsdg: 1125, equityAt: NOW - 60, pnlUsdg: 125,
  pnlBps: 1250, pnlAt: NOW - 60, publicBook: true, gasComplete: true, held: false, ...over,
});
const row = (name: string, over: Record<string, unknown> = {}) => ({
  slug: name.toLowerCase().replace(/\s+/g, "-"), name, handle: null, mode: "live", landed: 3, filledPaper: 0,
  pnlBps: 0, paperPnlBps: 0, curve: [777], performance: performance(), ...over,
});
/** A live book whose gas cost is not yet recorded: listed, valued, and no return to show. */
const gasPending = (name: string) => row(name, { pnlBps: null, unrankedWhy: "gas-pending",
  performance: performance({ pnlUsdg: null, pnlBps: null, gasComplete: false, fills: 9, fillsAtMark: 9, valuation: "current" }) });
/** A paper book that traded: its change since its first recorded valuation. */
const paper = (name: string, bps: number) => row(name, { mode: "paper", pnlBps: null, unrankedWhy: "paper", paperPnlBps: bps, landed: 0,
  filledPaper: 8, paperFills: 8, performance: performance({ book: "paper", publicBook: false, pnlUsdg: null, pnlBps: bps, fills: 8, fillsAtMark: 8, valuation: "current" }) });
/** A paper book that never traded: No trades yet, never a flat 0.0%. */
const quiet = (name: string) => row(name, { mode: "paper", pnlBps: null, unrankedWhy: "paper", paperPnlBps: 0, landed: 0, filledPaper: 11, paperFills: 0,
  performance: performance({ book: "paper", publicBook: false, pnlUsdg: null, pnlBps: 0, fills: 0, fillsAtMark: 0, valuation: "current" }) });

/** Through the real wire mapping, as the app reads the leaderboard. */
async function read(rows: Record<string, unknown>[]): Promise<LiveAgent[]> {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => new Response(JSON.stringify(String(input).includes("/api/leaderboard")
    ? { source: "sqlite", agents: rows }
    : { tokens: [], theses: [], rows: [], assets: [], quotes: [] }));
  try { return (await loadLive()).agents; }
  finally { globalThis.fetch = original; }
}

const names = (agents: LiveAgent[]) => boardOrder(agents).map((r) => r.agent.name);

test("ranked live returns lead and alone are numbered; a paper return follows them, unnumbered", async () => {
  const agents = await read([
    gasPending("Gas"),
    paper("Paper", 300),
    row("Low", { pnlBps: 500, performance: performance({ pnlBps: 500 }) }),
    row("High", { pnlBps: 1200, performance: performance({ pnlBps: 1200 }) }),
  ]);
  const rows = boardOrder(agents);
  assert.deepEqual(rows.map((r) => [r.agent.name, r.rank, r.ret]), [
    ["High", 1, 1200],
    ["Low", 2, 500],
    ["Paper", 0, null],
    ["Gas", 0, null],
  ]);
});

test("with no live return ranked, the paper returns come first, highest first, then the rows with no return to show in server order", async () => {
  // The fleet on 2026-10-07: four live books waiting on gas, one paper book
  // whose figure is unavailable, then paper books with returns and without.
  const agents = await read([
    gasPending("Shogun"), gasPending("SirSendIt"), gasPending("Vector"), gasPending("Johnny"),
    row("Lost", { mode: "paper", pnlBps: null, paperPnlBps: null, unrankedWhy: "paper", landed: 0, filledPaper: 0,
      performance: performance({ book: "paper", publicBook: false, equityUsdg: null, equityAt: null, pnlUsdg: null, pnlBps: null, pnlAt: null }) }),
    quiet("Bullet"),
    paper("Guillermo", -5),
    paper("Replyarcweb", 10),
    paper("Wills", 4.6),
    paper("REALM", -120),
  ]);
  assert.deepEqual(names(agents), [
    "Replyarcweb", "Wills", "Guillermo", "REALM",
    "Shogun", "SirSendIt", "Vector", "Johnny", "Lost", "Bullet",
  ]);
  assert.ok(boardOrder(agents).every((r) => r.rank === 0 && r.ret === null), "nothing here is ranked");
});

test("a book that never traded is not sorted as a flat 0.0% among books that traded", async () => {
  const agents = await read([quiet("Quiet"), paper("Down", -3), paper("Even", 0)]);
  // "Even" traded and broke even: a figure. "Quiet" never traded: No trades yet, after every figure, even a loss.
  assert.deepEqual(names(agents), ["Even", "Down", "Quiet"]);
});

test("the Home preview's five rows show the paper returns, unnumbered, beside their Paper label", async () => {
  const agents = await read([
    gasPending("Shogun"), gasPending("SirSendIt"), gasPending("Vector"), gasPending("Johnny"),
    quiet("Bullet"), paper("Replyarcweb", 10), paper("Wills", 4.6), paper("Guillermo", -5),
  ]);
  const doc = new JSDOM(renderToStaticMarkup(React.createElement(Board, {
    agents, preview: true, theses: [], mine: null, onProfile: noop, onDesk: noop,
  }))).window.document;
  const rows = [...doc.querySelectorAll(".rank")];
  assert.equal(rows.length, 5, "the preview shows five rows");
  assert.deepEqual(rows.slice(0, 3).map((r) => r.querySelector(".chg")!.textContent), [pctBps(10), pctBps(4.6), pctBps(-5)]);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.querySelector(".n")!.textContent), ["—", "—", "—"], "paper returns stay outside the ranking");
  assert.ok(rows.slice(0, 3).every((r) => /Paper/.test(r.textContent!)), "each says it is a paper book");
});
