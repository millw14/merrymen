import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import React, { act } from "react";
import { Profile } from "./screens/Profile";
import type { ProfileAgent } from "./profile-view";
import { json, testDom } from "./test-dom";

/**
 * THE PROFILE, RENDERED — what a stranger and the owner actually see.
 *
 * The rules are tested in profile-view.test.ts; this proves the page applies
 * them: the stats line, TOP TRADES, the chart's windows and the owner's switch.
 */
let ui: ReturnType<typeof testDom>;
const realFetch = globalThis.fetch;
const g = globalThis as { ResizeObserver?: unknown; self?: unknown };
const real = { observer: g.ResizeObserver, self: g.self };
beforeEach(() => {
  ui = testDom();
  // No network: a case that needs an answer sets its own.
  globalThis.fetch = (async () => json({}, 404)) as typeof fetch;
  // The chart observes its own size; jsdom has no layout, so nothing to observe.
  g.ResizeObserver = class { observe() {} disconnect() {} };
  // A stranger's view mounts the wire button, whose link prefetch schedules
  // idle work through `self` — the window, in a browser.
  g.self = ui.dom.window;
});
afterEach(async () => {
  await ui.close();
  globalThis.fetch = realFetch;
  g.ResizeObserver = real.observer;
  g.self = real.self;
});

const H = 3_600;
const nowSec = () => Math.floor(Date.now() / 1000);
function agent(over: Partial<ProfileAgent> = {}): ProfileAgent {
  return {
    slug: "shogun", name: "Shogun", handle: null, owner: null, pnlBps: 2_150, curve: [], landed: 4, last: null,
    glance: { id: "trencher", label: "new pairs" }, thesis: "Trades newly launched coins.", mode: "live",
    curveKind: "growth", contributionsEvidenced: true, recentTrades: [], activityRead: true, publicBook: false,
    ...over,
  } as ProfileAgent;
}
const render = (a: ProfileAgent, extra: Record<string, unknown> = {}) =>
  ui.render(React.createElement(Profile, { agent: a, theses: [], tokens: [], onBack() {}, onToken() {}, ...extra }));
const text = () => ui.container.textContent ?? "";

it("the stats line says what was read, and nothing it was not", async () => {
  await render(agent({ tradeCount: 12, tradeCountFloor: false, avgHoldSec: 3 * H + 20 * 60, joinedAt: null, gasless: true }));
  const line = ui.container.querySelector(".profile-stats")!.textContent!;
  assert.match(line, /^12 trades · avg hold 3h 20m · Gasless: every trade sponsored$/);
  // Nothing read, nothing printed — not "0 trades", not an empty line.
  await render(agent());
  assert.equal(ui.container.querySelector(".profile-stats"), null);
});

it("TOP TRADES rank by return, show dollars only when sent, and say when there are none", async () => {
  const trade = (id: string, symbol: string, bps: number, usd: number | null) =>
    ({ id, action: "sell" as const, symbol, displayName: null, at: 1, paper: false, sizeUsdg: null, realizedPnlUsdg: usd, realizedPnlBps: bps });
  await render(agent({ topTrades: [trade("1", "CASHCAT", 4_210, null), trade("2", "CHUMP", -500, null)], topTradesRead: true }));
  const rows = [...ui.container.querySelectorAll(".profile-top-trade")].map((r) => [
    r.querySelector(".profile-top-rank")!.textContent,
    r.querySelector(".profile-top-name strong")!.textContent,
    r.querySelector(".profile-top-figure")!.textContent,
  ]);
  assert.deepEqual(rows, [["#1", "CASHCAT", "+42.1%"], ["#2", "CHUMP", "−5.0%"]]);
  assert.doesNotMatch(text(), /\$/, "a private book prints no dollar anywhere in the list");
  await render(agent({ topTrades: [trade("1", "CASHCAT", 4_210, 3.1)], topTradesRead: true, publicBook: true }));
  assert.match(ui.container.querySelector(".profile-top-trade")!.textContent!, /\+42\.1% \(\+\$3\.10\)/);
  // A private book handed a dollar anyway: the page refuses it, as the swaps
  // table below it does, rather than trusting the one server line that nulls it.
  await render(agent({ topTrades: [trade("1", "CASHCAT", 4_210, 3.1)], topTradesRead: true, publicBook: false }));
  assert.equal(ui.container.querySelector(".profile-top-figure")!.textContent, "+42.1%");
  assert.doesNotMatch(ui.container.querySelector(".profile-top-trades")!.textContent!, /\$/);
  await render(agent({ topTrades: [], topTradesRead: true }));
  assert.match(text(), /No closed trades yet/);
  await render(agent({ topTrades: [], topTradesRead: false }));
  assert.match(text(), /Top trades could not be loaded/);
  assert.doesNotMatch(text(), /No closed trades yet/, "an unread list is not an empty one");
  // Unread also means "its costs could not be checked", which no retry cures.
  assert.doesNotMatch(text(), /Retrying shortly/);
});

it("a sale listed with no return says what that absence is", async () => {
  // CP1: a sell whose cost was an estimate, or could not be checked at all
  // (a coin traded more often than one replay reads), is listed with no
  // figure. Unexplained, a column of sells with no return reads as a bug.
  const now = nowSec();
  const sale = (id: string, bps: number | null) =>
    ({ id, action: "sell" as const, symbol: "CASHCAT", displayName: null, at: now - 60, paper: false, sizeUsdg: null, realizedPnlUsdg: null, realizedPnlBps: bps });
  await render(agent({ recentTrades: [sale("2", null), sale("1", 1_000)] }));
  assert.match(text(), /A sale with no return is one whose cost could not be confirmed\./);
  await render(agent({ recentTrades: [sale("1", 1_000), { ...sale("0", null), action: "buy" as const }] }), { key: "all-read" });
  assert.doesNotMatch(text(), /no return/, "every sale has its figure, and a buy realizes nothing");
});

it("the chart opens on ALL, and a window the history cannot back is disabled", async () => {
  const now = nowSec();
  const growthPoints = [{ at: now - 9 * H, g: 1 }, { at: now - 4 * H, g: 1.1 }, { at: now, g: 1.215 }];
  await render(agent({ curve: growthPoints.map((p) => p.g), growthPoints, growthComplete: true }));
  const buttons = [...ui.container.querySelectorAll(".profile-chart-windows button")] as HTMLButtonElement[];
  assert.deepEqual(buttons.map((b) => [b.textContent, b.disabled, b.getAttribute("aria-pressed")]), [
    ["24H", true, "false"], ["7D", true, "false"], ["30D", true, "false"], ["ALL", false, "true"],
  ]);
  assert.match(text(), /over this whole trading period/);
});

it("the owner's switch is shown only on their own page, and only once the setting was read", async () => {
  await render(agent({ publicBook: false }), { isMine: false });
  assert.equal(ui.container.querySelector(".profile-book"), null, "a stranger never sees it");
  await render(agent({ publicBook: undefined }), { isMine: true });
  assert.equal(ui.container.querySelector(".profile-book"), null, "an unread setting is not drawn as off");
  await render(agent({ publicBook: false }), { isMine: true });
  const sw = ui.container.querySelector(".profile-book [role=switch]")!;
  assert.equal(sw.getAttribute("aria-checked"), "false", "off by default");
});

it("the switch names everything turning it on publishes: sizes, dollar P&L, holdings, and the token pages", async () => {
  // It said only "trade sizes and dollar P&L", and "percentages are public
  // either way". The same flag also publishes what the agent holds and how
  // much, and lists it by name as a holder on every token page it holds —
  // this is the consent, so it has to say so.
  for (const on of [false, true]) {
    await render(agent({ publicBook: on }), { isMine: true, key: String(on) });
    const words = ui.container.querySelector(".profile-book small")!.textContent!;
    const label = ui.container.querySelector(".profile-book [role=switch]")!.getAttribute("aria-label")!;
    for (const said of [words, label]) {
      assert.match(said, /trade sizes/, said);
      assert.match(said, /dollar P&L/, said);
      assert.match(said, /holds/, said);
      assert.match(said, /token pages?/, said);
    }
    assert.doesNotMatch(words, /Percentages are public either way/, "holdings are not public either way");
    assert.doesNotMatch(words, /Only percentages are public/);
  }
});

it("turning the book on saves a boolean, re-reads the profile, and a failure is said", async () => {
  const sent: unknown[] = [];
  let refreshed = 0;
  // The saves only: the owner's page also reads its own view (the PF6 cases below).
  globalThis.fetch = (async (_url: string, init?: RequestInit) => { if (init?.method === "PUT") sent.push(JSON.parse(String(init.body))); return json({ ok: true }); }) as typeof fetch;
  await render(agent({ publicBook: false }), { isMine: true, onBookChanged: () => { refreshed += 1; } });
  await act(async () => { (ui.container.querySelector(".profile-book [role=switch]") as HTMLElement).click(); });
  assert.deepEqual(sent, [{ publicBook: true }]);
  assert.equal(refreshed, 1);
  assert.equal(ui.container.querySelector(".profile-book [role=switch]")!.getAttribute("aria-checked"), "true");

  // A server that ignored the field did not save it, and the switch stays put.
  globalThis.fetch = (async () => json({ ok: true, ignored: ["publicBook"] })) as typeof fetch;
  await render(agent({ publicBook: false }), { isMine: true, onBookChanged: () => { refreshed += 1; }, key: "again" });
  await act(async () => { (ui.container.querySelector(".profile-book [role=switch]") as HTMLElement).click(); });
  assert.equal(ui.container.querySelector(".profile-book [role=switch]")!.getAttribute("aria-checked"), "false");
  assert.match(ui.container.querySelector(".profile-book [role=alert]")!.textContent!, /nothing changed/);
  assert.equal(refreshed, 1, "nothing to re-read after a save that did not happen");
});

it("Buys & sells is the swaps table: pills, a P&L chip on sells only, and no dollar a private book hides", async () => {
  const fill = (id: string, action: "buy" | "sell", at: number, bps: number | null, size: number | null, usd: number | null = null) =>
    ({ id, action, symbol: "CASHCAT", displayName: "Cash Cat", at, paper: false, sizeUsdg: size, realizedPnlUsdg: usd, realizedPnlBps: bps });
  const now = nowSec();
  // Sizes and dollars on a PRIVATE book: the server withholds them, and the
  // table must not print them even if a row arrives carrying them.
  const trades = [fill("2", "sell", now - 60, 1_234, 12, 3.1), fill("1", "buy", now - 3 * H, null, 9)];
  await render(agent({ recentTrades: trades, publicBook: false }));
  const table = () => ui.container.querySelector("[aria-label='Trade history'] .swaps")!;
  assert.deepEqual([...table().querySelectorAll(".swap-pill")].map((p) => p.textContent), ["Sell", "Buy"]);
  assert.deepEqual([...table().querySelectorAll(".swap-pnl")].map((p) => p.textContent), ["+12.3%"], "only the sell carries a chip");
  assert.doesNotMatch(table().textContent!, /\$/, "a private book prints no dollar");
  assert.doesNotMatch(text(), /Not realized on a buy/);
  assert.deepEqual([...table().querySelectorAll(".swap-age")].map((a) => a.textContent), ["1m", "3h"]);
  assert.ok(table().querySelector(".swap-age")!.getAttribute("title"), "the full date is on hover");
  assert.match(table().textContent!, /Cash Cat/, "the coin's own name travels with the fill");

  await render(agent({ recentTrades: [fill("2", "sell", now - 60, 1_234, 12, 3.1), fill("1", "buy", now - 3 * H, null, 9)], publicBook: true }));
  assert.match(table().textContent!, /\$12\.00/);
  assert.match(table().textContent!, /\+12\.3% · \+\$3\.10/);

  // The tabs filter the same rows.
  await act(async () => { (Array.from(table().querySelectorAll(".swaps-tabs button")).find((b) => b.textContent === "Buys") as HTMLElement).click(); });
  assert.deepEqual([...table().querySelectorAll(".swap-pill")].map((p) => p.textContent), ["Buy"]);
});

// ── PF6: the owner's own view of a private book ─────────────────────────────
const ownFill = (id: string, action: "buy" | "sell", at: number, bps: number | null, size: number | null, usd: number | null = null) =>
  ({ id, action, symbol: "CASHCAT", displayName: null, at, paper: false, sizeUsdg: size, realizedPnlUsdg: usd, realizedPnlBps: bps });

it("the owner's own private profile shows their own sizes and dollars, from their session-checked read", async () => {
  // "$ only when the book is public OR it is the owner's own view": the public
  // read withholds a private book's money from everyone, its owner included, so
  // the owner's own figures come from /api/agents/<slug>/own, which checks the
  // session. Visitors still see percentages only.
  const now = nowSec();
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return json({
      recentTrades: [ownFill("2", "sell", now - 60, 1_234, 12, 3.1), ownFill("1", "buy", now - 3 * H, null, 9)],
      activityRead: true,
      topTrades: [ownFill("2", "sell", now - 60, 1_234, 12, 3.1)],
      topTradesRead: true,
    });
  }) as typeof fetch;
  const publicView = [ownFill("2", "sell", now - 60, 1_234, null), ownFill("1", "buy", now - 3 * H, null, null)];
  await render(agent({ publicBook: false, recentTrades: publicView, topTrades: [publicView[0]!], topTradesRead: true }), { isMine: true });
  await act(async () => {});
  assert.deepEqual(calls, ["/api/agents/shogun/own"]);
  const table = ui.container.querySelector("[aria-label='Trade history'] .swaps")!;
  assert.match(table.textContent!, /\$12\.00/, "the owner's own size");
  assert.match(table.textContent!, /\+12\.3% · \+\$3\.10/, "and their own dollar P&L");
  assert.match(ui.container.querySelector(".profile-top-trade")!.textContent!, /\+12\.3% \(\+\$3\.10\)/);
  assert.match(text(), /Only you can see the sizes and dollar figures here/);
  assert.doesNotMatch(text(), /Trade sizes are private\./);
});

it("a stranger never asks for the owner's view, and a published book needs none", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => { calls.push(String(url)); return json({}, 404); }) as typeof fetch;
  await render(agent({ publicBook: false, recentTrades: [ownFill("1", "sell", nowSec() - 60, 1_234, null)] }), { isMine: false });
  await act(async () => {});
  await render(agent({ publicBook: true, recentTrades: [ownFill("1", "sell", nowSec() - 60, 1_234, 12, 3.1)] }), { isMine: true, key: "public" });
  await act(async () => {});
  assert.deepEqual(calls.filter((c) => c.includes("/own")), []);
});

it("an owner's read that fails leaves the public figures, and no dollars", async () => {
  globalThis.fetch = (async () => json({ error: "Sign in to see your own agent's figures." }, 401)) as typeof fetch;
  const trades = [ownFill("2", "sell", nowSec() - 60, 1_234, null)];
  await render(agent({ publicBook: false, recentTrades: trades }), { isMine: true });
  await act(async () => {});
  const table = ui.container.querySelector("[aria-label='Trade history'] .swaps")!;
  assert.deepEqual([...table.querySelectorAll(".swap-pnl")].map((p) => p.textContent), ["+12.3%"]);
  assert.doesNotMatch(table.textContent!, /\$/);
  assert.match(text(), /Trade sizes are private\./);
});

it("an owner's read that could not read its top trades leaves the public list, never 'No closed trades yet'", async () => {
  // CP6: the owner's answer said its TOP TRADES were not read, with an empty
  // list beside that. Taken at its list, the owner's own page read "No closed
  // trades yet" over the public read's real trade.
  const now = nowSec();
  globalThis.fetch = (async () => json({ recentTrades: [ownFill("2", "sell", now - 60, 1_234, 12, 3.1)], activityRead: true, topTrades: [], topTradesRead: false })) as typeof fetch;
  const best = ownFill("2", "sell", now - 60, 1_234, null);
  await render(agent({ publicBook: false, recentTrades: [best], topTrades: [best], topTradesRead: true }), { isMine: true });
  await act(async () => {});
  assert.doesNotMatch(text(), /No closed trades yet/);
  assert.deepEqual([...ui.container.querySelectorAll(".profile-top-trade .profile-top-figure")].map((f) => f.textContent), ["+12.3%"], "the public best trade, with no dollars");
  assert.match(ui.container.querySelector("[aria-label='Trade history'] .swaps")!.textContent!, /\+12\.3% · \+\$3\.10/, "the list the owner's read did answer keeps its dollars");
});

it("an owner's read that could not read the fills does not claim to show the owner's sizes", async () => {
  // The top trades came back and the list did not: the list shown is the
  // public one, so the note under it is the public one too.
  globalThis.fetch = (async () => json({ recentTrades: [], activityRead: false, topTrades: [], topTradesRead: true })) as typeof fetch;
  await render(agent({ publicBook: false, recentTrades: [ownFill("2", "sell", nowSec() - 60, 1_234, null)] }), { isMine: true });
  await act(async () => {});
  assert.match(text(), /Trade sizes are private\./);
  assert.doesNotMatch(text(), /Only you can see/);
});
