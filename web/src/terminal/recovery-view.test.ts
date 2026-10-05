import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { ownerTradeEmptyTitle, RECOVERY_WITHDRAW_VERIFIED, recoveryAutonomy, recoveryFunds, recoveryMemory, recoveryTelegram } from "./recovery-view";
import { RecoveryNotice } from "./RecoveryNotice";
import { DesktopHeader, DesktopPortfolio, DesktopSidebar } from "./Desktop";
import { Agent } from "./screens/Agent";
import { You } from "./screens/You";
import { AccountEntry, FundingPanel } from "./HostedControls";
import { SwapsTable } from "./SwapsTable";
import { AgentStrip } from "./AgentStrip";

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

describe("where the money is during recovery", () => {
  const ACCOUNT = "0x12aB34cD56eF7890123456789012345678abcDEF";
  const caps = { perTradeUsdg: 10, dailyUsdg: 20 };
  /** 12.34 USDG of cash, and 5e18 vault SHARES — a count that must never be printed as dollars. */
  const balances = { ethWei: "1", cashUsdg: "12340000", vaultUsdg: "5000000000000000000" };
  const status = (chainId = 4663, over: Record<string, unknown> = {}) =>
    ({ grant: { smartAccount: ACCOUNT, chainId, caps }, balances, ...over });
  const notice = (funds: ReturnType<typeof recoveryFunds>, recovery: FleetRecoveryView | null = held) =>
    doc(React.createElement(RecoveryNotice, { recovery, funds }));
  // Never a renewal remedy, never a "paused since" date, never a claim about
  // what was lost or when trading comes back.
  const NEVER = /renew|re-sign|resign|since|lost|zero|restored|complete|resumes/i;

  it("ships without the withdraw line until R1.4 has exercised Withdraw during the hold", () => {
    assert.equal(RECOVERY_WITHDRAW_VERIFIED, false);
    assert.equal(recoveryFunds(status())!.withdraw, null);
    assert.doesNotMatch(notice(recoveryFunds(status())).body.textContent!, /Withdraw/);
  });

  it("names the smart account, links it on its own chain and prints only the chain's cash", () => {
    const funds = recoveryFunds(status())!;
    assert.deepEqual(funds, { account: ACCOUNT, short: "0x12aB…cDEF",
      explorer: `https://robinhoodchain.blockscout.com/address/${ACCOUNT}`, testnet: false,
      cash: "Cash on chain: $12.34.", withdraw: null });
    const page = notice(funds);
    const text = page.body.textContent!;
    assert.match(text, /Trading paused for recovery/);
    assert.match(text, /Your funds are in your smart account 0x12aB…cDEF and the vaults it controls\./);
    const link = page.querySelector(".agent-recovery a")!;
    assert.equal(link.getAttribute("href"), `https://robinhoodchain.blockscout.com/address/${ACCOUNT}`);
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noreferrer");
    assert.equal(link.getAttribute("title"), ACCOUNT);
    assert.match(text, /Cash on chain: \$12\.34\./);
    assert.match(text, /Only USDG held in the account itself\. Not included: USDG in the Morpho vault, and any tokens the account holds\./);
    // The vault balance is shares: neither its raw count nor a dollar reading of it appears.
    assert.doesNotMatch(text, /5000000000000000000|\$5\b|\$5\.00|\$17\.34/);
    assert.doesNotMatch(text, NEVER);
  });

  it("links a testnet account on the testnet explorer and says it is the test network", () => {
    const funds = recoveryFunds(status(46630))!;
    assert.equal(funds.explorer, `https://explorer.testnet.chain.robinhood.com/address/${ACCOUNT}`);
    assert.equal(funds.testnet, true);
    const page = notice(funds);
    assert.equal(page.querySelector(".agent-recovery a")!.getAttribute("href"), funds.explorer);
    assert.match(page.body.textContent!, /smart account 0x12aB…cDEF on the test network and the vaults it controls/);
  });

  it("gives an account on a chain this product does not run on no explorer link", () => {
    for (const chainId of [1, 8453, Number.NaN]) {
      const funds = recoveryFunds(status(chainId))!;
      assert.equal(funds.explorer, null);
      assert.equal(funds.testnet, false);
      const page = notice(funds);
      assert.equal(page.querySelector(".agent-recovery a"), null);
      assert.match(page.body.textContent!, /Your funds are in your smart account 0x12aB…cDEF and the vaults it controls/);
    }
  });

  it("an unread cash balance is said to be unread, never $0.00", () => {
    for (const over of [{ balances: { ...balances, cashUsdg: null } }, { balances: { ...balances, cashUsdg: "" } },
      { balances: { ...balances, cashUsdg: "not-a-number" } }, { balances: undefined }]) {
      const funds = recoveryFunds(status(4663, over))!;
      assert.equal(funds.cash, "Cash on chain: couldn't be read just now.");
      const text = notice(funds).body.textContent!;
      assert.match(text, /Cash on chain: couldn't be read just now\./);
      assert.doesNotMatch(text, /\$0\.00|\$0\b/);
      assert.match(text, /smart account 0x12aB…cDEF/);
    }
    // A measured zero is a fact and is printed as one.
    assert.equal(recoveryFunds(status(4663, { balances: { ...balances, cashUsdg: "0" } }))!.cash, "Cash on chain: $0.00.");
  });

  it("says nothing about funds without a well-formed smart account", () => {
    for (const s of [null, undefined, {}, { balances }, { grant: undefined, balances },
      { grant: { smartAccount: "", chainId: 4663, caps }, balances },
      { grant: { smartAccount: "0x1234", chainId: 4663, caps }, balances },
      { grant: { smartAccount: ACCOUNT + "00", chainId: 4663, caps }, balances },
      { grant: { smartAccount: "javascript:alert(1)", chainId: 4663, caps }, balances }]) {
      assert.equal(recoveryFunds(s as Parameters<typeof recoveryFunds>[0]), null, JSON.stringify(s));
      assert.equal(recoveryFunds(s as Parameters<typeof recoveryFunds>[0], true), null, "the flag never invents an account");
    }
    const page = notice(null);
    assert.equal(page.querySelector(".agent-recovery a"), null);
    assert.doesNotMatch(page.body.textContent!, /smart account|Cash on chain|Morpho|Withdraw/);
    assert.match(page.body.textContent!, /Trading paused for recovery/);
  });

  it("funds never create a hold: no recovery, no notice", () => {
    for (const absent of [null, undefined, { ...held, tradingPaused: false } as unknown as FleetRecoveryView]) {
      assert.equal(renderToStaticMarkup(React.createElement(RecoveryNotice, { recovery: absent, funds: recoveryFunds(status(4663), true) })), "");
    }
  });

  it("every combination of facts keeps the same promises", () => {
    for (const chainId of [4663, 46630]) for (const cash of ["12340000", null]) for (const withdraw of [false, true])
      for (const hasAccount of [true, false]) {
        const input = hasAccount ? status(chainId, { balances: { ...balances, cashUsdg: cash } }) : { balances };
        const before = JSON.stringify(input);
        const funds = recoveryFunds(input, withdraw);
        assert.equal(JSON.stringify(input), before, "read-only");
        const page = notice(funds);
        const text = page.body.textContent!;
        const what = JSON.stringify({ chainId, cash, withdraw, hasAccount });
        assert.match(text, /Trading paused for recovery/, what);
        assert.doesNotMatch(text, NEVER, what);
        assert.doesNotMatch(text, /\$0\.00/, what);
        assert.equal(/smart account/.test(text), hasAccount, what);
        assert.equal(/Not included: USDG in the Morpho vault, and any tokens the account holds/.test(text), hasAccount, what);
        assert.equal(/on the test network/.test(text), hasAccount && chainId === 46630, what);
        assert.equal(/Cash on chain: \$12\.34\./.test(text), hasAccount && cash !== null, what);
        assert.equal(/Cash on chain: couldn't be read just now\./.test(text), hasAccount && cash === null, what);
        assert.equal(/Withdraw still works while trading is paused/.test(text), hasAccount && withdraw, what);
        const href = page.querySelector(".agent-recovery a")?.getAttribute("href") ?? null;
        assert.equal(href, !hasAccount ? null : chainId === 46630
          ? `https://explorer.testnet.chain.robinhood.com/address/${ACCOUNT}`
          : `https://robinhoodchain.blockscout.com/address/${ACCOUNT}`, what);
      }
  });

  it("the account entry and the funding panel say where the money is from the same grants answer", () => {
    const account = { session: { hosted: true, address: "0x" + "a".repeat(40) },
      status: { exists: true, recovery: held, ...status() } };
    const entry = doc(React.createElement(AccountEntry, { account, portfolio: "ok", onRefresh: noop, onSignedIn: noop }));
    assert.match(entry.body.textContent!, /Trading paused for recovery.*Your funds are in your smart account 0x12aB…cDEF.*Cash on chain: \$12\.34\./);
    assert.equal(entry.querySelector(".agent-recovery a")!.getAttribute("href"), `https://robinhoodchain.blockscout.com/address/${ACCOUNT}`);
    assert.doesNotMatch(entry.body.textContent!, NEVER);
    const deposit = doc(React.createElement(FundingPanel, { mode: "deposit", account, onClose: noop }));
    assert.match(deposit.body.textContent!, /Trading paused for recovery.*Your funds are in your smart account 0x12aB…cDEF.*Cash on chain: \$12\.34\./);
    assert.match(deposit.body.textContent!, /Copy deposit address/);
    // The panel's own wrong-network warning mentions a re-sign; the notice never does.
    assert.doesNotMatch(deposit.querySelector(".agent-recovery")!.textContent!, NEVER);
    // Without a hold the funding panel is exactly what it was: no funds sentences.
    const ordinary = doc(React.createElement(FundingPanel, { mode: "deposit", onClose: noop,
      account: { ...account, status: { ...account.status, recovery: null } } }));
    assert.doesNotMatch(ordinary.body.textContent!, /Trading paused for recovery|Your funds are in|Cash on chain/);
    // An entry whose grants answer named no account keeps the plain notice.
    const bare = doc(React.createElement(AccountEntry, { account: { ...account, status: { exists: true, recovery: held } },
      portfolio: "ok", onRefresh: noop, onSignedIn: noop }));
    assert.match(bare.body.textContent!, /Trading paused for recovery/);
    assert.doesNotMatch(bare.body.textContent!, /smart account|Cash on chain/);
  });

  it("the profile and the home strip say where the money is and keep Withdraw", () => {
    const funds = recoveryFunds(status());
    const profile = doc(React.createElement(You, { mine: { ...mine, recovery: held, recoveryFunds: funds }, history: [40, 42],
      stopped: false, perTrade: 10, perDay: 20, onLimits: noop, onStop: noop, onDesk: noop, onDeposit: noop, onWithdraw: noop }));
    const card = profile.querySelector(".agent-recovery")!;
    assert.match(card.textContent!, /Your funds are in your smart account 0x12aB…cDEF and the vaults it controls\..*Cash on chain: \$12\.34\./);
    assert.equal(card.querySelector("a")!.getAttribute("href"), `https://robinhoodchain.blockscout.com/address/${ACCOUNT}`);
    assert.doesNotMatch(card.textContent!, NEVER);
    assert.ok([...profile.querySelectorAll("button")].some(b => b.textContent === "Withdraw"), "the Withdraw button stays");
    const strip = doc(React.createElement(AgentStrip, { hasAgent: true, recovery: held, funds }));
    assert.match(strip.querySelector(".agent-recovery")!.textContent!, /Your funds are in your smart account 0x12aB…cDEF.*Cash on chain: \$12\.34\./);
    assert.match(strip.body.textContent!, /Trading paused/);
    assert.doesNotMatch(strip.querySelector(".agent-recovery")!.textContent!, NEVER);
    // No funds handed down: the strip's notice is the plain one, and no hold means no notice at all.
    const plain = doc(React.createElement(AgentStrip, { hasAgent: true, recovery: held }));
    assert.doesNotMatch(plain.body.textContent!, /smart account|Cash on chain/);
    const none = doc(React.createElement(AgentStrip, { hasAgent: true, recovery: null, funds }));
    assert.equal(none.querySelector(".agent-recovery"), null);
  });

  it("App derives the funds from the account that carried the hold, and only while it holds", () => {
    // App renders under next/navigation and cannot be mounted here (see
    // account-read.ts), so the one line that pairs the two is pinned in source.
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    assert.match(app, /const recovery = pausedRecovery\(account\?\.status\.recovery\);/);
    assert.match(app, /\.\.\.\(recovery \? \{ chg24: null, recoveryFunds: recoveryFunds\(account\.status\) \} : \{\}\)/);
    assert.equal(app.match(/recoveryFunds\(/g)?.length, 1, "computed once, never re-derived");
    assert.match(readFileSync(new URL("./screens/Home.tsx", import.meta.url), "utf8"),
      /<AgentStrip hasAgent=\{hasAgent\} recovery=\{mine\?\.recovery\} funds=\{mine\?\.recoveryFunds\}\/>/);
    assert.match(readFileSync(new URL("./Desktop.tsx", import.meta.url), "utf8"),
      /<AgentStrip hasAgent recovery=\{mine\.recovery\} funds=\{mine\.recoveryFunds\}\/>/);
  });

  it("reads the hold without changing it, and keeps the hold's own words", () => {
    const before = JSON.stringify(held);
    const text = notice(recoveryFunds(status(), true)).body.textContent!;
    assert.equal(JSON.stringify(held), before);
    assert.match(text, /Trading paused for recovery.*Some saved history is available.*Trading remains paused pending reconciliation/);
    assert.match(text, /Last verified activity/);
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
