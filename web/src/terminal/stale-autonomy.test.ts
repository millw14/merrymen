/**
 * NOT RUNNING, SAID TRUTHFULLY — AND WITHOUT COSTING ANYTHING ELSE ITS PLACE.
 *
 * An agent whose worker had stopped wore the chip it stopped with — LIVE or
 * PAPER — because `mode` is the last thing a worker said and a stopped worker
 * goes on saying it. This pins the three halves of saying so instead:
 *
 *   - the server decides "stopped" by its own clock and the watchdog's rule,
 *     never the browser's clock and never a second rule (worker-stale.ts);
 *   - the route carries that answer and the page reads it back unchanged;
 *   - the desk keeps every remedy it had: a silent agent short of ETH is still
 *     told to send ETH, an expired one is still offered the renewal, and a held
 *     one is offered nothing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { autonomyOf, type AutonomyInput } from "@merrymen/core";
import { freshWithin } from "@/lib/services/agent-status";
import { ORDER_IN_FLIGHT_MS } from "@/lib/order-state";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import type { ChatController } from "./chat-controller";
import { DesktopPortfolio } from "./Desktop";
import type { LiveMine } from "./live";
import { Agent } from "./screens/Agent";
import { WORKER_STALE_MARGIN_SEC, beatSeconds, workerSilentSince, workerStale } from "./worker-stale";

(globalThis as unknown as { React: typeof React }).React = React;

const raw = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** Comments stripped — block, JSX and line — so prose about a rule never satisfies it. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const ROUTE = code(raw("../app/api/grants/route.ts"));
const APP = code(raw("./App.tsx"));
const AGENT = code(raw("./screens/Agent.tsx"));
const NOW = Date.parse("2026-10-05T12:00:00Z") / 1000;
/** The beat a silent worker went quiet at, as the page reads it back. */
const SILENT = NOW - 6 * 3_600;

const noop = () => {};
const held: FleetRecoveryView = { state: "history-only", tradingPaused: true,
  history: "available", memory: "unknown", checkedAt: NOW, lastVerifiedHeartbeatAt: null };
const chat = { draft: "", setDraft: noop, proposal: null, setProposal: noop,
  confirming: false, messages: [], sending: false, streaming: "", ceiling: 10 } as unknown as ChatController;
/** An owner's agent as App hands it down: the label is the verdict's, as App sets it. */
const mineFor = (input: AutonomyInput, over: Partial<LiveMine> = {}): LiveMine => {
  const autonomy = autonomyOf(input);
  return { name: "Shogun", slug: "shogun", handle: null, owner: "you", mode: input.mode ?? null,
    equity: 42, chg24: 2, glance: { id: "custom", label: "", cashUsd: 40 }, moves: [], thesis: null,
    statusLabel: autonomy.label, autonomy, ...over };
};
const doc = (node: React.ReactElement) => new JSDOM(renderToStaticMarkup(node)).window.document;
const desk = (mine: LiveMine, liveBlocker: string | null, staleBlocker = false) =>
  doc(React.createElement(Agent, { mine, tokens: [], stopped: false, chat, perTrade: 10, perDay: 20,
    liveBlocker, staleBlocker, onToken: noop, onDeposit: noop, onWithdraw: noop, onLimits: noop,
    onResign: noop, onSettings: noop }));
const portfolio = (mine: LiveMine) =>
  doc(React.createElement(DesktopPortfolio, { mine, tokens: [], stopped: false, perTrade: 10, perDay: 20,
    onScreen: noop, onTab: noop }));

describe("the server decides when a worker has stopped, by one rule", () => {
  it("IS THE WATCHDOG'S WINDOW, NEVER SHORTER THAN ONE ORDER'S RUN, PLUS A MARGIN FOR THE MIRROR", () => {
    for (const tick of [null, 15, 60, 240, 300, 3_600]) {
      const edge = Math.max(freshWithin(tick), ORDER_IN_FLIGHT_MS / 1000) + WORKER_STALE_MARGIN_SEC;
      assert.equal(workerStale(NOW - edge, NOW, tick), false, `exactly at the edge is still fresh (tick ${tick})`);
      assert.equal(workerStale(NOW - edge - 1, NOW, tick), true, `one second past it is stopped (tick ${tick})`);
    }
  });

  it("AN AGENT WAITING ON A SLOW RECEIPT IS NOT CALLED STOPPED, however short its tick", () => {
    // Hosted, the row is written only when a tick starts, and an order in
    // flight holds the next tick back for up to ORDER_IN_FLIGHT_MS while the
    // clock beats only the FILE. The watchdog sees a live child; this must not
    // say NOT RUNNING over the trade. Six minutes is the reviewer's case: past
    // the one-minute tick's own window, inside one order's run.
    for (const tick of [15, 60]) {
      assert.ok(freshWithin(tick) + WORKER_STALE_MARGIN_SEC < 6 * 60, `the bare window is shorter than the stall (tick ${tick})`);
      assert.equal(workerStale(NOW - 6 * 60, NOW, tick), false, `six minutes on a receipt (tick ${tick})`);
      assert.equal(workerStale(NOW - ORDER_IN_FLIGHT_MS / 1000, NOW, tick), false, `a whole order's run (tick ${tick})`);
    }
    // The floor only ever widens: a long tick keeps the watchdog's own window.
    assert.equal(workerStale(NOW - freshWithin(300) - WORKER_STALE_MARGIN_SEC - 1, NOW, 300), true);
  });

  it("a longer tick earns a longer window, as the watchdog grants it", () => {
    const silence = 15 * 60;
    assert.equal(workerStale(NOW - silence, NOW, 60), true, "fifteen quiet minutes on a one-minute tick");
    assert.equal(workerStale(NOW - silence, NOW, 600), false, "is under one window on a ten-minute tick");
  });

  it("NEVER HEARD FROM IS NOT STOPPED", () => {
    // A new agent waiting for its first tick has not stopped; null leaves the
    // idle arm to say what is true of it.
    for (const beat of [null, undefined, 0, -5, Number.NaN, Infinity]) {
      assert.equal(workerStale(beat, NOW, 240), null, String(beat));
    }
  });

  it("reads a beat written in milliseconds as the same moment", () => {
    // Read as seconds, a millisecond beat is far in the future and forever
    // fresh — the exact lie this exists to remove.
    const old = NOW - 3_600;
    assert.equal(beatSeconds(old * 1000), old);
    assert.equal(workerStale(old * 1000, NOW, 240), true);
    assert.equal(workerStale(old, NOW, 240), true);
    assert.equal(workerStale((NOW - 30) * 1000, NOW, 240), false);
  });

  it("a beat ahead of this server's clock is fresh, not an error", () => {
    assert.equal(workerStale(NOW + 30, NOW, 240), false);
  });
});

describe("the page reads the server's answer back, and nothing else", () => {
  it("the last beat when the server said stale; null otherwise", () => {
    assert.equal(workerSilentSince({ workerStale: true, workerAliveAt: NOW - 900 }), NOW - 900);
    assert.equal(workerSilentSince({ workerStale: true, workerAliveAt: (NOW - 900) * 1000 }), NOW - 900);
    for (const status of [
      { workerStale: false, workerAliveAt: NOW - 900 },
      { workerStale: null, workerAliveAt: NOW - 900 },
      // An older server sends no verdict at all: described as before.
      { workerAliveAt: NOW - 900 },
      { workerStale: true, workerAliveAt: null },
      null,
      undefined,
    ]) {
      assert.equal(workerSilentSince(status), null, JSON.stringify(status));
    }
  });

  it("THE ROUTE DECLARES IT, nullable", () => {
    assert.match(ROUTE, /workerStale\?: boolean \| null;/);
  });

  it("the route judges it with its own clock, after both heartbeat sources", () => {
    const get = ROUTE.indexOf("export async function GET");
    assert.ok(get > 0, "the GET handler must exist");
    const call = ROUTE.indexOf("workerStaleOf(workerAliveAt, Math.floor(Date.now() / 1000), await tickSecondsFor(hostedTenant))", get);
    assert.ok(call > get, "GET must judge the heartbeat it read, by the server's clock and the owner's tick");
    // After the ledger branch, so the hosted heartbeat (the mirrored row) is
    // the one judged, not only the self-hosted file.
    const branch = ROUTE.indexOf("if (workerAliveAt === null)", get);
    assert.ok(branch > get && call > branch, "after the hosted heartbeat read, not before it");
    const status = ROUTE.slice(ROUTE.indexOf("const status: AgentStatus = {"));
    assert.match(status.slice(0, status.indexOf("};")), /\bworkerStale,/, "and it reaches the response");
  });

  it("the tick is read for the caller, and a failed read is the default, never the house's", () => {
    const fn = ROUTE.slice(ROUTE.indexOf("async function tickSecondsFor"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /getSettingsStore\(\)\.get\(hostedTenant\)/, "hosted: this tenant's own settings");
    assert.match(body, /catch \{\s*return null;/, "a failed read falls back to freshWithin's default");
  });

  it("App hands the verdict the server's answer, and the desk the bare fact", () => {
    assert.match(APP, /workerSilentSince: workerSilentSince\(account\?\.status\)/, "the server's answer, read back");
    assert.match(APP, /expiresSoonDays:/, "the key's days left reach the verdict");
    // The desk's staleness is the FACT, not the verdict's word for it: once a
    // silent worker answers NOT RUNNING instead of CHECKING, the word no
    // longer means "the blocker predates the signature".
    assert.equal((APP.match(/staleBlocker=\{blockerPredatesGrant\}/g) ?? []).length, 2, "both desk mounts");
    assert.doesNotMatch(APP, /autonomy\.state === "checking"/);
  });
});

describe("the desk says NOT RUNNING without losing a remedy", () => {
  it("A SILENT WORKER SHORT OF ETH STILL SHOWS THE FUNDING PANEL", () => {
    // The panel used to hide on `state === "checking"`. Silence is not about
    // ETH, and the owner who reads NOT RUNNING still needs to know to send it.
    const mine = mineFor({ mode: "paper", liveBlocker: "no-gas", realCashUsd: 0, workerSilentSince: SILENT });
    assert.equal(mine.autonomy.label, "NOT RUNNING");
    for (const staleBlocker of [false, true]) {
      const page = desk(mine, "no-gas", staleBlocker);
      const panel = page.querySelector(".desk-blocked");
      assert.ok(panel, `no-gas must render its panel (staleBlocker=${staleBlocker}): a signature says nothing about ETH`);
      assert.match(panel.textContent!, /no ETH/);
      assert.equal(page.querySelector(".desk-status")!.textContent, "NOT RUNNING");
    }
  });

  it("NOT RUNNING never wears the running dot", () => {
    const silent = desk(mineFor({ mode: "live", liveBlocker: null, workerSilentSince: SILENT }), null);
    assert.ok(silent.querySelector(".desk-status")!.classList.contains("paused"));
    const running = desk(mineFor({ mode: "live", liveBlocker: null }), null);
    assert.equal(running.querySelector(".desk-status")!.textContent, "LIVE");
    assert.ok(!running.querySelector(".desk-status")!.classList.contains("paused"), "a running agent keeps it");
    const wide = portfolio(mineFor({ mode: "live", liveBlocker: null, workerSilentSince: SILENT }));
    assert.equal(wide.querySelector(".desktop-running")!.textContent, "NOT RUNNING");
    assert.ok(wide.querySelector(".desktop-running")!.classList.contains("paused"));
  });

  it("a re-signer whose worker is silent is told NOT RUNNING, and still not asked to sign again", () => {
    const mine = mineFor({ mode: "paper", liveBlocker: "wrong-chain", blockerPredatesGrant: true, workerSilentSince: SILENT });
    const page = desk(mine, "wrong-chain", true);
    assert.equal(page.querySelector(".desk-status")!.textContent, "NOT RUNNING");
    assert.equal(page.querySelector(".desk-blocked"), null, "the verdict about the replaced key stays down");
    assert.doesNotMatch(page.body.textContent!, /re-sign my permission|few minutes/);
    assert.equal(portfolio(mine).querySelector(".desktop-blocked"), null, "and no banner on the desktop either");
  });

  it("an owner-action verdict that does NOT predate the signature is still shown in full", () => {
    const page = desk(mineFor({ mode: "paper", liveBlocker: "dead-policy", workerSilentSince: SILENT }), "dead-policy", false);
    assert.match(page.querySelector(".desk-blocked")!.textContent!, /re-sign my permission/);
  });
});

describe("an expired key is renewed from the desk, and only outside a hold", () => {
  const expired = (over: Partial<AutonomyInput> = {}) =>
    mineFor({ mode: "paper", liveBlocker: "no-gas", realCashUsd: 0, expired: true, ...over });

  it("RENDERS THE RENEW PANEL FROM THE VERDICT, in place of the worker's last blocker", () => {
    const page = desk(expired(), "no-gas");
    const panels = [...page.querySelectorAll(".desk-blocked")];
    assert.equal(panels.length, 1, "one panel: the renewal replaces the stale blocker, never sits beside it");
    assert.match(panels[0]!.textContent!, /trading permission has expired/);
    assert.match(panels[0]!.querySelector("button")!.textContent!, /^Renew permission/);
    assert.doesNotMatch(page.body.textContent!, /no ETH/, "the blocker on record predates the expiry");
  });

  it("silent + expired is still BLOCKED with the renewal", () => {
    const mine = expired({ workerSilentSince: SILENT });
    assert.equal(mine.autonomy.label, "BLOCKED");
    assert.match(desk(mine, "no-gas").querySelector(".desk-blocked")!.textContent!, /expired/);
    assert.ok(portfolio(mine).querySelector(".desktop-blocked"), "the desktop banner, as before");
  });

  it("NOT A RULE OF OUR OWN: no expired advice, no invented blocker, and the one signing control", () => {
    assert.match(AGENT, /displayedAutonomy\.rule === "expired"/);
    assert.doesNotMatch(APP, /liveBlocker=\{[^}]*expired/, "the worker's field carries the worker's word");
    // The renewal button goes where every other re-sign goes.
    const panel = AGENT.slice(AGENT.indexOf("{renewal && renewal.action && ("));
    assert.match(panel.slice(0, panel.indexOf("</section>")), /onClick=\{onResign\}/);
  });

  it("A HELD TENANT IS OFFERED NO RENEWAL", () => {
    // recoveryAutonomy clears the rule, so the panel has nothing to render.
    const mine = expired({ expiresSoonDays: null });
    const page = desk({ ...mine, recovery: held }, "no-gas");
    assert.equal(page.querySelector(".desk-blocked"), null);
    assert.doesNotMatch(page.body.textContent!, /Renew permission|re-sign/i);
  });
});

describe("a key about to expire is a chip, not an alarm", () => {
  const soon = (over: Partial<AutonomyInput> = {}) =>
    mineFor({ mode: "live", liveBlocker: null, expiresSoonDays: 2, ...over });

  it("the desk and the desktop both say it, in the neutral style, with the verdict's words", () => {
    const page = desk(soon(), null);
    assert.equal(page.querySelector(".desk-blocked"), null, "never the red panel");
    const note = page.querySelector(".desk-note")!;
    assert.match(note.querySelector("button")!.textContent!, /Renew permission \(expires in 2 days\)/);
    assert.equal(page.querySelector(".desk-status")!.textContent, "LIVE", "and the agent is still what it is");
    const wide = portfolio(soon());
    const link = wide.querySelector('a[href="/grant#resign"]')!;
    assert.equal(link.textContent, "Renew permission (expires in 2 days)");
    assert.equal(wide.querySelector(".desktop-blocked"), null);
  });

  it("not during a hold", () => {
    const mine = { ...soon(), recovery: held };
    assert.doesNotMatch(desk(mine, null).body.textContent!, /Renew permission/);
    assert.doesNotMatch(portfolio(mine).body.textContent!, /Renew permission/);
  });

  it("outside the window, nothing", () => {
    assert.doesNotMatch(desk(soon({ expiresSoonDays: 10 }), null).body.textContent!, /Renew permission/);
    assert.doesNotMatch(portfolio(soon({ expiresSoonDays: 10 })).body.textContent!, /Renew permission/);
  });
});
