/**
 * A MESSAGE THE AGENT STARTS, THAT TELEGRAM WILL NOT TAKE, IS SAID (plan P5).
 *
 * The notifier sends everything the agent says unasked: trade receipts,
 * digests, alerts, reminders, watchers, the daily report, all to the owner's
 * chat. Every one of those sends ignored the answer, so a bot the owner had
 * blocked, or a chat that was gone, failed each of them without a line
 * anywhere. Now each goes through the same check the poll loop uses, onto
 * the fleet's log with the chat cut to four digits, and never into the
 * owner's event feed.
 *
 * The real notifier, over a home with no ledger (so the trade pass reads
 * nothing), a due reminder, and Telegram's API replaced by a fake that
 * refuses every send the way it refuses a blocked bot.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-notifier-delivery-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_DASHBOARD_URL = "https://app.merrymen.dev";
after(() => rmSync(HOME, { recursive: true, force: true }));

const { startNotifier } = await import("./notifier");
const { makeChatTally } = await import("./poll-rules");

const NOW = Math.floor(Date.parse("2026-09-28T15:00:00Z") / 1000);
const OWNER = 123_456_789;
const BLOCKED = "Forbidden: bot was blocked by the user";

afterEach(() => mock.restoreAll());

/** Run two passes of the real notifier with one reminder due; every sendMessage is refused. */
async function run(tally?: ReturnType<typeof makeChatTally>) {
  const sends: string[] = [];
  const notes: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const method = String(url).split("/").pop() ?? "";
    if (method === "sendMessage") sends.push(String((JSON.parse(init?.body ?? "{}") as { text?: string }).text));
    return new Response(JSON.stringify({ ok: false, error_code: 403, description: BLOCKED }), { status: 403 });
  }) as typeof fetch;
  mock.timers.enable({ apis: ["setTimeout"] });
  let state = {
    offset: 0, chatSettings: null, linkCode: "", linkRound: 0, ownerId: OWNER, linkedAt: null, linkedChats: [], linkedChatAt: {},
    messageCount: 0, lastNotifiedTradeId: 0, lastTradeDigestAt: 0, lastRemedyRule: null, firedAlerts: {} as Record<string, number>,
    signWatch: null, lastDigestDate: "", lastJournalDate: "", priceAlerts: [], watchers: [], nextId: 2, poll: null,
    reminders: [{ id: 1, text: "call the broker", fireAt: NOW - 60 }],
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
    note: (_level, message) => notes.push(message),
    stateRef: { get: () => state as never, set: (s) => { state = s as never; } },
    buildStatusContext: () => ({ name: "Robin", strategy: "s", venue: "v", paused: false, workerAliveSec: 0, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 }),
    getAlertInputs: () => ({ grantExpiresAt: null, maxActionUsdg: null, cashUsdg: null, drawdownBps: null, breakerBps: null, gasWei: null }),
    getChainId: () => null,
    getAgentId: () => null,
    ...(tally ? { tally } : {}),
    now: () => NOW,
  });
  try {
    await settle();
    mock.timers.tick(30_000);
    await settle();
    return { sends, notes };
  } finally {
    handle.stop();
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
}

describe("the notifier's own sends", () => {
  it("A REFUSED REMINDER IS LOGGED, with the chat cut to four digits, and not into the owner's feed", async () => {
    const logs: { level: string; message: string }[] = [];
    const { sends, notes } = await run(makeChatTally((level, message) => logs.push({ level, message }), () => NOW));
    assert.ok(sends.some((t) => t.includes("call the broker")), "premise: the reminder was sent, and refused");
    assert.deepEqual(logs, [{ level: "warn", message: `Telegram: a reply to chat …6789 was not delivered — ${BLOCKED}` }]);
    assert.ok(!logs.some((l) => l.message.includes(String(OWNER))), "never the whole chat id");
    assert.deepEqual(notes.filter((n) => /not delivered/.test(n)), []);
  });

  it("WITH NO TALLY HANDED IN, it goes to stdout, the fleet's log", async () => {
    const out: string[] = [];
    mock.method(console, "log", (...a: unknown[]) => void out.push(a.map(String).join(" ")));
    await run();
    assert.ok(out.includes(`[telegram warn] Telegram: a reply to chat …6789 was not delivered — ${BLOCKED}`), out.join("\n"));
  });
});
