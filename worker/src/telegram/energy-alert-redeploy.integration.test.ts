/**
 * THE "ENERGY SPENT" TELEGRAM ALERT GOES ONCE PER UTC DAY — ACROSS A REDEPLOY.
 *
 * Its own dedupe key lives in telegram.json, and a hosted redeploy does not
 * restore that file's alert keys (writeTelegramForChild puts back the link and
 * nothing else). Keyed on that alone, every deploy on a spent day told the
 * owner again. So the alert rides the notice's durable claim —
 * energy_days.told_at — and speaks only for a day whose claim this process
 * won (index.ts tellEnergySpent → energyToldHere → energyToldDayOf).
 *
 * Driven end to end over real sqlite with the real statements and the real
 * notifier (Telegram's API replaced by a recording fake, timers mocked):
 * child A spends the day, wins the claim and sends the alert once → the
 * mirror carries the day up → A is destroyed → an EMPTY child B is seeded
 * exactly as seedEnergyForChild seeds it, with a telegram.json that knows no
 * alert keys → B's tick finds the day spent again, its claim finds the stamp
 * and wins nothing, and B's notifier sends nothing. The control shows the
 * seed is what stops it: an unseeded child wins the claim and would send.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it, mock } from "node:test";

import type { EnergyStatus } from "../../../packages/core/src/index";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-energy-alert-redeploy-"));
process.env.MERRYMEN_HOME = HOME; // no ledger file: the notifier's trade pass reads nothing
process.env.MERRYMEN_DASHBOARD_URL = "https://app.merrymen.dev";
after(() => rmSync(HOME, { recursive: true, force: true }));

const { wrapSqlite } = await import("../db");
const { ENERGY_DAYS_SCHEMA, claimEnergyDay, claimEnergyNoticeDay, mergeEnergyDayRow, readEnergyDay, readEnergyDaysSince } =
  await import("../energy-days");
const { energyPlan, energyStatus, nextUtcMidnight, planEnergySeed, utcDay } = await import("../energy");
const { MIRROR_STATE_DDL, mirrorTenant } = await import("../ledger-mirror");
const { energyToldDayOf } = await import("./energy-alert");
const { startNotifier } = await import("./notifier");

const AGENT = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";
const HOLDER = "0x1234567890abcdef1234567890abcdef12345678";
const NOW = Math.floor(Date.parse("2026-09-27T15:00:00Z") / 1000);
const TODAY = utcDay(NOW);
const ENTRIES = 2;

/** Enough of the ledger for the mirror's snapshot pass to reach its energy block (energy-durability.test.ts). */
const SCHEMA = [
  "CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT, owner_address TEXT, session_key_address TEXT," +
    " chain_id INTEGER, caps TEXT, granted_at INTEGER, expires_at INTEGER, status TEXT, created_at INTEGER, mode TEXT," +
    " beat_at INTEGER, sponsor_gas INTEGER, live_blocker TEXT, x_handle TEXT, x_verified INTEGER DEFAULT 0," +
    " epoch INTEGER DEFAULT 1, hwm_usdg REAL DEFAULT 0, hwm_withdrawn_usdg REAL NOT NULL DEFAULT 0," +
    " accrued_fee_usdg REAL DEFAULT 0, contributions_known INTEGER, contributions_why TEXT, gas_accounting TEXT," +
    " quality_at INTEGER, energy TEXT);",
  "CREATE TABLE positions (agent_id TEXT, symbol TEXT, token TEXT, raw_balance TEXT, ui_multiplier TEXT," +
    " price_usd REAL, price_stale INTEGER, price_source TEXT DEFAULT 'chainlink', value_usdg REAL," +
    " updated_at INTEGER, PRIMARY KEY (agent_id, symbol));",
  "CREATE TABLE cost_basis (agent_id TEXT, mode TEXT, symbol TEXT, qty_raw TEXT, cost_usdg TEXT," +
    " updated_at INTEGER, PRIMARY KEY (agent_id, mode, symbol));",
  "CREATE TABLE position_floors (agent_id TEXT, mode TEXT, symbol TEXT, stop_bps INTEGER, rung INTEGER," +
    " why TEXT, at INTEGER, PRIMARY KEY (agent_id, mode, symbol));",
  "CREATE TABLE class_positions (agent_id TEXT, token TEXT, symbol TEXT, decimals INTEGER DEFAULT 18," +
    " curve TEXT, quote_token TEXT, first_seen INTEGER, vault TEXT, entry_tx TEXT, exit_tx TEXT," +
    " cost_usdg TEXT, qty_raw TEXT, proceeds_usdg TEXT, opened_at_block TEXT, state TEXT DEFAULT 'open'," +
    " swept_raw TEXT, PRIMARY KEY (agent_id, token));",
  ENERGY_DAYS_SCHEMA + ";",
].join("\n");

type Ledger = { raw: DatabaseSync; db: ReturnType<typeof wrapSqlite> };
const open = (ddl: string): Ledger => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(ddl);
  return { raw, db: wrapSqlite(raw) };
};

/** Exactly what seedEnergyForChild does, over sqlite standing in for shared Postgres. */
const seed = async (child: Ledger, shared: Ledger) => {
  const sinceDay = utcDay(NOW - 86_400);
  const plan = planEnergySeed({
    shared: await readEnergyDaysSince(shared.db, AGENT, sinceDay),
    child: await readEnergyDaysSince(child.db, AGENT, sinceDay),
    sinceDay,
  });
  for (const row of plan) await mergeEnergyDayRow(child.db, AGENT, row);
};

/**
 * One child's tick on a spent day, as index.ts runs it: the plan from its own
 * ledger, the report (energyStatus), and — spent and not yet told — the notice
 * claim (tellEnergySpent), which is the only thing that sets energyToldHere.
 */
const tickOn = async (child: Ledger) => {
  const counters = await readEnergyDay(child.db, AGENT, TODAY);
  const plan = energyPlan({ mode: "enforce", level: "low", counters, reviewsAllowed: 29, entriesAllowed: ENTRIES, nowSec: NOW });
  const report: EnergyStatus = energyStatus({
    plan,
    parts: { holder: 12_000n * 10n ** 18n, account: 345n * 10n ** 18n },
    hasReviewer: true,
    buy: "ready",
    estimateUsdg: 37.12,
    nowSec: NOW,
  });
  let energyToldHere: { agentId: string; day: string } | null = null;
  if (plan.enforce && report.spent && !plan.told) {
    if (await claimEnergyNoticeDay(child.db, AGENT, plan.day, NOW)) energyToldHere = { agentId: AGENT, day: plan.day };
  }
  return { report, energyToldHere };
};

/**
 * Run the real notifier over one child's inputs for two passes, with a fresh
 * telegram.json — what a redeployed child starts from: the link put back,
 * no alert keys. Returns how many "Energy spent" messages went to Telegram.
 */
const alertsSent = async (tick: Awaited<ReturnType<typeof tickOn>>): Promise<number> => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const method = String(url).split("/").pop() ?? "";
    calls.push({ method, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { status: 200 });
  }) as typeof fetch;
  mock.timers.enable({ apis: ["setTimeout"] });
  let state = {
    offset: 0, chatSettings: null, linkCode: "", linkRound: 0, ownerId: 4242, linkedAt: null, linkedChats: [], linkedChatAt: {},
    messageCount: 0, lastNotifiedTradeId: 0, lastTradeDigestAt: 0, lastRemedyRule: null, firedAlerts: {} as Record<string, number>,
    signWatch: null, lastDigestDate: "", lastJournalDate: "", priceAlerts: [], reminders: [], watchers: [], nextId: 1,
  };
  const cfg = {
    telegramEnabled: true, telegramBotToken: "123:TEST", telegramNotifyEnabled: true, telegramNotifyEveryMin: 0,
    telegramDigestHour: 99, tickSeconds: 60, customTokens: [], telegramPcControlEnabled: false, telegramCapabilities: [],
  };
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
  };
  const handle = startNotifier({
    getCfg: () => cfg as never,
    note: () => {},
    stateRef: { get: () => state as never, set: (s) => { state = s as never; } },
    buildStatusContext: () => ({ name: "Robin", strategy: "s", venue: "v", paused: false, workerAliveSec: 0, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 }),
    // index.ts's getAlertInputs, energy half, over this child's tick.
    getAlertInputs: () => ({
      grantExpiresAt: null, maxActionUsdg: null, cashUsdg: null, drawdownBps: null, breakerBps: null, gasWei: null,
      energy: tick.report,
      energyAccount: AGENT,
      energyChainId: 4663,
      energyHolder: HOLDER,
      energyToldDay: energyToldDayOf(tick.energyToldHere, AGENT),
    }),
    getChainId: () => 4663,
    getAgentId: () => AGENT,
    now: () => NOW,
  });
  try {
    await settle();
    mock.timers.tick(15_000); // and the next pass
    await settle();
    return calls.filter((c) => c.method === "sendMessage" && String(c.body.text).includes("Energy spent for today")).length;
  } finally {
    handle.stop();
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
};

/** A child that has used the day's new trades — a low agent's whole allowance. */
const spendDay = async (child: Ledger) => {
  for (let i = 0; i < ENTRIES; i++) assert.equal(await claimEnergyDay(child.db, AGENT, TODAY, "entries", ENTRIES), true);
};

describe("the energy alert across a hosted redeploy", () => {
  it("premise: the fixed clock is inside the report's day", () => {
    assert.ok(NOW < nextUtcMidnight(NOW));
  });

  it("SENT ONCE ON THE SPENT DAY, AND NOT AGAIN BY THE CHILD THE REDEPLOY REBUILDS", async () => {
    // ── child A spends the day, wins the notice claim, and tells the owner ──
    const a = open(SCHEMA);
    a.raw.exec(`INSERT INTO agents (smart_account, name, epoch) VALUES ('${AGENT}','Robin',1)`);
    await spendDay(a);
    const tickA = await tickOn(a);
    assert.equal(tickA.report.spent, true, "premise: the report says spent");
    assert.deepEqual(tickA.energyToldHere, { agentId: AGENT, day: TODAY }, "A won today's claim");
    assert.equal(await alertsSent(tickA), 1, "the owner hears it once, from the process that claimed it");

    // ── the mirror carries the day up; A is destroyed; B starts empty and is seeded ──
    const shared = open(SCHEMA + MIRROR_STATE_DDL);
    const r = await mirrorTenant({ tenant: "0xten", child: a.db, shared: shared.db, nowSec: NOW });
    assert.equal(r.failed?.energy_days, undefined);
    a.raw.close();
    const b = open(SCHEMA);
    await seed(b, shared);
    assert.equal((await readEnergyDay(b.db, AGENT, TODAY)).toldAt, NOW, "the stamp came back with the counters");

    // ── B's tick finds the day spent again, but the claim is already made ──
    const tickB = await tickOn(b);
    assert.equal(tickB.report.spent, true, "the rebuilt child's report is still spent");
    assert.equal(tickB.energyToldHere, null, "B wins nothing — the seeded stamp stands");
    assert.equal(await alertsSent(tickB), 0, "and a fresh telegram.json does not make the alert news again");
    b.raw.close();
    shared.raw.close();
  });

  it("control: a child that lost the stamp (no seed) would claim and send — the durable claim is what stops it", async () => {
    const lost = open(SCHEMA);
    await spendDay(lost);
    const tick = await tickOn(lost);
    assert.ok(tick.energyToldHere);
    assert.equal(await alertsSent(tick), 1);
    lost.raw.close();
  });
});
