/**
 * THE OWNER'S TRADES LIST IS THE SWAPS TABLE, and refusals stop drowning it.
 *
 * The desk listed every row of any status, so a paper agent at its ops cap
 * showed its owner thirty identical refusals and pushed the fills off the
 * screen — while "Trades · 30" counted the refusals as trades. The owner must
 * still be told every refusal and why (the forbidden list: never hide
 * refusals from the owner), so they fold into one line per reason instead.
 *
 * Rendered for real, because the list sits behind a tab a static render never
 * reaches.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import React, { act } from "react";
import { autonomyOf } from "@merrymen/core";
import { Agent } from "./screens/Agent";
import type { LiveMine, Thesis } from "./live";
import { json, testDom } from "./test-dom";
import { idleChat } from "./test-chat";
import { DESK_TAPE_LIMIT } from "@/lib/desk-trades";
import { SwapsTable } from "./SwapsTable";
import { swapRowsOfProfile } from "./swaps";

let ui: ReturnType<typeof testDom>;
const realFetch = globalThis.fetch;
const g = globalThis as { ResizeObserver?: unknown; self?: unknown };
const realObserver = g.ResizeObserver;
const realSelf = g.self;
beforeEach(() => {
  ui = testDom();
  // The desk asks for the owner's tier on mount; nothing here depends on it.
  globalThis.fetch = (async () => json({}, 404)) as typeof fetch;
  // The balance chart observes its size; jsdom has no layout to observe.
  g.ResizeObserver = class { observe() {} disconnect() {} };
  // Links schedule their prefetch through `self` — the window, in a browser.
  g.self = ui.dom.window;
});
afterEach(async () => {
  await ui.close();
  globalThis.fetch = realFetch;
  g.ResizeObserver = realObserver;
  g.self = realSelf;
});

const now = () => Math.floor(Date.now() / 1000);
const move = (over: Partial<Thesis>): Thesis => ({
  name: "Shogun", slug: "shogun", handle: null, action: "buy", symbol: "CASHCAT", sizeUsdg: 5, reason: "momentum", paper: false,
  head: "swap", at: now() - 60, outcome: "landed", outcomeText: null, ...over,
});
const mine = (moves: Thesis[]): LiveMine => ({
  name: "Shogun", slug: "shogun", handle: null, owner: "you", equity: 100, chg24: null, mode: "trencher", thesis: null,
  moves, glance: { id: "trencher", label: "", cashUsd: 50 }, autonomy: autonomyOf({ mode: null, liveBlocker: null }), positions: [],
});
const noop = () => {};
const render = (moves: Thesis[]) =>
  ui.render(React.createElement(Agent, {
    mine: mine(moves), tokens: [], perTrade: 10, perDay: 50, stopped: false, chat: idleChat,
    onToken: noop, onDeposit: noop, onWithdraw: noop, onLimits: noop, onResign: noop, onSettings: noop,
  } as never));

it("fills show as rows, refusals fold into one line per reason, and the count is of trades", async () => {
  const ops = "past today's number of trades";
  await render([
    move({ at: now() - 60 }),
    move({ at: now() - 120, outcome: "refused", outcomeText: ops }),
    move({ at: now() - 180, outcome: "refused", outcomeText: ops }),
    move({ at: now() - 240, action: "sell", outcome: "pending", sizeUsdg: 4 }),
    move({ at: now() - 300, outcome: "refused", outcomeText: ops }),
  ]);
  const tab = Array.from(ui.container.querySelectorAll("button")).find((b) => /^Trades · /.test(b.textContent ?? ""))!;
  assert.equal(tab.textContent, "Trades · 2", "a refusal is not a trade");
  await act(async () => { tab.click(); });
  const table = ui.container.querySelector(".desk-trades .swaps")!;
  const lines = [...table.querySelectorAll(".swap-row")].map((r) => r.querySelector(".swap-pill")!.textContent + " " + (r.querySelector(".swap-tried")?.textContent ?? r.querySelector(".swap-coin strong")!.textContent));
  assert.deepEqual(lines, ["Buy CASHCAT", `Tried Refused 3× today: ${ops}`, "Sell CASHCAT"]);
  assert.match(table.textContent!, /\$5\.00/, "the owner sees their own sizes");
  assert.match(table.textContent!, /Pending/);
  assert.match(table.textContent!, /momentum/, "and why the agent did it");
});

it("a full tape's counts are floors, because there may be more past its end", async () => {
  const ops = "past today's number of trades";
  // A paper agent at its cap: the whole tape is this morning's refusals, as
  // many rows as the owner's tape read returns at most (desk-trades.ts).
  await render(Array.from({ length: DESK_TAPE_LIMIT }, (_, i) => move({ at: now() - 60 * (i + 1), outcome: "refused", outcomeText: ops })));
  const tab = Array.from(ui.container.querySelectorAll("button")).find((b) => /^Trades · /.test(b.textContent ?? ""))!;
  assert.equal(tab.textContent, "Trades · 0+");
  await act(async () => { tab.click(); });
  const line = ui.container.querySelector(".desk-trades .swap-tried")!.textContent!;
  // Today, unless the test runs in the first half hour after midnight.
  assert.match(line, new RegExp(`^Refused ${DESK_TAPE_LIMIT}\\+× (today|since .+): past today's number of trades$`));
});

it("a tape one row short of the read's limit was not cut, so its count is exact", async () => {
  // The floor is the READ's limit, not a copy of it the desk keeps: a desk that
  // floored at a smaller number would call a whole tape partial.
  await render(Array.from({ length: DESK_TAPE_LIMIT - 1 }, (_, i) => move({ at: now() - 60 * (i + 1), outcome: "refused", outcomeText: "ops" })));
  const tab = Array.from(ui.container.querySelectorAll("button")).find((b) => /^Trades · /.test(b.textContent ?? ""))!;
  assert.equal(tab.textContent, "Trades · 0");
});

it("a vault move or a transfer is not a swap of an unlabelled token, and is not a trade", async () => {
  // The owner's tape carries every kind the worker records. A steady basket
  // parks its idle cash in a vault and the chat can send USDG out; neither has
  // a side or a coin, so each read "Swap · Token label unavailable" and was
  // counted in "Trades · N". The profile reads only swaps and curve trades.
  await render([
    move({ at: now() - 60, action: "buy", symbol: "TSLA", head: "swap" }),
    move({ at: now() - 120, action: null, symbol: null, head: "vault-deposit", sizeUsdg: 50, reason: null }),
    move({ at: now() - 180, action: null, symbol: null, head: "transfer", sizeUsdg: 20, reason: null }),
    move({ at: now() - 240, action: null, symbol: null, head: "vault-withdraw", sizeUsdg: 10, reason: null }),
    // A refused vault move is still a refusal the owner is told about.
    move({ at: now() - 300, action: null, symbol: null, head: "vault-deposit", outcome: "refused", outcomeText: "vault paused" }),
  ]);
  const tab = Array.from(ui.container.querySelectorAll("button")).find((b) => /^Trades · /.test(b.textContent ?? ""))!;
  assert.equal(tab.textContent, "Trades · 1", "one buy; the moves of cash are not trades");
  await act(async () => { tab.click(); });
  const table = ui.container.querySelector(".desk-trades .swaps")!;
  const lines = [...table.querySelectorAll(".swap-row")].map((r) => r.querySelector(".swap-pill")!.textContent + " " + (r.querySelector(".swap-tried")?.textContent ?? r.querySelector(".swap-coin strong")!.textContent));
  assert.deepEqual(lines, [
    "Buy TSLA",
    "Vault Moved to a vault",
    "Transfer Sent out of the account",
    "Vault Taken back from a vault",
    "Tried Refused 1× today: vault paused",
  ]);
  assert.doesNotMatch(table.textContent!, /Token label unavailable/);
  assert.match(table.textContent!, /\$50\.00/, "the owner still sees how much moved");
});

it("the desk names the coin and prints the owner's realized dollars on a sell whose cost was checked", async () => {
  // D3: the owner's tape already reads the coin's name and the fill's realized
  // P&L; mineOf carries them onto each move. CP5: the dollars are printed only
  // when the tape vouches for the cost behind them — an estimate is not shown
  // as a result.
  await render([
    { ...move({ at: now() - 60, action: "sell", symbol: "T3139F043B88" }), displayName: "JUGGERNAUT", realizedPnlUsdg: 1.25, realizedVouched: true } as Thesis,
    { ...move({ at: now() - 120, action: "sell", symbol: "CASHCAT" }), realizedPnlUsdg: -0.5, realizedVouched: true } as Thesis,
    { ...move({ at: now() - 180, action: "sell", symbol: "CHUMP" }), realizedPnlUsdg: 9, realizedVouched: false } as Thesis,
    { ...move({ at: now() - 240, action: "sell", symbol: "OLDTAPE" }), realizedPnlUsdg: 4 } as Thesis,
  ]);
  const tab = Array.from(ui.container.querySelectorAll("button")).find((b) => /^Trades · /.test(b.textContent ?? ""))!;
  await act(async () => { tab.click(); });
  const rows = [...ui.container.querySelectorAll(".desk-trades .swap-row")];
  assert.match(rows[0]!.textContent!, /JUGGERNAUT/, "the coin's own name beside its symbol");
  assert.equal(rows[0]!.querySelector(".swap-pnl")?.textContent, "+$1.25");
  assert.equal(rows[1]!.querySelector(".swap-pnl")?.textContent, "−$0.50");
  assert.equal(rows[1]!.querySelector(".swap-pnl")?.className, "swap-pnl down");
  // Compared as text: a failed assert on a DOM node inspects the whole window.
  assert.equal(rows[2]!.querySelector(".swap-pnl")?.textContent ?? null, null, "a sell on an estimated cost prints no dollars");
  assert.equal(rows[3]!.querySelector(".swap-pnl")?.textContent ?? null, null, "nor one the tape did not vouch for");
  assert.doesNotMatch(rows[2]!.textContent! + rows[3]!.textContent!, /\+\$(9|4)\.00/);
});

it("an empty tape says so", async () => {
  await render([]);
  const tab = Array.from(ui.container.querySelectorAll("button")).find((b) => /^Trades · /.test(b.textContent ?? ""))!;
  assert.equal(tab.textContent, "Trades · 0");
  await act(async () => { tab.click(); });
  assert.match(ui.container.querySelector(".desk-trades")!.textContent!, /No trades yet\./);
});

it("an age in seconds moves on while it is being read", async () => {
  // The table prints "55s" but re-rendered every thirty seconds, so a fill
  // read "55s" for half a minute and then jumped. The feed's rows tick every
  // five seconds (wire.tsx); the table now keeps the same pace.
  const start = 1_900_000_000_000;
  mock.timers.enable({ apis: ["setInterval", "Date"], now: start });
  try {
    const rows = swapRowsOfProfile([{ id: "1", action: "sell", symbol: "CASHCAT", displayName: null, at: start / 1000 - 55, paper: false, sizeUsdg: null, realizedPnlUsdg: null, realizedPnlBps: null }]);
    await ui.render(React.createElement(SwapsTable, { rows, tokens: [], showMoney: false, emptyTitle: "none" }));
    const age = () => ui.container.querySelector(".swap-age")?.textContent ?? null;
    assert.equal(age(), "55s");
    await act(async () => { mock.timers.tick(5_000); });
    assert.equal(age(), "1m", "five seconds on, the row says so");
  } finally {
    mock.timers.reset();
  }
});
