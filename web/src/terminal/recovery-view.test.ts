import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { autonomyOf } from "@merrymen/core";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import type { TelegramStatus } from "@/app/api/telegram/route";
import { telegramListening } from "@/lib/telegram-listening";
import { runtimeFromRow } from "@/lib/telegram-runtime";
import type { ChatController } from "./chat-controller";
import type { LiveMine } from "./live";
import { ownerTradeEmptyTitle, recoveryAutonomy, recoveryMemory, recoveryTelegram } from "./recovery-view";
import { RecoveryNotice } from "./RecoveryNotice";
import { DesktopHeader, DesktopPortfolio, DesktopSidebar } from "./Desktop";
import { Agent } from "./screens/Agent";
import { You } from "./screens/You";
import { AccountEntry } from "./HostedControls";
import { SwapsTable } from "./SwapsTable";

(globalThis as unknown as { React: typeof React }).React = React;
const noop = () => {};
const held: FleetRecoveryView = { state: "history-only", tradingPaused: true,
  history: "available", memory: "unknown", checkedAt: 1_791_111_100, lastVerifiedHeartbeatAt: 1_791_110_000 };
const mine: LiveMine = { name: "Shogun", slug: "shogun", handle: null, owner: "you", mode: "live",
  equity: 42, chg24: 2, glance: { id: "custom", label: "", cashUsd: 40 }, moves: [], thesis: null,
  statusLabel: "LIVE", autonomy: autonomyOf({ mode: "live", liveBlocker: null }) };
const doc = (node: React.ReactElement) => new JSDOM(renderToStaticMarkup(node)).window.document;

describe("owner recovery presentation", () => {
  it("keeps old-server autonomy unchanged and never creates a hold from missing metadata", () => {
    for (const absent of [null, undefined]) {
      assert.equal(recoveryAutonomy(mine.autonomy, absent), mine.autonomy);
      assert.equal(renderToStaticMarkup(React.createElement(RecoveryNotice, { recovery: absent })), "");
    }
  });

  it("recovery outranks stale live, expired and funding/renewal advice without changing the book type", () => {
    for (const before of [mine.autonomy,
      autonomyOf({ mode: "paper", liveBlocker: "dead-policy", realCashUsd: 0 }),
      autonomyOf({ mode: "live", liveBlocker: "no-gas", expired: true })]) {
      const after = recoveryAutonomy(before, held);
      assert.equal(after.label, "RECOVERING");
      assert.equal(after.action, null);
      assert.equal(after.needsOwnerAction, false);
      assert.equal(after.rule, null);
      assert.equal(after.simulated, before.simulated);
      assert.match(after.moneyLabel, /^Last recorded /);
    }
  });

  it("only describes available history and preserved/recovered memory when proved", () => {
    const saved = doc(React.createElement(RecoveryNotice, { recovery: held }));
    assert.match(saved.body.textContent!, /Trading paused for recovery.*Some saved history is available/);
    assert.match(saved.body.textContent!, /Trading remains paused pending reconciliation/);
    assert.match(saved.body.textContent!, /Last verified activity/);
    assert.doesNotMatch(saved.body.textContent!, /memories|lost|zero|restored|complete/i);
    const unknown = doc(React.createElement(RecoveryNotice, { recovery: { ...held, history: "unknown", lastVerifiedHeartbeatAt: null } }));
    assert.match(unknown.body.textContent!, /Saved trading records have not yet been verified.*Trading remains paused/);
    assert.doesNotMatch(unknown.body.textContent!, /history is available|Last verified activity|no history/i);
    for (const page of [saved, unknown]) assert.doesNotMatch(page.body.textContent!, /before this agent resumes|automatically resumes/i);
    assert.equal(recoveryMemory({ ...held, memory: "preserved" }), "Its saved memories are preserved.");
    assert.equal(recoveryMemory({ ...held, memory: "recovered" }), "Its saved memories have been recovered.");
  });

  it("the actual owner panel qualifies balances, suppresses the stale renewal remedy and keeps withdrawals", () => {
    const panel = doc(React.createElement(DesktopPortfolio, { mine: { ...mine, recovery: held,
      autonomy: autonomyOf({ mode: "live", liveBlocker: "dead-policy" }) }, tokens: [], stopped: false,
      perTrade: 10, perDay: 20, onScreen: noop, onTab: noop }));
    assert.equal(panel.querySelector(".desktop-running")!.textContent, "RECOVERING");
    assert.ok(panel.querySelector(".desktop-running")!.classList.contains("paused"));
    assert.match(panel.body.textContent!, /Last recorded balance.*\$42.*Reconciliation pending/);
    assert.equal(panel.querySelector(".recovery-balance-label")!.textContent, "Last recorded balance");
    assert.match(panel.body.textContent!, /Last recorded cash/);
    assert.match(panel.body.textContent!, /Withdraw/);
    assert.equal(panel.querySelector(".desktop-blocked"), null);
    assert.doesNotMatch(panel.body.textContent!, /Available cash|today|renew permission/);
    const savedPositions = [...panel.querySelectorAll(".desktop-section-heading")].find(heading => heading.querySelector("h2")?.textContent === "Saved positions")!;
    assert.equal(savedPositions.querySelector("span")!.textContent, "—");
    assert.match(savedPositions.parentElement!.textContent!, /Reconciliation pending/);
    const sidebar = doc(React.createElement(DesktopSidebar, { mine: { ...mine, recovery: held },
      tokens: [], agents: [], theses: [], screen: { kind: "tab", tab: "agent" }, section: "agents", onSection: noop,
      onScreen: noop, onTab: noop, reads: { market: "ok", board: "ok", theses: "ok", discoveries: "ok", mine: "ok" } }));
    assert.match(sidebar.querySelector(".sidebar-agent")!.textContent!, /Last recorded balance/);
  });

  it("the agent screen replaces stale blocker/confirmation with the recovery state", () => {
    const chat = { draft: "", setDraft: noop, proposal: { id: "start-live", args: {} }, setProposal: noop,
      confirming: false, messages: [], sending: false, streaming: "", ceiling: 10 } as unknown as ChatController;
    const page = doc(React.createElement(Agent, { mine: { ...mine, recovery: held }, tokens: [], stopped: false,
      chat, perTrade: 10, perDay: 20, liveBlocker: "dead-policy", onToken: noop, onDeposit: noop,
      onWithdraw: noop, onLimits: noop, onResign: noop, onSettings: noop }));
    assert.equal(page.querySelector(".desk-status")!.textContent, "RECOVERING");
    assert.ok(page.querySelector(".desk-status")!.classList.contains("paused"));
    assert.match(page.body.textContent!, /Trading paused for recovery.*Last recorded agent balance/);
    assert.equal(page.querySelector(".portfolio-summary .recovery-balance-label")!.textContent, "Last recorded agent balance");
    assert.equal(page.querySelector(".desk-blocked"), null);
    assert.equal(page.querySelector(".desk-confirm"), null);
    assert.doesNotMatch(page.body.textContent!, /Fix it.*re-sign|Start live trading/);
    assert.equal(page.querySelector("#portfolio-title")!.textContent, "Last recorded portfolio");
    assert.match(page.querySelector(".agent-portfolio-meta")!.textContent!, /Last recorded cash: \$40/);
    assert.match(page.querySelector(".agent-portfolio-meta")!.textContent!, /Saved positions pending/);
    assert.doesNotMatch(page.querySelector(".agent-portfolio-meta")!.textContent!, /0 positions/);
  });

  it("an existing agent whose feed is empty shows recovery instead of a broken portfolio placeholder", () => {
    const entry = doc(React.createElement(AccountEntry, { account: { session: { hosted: true, address: "0x" + "a".repeat(40) },
      status: { exists: true, recovery: held } }, portfolio: "ok", onRefresh: noop, onSignedIn: noop }));
    assert.match(entry.body.textContent!, /Trading paused for recovery/);
    assert.doesNotMatch(entry.body.textContent!, /not available yet|Create an agent/);
  });

  it("the owner profile qualifies saved balances and withholds daily usage without hiding withdrawals", () => {
    const profile = doc(React.createElement(You, { mine: { ...mine, recovery: held }, history: [40, 42],
      stopped: false, perTrade: 10, perDay: 20, onLimits: noop, onStop: noop, onDesk: noop, onDeposit: noop, onWithdraw: noop }));
    assert.equal(profile.querySelector(".profile-mode")!.textContent, "RECOVERING");
    assert.match(profile.body.textContent!, /Last recorded portfolio balance/);
    assert.equal(profile.querySelector(".account-balance > .recovery-balance-label")!.textContent, "Last recorded portfolio balance");
    assert.match(profile.querySelector(".profile-usage")!.textContent!, /Daily usageReconciliation pending/);
    assert.equal(profile.querySelector(".profile-usage progress"), null);
    assert.doesNotMatch(profile.body.textContent!, /Used today|\+\$2.*today/);
    assert.match(profile.body.textContent!, /Withdraw/);
  });

  it("the desktop header does not promise mirrored cash is available during recovery", () => {
    const header = doc(React.createElement(DesktopHeader, { mine: { ...mine, recovery: held }, onScreen: noop, onTab: noop }));
    assert.match(header.body.textContent!, /Last recorded cash/);
    assert.doesNotMatch(header.body.textContent!, /Available cash/);
  });

  it("an empty saved tape does not claim the recovering agent has never traded", () => {
    for (const recovery of [held, { ...held, history: "unknown" as const }]) {
      const table = doc(React.createElement(SwapsTable, { rows: [], tokens: [], showMoney: true,
        emptyTitle: ownerTradeEmptyTitle(recovery) }));
      assert.match(table.body.textContent!, /No saved trades available yet/);
      assert.doesNotMatch(table.body.textContent!, /No trades yet|never traded/);
    }
    assert.equal(ownerTradeEmptyTitle(undefined), "No trades yet.");
  });
});

describe("Telegram during recovery", () => {
  const status = (over: Partial<TelegramStatus> = {}): TelegramStatus => ({ enabled: true, hasToken: true, connected: true,
    botUsername: "shogunbot", ownerId: 1, allowlist: [], linkCode: null, linkPending: false, botElsewhere: false,
    listening: { state: "unknown", lastOkAt: null, reason: null }, tradingHeld: null, control: true, ...over });
  it("a verified token without polling never becomes a replying bot", () => {
    assert.deepEqual(recoveryTelegram(status()), { label: "Waiting for recovery", detail: "Replies are not confirmed while recovery is in progress." });
    assert.equal(recoveryTelegram(null).label, "Checking connection…");
  });
  it("preserves actual connection errors and qualifies polling without promising replies", () => {
    assert.equal(recoveryTelegram(status({ listening: { state: "conflict", lastOkAt: null, reason: null } })).label, "Another program has the bot");
    assert.equal(recoveryTelegram(status({ connected: false, listening: { state: "revoked", lastOkAt: null, reason: null } })).label, "Token refused");
    const polling = recoveryTelegram(status({ listening: { state: "live", lastOkAt: held.checkedAt, reason: null } }));
    assert.equal(polling.label, "Waiting for recovery");
    assert.equal(polling.detail, "Bot polling is confirmed. Trading stays paused.");
    assert.doesNotMatch(polling.detail!, /replying|ready|connected/i);
  });
  it("a held state without a fresh live measurement does not prove polling", () => {
    for (const lastOkAt of [null, held.checkedAt - 3600]) {
      const polling = recoveryTelegram(status({ listening: { state: "held", lastOkAt, reason: "saved records unconfirmed" } }));
      assert.equal(polling.detail, "Replies are not confirmed while recovery is in progress.");
      assert.doesNotMatch(polling.detail!, /polling is confirmed/);
    }
  });
  it("shows the separate public listener only with a current measured poll and its trading hold", () => {
    const now = held.checkedAt;
    const runtime = runtimeFromRow({ bot_id: "801", owner_id: 1, poll_ok_at: now - 10,
      poll_err: null, poll_err_at: null, child_state: "held:recovery-replies" }, true);
    const publicStatus = status(telegramListening(runtime, "801:local_fixture", now));
    assert.deepEqual(recoveryTelegram(publicStatus, now), {
      label: "Listening for public questions", detail: "Charts and project descriptions only. Trading remains paused." });
    for (const lastOkAt of [null, 0, now - 181, now + 1]) {
      const unproved = recoveryTelegram({ ...publicStatus, listening: { ...publicStatus.listening!, lastOkAt } }, now);
      assert.equal(unproved.label, "Waiting for recovery");
    }
    assert.equal(recoveryTelegram({ ...publicStatus, tradingHeld: null }, now).label, "Waiting for recovery");
    assert.equal(recoveryTelegram({ ...publicStatus, connected: false }, now).label, "Connection unverified");
    assert.equal(recoveryTelegram({ ...publicStatus, botElsewhere: true }, now).label, "Connected to another agent");
    const wrongBot = status(telegramListening(runtime, "802:local_fixture", now));
    assert.equal(wrongBot.linkPending, true);
    assert.equal(recoveryTelegram(wrongBot, now).label, "Waiting for recovery");
  });
});
