/**
 * WHAT A MISSING OR FLAT RETURN MEANS, on every surface that prints one.
 *
 * The board, the desktop sidebar, search and the profile each printed
 * `pctBps` of whatever arrived, so a paper book that had never traded read
 * "0.0%" beside books that traded and broke even; a buy no valuation had
 * included read as a flat result; a funded live book with no trade read
 * "Unavailable". performanceOf now says which of those a row is, and these
 * tests render the real pages through the real wire mapping to prove each
 * surface prints it — and that no real number is ever replaced.
 *
 * React DOM is loaded with a document present (the `before` below), as the
 * other typing tests do: it decides at import whether the browser has an
 * `input` event, and search is only reached by typing.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { autonomyOf } from "@merrymen/core";
import { loadLive, type LiveAgent, type LiveMine } from "./live";
import { STALE_VALUATION_SEC, performanceFromWire, staleSince, type AgentPerformance } from "./agent-performance";
import type { ProfileAgent } from "./profile-view";

(globalThis as unknown as { React: typeof React }).React = React;
// Not test-dom's: importing it loads React DOM before the document exists.
const notFound = async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
let testDom: typeof import("./test-dom").testDom;
let Board: typeof import("./screens/Board").Board;
let tradeLine: typeof import("./screens/Board").tradeLine;
let Search: typeof import("./screens/Search").Search;
let Profile: typeof import("./screens/Profile").Profile;
let DesktopSidebar: typeof import("./Desktop").DesktopSidebar;

before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>");
  Object.assign(globalThis, { window: boot.window, document: boot.window.document });
  ({ testDom } = await import("./test-dom"));
  ({ Board, tradeLine } = await import("./screens/Board"));
  ({ Search } = await import("./screens/Search"));
  ({ Profile } = await import("./screens/Profile"));
  ({ DesktopSidebar } = await import("./Desktop"));
  Reflect.deleteProperty(globalThis, "window"); Reflect.deleteProperty(globalThis, "document"); boot.window.close();
});

const noop = () => {};
const NOW = Math.floor(Date.now() / 1000);
/** A fresh valuation by default, so no as-of text or banner is part of what a test reads unless it asks. */
const performance = (over: Partial<AgentPerformance> = {}): AgentPerformance => ({
  book: "live", equityUsdg: 1125, equityAt: NOW - 60, pnlUsdg: 125,
  pnlBps: 1250, pnlAt: NOW - 60, publicBook: true, gasComplete: true, held: false, ...over,
});
const row = (name: string, over: Record<string, unknown> = {}) => ({
  slug: name.toLowerCase(), name, handle: null, mode: "live", landed: 3, filledPaper: 0,
  pnlBps: 0, paperPnlBps: 0, curve: [777], performance: performance(), ...over,
});

/** Through the real wire mapping, as the app reads the leaderboard. */
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

const mine: LiveMine = { name: "Mine", slug: "mine", handle: null, owner: "you", mode: null, equity: null, glance: { id: "custom", label: "" },
  autonomy: autonomyOf({ mode: null, liveBlocker: null }), moves: [], thesis: null, chg24: null };
function sidebar(agents: LiveAgent[]) {
  return new JSDOM(renderToStaticMarkup(React.createElement(DesktopSidebar, {
    agents, mine, tokens: [], theses: [], screen: { kind: "tab", tab: "home" }, section: "agents", onSection: noop,
    onScreen: noop, onTab: noop, reads: { market: "ok", board: "ok", theses: "ok", discoveries: "ok", mine: "ok" },
  }))).window.document;
}

/** Search and the profile are stateful pages: rendered in a DOM, with no network. */
async function inDom<T>(fn: (ui: ReturnType<typeof testDom>) => Promise<T>): Promise<T> {
  const ui = testDom();
  const realFetch = globalThis.fetch;
  const g = globalThis as { ResizeObserver?: unknown; self?: unknown };
  const real = { observer: g.ResizeObserver, self: g.self };
  globalThis.fetch = notFound as typeof fetch;
  g.ResizeObserver = class { observe() {} disconnect() {} };
  // The profile's wire button schedules idle work through `self`.
  g.self = ui.dom.window;
  try { return await fn(ui); }
  finally {
    await ui.close();
    globalThis.fetch = realFetch;
    g.ResizeObserver = real.observer;
    g.self = real.self;
  }
}

async function searchRows(agents: LiveAgent[], query: string): Promise<string[]> {
  return inDom(async (ui) => {
    await ui.render(React.createElement(Search, { tokens: [], agents, onBack: noop, onToken: noop, onProfile: noop }));
    const input = ui.container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, query);
      input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
    });
    return [...ui.container.querySelectorAll("button.tok")].map((b) => b.textContent ?? "");
  });
}

async function profilePage(agent: LiveAgent): Promise<{ figure: string; text: string }> {
  return inDom(async (ui) => {
    await ui.render(React.createElement(Profile, { agent: agent as ProfileAgent, theses: [], tokens: [], onBack: noop, onToken: noop }));
    return { figure: ui.container.querySelector(".public-return")!.textContent ?? "", text: ui.container.textContent ?? "" };
  });
}

test("a paper book that never traded says No trades yet on the board, the sidebar, search and its profile — never 0.0%", async () => {
  // Eleven simulated operations and no swap among them: its flat return is
  // the book compared with itself, and its operations are not trades.
  const { agents } = await read([row("Quiet", { mode: "paper", pnlBps: null, paperPnlBps: 0, landed: 0, filledPaper: 11, paperFills: 0,
    performance: performance({ book: "paper", equityUsdg: 1000, pnlUsdg: 0, pnlBps: 0, fills: 0, fillsAtMark: 0, valuation: "current" }) })]);
  for (const preview of [false, true]) {
    const r = board(agents, preview).querySelector(".rank")!;
    assert.equal(r.querySelector(".chg")!.textContent, "No trades yet");
    assert.doesNotMatch(r.querySelector(".chg")!.className, /\b(up|down)\b/);
    assert.equal(r.querySelector(".rank-trades")!.textContent, "0 paper trades", "its operations are not called trades");
    assert.equal(r.querySelector(".rank-pnl"), null, "and no flat dollar result either");
  }
  const card = sidebar(agents).querySelector(".sidebar-agent-performance")!;
  assert.match(card.textContent!, /No trades yet/);
  assert.match(card.getAttribute("aria-label")!, /return No trades yet/);
  const [found] = await searchRows(agents, "quiet");
  assert.match(found!, /No trades yet/);
  const page = await profilePage(agents[0]!);
  assert.equal(page.figure, "No trades yet");
  assert.doesNotMatch(page.text, /paper trades/, "no count of trades it did not make");
  for (const text of [board(agents).querySelector(".board")!.textContent!, card.textContent!, found!, page.text]) {
    assert.doesNotMatch(text, /0\.0%|\$0\.00 P&L/);
  }
});

test("a real number is never replaced: a ranked return, a nonzero paper change, a vault-only live book", async () => {
  const { agents } = await read([
    // Its only landed operation is a vault deposit: ranked, and no trade.
    row("Vault", { landed: 1, liveFills: 0, pnlBps: 1000,
      performance: performance({ pnlBps: 1000, pnlUsdg: 10, fills: 0, fillsAtMark: 0, funded: true, valuation: "current" }) }),
    // A simulated vault move changed the paper book; no swap was made.
    row("Drift", { mode: "paper", pnlBps: null, landed: 0, filledPaper: 2, paperFills: 0,
      performance: performance({ book: "paper", pnlBps: 12.5, pnlUsdg: 1.25, fills: 0, fillsAtMark: 0, valuation: "current" }) }),
    // A ranked flat result stays a flat result.
    row("Flat", { pnlBps: 0, performance: performance({ pnlBps: 0, pnlUsdg: 0, fills: 3, fillsAtMark: 3, valuation: "current" }) }),
  ]);
  const rows = [...board(agents).querySelectorAll(".rank")];
  const named = (name: string) => rows.find((r) => r.textContent!.includes(name))!;
  assert.equal(named("Vault").querySelector(".chg")!.textContent, "+10.0%");
  assert.equal(named("Vault").querySelector(".rank-trades")!.textContent, "1 operation");
  assert.equal(named("Drift").querySelector(".chg")!.textContent, "+0.1%");
  assert.equal(named("Flat").querySelector(".chg")!.textContent, "0.0%");
  for (const name of ["Vault", "Drift", "Flat"]) assert.equal(named(name).querySelector(".performance-state"), null, name);
  const [drift] = await searchRows(agents, "drift");
  assert.match(drift!, /\+0\.1%/);
});

test("Finley and Ajinde: trades no valuation includes say so, without touching a measured return", async () => {
  const { agents } = await read([
    // One valuation, then two buys eight seconds later.
    row("Finley", { mode: "paper", pnlBps: null, paperFills: 2, filledPaper: 2,
      performance: performance({ book: "paper", pnlBps: 0, pnlUsdg: 0, fills: 2, fillsAtMark: 0, lastFillAt: NOW - 52, valuation: "awaiting" }) }),
    // A measured −0.42 bps, and a fill four seconds after it.
    row("Ajinde", { mode: "paper", pnlBps: null, paperFills: 2, filledPaper: 2,
      performance: performance({ book: "paper", pnlBps: -0.42, pnlUsdg: -0.042, fills: 2, fillsAtMark: 1, lastFillAt: NOW - 56, valuation: "awaiting" }) }),
  ]);
  const rows = [...board(agents).querySelectorAll(".rank")];
  const finley = rows.find((r) => r.textContent!.includes("Finley"))!;
  assert.equal(finley.querySelector(".chg")!.textContent, "Awaiting first valuation");
  const ajinde = rows.find((r) => r.textContent!.includes("Ajinde"))!;
  assert.equal(ajinde.querySelector(".chg")!.textContent, "−0.0042%");
  assert.equal(ajinde.querySelector(".performance-note")!.textContent, "awaiting valuation");
  assert.match(ajinde.querySelector(".rank-return")!.getAttribute("title")!, /newer trade is not in this return yet/);
  assert.equal((await profilePage(agents[0]!)).figure, "Awaiting first valuation");
  assert.match(sidebar(agents).body.textContent!, /Awaiting first valuation/);
  const [found] = await searchRows(agents, "ajinde");
  assert.match(found!, /−0\.0042%awaiting valuation/);
});

test("a live book with no trade says whether it is funded, and never shows Unavailable for it", async () => {
  const { agents } = await read([
    row("Funded", { pnlBps: null, unrankedWhy: "never-filled", landed: 0, liveFills: 0,
      performance: performance({ pnlBps: null, pnlUsdg: null, fills: 0, fillsAtMark: 0, funded: true, valuation: "current" }) }),
    row("Empty", { pnlBps: null, unrankedWhy: "no-deposit", landed: 0, liveFills: 0,
      performance: performance({ pnlBps: null, pnlUsdg: null, fills: 0, fillsAtMark: 0, funded: false, valuation: "current" }) }),
    // No valuation names a book yet; the heartbeat says it will be live.
    row("Newborn", { pnlBps: null, unrankedWhy: "no-deposit", landed: 0, liveFills: 0,
      performance: { book: null, publicBook: false, fills: 0, fillsAtMark: 0, funded: false } }),
  ]);
  const doc = board(agents);
  const said = (name: string) => [...doc.querySelectorAll(".rank")].find((r) => r.textContent!.includes(name))!.querySelector(".chg")!.textContent;
  assert.equal(said("Funded"), "Funded · no trades yet");
  assert.equal(said("Empty"), "No deposit yet");
  assert.equal(said("Newborn"), "No deposit yet");
  assert.doesNotMatch(doc.querySelector(".board")!.textContent!, /Unavailable/);
  assert.equal((await profilePage(agents[0]!)).figure, "Funded · no trades yet");
});

test("a return under review says so everywhere and shows no percentage, even if one arrives", async () => {
  const { agents } = await read([row("Johnny", { mode: "idle", pnlBps: null,
    performance: { ...performance({ pnlBps: 4321, pnlUsdg: 43.21, fills: 9, fillsAtMark: 9, valuation: "current" }), underReview: true } })]);
  assert.equal(agents[0]!.performance!.pnlBps, null, "withheld at the mapping boundary too");
  const r = board(agents).querySelector(".rank")!;
  assert.equal(r.querySelector(".chg")!.textContent, "Return under review");
  assert.equal(r.querySelector(".rank-have")!.textContent, "$1,125.00", "the valuation stays");
  const card = sidebar(agents).querySelector(".sidebar-agent-performance")!.textContent!;
  assert.match(card, /Return under review/);
  const page = await profilePage(agents[0]!);
  assert.equal(page.figure, "Return under review");
  const [found] = await searchRows(agents, "johnny");
  assert.match(found!, /Return under review/);
  for (const text of [r.textContent!, card, found!, page.text]) assert.doesNotMatch(text, /43\.2|\+\$43/);
});

test("a stale valuation says when it was taken in visible text, and the board says when the newest was", async () => {
  const stale = NOW - 3 * 3_600;
  const { agents } = await read([
    row("Old", { performance: performance({ equityAt: stale, pnlAt: stale }) }),
    row("Older", { performance: performance({ equityAt: stale - 3_600, pnlAt: stale - 3_600 }) }),
  ]);
  assert.equal(staleSince(agents, NOW), stale, "the NEWEST valuation, not the oldest");
  for (const preview of [false, true]) {
    const doc = board(agents, preview);
    const banner = doc.querySelector(".performance-banner")!;
    assert.match(banner.textContent!, /^No new valuations since \S.*\. Each figure is as of its agent's last valuation\.$/);
    assert.doesNotMatch(banner.textContent!, /paus|halt|held|recover|incident/i, "staleness only, never a cause");
    for (const r of doc.querySelectorAll(".rank")) assert.match(r.querySelector(".performance-asof")!.textContent!, /^as of \S/);
  }
  assert.ok(sidebar(agents).querySelector(".performance-asof"), "the sidebar says it too");
  assert.match((await searchRows(agents, "old"))[0]!, /as of \S/);
  assert.match((await profilePage(agents[0]!)).text, /as of \S/);
  // A row the recovery hold kept already says "Last valued" on the board, so
  // it is not said twice there — and the other surfaces, which do not print
  // that, still say when.
  const { agents: kept } = await read([row("Kept", { mode: "idle", notRunning: true, performance: performance({ equityAt: stale, pnlAt: stale }) })]);
  const keptRow = board(kept).querySelector(".rank")!;
  assert.match(keptRow.textContent!, /Last valued \S/);
  assert.equal(keptRow.querySelector(".performance-asof"), null);
  assert.ok(sidebar(kept).querySelector(".performance-asof"));
  // Fresh: nothing about time is added.
  const { agents: current } = await read([row("Now")]);
  assert.equal(staleSince(current, NOW), null);
  const doc = board(current);
  assert.equal(doc.querySelector(".performance-banner"), null);
  assert.equal(doc.querySelector(".performance-asof"), null);
  assert.equal(staleSince(current, NOW + STALE_VALUATION_SEC + 120), NOW - 60, "and it turns stale on its own clock");
});

test("an older server's performance reads as unread, and contradictory counts are not believed", () => {
  const legacy = performanceFromWire({ book: "paper", publicBook: true, pnlBps: 0, equityAt: 1 });
  assert.deepEqual([legacy.fills, legacy.fillsAtMark, legacy.funded, legacy.valuation, legacy.underReview], [null, null, null, null, false]);
  const broken = performanceFromWire({ book: "paper", fills: 1, fillsAtMark: 2, valuation: "soon", funded: "yes", gasOps: { sponsored: -1 } });
  assert.deepEqual([broken.fills, broken.fillsAtMark, broken.valuation, broken.funded, broken.gasOps], [null, null, null, null, null]);
});

test("the trade line counts trades where the server counted them, and operations where it did not", () => {
  const agent = (over: Partial<LiveAgent>) =>
    ({ slug: "a", name: "A", handle: null, pnlBps: null, curve: [], landed: 0, ...over }) as LiveAgent;
  assert.equal(tradeLine(agent({ mode: "paper", filledPaper: 11, paperFills: 0 })), "0 paper trades");
  assert.equal(tradeLine(agent({ mode: "paper", filledPaper: 11 })), "11 paper trades", "an older server: as before");
  assert.equal(tradeLine(agent({ landed: 4, liveFills: 3 })), "3 trades");
  assert.equal(tradeLine(agent({ landed: 2, liveFills: 0 })), "2 operations");
  assert.equal(tradeLine(agent({ landed: 0, liveFills: 0, filledPaper: 5, paperFills: 1 })), "1 on paper");
  assert.equal(tradeLine(agent({ landed: 0, liveFills: 0, filledPaper: 5, paperFills: 0 })), "No trades yet");
});
