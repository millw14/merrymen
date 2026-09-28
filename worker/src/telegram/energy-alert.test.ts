/**
 * THE DAILY "ENERGY SPENT" PUSH — WHEN IT SPEAKS, WHAT IT SAYS, WHAT IT OFFERS.
 *
 * Telegram is read-only for energy in v1 (design D6). This alert is the one
 * thing it pushes: once per UTC day, only while the gate ENFORCES and today's
 * new-trade allowance is used up, in the notice's own words with the addresses
 * in <code> and the buy pointed at the Merrymen app chat — and never with a
 * button that buys anything.
 *
 * The rules are executed on the pure module; the wiring is executed through
 * the real startNotifier against a recording fake of Telegram's API (global
 * fetch replaced, so nothing here can reach the network), with its timers
 * mocked so a second pass runs on demand.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";

import type { EnergyStatus } from "../../../packages/core/src/index";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-energy-alert-"));
process.env.MERRYMEN_HOME = HOME; // no ledger, no grant file: the pass reads nothing else
process.env.MERRYMEN_DASHBOARD_URL = "https://app.merrymen.dev";
after(() => rmSync(HOME, { recursive: true, force: true }));

const {
  ENERGY_ALERT_KEY_PREFIX,
  ENERGY_ALERT_RETRY_SEC,
  energyAlert,
  energyAlertDue,
  energyToldDayOf,
  recordEnergyAlert,
} = await import("./energy-alert");
const { startNotifier } = await import("./notifier");

const ACCOUNT = "0x8e93ba0c1b1d8f0a3c9b2e6f4d5a7c8b9e0f1a2b";
const HOLDER = "0x1234567890abcdef1234567890abcdef12345678";
const NOW = 1_790_000_000;
const PUBLIC = "https://app.merrymen.dev";

const REPORT: EnergyStatus = {
  v: 1,
  gated: true,
  mode: "enforce",
  level: "low",
  agentTokens: 345,
  holderTokens: 12_000,
  needTokens: 100_000,
  day: "2026-09-21",
  resetsAt: NOW + 3_600,
  reviews: { used: 5, allowed: 5 },
  entries: { used: 2, allowed: 2 },
  spent: true,
  buy: "ready",
  estimateUsdg: 37.12,
  at: NOW - 10,
};

const inputs = (over: Partial<EnergyStatus> = {}, rest: Record<string, unknown> = {}) => ({
  energy: { ...REPORT, ...over },
  energyAccount: ACCOUNT,
  energyChainId: 4663,
  energyHolder: HOLDER,
  // This process won the day's notice claim (energy_days.told_at).
  energyToldDay: over.day ?? REPORT.day,
  ...rest,
});

describe("energyAlert — it speaks only when today's energy is spent", () => {
  it("fires for a gated, spent report", () => {
    const a = energyAlert(inputs(), PUBLIC, NOW);
    assert.ok(a);
    assert.equal(a.key, "energy:2026-09-21");
  });

  it("never when not gated (off/observe limit nothing), not spent, or full", () => {
    assert.equal(energyAlert(inputs({ gated: false, mode: "observe" }), PUBLIC, NOW), null);
    assert.equal(energyAlert(inputs({ gated: false, mode: "off" }), PUBLIC, NOW), null);
    assert.equal(energyAlert(inputs({ spent: false }), PUBLIC, NOW), null);
    assert.equal(energyAlert(inputs({ level: "full" }), PUBLIC, NOW), null);
  });

  it("never without a report, or without an armed account to name", () => {
    assert.equal(energyAlert({}, PUBLIC, NOW), null);
    assert.equal(energyAlert({ ...inputs(), energy: null }, PUBLIC, NOW), null);
    assert.equal(energyAlert(inputs({}, { energyAccount: null }), PUBLIC, NOW), null);
    assert.equal(energyAlert(inputs({}, { energyChainId: null }), PUBLIC, NOW), null);
  });

  it("never yesterday's news: a report whose day has reset says nothing", () => {
    assert.equal(energyAlert(inputs(), PUBLIC, REPORT.resetsAt), null);
  });

  it("ONLY FOR A DAY WHOSE NOTICE CLAIM THIS PROCESS WON — after a redeploy the seeded stamp means silence", () => {
    assert.equal(energyAlert(inputs({}, { energyToldDay: null }), PUBLIC, NOW), null, "claimed elsewhere, or not yet");
    assert.equal(energyAlert(inputs({}, { energyToldDay: undefined }), PUBLIC, NOW), null);
    assert.equal(energyAlert(inputs({}, { energyToldDay: "2026-09-20" }), PUBLIC, NOW), null, "yesterday's claim is not today's");
    assert.ok(energyAlert(inputs({}, { energyToldDay: REPORT.day }), PUBLIC, NOW));
  });

  it("energyToldDayOf: the claim counts only for the agent that won it", () => {
    const told = { agentId: ACCOUNT, day: "2026-09-21" };
    assert.equal(energyToldDayOf(told, ACCOUNT), "2026-09-21");
    assert.equal(energyToldDayOf(told, HOLDER), null, "a re-sign armed another account in this process");
    assert.equal(energyToldDayOf(told, null), null, "unarmed");
    assert.equal(energyToldDayOf(null, ACCOUNT), null, "nothing claimed here");
  });
});

describe("energyAlert — what it says", () => {
  const a = energyAlert(inputs(), PUBLIC, NOW)!;

  it("leads with the headline, then the notice's own dated sentence", () => {
    assert.ok(a.text.startsWith("⚡ <b>Energy spent for today.</b> Energy spent for 21 Sep (UTC): "), a.text);
    assert.match(a.text, /stop-losses, take-profits and your own orders still run/);
    assert.match(a.text, /My own AI reviews — including of my open positions — are paced/);
    assert.doesNotMatch(a.text, /\bselling\b/i, "an exit the AI decides is paced; 'selling is never limited' was false");
    assert.match(a.text, /00:00 UTC/);
    assert.match(a.text, /Robinhood Chain/);
  });

  it("every address is in full, inside <code>", () => {
    assert.ok(a.text.includes(`<code>${ACCOUNT}</code>`), "the agent's account");
    assert.ok(a.text.includes(`<code>${HOLDER}</code>`), "the owner's wallet");
    const bare = a.text.replace(/<code>0x[0-9a-fA-F]{40}<\/code>/g, "");
    assert.doesNotMatch(bare, /0x[0-9a-fA-F]{6,}/, "no address outside a code span");
  });

  it("points the buy at the Merrymen app chat, not here", () => {
    assert.match(a.text, /ask me in the Merrymen app chat \(not here\) to get my \$MERRYMEN/);
    assert.doesNotMatch(a.text, /\/getenergy|\/buy/);
  });

  it("the only button is a link to the desk — nothing that buys", () => {
    assert.deepEqual(a.keyboard, [[{ text: "⚡ Open my desk", url: `${PUBLIC}/agent` }]]);
    for (const row of a.keyboard ?? []) {
      for (const b of row) assert.ok(!("callbackData" in b), "a callback button is an action; this alert has none");
    }
  });

  it("no button where a phone cannot open the link", () => {
    assert.equal(energyAlert(inputs(), "http://localhost:3100", NOW)!.keyboard, undefined);
  });

  it("the paper, resign and not-mainnet arms keep their own remedies", () => {
    const paper = energyAlert(inputs({ buy: "paper" }), PUBLIC, NOW)!.text;
    assert.match(paper, /Paper mode/);
    assert.doesNotMatch(paper, /send USDG/, "practising, it will not spend real USDG on it");
    const resign = energyAlert(inputs({ buy: "resign" }), PUBLIC, NOW)!.text;
    assert.match(resign, /re-sign my permission/);
    const notMainnet = energyAlert(inputs({ buy: "not-mainnet", agentTokens: null }, { energyChainId: 46630 }), PUBLIC, NOW)!.text;
    assert.ok(!notMainnet.includes(ACCOUNT), "tokens sent to an account on another network would not count");
    assert.match(notMainnet, /in your own wallet/);
  });

  it("unread is our read failing, never 'hold 0'", () => {
    const t = energyAlert(inputs({ level: "unread", holderTokens: null, agentTokens: null }), PUBLIC, NOW)!.text;
    assert.match(t, /our read failing, not your wallet/);
    assert.doesNotMatch(t, /hold 0|\b0 \$MERRYMEN/);
  });

  it("nothing about the token's price or returns", () => {
    for (const over of [{}, { buy: "paper" as const }, { buy: "resign" as const }, { level: "unread" as const }]) {
      const t = energyAlert(inputs(over), PUBLIC, NOW)!.text;
      // "take-profit" names a sell rule; it is not a word about returns.
      assert.doesNotMatch(t, /price (will|to)|returns?\b|(?<!take-)profit|moon|pump|buyback|burn|invest/i, t);
    }
  });
});

describe("once per UTC day, not once per six hours", () => {
  it("a sent key never sends again", () => {
    assert.equal(energyAlertDue("energy:2026-09-21", {}, null, NOW), true);
    assert.equal(energyAlertDue("energy:2026-09-21", { "energy:2026-09-21": NOW - 7 * 3600 }, null, NOW), false);
  });

  it("a refused send waits out the retry, then tries again", () => {
    const retry = { key: "energy:2026-09-21", at: NOW + ENERGY_ALERT_RETRY_SEC };
    assert.equal(energyAlertDue("energy:2026-09-21", {}, retry, NOW), false);
    assert.equal(energyAlertDue("energy:2026-09-21", {}, retry, NOW + ENERGY_ALERT_RETRY_SEC), true);
    assert.equal(energyAlertDue("energy:2026-09-22", {}, retry, NOW), true, "another day's retry holds nothing back");
  });

  it("recording keeps one energy key, and every other alert's", () => {
    const next = recordEnergyAlert({ "energy:2026-09-20": 1, "low-gas": 2, "drawdown-halted:500": 3 }, "energy:2026-09-21", 9);
    assert.deepEqual(next, { "low-gas": 2, "drawdown-halted:500": 3, "energy:2026-09-21": 9 });
    assert.ok(Object.keys(next).filter((k) => k.startsWith(ENERGY_ALERT_KEY_PREFIX)).length === 1);
  });
});

describe("through the real notifier", () => {
  it("sends once, with the link and no buy button, and not again on the next pass", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const method = String(url).split("/").pop() ?? "";
      calls.push({ method, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
      return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { status: 200 });
    }) as typeof fetch;
    mock.timers.enable({ apis: ["setTimeout"] });
    let state = {
      offset: 0, chatSettings: null, linkCode: "", linkRound: 0, ownerId: 4242, linkedAt: null, linkedChats: [],
      messageCount: 0, lastNotifiedTradeId: 0, lastTradeDigestAt: 0, lastRemedyRule: null, firedAlerts: {} as Record<string, number>,
      signWatch: null, lastDigestDate: "", lastJournalDate: "", priceAlerts: [], reminders: [], watchers: [], nextId: 1,
    };
    const cfg = {
      telegramEnabled: true, telegramBotToken: "123:TEST", telegramNotifyEnabled: true, telegramNotifyEveryMin: 0,
      telegramDigestHour: 99, tickSeconds: 60, customTokens: [], telegramPcControlEnabled: false, telegramCapabilities: [],
    };
    let passes = 0;
    const settle = async () => {
      for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
    };
    const handle = startNotifier({
      getCfg: () => cfg as never,
      note: () => {},
      stateRef: { get: () => state as never, set: (s) => { state = s as never; } },
      buildStatusContext: () => ({ name: "Robin", strategy: "s", venue: "v", paused: false, workerAliveSec: 0, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 }),
      getAlertInputs: () => {
        passes += 1; // read once per pass
        return {
          grantExpiresAt: null, maxActionUsdg: null, cashUsdg: null, drawdownBps: null, breakerBps: null, gasWei: null,
          energy: { ...REPORT, resetsAt: Math.floor(Date.now() / 1000) + 3_600 },
          energyAccount: ACCOUNT,
          energyChainId: 4663,
          energyHolder: HOLDER,
          energyToldDay: REPORT.day,
        };
      },
      getChainId: () => 4663,
      getAgentId: () => ACCOUNT,
    });
    try {
      await settle();
      const sends = () => calls.filter((c) => c.method === "sendMessage" && String(c.body.text).includes("Energy spent for today"));
      assert.equal(sends().length, 1, "sent on the first pass");
      const sent = sends()[0]!.body;
      assert.equal(sent.chat_id, 4242, "to the /link owner only");
      assert.ok(String(sent.text).includes(`<code>${ACCOUNT}</code>`));
      assert.match(String(sent.text), /Merrymen app chat \(not here\)/);
      const rows = (sent.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> }).inline_keyboard;
      assert.ok(rows.flat().every((b) => b.callback_data === undefined), "no inline button that acts");
      assert.deepEqual(rows, [[{ text: "⚡ Open my desk", url: `${PUBLIC}/agent` }]]);
      assert.ok(state.firedAlerts["energy:2026-09-21"] !== undefined, "the day's key is recorded");

      mock.timers.tick(15_000); // the next pass, fifteen seconds on
      await settle();
      mock.timers.tick(7 * 3600 * 1000); // and one well past fire()'s six-hour cooldown
      await settle();
      assert.equal(passes, 3, "three passes ran");
      assert.equal(sends().length, 1, "once per day, not once per pass or per six hours");
    } finally {
      handle.stop();
      mock.timers.reset();
      globalThis.fetch = realFetch;
    }
  });

  it("the pass sends it outside fire(), after the gas alerts, with no keyboard of its own making", () => {
    const src = readFileSync(new URL("./notifier.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("TODAY'S ENERGY IS SPENT"));
    const body = block.slice(0, block.indexOf("relationship milestones"));
    assert.ok(src.indexOf("TODAY'S ENERGY IS SPENT") > src.indexOf('"low-gas"'), "after the gas alerts");
    assert.doesNotMatch(body, /await fire\(/, "fire()'s six-hour cooldown would repeat it the same day");
    assert.doesNotMatch(body, /callbackData|parkAction|pending/i, "no action, parked or otherwise");
    assert.match(body, /energyAlert\(inputs, dashboardBase\(\), now\(\)\)/);
    assert.match(body, /recordEnergyAlert\(fresh\.firedAlerts/, "recorded on the fresh state, after the send");
    assert.doesNotMatch(body, /console\.log\([^)]*alert\.text/, "the body carries addresses — never logged");
  });
});
