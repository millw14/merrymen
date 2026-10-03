/**
 * TWO HUNDRED REFUSALS, THREE MESSAGES, EVERY ONE ACCOUNTED FOR.
 *
 * Reported 2026-10-02: an owner's bot pushed "⛽ a buy of LARP wasn't sent —
 * its permission set is too wide to install together with this trade …
 * (enable-too-wide)" more than two hundred times, one per tick, because the
 * strategist re-proposed the same buy and every refused row became a push.
 *
 * The real notifier over a real ledger, one pass per simulated minute, with
 * refused rows landing on a schedule. Telegram's API is a fake that records
 * what was sent.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, describe, it, mock } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-refusal-repeats-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_DASHBOARD_URL = "https://app.merrymen.dev";
after(() => rmSync(HOME, { recursive: true, force: true }));

const { startNotifier, REFUSAL_FIRST_NOTE } = await import("./notifier");

const T0 = Math.floor(Date.parse("2026-10-02T10:43:00Z") / 1000);
const OWNER = 123_456_789;
const AGENT = "agent-larp";

afterEach(() => mock.restoreAll());

function ledger(): DatabaseSync {
  const db = new DatabaseSync(path.join(HOME, "merrymen.db"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY, agent_id TEXT, kind TEXT, amount_usdg REAL, " +
      "status TEXT, reject_rule TEXT, tx_hash TEXT, decision_id TEXT, target TEXT, fill_side TEXT, " +
      "fill_cash_usdg REAL, realized_pnl_usdg REAL, sell_token TEXT, buy_token TEXT, " +
      "user_op_hash TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))",
  );
  db.exec("DELETE FROM trades");
  return db;
}

/**
 * Drive the real notifier one pass per simulated minute. `rowsAt(minute)` says
 * what lands in the ledger just before that pass.
 */
async function run(minutes: number, rowsAt: (minute: number) => { status: string; reject_rule: string | null }[]) {
  const db = ledger();
  const insert = db.prepare(
    "INSERT INTO trades (agent_id, kind, amount_usdg, status, reject_rule, tx_hash, target) VALUES (?, 'swap', 20, ?, ?, NULL, '0xrouter')",
  );
  const sends: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const method = String(url).split("/").pop() ?? "";
    if (method === "sendMessage") sends.push(String((JSON.parse(init?.body ?? "{}") as { text?: string }).text));
    return new Response(JSON.stringify({ ok: true, result: { message_id: sends.length } }), { status: 200 });
  }) as typeof fetch;
  mock.timers.enable({ apis: ["setTimeout"] });
  let now = T0;
  let state: Record<string, unknown> = {
    offset: 0, chatSettings: null, linkCode: "", linkRound: 0, ownerId: OWNER, linkedAt: null, linkedChats: [], linkedChatAt: {},
    messageCount: 0, lastNotifiedTradeId: 0, lastTradeDigestAt: 0, lastRemedyRule: null, firedAlerts: {},
    signWatch: null, lastDigestDate: "", lastJournalDate: "2026-10-02", priceAlerts: [], watchers: [], reminders: [], nextId: 1, poll: null,
  };
  const cfg = {
    telegramEnabled: true, telegramBotToken: "123:TEST", telegramNotifyEnabled: true, telegramNotifyEveryMin: 0,
    telegramDigestHour: 99, tickSeconds: 60, customTokens: [], telegramPcControlEnabled: false, telegramCapabilities: [],
  };
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
  };
  let minute = 0;
  for (const r of rowsAt(minute)) insert.run(AGENT, r.status, r.reject_rule);
  const handle = startNotifier({
    getCfg: () => cfg as never,
    note: () => {},
    stateRef: { get: () => state as never, set: (s) => { state = s as never; } },
    buildStatusContext: () => ({ name: "Robin", strategy: "s", venue: "v", paused: false, workerAliveSec: 0, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 }),
    getAlertInputs: () => ({ grantExpiresAt: null, maxActionUsdg: null, cashUsdg: null, drawdownBps: null, breakerBps: null, gasWei: null }),
    getChainId: () => null,
    getAgentId: () => AGENT,
    now: () => now,
  });
  try {
    await settle();
    for (minute = 1; minute < minutes; minute += 1) {
      now = T0 + minute * 60;
      for (const r of rowsAt(minute)) insert.run(AGENT, r.status, r.reject_rule);
      mock.timers.tick(15_000);
      await settle();
    }
    return { sends, state };
  } finally {
    handle.stop();
    mock.timers.reset();
    globalThis.fetch = realFetch;
    db.close();
  }
}

const tooWide = { status: "rejected", reject_rule: "enable-too-wide" };
const counts = (sends: string[]) =>
  sends.map((s) => /was refused (\d+) more times?/.exec(s)?.[1]).filter(Boolean).map(Number);

describe("one refusal re-proposed every tick", () => {
  it("200 refused attempts reach the chat as three lines whose counts add up to 200", async () => {
    // A refusal every minute for minutes 0..199, then nothing, watched to minute 421.
    const { sends, state } = await run(422, (m) => (m < 200 ? [tooWide] : []));
    const about = sends.filter((s) => /enable-too-wide/.test(s));
    assert.equal(about.length, 3, about.join("\n---\n"));

    const [first, hour, later] = about as [string, string, string];
    assert.match(first, /^⛽ a swap wasn't sent — its permission set is too wide to install together with this trade\./);
    assert.match(first, /No action needed: your agent installs its new permissions on their own first/, "the fix, with the first line");
    assert.ok(first.endsWith(REFUSAL_FIRST_NOTE), "and what to expect if it repeats");

    assert.ok(
      hour.startsWith("↻ the swap was refused 60 more times in the last 60 min (enable-too-wide), the last just now. "),
      hour,
    );
    assert.match(hour, /If this keeps repeating, re-sign at \/grant with fewer custom tokens or capabilities/, "the fix rides on the count");
    assert.match(later, /was refused 139 more times in the last 6 hours \(enable-too-wide\), the last 4 hours ago\./);

    assert.equal(1 + counts(about).reduce((a, b) => a + b, 0), 200, "every attempt is accounted for");
    assert.equal(state.lastNotifiedTradeId, 200, "every row is behind the cursor");
    assert.deepEqual(state.refusalRepeats, {}, "nothing left owed");
  });

  it("a slow strategist is not told the run ended between its windows", async () => {
    // One refusal every 20 minutes for three hours: ten rows. Pushed one per
    // row this was ten messages; a gap-based "it stopped" would have been more.
    const { sends } = await run(422, (m) => (m <= 180 && m % 20 === 0 ? [tooWide] : []));
    const about = sends.filter((s) => /enable-too-wide/.test(s));
    assert.equal(about.length, 3, about.join("\n---\n"));
    assert.deepEqual(counts(about), [3, 6]);
  });

  it("a different refusal, and every fill, still goes out the moment it lands", async () => {
    const { sends } = await run(6, (m) =>
      m === 3
        ? [{ status: "rejected", reject_rule: "no-exit" }, { status: "landed", reject_rule: null }]
        : [tooWide],
    );
    assert.equal(sends.filter((s) => /enable-too-wide/.test(s)).length, 1, "the repeat is counted");
    assert.equal(sends.filter((s) => /no-exit/.test(s)).length, 1, "another rule is its own line");
    assert.equal(sends.filter((s) => /went through/.test(s)).length, 1, "a fill is never held");
  });
});
