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
const { TG_GROUPS_FORGET_FILE, parseTgForgets } = await import("./tg-groups/forget-file");
const { HELD_GROUPS_FILE, takeHeldGroupUpdates } = await import("./held-groups");

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
  for (const f of ["settings.json", "telegram.json", "grant.json", "restore-blocked.json", "tg-groups-forget.json", "telegram-held-groups.json"]) {
    rmSync(path.join(HOME, f), { force: true });
  }
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

describe("a hold that names no cause is a retry, not a broken book", () => {
  // A dropped connection or a timed-out statement during the restore names
  // none of the book's rules. The owner used to be told their practice book
  // "couldn't be restored" and to start it over, and a reset asked for is
  // honoured even when the book would have restored a pass later.
  const RETRYING =
    /^I'm not trading right now: I couldn't load your practice book just now, and I'm trying again\. Nothing was traded or lost\. \/link still works\.$/;

  it("A LIVE MESSAGE, A LATE ONE AND A NEW LINK ARE ALL TOLD IT IS RETRYING, with no reset offered", async () => {
    writeRestoreBlocked(HOME, {
      reason: "Connection terminated unexpectedly",
      class: restoreBlockClass("Connection terminated unexpectedly"),
      since: Math.floor(T0 / 1000) - 30,
      // The owner's settings would let a reset be honoured: it is the class, not this, that withholds it.
      resettable: true,
    });
    await withHold(async (h) => {
      await h.advance(600);
      const code = h.code();
      h.queue.push(text(1, OWNER, "/status", nowSec() - 3_600));
      await h.advance(1_000);
      h.queue.push(text(2, OWNER, "hey"), text(3, STRANGER, `/link ${code}`));
      await h.advance(1_000);
      const said = [...h.sentTo(OWNER), ...h.sentTo(STRANGER)];
      assert.equal(said.length, 3, said.join("\n"));
      assert.match(h.sentTo(OWNER)[0]!, RETRYING, "the late one");
      assert.match(h.sentTo(OWNER)[1]!, RETRYING, "the live one");
      assert.match(h.sentTo(STRANGER)[0]!, /^🏹 you're linked/);
      for (const s of said) {
        assert.doesNotMatch(s, /Start over|start practice over|couldn't be restored|team has been alerted/, s);
      }
    });
  });

  it("an unreadable hold record is the same retry", async () => {
    writeFileSync(path.join(HOME, "restore-blocked.json"), "{ not json");
    await withHold(async (h) => {
      h.queue.push(text(1, OWNER, "hey"));
      await h.advance(1_000);
      assert.match(h.sentTo(OWNER)[0]!, RETRYING);
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

describe("Telegram groups are not answered while trading is held", () => {
  const GROUP = -1001234567890;
  const inGroup = (id: number, from: number, t: string, date = nowSec()): Update => ({
    update_id: id,
    message: {
      message_id: 500 + id,
      text: t,
      date,
      chat: { id: GROUP, type: "supergroup", title: "frens" },
      from: { id: from, is_bot: false, first_name: "Ann" },
    },
  });
  const added = (id: number, by: number): Update => ({
    update_id: id,
    my_chat_member: {
      chat: { id: GROUP, type: "supergroup", title: "frens" },
      from: { id: by, is_bot: false, first_name: "Cat" },
      date: nowSec(),
      old_chat_member: { status: "left" },
      new_chat_member: { status: "member" },
    },
  });
  const joined = (id: number): Update => ({
    update_id: id,
    message: {
      message_id: 500 + id,
      date: nowSec(),
      chat: { id: GROUP, type: "supergroup", title: "frens" },
      from: { id: STRANGER, is_bot: false, first_name: "Cat" },
      new_chat_members: [{ id: 31337, is_bot: false, first_name: "Zed" }],
    },
  });

  it("nothing is said in a group, nothing links it and nothing runs, the owner's lines included; membership and joins are passed over", async () => {
    await withHold(async (h) => {
      await h.advance(600);
      const code = h.code();
      h.queue.push(
        inGroup(1, STRANGER, "hey merryman"),
        inGroup(2, STRANGER, "/link WRONG1"),
        inGroup(3, STRANGER, "/start"),
        inGroup(4, OWNER, "/status"),
        inGroup(5, OWNER, "/kill"),
        inGroup(6, OWNER, "/confirm"),
        added(7, STRANGER),
        joined(8),
        // Late as well as live: a group gets nothing either way.
        inGroup(9, STRANGER, "/link WRONG2", nowSec() - 20 * 3_600),
      );
      await h.advance(1_000);
      assert.deepEqual(h.sentTo(GROUP), [], "no refusal, no hold text, no late-code prompt in the room");
      assert.deepEqual(h.sentTo(OWNER), [], "and nothing to the owner: nothing happened");
      assert.deepEqual(h.sentTo(STRANGER), []);
      assert.equal(killRequested(HOME), false, "a /kill typed in a group is not this process's to run");
      assert.equal(h.code(), code, "a wrong code typed in a group is never compared or counted");
      const settings = JSON.parse(readFileSync(path.join(HOME, "settings.json"), "utf8")) as { telegramAllowlist: number[] };
      assert.deepEqual(settings.telegramAllowlist, [OWNER], "a group is never linked");
      const tg = JSON.parse(readFileSync(path.join(HOME, "telegram.json"), "utf8")) as { offset: number; linkedChats: number[] };
      assert.deepEqual(tg.linkedChats, []);
      assert.equal(tg.offset, 10, "every update is passed, membership and service messages included");
      assert.ok(!h.notes.some((m) => /refused|failed/.test(m)), "and no stranger tally for a room");
      // The stranger's add is kept for the child, which asks the owner about
      // it when trading resumes; the join and the lines are not.
      const kept = takeHeldGroupUpdates(HOME);
      assert.deepEqual(
        kept.map((e) => e.kind),
        ["member"],
      );
    });
  });

  it("A /forgetme WHILE HELD IS WRITTEN DOWN, late or live, and so is the owner's /forget; nothing is said", async () => {
    writeFileSync(path.join(HOME, "telegram.json"), JSON.stringify({ ownerId: OWNER }));
    await withHold(async (h) => {
      await h.advance(600);
      h.queue.push(
        inGroup(1, STRANGER, "/forgetme"),
        inGroup(2, OWNER, "/forget@heldbot"),
        // Someone else's /forget is not theirs to give, another bot's
        // /forgetme is that bot's, and a bot's line is nobody's.
        inGroup(3, 555, "/forget"),
        inGroup(4, 556, "/forgetme@otherbot"),
        {
          update_id: 5,
          message: { message_id: 505, text: "/forgetme", date: nowSec(), chat: { id: GROUP, type: "supergroup" }, from: { id: 558, is_bot: true, first_name: "B" } },
        },
        // Every /forgetme wipes, whenever it was typed.
        inGroup(6, 557, "/forgetme", nowSec() - 20 * 3_600),
      );
      await h.advance(1_000);
      const ops = parseTgForgets(readFileSync(path.join(HOME, TG_GROUPS_FORGET_FILE), "utf8"));
      assert.deepEqual(
        ops.map((o) => `${o.chatId}:${o.userId}`).sort(),
        [`${GROUP}:${STRANGER}`, `${GROUP}:*`, `${GROUP}:557`].sort(),
      );
      assert.ok(ops.every((o) => o.atMs >= T0 && o.atMs <= Date.now()), "stamped when it was handled, which erases all it said before");
      assert.deepEqual(h.sentTo(GROUP), [], "nothing said in the room");
      assert.deepEqual(h.sentTo(OWNER), []);
      assert.deepEqual(h.sentTo(STRANGER), []);
    });
  });

  it("the bot's membership, a migration and its own removal are kept for the child; joins and others' leaves are not", async () => {
    await withHold(async (h) => {
      const service = (id: number, extra: Record<string, unknown>): Update => ({
        update_id: id,
        message: { message_id: 500 + id, date: nowSec(), chat: { id: GROUP, type: "supergroup", title: "frens" }, from: { id: STRANGER, is_bot: false, first_name: "Cat" }, ...extra },
      });
      h.queue.push(
        added(1, STRANGER),
        joined(2),
        service(3, { left_chat_member: { id: 31337, is_bot: false, first_name: "Zed" } }),
        service(4, { migrate_to_chat_id: -1009999999999 }),
        service(5, { left_chat_member: { id: 111, is_bot: true, first_name: "held" } }),
        inGroup(6, STRANGER, "hey merryman"),
      );
      await h.advance(1_000);
      assert.equal(existsSync(path.join(HOME, HELD_GROUPS_FILE)), true);
      const kept = takeHeldGroupUpdates(HOME);
      assert.deepEqual(
        kept.map((e) => (e.kind === "service" ? `service:${e.service.migrateToChatId ?? e.service.leftChatMember?.id}` : e.kind)),
        ["member", "service:-1009999999999", "service:111"],
      );
      assert.ok(kept.every((e) => e.bot === "111"), "tied to the bot the token names");
      const member = kept[0]!;
      assert.ok(member.kind === "member" && member.member.fromId === STRANGER && member.member.newStatus === "member");
      assert.ok(!JSON.stringify(kept).includes("Cat") && !JSON.stringify(kept).includes("Zed"), "no names kept");
      assert.equal(existsSync(path.join(HOME, HELD_GROUPS_FILE)), false, "taken once");
      assert.deepEqual(h.sentTo(GROUP), []);
    });
  });

  it("THE OWNER'S STAY, LEAVE OR FORGET IS KEPT, NEVER CALLED EXPIRED: the question asked before the hold still stands", async () => {
    writeFileSync(path.join(HOME, "telegram.json"), JSON.stringify({ ownerId: OWNER }));
    await withHold(async (h) => {
      await h.advance(600);
      const asked = nowSec() - 20 * 3_600;
      const groupPress = (id: number, from: number, data: string): Update => ({
        update_id: id,
        callback_query: { id: `cb${id}`, data, from: { id: from }, message: { message_id: 40 + id, chat: { id: from }, date: asked } },
      });
      h.queue.push(
        groupPress(1, OWNER, `tgg:stay:${GROUP}`),
        groupPress(2, OWNER, "tgg:forget:-1005555555555"),
        groupPress(3, STRANGER, `tgg:leave:${GROUP}`),
      );
      await h.advance(1_000);
      assert.deepEqual(h.answers(), [
        "Got it — I'll do that as soon as trading resumes.",
        "Got it — I'll do that as soon as trading resumes.",
        "Only my owner can do that.",
      ]);
      assert.deepEqual(h.sentTo(OWNER), [], "a toast, not the hold text: nothing is wrong with the button");
      const kept = takeHeldGroupUpdates(HOME);
      assert.deepEqual(
        kept.map((e) => (e.kind === "press" ? `${e.press.fromId}:${e.press.chatId}:${e.press.messageId}:${e.press.data}` : e.kind)),
        [`${OWNER}:${OWNER}:41:tgg:stay:${GROUP}`, `${OWNER}:${OWNER}:42:tgg:forget:-1005555555555`],
        "the owner's two, for the child to carry out; not the stranger's",
      );
      // A Forget is written down at once too, so the stored copy is wiped
      // within a mirror pass whatever happens to the hold.
      const ops = parseTgForgets(readFileSync(path.join(HOME, TG_GROUPS_FORGET_FILE), "utf8"));
      assert.deepEqual(
        ops.map((o) => `${o.chatId}:${o.userId}`),
        ["-1005555555555:*"],
      );
    });
  });

  it("the live code typed in a group is replaced, and only the owner is told, in their DM", async () => {
    writeFileSync(path.join(HOME, "telegram.json"), JSON.stringify({ ownerId: OWNER }));
    await withHold(async (h) => {
      await h.advance(600);
      const code = h.code();
      h.queue.push(inGroup(1, STRANGER, `/link ${code}`));
      await h.advance(1_000);
      assert.notEqual(h.code(), code, "everyone in the room has seen it, and a held bot answers /link");
      assert.deepEqual(h.sentTo(GROUP), []);
      assert.equal(h.sentTo(OWNER).length, 1);
      assert.match(h.sentTo(OWNER)[0]!, /link code got posted in a group/);
      // Whoever read it in the room can no longer use it.
      h.queue.push(text(2, STRANGER, `/link ${code}`));
      await h.advance(1_000);
      assert.match(h.sentTo(STRANGER)[0]!, /^couldn't link/);
      const settings = JSON.parse(readFileSync(path.join(HOME, "settings.json"), "utf8")) as { telegramAllowlist: number[] };
      assert.deepEqual(settings.telegramAllowlist, [OWNER]);
    });
  });

  it("a press in a group gets the plain expiry, never the hold text", async () => {
    await withHold(async (h) => {
      h.queue.push({
        update_id: 1,
        callback_query: { id: "cb1", data: "mm:y:abcdefghjk", from: { id: OWNER }, message: { message_id: 9, chat: { id: GROUP }, date: nowSec() } },
      });
      await h.advance(1_000);
      assert.deepEqual(h.answers(), ["That button has expired."]);
      assert.deepEqual(h.sentTo(GROUP), []);
      assert.deepEqual(h.sentTo(OWNER), []);
    });
  });
});
