/**
 * What the hold process passes over in Telegram groups, kept for the child
 * (held-groups.ts): the file on its own, then the child taking it through the
 * real poll service. The hold's side (what it keeps, and what it tells the
 * owner) is in hold.integration.test.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { resolveConfig, type ResolvedConfig } from "../settings";
import type { TgMemberUpdate } from "./api";
import { GROUP_PRESS_RE, HELD_GROUPS_FILE, HELD_GROUPS_MAX, keepHeldGroupUpdate, takeHeldGroupUpdates, type HeldGroupEntry } from "./held-groups";
import { startTelegram } from "./service";
import { loadTelegramState, type TelegramState } from "./state";
import { TgGroupsStore, emptyTgGroupsState } from "./tg-groups/store";

const BOT = "123456";
const OWNER = 424242;
const STRANGER = 717171;
const BOB = 818181;

const member = (chatId: number, over: Partial<TgMemberUpdate> = {}): TgMemberUpdate => ({
  updateId: 1,
  chatId,
  chatType: "supergroup",
  chatTitle: "frens",
  fromId: STRANGER,
  fromUsername: "cat",
  fromFirstName: "Cat",
  oldStatus: "left",
  newStatus: "member",
  dateSec: 1_790_000_000,
  ...over,
});

describe("held-groups.ts: the file the hold keeps and the child takes", () => {
  let home: string;
  before(() => {
    home = mkdtempSync(path.join(tmpdir(), "held-groups-"));
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  it("keeps an entry for the child, private to the home, and the child takes it once", () => {
    assert.equal(keepHeldGroupUpdate(home, { bot: BOT, kind: "member", member: member(-1001) }), true);
    const file = path.join(home, HELD_GROUPS_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const taken = takeHeldGroupUpdates(home);
    assert.equal(taken.length, 1);
    assert.equal(existsSync(file), false, "removed before anything is replayed: at most once");
    assert.deepEqual(takeHeldGroupUpdates(home), []);
  });

  it("keeps only what the group handler reads: no names, no joins, no one else's buttons", () => {
    const e = { bot: BOT, kind: "member", member: member(-1002) } as const;
    keepHeldGroupUpdate(home, e);
    const service = { updateId: 2, chatId: -1002, chatType: "supergroup", messageId: 9, dateSec: 1, fromId: STRANGER } as const;
    assert.equal(
      keepHeldGroupUpdate(home, { bot: BOT, kind: "service", service: { ...service, newChatMembers: [{ id: 5, isBot: false, firstName: "Zed" }] } }),
      false,
      "a join is not kept: a late one gets no welcome",
    );
    assert.equal(keepHeldGroupUpdate(home, { bot: BOT, kind: "service", service: { ...service, migrateToChatId: -1003 } }), true);
    assert.equal(
      keepHeldGroupUpdate(home, { bot: BOT, kind: "press", press: { chatId: OWNER, fromId: OWNER, messageId: 3, data: "mm:y:abcdefghjk", date: 1 } }),
      false,
      "only a Stay, Leave or Forget",
    );
    assert.equal(keepHeldGroupUpdate(home, { bot: "not-a-bot", kind: "member", member: member(-1002) }), false);
    const taken = takeHeldGroupUpdates(home);
    assert.deepEqual(
      taken.map((t) => t.kind),
      ["member", "service"],
    );
    const kept = taken[0]!;
    assert.ok(kept.kind === "member");
    assert.equal(kept.member.fromId, STRANGER, "who added it is what the handler needs");
    assert.ok(!("fromUsername" in kept.member) && !("fromFirstName" in kept.member), "their name is not");
    assert.ok(taken[1]!.kind === "service" && !("fromId" in taken[1]!.service));
  });

  it("keeps the newest HELD_GROUPS_MAX", () => {
    for (let i = 0; i < HELD_GROUPS_MAX + 5; i++) keepHeldGroupUpdate(home, { bot: BOT, kind: "member", member: member(-2000 - i, { updateId: i }) });
    const taken = takeHeldGroupUpdates(home);
    assert.equal(taken.length, HELD_GROUPS_MAX);
    assert.ok(taken[0]!.kind === "member" && taken[0]!.member.updateId === 5);
  });

  it("reads a press by the pattern the group handler asks with", () => {
    const handler = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "tg-groups", "handler.ts"), "utf8");
    const asked = /\nconst CB_RE = \/(.+)\/;\n/.exec(handler)?.[1];
    assert.equal(asked, GROUP_PRESS_RE.source);
  });

  it("a file it did not write is taken as nothing, and removed", () => {
    writeFileSync(path.join(home, HELD_GROUPS_FILE), "{not json");
    assert.deepEqual(takeHeldGroupUpdates(home), []);
    assert.equal(existsSync(path.join(home, HELD_GROUPS_FILE)), false);
    writeFileSync(path.join(home, HELD_GROUPS_FILE), JSON.stringify({ version: 1, entries: [{ bot: BOT, kind: "member", member: { chatId: "x" } }] }));
    assert.deepEqual(takeHeldGroupUpdates(home), []);
  });
});

/**
 * THE CHILD THAT ENDS A HOLD APPLIES WHAT THE HOLD KEPT, at its first poll,
 * through the real poll service and group handler, before anything newer.
 */
describe("the child takes what the hold kept, through the poll service", () => {
  const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);
  const NEWCOMER = -1001111111111;
  const OLD = -2222222;
  const MIGRATED = -1002222222222;
  const GONE = -1003333333333;
  const ASKED = -1004444444444;
  const OTHER_BOTS = -1005555555555;
  const TOKEN = `${BOT}:SECRET-TOKEN-XYZ`;

  let home: string;
  let store: TgGroupsStore;
  let stop: () => void;
  let tstate: TelegramState;
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const batches: unknown[][] = [];
  const saved: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;

  const waitFor = async (pred: () => boolean, ms = 6_000): Promise<void> => {
    const until = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > until) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 15));
    }
  };

  before(async () => {
    for (const k of ["MERRYMEN_HOME", "MERRYMEN_SETTINGS_FILE", "MERRYMEN_HOSTED", "MERRYMEN_TG_GROUPS_LLM_KEY"]) saved[k] = process.env[k];
    home = mkdtempSync(path.join(tmpdir(), "held-groups-child-"));
    process.env.MERRYMEN_HOME = home;
    process.env.MERRYMEN_SETTINGS_FILE = path.join(home, "settings.json");
    delete process.env.MERRYMEN_HOSTED;
    delete process.env.MERRYMEN_TG_GROUPS_LLM_KEY;
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (!u.startsWith("https://api.telegram.org/")) throw new Error("no network in tests");
      const method = u.split("/").pop() ?? "";
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ method, body });
      let result: unknown = true;
      if (method === "getMe") result = { id: Number(BOT), is_bot: true, first_name: "Pine", username: "pinebot", can_read_all_group_messages: true };
      else if (method === "getUpdates") {
        const b = batches.shift();
        if (!b) await new Promise((r) => setTimeout(r, 20));
        result = b ?? [];
      } else if (method === "sendMessage") result = { message_id: 90_000 + calls.length };
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }) as never;

    // What the last child left: a group about to become a supergroup, one the
    // bot is about to be removed from, and a stranger's group the owner was
    // asked about 20 hours before the hold began.
    let clock = T0;
    store = new TgGroupsStore(path.join(home, "tg-groups.json"), emptyTgGroupsState(), { now: () => clock, debounceMs: 60_000 });
    store.ensureRoom(OLD, { title: "old frens", kind: "group" }, { owner: true });
    store.setStatus(OLD, "approved", OWNER);
    store.addLine(OLD, { messageId: 1, fromId: BOB, name: "Bob", text: "gm", atMs: T0 - 60_000 });
    store.ensureRoom(GONE, { title: "gone", kind: "supergroup" }, { owner: true });
    store.setStatus(GONE, "approved", OWNER);
    store.ensureRoom(ASKED, { title: "asked", kind: "supergroup" });
    store.setStatus(ASKED, "pending", STRANGER);
    store.update(ASKED, (r) => {
      r.askedOwnerAtMs = T0 - 50 * 3_600_000;
    });
    clock = T0 + 30 * 3_600_000;

    // What the hold kept, over the 30 hours it lasted.
    const kept: HeldGroupEntry[] = [
      { bot: BOT, kind: "press", press: { chatId: OWNER, fromId: OWNER, messageId: 77, data: `tgg:stay:${ASKED}`, date: Math.floor((T0 - 50 * 3_600_000) / 1000) } },
      { bot: BOT, kind: "member", member: member(NEWCOMER, { chatTitle: "newcomer" }) },
      { bot: BOT, kind: "service", service: { updateId: 3, chatId: OLD, chatType: "group", messageId: 8, dateSec: 1, migrateToChatId: MIGRATED } },
      { bot: BOT, kind: "service", service: { updateId: 4, chatId: GONE, chatType: "supergroup", messageId: 9, dateSec: 1, leftChatMember: { id: Number(BOT), isBot: true } } },
      // Another bot's: this agent was switched onto this one since.
      { bot: "999", kind: "member", member: member(OTHER_BOTS) },
    ];
    for (const e of kept) assert.equal(keepHeldGroupUpdate(home, e), true);

    tstate = { ...loadTelegramState(), ownerId: OWNER };
    const cfg = {
      ...resolveConfig(),
      telegramEnabled: true,
      telegramBotToken: TOKEN,
      telegramAllowlist: [OWNER],
      telegramControlEnabled: true,
      groqApiKey: undefined,
      anthropicApiKey: undefined,
      llmApiKey: undefined,
      llmProvider: undefined,
      telegramGroupsEnabled: true,
      telegramGroupCoinsEnabled: false,
      telegramGroupsChattiness: "normal",
    } as ResolvedConfig;
    const h = startTelegram({
      getCfg: () => cfg,
      stateRef: {
        get: () => tstate,
        set: (s) => {
          tstate = s;
        },
      },
      note: () => {},
      buildStatusContext: () => ({
        agentId: null,
        name: "Pine",
        strategy: "basket",
        venue: "test",
        paused: false,
        workerAliveSec: 0,
        grant: null,
        chainId: null,
        telegramMaxActionUsdg: 10,
      }),
      setStrategy: () => ({ ok: false, reason: "test" }),
      grantPerTradeUsdg: () => undefined,
      grantHasTransfer: () => false,
      readDepth: async () => "",
      submitTrade: async () => "refused in tests",
      submitTransfer: async () => "refused in tests",
      kill: () => ({ ok: false }) as never,
      tgGroupsStore: store,
      heldGroupUpdates: () => takeHeldGroupUpdates(home),
      tgGroupsTest: { now: () => clock, rand: () => 0.99, sleep: async () => {}, env: {}, log: () => {} },
      now: () => Math.floor(clock / 1000),
    });
    stop = h.stop;
    await waitFor(() => calls.filter((c) => c.method === "getUpdates").length >= 2);
  });

  after(() => {
    stop?.();
    globalThis.fetch = realFetch;
    store.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  const sendsTo = (chatId: number) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);

  it("the file is taken at the first poll", () => {
    assert.equal(existsSync(path.join(home, HELD_GROUPS_FILE)), false);
  });

  it("A STRANGER'S ADD WHILE HELD IS A STRANGER'S ADD: pending, the owner asked the stranger's question, and its own 24 hours from now", async () => {
    await waitFor(() => sendsTo(OWNER).some((c) => /newcomer/.test(String(c.body.text))));
    const room = store.room(NEWCOMER);
    assert.equal(room?.status, "pending");
    assert.equal(room?.addedById, STRANGER, "the adder on file, so the 24-hour leave applies");
    assert.equal(room?.askedOwnerAtMs, T0 + 30 * 3_600_000, "the clock starts when the owner can answer");
    const ask = sendsTo(OWNER).find((c) => /newcomer/.test(String(c.body.text)))!;
    assert.match(String(ask.body.text), /^someone added me to/);
    assert.deepEqual(sendsTo(NEWCOMER), [], "and nothing said in the group");
  });

  it("a supergroup migration while held keeps the group's memory, under its new id", () => {
    assert.equal(store.room(OLD), undefined);
    assert.equal(store.room(MIGRATED)?.status, "approved");
    assert.deepEqual(
      store.room(MIGRATED)?.lines.map((l) => l.text),
      ["gm"],
    );
  });

  it("a removal while held is recorded, so its 30 days begin", () => {
    assert.equal(store.room(GONE)?.status, "left");
  });

  it("THE OWNER'S STAY PRESSED WHILE HELD IS CARRIED OUT, before any sweep could leave the group; the long-gone query is not answered", async () => {
    assert.equal(store.room(ASKED)?.status, "approved");
    await waitFor(() => calls.some((c) => c.method === "editMessageText" && c.body.message_id === 77));
    const edit = calls.find((c) => c.method === "editMessageText" && c.body.message_id === 77)!;
    assert.equal(edit.body.chat_id, OWNER);
    assert.match(String(edit.body.text), /Staying in/);
    assert.equal(calls.filter((c) => c.method === "answerCallbackQuery").length, 0);
  });

  it("another bot's entries are not this bot's to apply", () => {
    assert.equal(store.room(OTHER_BOTS), undefined);
  });
});
