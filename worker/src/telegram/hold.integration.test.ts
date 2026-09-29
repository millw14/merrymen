/**
 * THE BOT KEEPS ANSWERING WHILE TRADING IS HELD.
 *
 * A paper tenant whose practice book cannot be restored is not started, and
 * the trading child was the only process that polled the owner's bot, so the
 * bot went silent for days. The orchestrator now runs a hold process instead
 * (telegram/hold.ts). This drives the real one: its real poll loop over a
 * scripted globalThis.fetch and a mocked clock, the real settings.json,
 * telegram.json, restore-blocked.json and grant.json in a temporary
 * MERRYMEN_HOME, the real link.ts and the real hosted kill path. The harness
 * pattern is energy-alert-redeploy.integration.test.ts's and backlog's.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-hold-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.MERRYMEN_SETTINGS_FILE;
delete process.env.MERRYMEN_GRANT_FILE;
after(() => rmSync(HOME, { recursive: true, force: true }));

const { startHoldTelegram } = await import("./hold");
const { createStateRef } = await import("./state");
const { resolveConfig } = await import("../settings");
const { killRequested } = await import("../kill-request");
const { writeRestoreBlocked, restoreBlockClass } = await import("../restore-block");

const T0 = Date.parse("2026-09-28T12:00:00Z");
const TOKEN = "111:secret";
const OWNER = 4242;
const STRANGER = 777;
/** The 0x516164 row the plan cites, as a raw restore error: figures an owner must never see. */
const REASON =
  "invalid paper checkpoint: NVDA basis 71971347499786536 raw disagrees with 0.07197134749978654 shares at multiplier 1.0007751591646306";
const CLASS = restoreBlockClass(REASON);
const HOLD = /^I'm not trading right now: your practice book couldn't be restored after a server update \(cost basis and holdings disagree\)\. Nothing was traded or lost, and the team has been alerted\. You can wait for a fix, or start practice over: restart the practice book in the app \(on the web, Wallet → Start over, then sign again\)\. \/link still works\.$/;
const REFUSED = new RegExp(`^🚫 not authorized — your chat id is ${STRANGER}\\.`);
const LOCKED = /too many wrong codes from this chat — try again in about \d+ min/;

interface Call {
  method: string;
  body: Record<string, unknown>;
}
type Update = Record<string, unknown> & { update_id: number };

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const nowSec = () => Math.floor(Date.now() / 1000);
const text = (id: number, chat: number, t: string, date = nowSec()): Update => ({
  update_id: id,
  message: { text: t, date, chat: { id: chat }, from: { id: chat } },
});
const press = (id: number, chat: number): Update => ({
  update_id: id,
  callback_query: { id: `cb${id}`, data: "mm:y:abcdefghjk", from: { id: chat }, message: { message_id: 9, chat: { id: chat }, date: nowSec() } },
});

function writeSettings(over: Record<string, unknown> = {}): void {
  writeFileSync(
    path.join(HOME, "settings.json"),
    JSON.stringify({ telegramEnabled: true, telegramBotToken: TOKEN, telegramAllowlist: [OWNER], telegramControlEnabled: true, ...over }),
  );
}

interface Harness {
  calls: Call[];
  /** Updates Telegram is holding for the bot; getUpdates hands over those at or past the offset. */
  queue: Update[];
  sentTo: (chat: number) => string[];
  answers: () => string[];
  notes: string[];
  advance: (ms: number) => Promise<void>;
  code: () => string;
}

async function withHold(body: (h: Harness) => Promise<void>): Promise<void> {
  const calls: Call[] = [];
  const queue: Update[] = [];
  const notes: string[] = [];
  const realFetch = globalThis.fetch;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const m = /\/bot([^/]+)\/(\w+)$/.exec(String(url));
    assert.ok(m, `unexpected url ${String(url)}`);
    const call: Call = { method: m[2]!, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} };
    calls.push(call);
    let result: unknown = true;
    if (call.method === "getMe") result = { id: 111, username: "heldbot" };
    if (call.method === "getUpdates") result = queue.filter((u) => u.update_id >= Number(call.body.offset));
    if (call.method === "sendMessage") result = { message_id: calls.length };
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  }) as typeof fetch;
  const stateRef = createStateRef();
  const svc = startHoldTelegram({ getCfg: () => resolveConfig(), stateRef, note: (_l, m) => notes.push(m) });
  const h: Harness = {
    calls,
    queue,
    notes,
    sentTo: (chat) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chat).map((c) => String(c.body.text)),
    answers: () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.body.text)),
    advance: async (ms) => {
      for (let t = 0; t < ms; t += 250) {
        mock.timers.tick(Math.min(250, ms - t));
        await settle();
      }
    },
    code: () => stateRef.get().linkCode,
  };
  try {
    await settle();
    await body(h);
  } finally {
    svc.stop();
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
}

beforeEach(() => {
  for (const f of ["settings.json", "telegram.json", "grant.json", "restore-blocked.json"]) rmSync(path.join(HOME, f), { force: true });
  for (const f of readdirSync(HOME)) if (f.startsWith("kill-request-")) rmSync(path.join(HOME, f), { force: true });
  writeSettings();
  writeRestoreBlocked(HOME, { reason: REASON, class: CLASS, since: Math.floor(T0 / 1000) - 3_600, resettable: true });
  writeFileSync(
    path.join(HOME, "grant.json"),
    JSON.stringify({ smartAccount: "0x00000000000000000000000000000000000000c7", serialized: "eyJ-held-grant", grantedAt: 1 }),
  );
});

describe("an allowlisted owner is told trading is held", () => {
  it("\"hey\", /status and /help each get the hold text, with the class and no figure from the book", async () => {
    await withHold(async (h) => {
      h.queue.push(text(1, OWNER, "hey"), text(2, OWNER, "/status"), text(3, OWNER, "/help"));
      await h.advance(1_000);
      const said = h.sentTo(OWNER);
      assert.equal(said.length, 3, said.join("\n"));
      for (const s of said) assert.match(s, HOLD);
      for (const s of said) {
        for (const figure of ["71971347499786536", "0.0719", "1.00077", "NVDA"]) {
          assert.ok(!s.includes(figure), `a restore figure reached the chat: ${s}`);
        }
        assert.ok(!/\d/.test(s), `no digit at all reaches the owner: ${s}`);
      }
    });
  });

  it("an owner the practice reset would be refused for is not told to press it, and is told again once it would not be", async () => {
    await withHold(async (h) => {
      // The orchestrator writes `resettable` from the owner's settings
      // (live switched on beside practice, here), and the hold reads it per reply.
      writeRestoreBlocked(HOME, { reason: REASON, class: CLASS, since: Math.floor(T0 / 1000) - 3_600, resettable: false });
      h.queue.push(text(1, OWNER, "hey"));
      await h.advance(1_000);
      const [refused] = h.sentTo(OWNER);
      assert.doesNotMatch(refused!, /Start over|start practice over/);
      assert.match(refused!, /You don't need to do anything\. \/link still works\.$/);
      writeRestoreBlocked(HOME, { reason: REASON, class: CLASS, since: Math.floor(T0 / 1000) - 3_600, resettable: true });
      h.queue.push(text(2, OWNER, "hey"));
      await h.advance(1_000);
      assert.match(h.sentTo(OWNER)[1]!, HOLD);
    });
  });

  it("a button press is answered, so it stops spinning, and does nothing", async () => {
    await withHold(async (h) => {
      h.queue.push(press(1, OWNER), press(2, STRANGER));
      await h.advance(1_000);
      assert.deepEqual(h.answers(), ["I'm not trading right now — nothing was done.", "Not authorized."]);
      assert.equal(h.sentTo(OWNER).length, 1);
      assert.match(h.sentTo(OWNER)[0]!, HOLD);
      assert.deepEqual(h.sentTo(STRANGER), [], "a stranger's press is answered and nothing more");
    });
  });
});

describe("a stranger is treated as the child treats one", () => {
  it("\"hey\" gets the refusal, with the chat id and where the code is", async () => {
    await withHold(async (h) => {
      h.queue.push(text(1, STRANGER, "hey"), text(2, STRANGER, "/status"));
      await h.advance(1_000);
      const said = h.sentTo(STRANGER);
      assert.equal(said.length, 2);
      for (const s of said) assert.match(s, REFUSED);
      assert.ok(!said.some((s) => /trading|practice/.test(s)), "and learns nothing about the agent");
    });
  });

  it("/link with the current code links: settings.json, linkedChats, a new code, and the hold text", async () => {
    await withHold(async (h) => {
      await h.advance(600); // the first poll mints and saves the code
      const code = h.code();
      assert.match(code, /^[A-Z2-9]{6}$/);
      h.queue.push(text(1, STRANGER, `/link ${code}`), text(2, STRANGER, "hey"));
      await h.advance(1_000);
      const said = h.sentTo(STRANGER);
      assert.match(said[0]!, /^🏹 you're linked/);
      assert.match(said[0]!, /I'm not trading right now/);
      const settings = JSON.parse(readFileSync(path.join(HOME, "settings.json"), "utf8")) as { telegramAllowlist: number[] };
      assert.deepEqual(settings.telegramAllowlist.sort(), [STRANGER, OWNER].sort(), "the allowlist the gate reads");
      const tg = JSON.parse(readFileSync(path.join(HOME, "telegram.json"), "utf8")) as { linkedChats: number[]; linkCode: string };
      assert.deepEqual(tg.linkedChats, [STRANGER], "the record the orchestrator promotes");
      assert.notEqual(tg.linkCode, code, "the code is spent");
      assert.match(said[1]!, HOLD, "and the next message is an owner's");
    });
  });

  it("a deep link, /start <code>, links the same way", async () => {
    await withHold(async (h) => {
      await h.advance(600);
      h.queue.push(text(1, STRANGER, `/start ${h.code()}`));
      await h.advance(1_000);
      assert.match(h.sentTo(STRANGER)[0]!, /^🏹 you're linked/);
    });
  });

  it("five live wrong codes lock the chat: the right one then gets \"too many\"", async () => {
    await withHold(async (h) => {
      await h.advance(600);
      const code = h.code();
      for (let i = 1; i <= 5; i++) h.queue.push(text(i, STRANGER, "/link WRONG1"));
      h.queue.push(text(6, STRANGER, `/link ${code}`));
      await h.advance(1_000);
      const said = h.sentTo(STRANGER);
      assert.equal(said.length, 6);
      assert.match(said[5]!, LOCKED);
      assert.equal(h.code(), code, "the code was never spent");
    });
  });
});

describe("the owner can always revoke", () => {
  it("/kill then /confirm leaves the hosted kill request and drops the key", async () => {
    await withHold(async (h) => {
      h.queue.push(text(1, OWNER, "/kill"));
      await h.advance(1_000);
      assert.match(h.sentTo(OWNER)[0]!, /confirm kill/);
      assert.equal(killRequested(HOME), false, "asking is not killing");
      h.queue.push(text(2, OWNER, "/confirm"));
      await h.advance(1_000);
      assert.equal(killRequested(HOME), true, "the request the orchestrator carries to the store");
      assert.equal(existsSync(path.join(HOME, "grant.json")), false, "and this home's copy of the key is gone");
      assert.match(h.sentTo(OWNER)[1]!, /KILL SWITCH — this agent's copy of the key is gone/);
    });
  });

  it("with control switched off, /kill is refused as the child refuses it", async () => {
    writeSettings({ telegramControlEnabled: false });
    await withHold(async (h) => {
      h.queue.push(text(1, OWNER, "/kill"), text(2, OWNER, "/confirm"));
      await h.advance(1_000);
      assert.match(h.sentTo(OWNER)[0]!, /control commands are turned off/);
      assert.match(h.sentTo(OWNER)[1]!, HOLD, "and there is nothing parked to confirm");
      assert.equal(killRequested(HOME), false);
    });
  });

  it("a stranger's /kill and /confirm are refusals", async () => {
    await withHold(async (h) => {
      h.queue.push(text(1, STRANGER, "/kill"), text(2, STRANGER, "/confirm"));
      await h.advance(1_000);
      for (const s of h.sentTo(STRANGER)) assert.match(s, REFUSED);
      assert.equal(killRequested(HOME), false);
    });
  });
});

describe("a backlog is held back by the child's rules", () => {
  it("a stale current code is never used, and a stale owner hears the hold once", async () => {
    await withHold(async (h) => {
      await h.advance(600);
      const code = h.code();
      const stale = nowSec() - 20 * 3_600;
      h.queue.push(
        text(1, STRANGER, `/link ${code}`, stale),
        text(2, STRANGER, `/link ${code}`, stale),
        text(3, OWNER, "hey", stale),
        text(4, OWNER, "/status", stale),
      );
      await h.advance(1_000);
      assert.deepEqual(h.sentTo(STRANGER), [
        "that code reached me after I'd been offline, so I didn't use it — send the code shown in Settings → Telegram now.",
      ]);
      assert.equal(h.code(), code, "not compared, not spent");
      assert.equal(h.sentTo(OWNER).length, 1);
      assert.match(h.sentTo(OWNER)[0]!, HOLD);
      // Saved before each ran: nothing is asked for again.
      const tg = JSON.parse(readFileSync(path.join(HOME, "telegram.json"), "utf8")) as { offset: number };
      assert.equal(tg.offset, 5);
    });
  });
});

describe("what the hold process leaves for the dashboard and the log", () => {
  it("RECORDS ITS POLLS AS THE CHILD DOES, so a held bot that answers reads as heard", async () => {
    // The orchestrator publishes this record for held tenants too (plan §1.4),
    // and watches it for a bot nobody hears.
    await withHold(async (h) => {
      await h.advance(1_000);
      const onDisk = JSON.parse(readFileSync(path.join(HOME, "telegram.json"), "utf8")) as { poll?: unknown };
      assert.deepEqual(onDisk.poll, { okAt: Math.floor(T0 / 1000), err: null, errAt: null, botId: "111" });
    });
  });

  it("counts a stranger's messages and wrong codes, with the chat cut to its last digits", async () => {
    await withHold(async (h) => {
      h.queue.push(text(1, 123456789, "hi"), text(2, 123456789, "/link WRONG1"));
      await h.advance(1_000);
      assert.deepEqual(
        h.notes.filter((m) => m.includes("…6789")),
        [
          "Telegram: message from unlisted chat …6789 refused (1 so far)",
          "Telegram: /link from chat …6789 failed (wrong code) — 1 so far",
        ],
      );
      assert.ok(!h.notes.some((m) => m.includes("123456789")));
    });
  });
});
