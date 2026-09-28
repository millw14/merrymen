/**
 * The Telegram groups handler (docs/tg-groups.md), against the real store in a
 * temp dir, a fake Bot API transport that records every call, a fake coin
 * port, a fake clock (every wait advances it instead of sleeping) and, where a
 * test needs one, a fake model behind the real gate.
 *
 * What these pin:
 *   - which groups it talks in, and the owner's Stay / Leave / Forget buttons;
 *   - that nothing is said or remembered where it may not be (a room that is
 *     not approved, groups switched off, the operator's switch);
 *   - that an answer is a Telegram reply, in the topic, after a typing action,
 *     and that its books (flood, roasts, greetings, ambient) are kept only
 *     after it lands;
 *   - shush, roasts and their cap, the 🤡, the kind line, greetings, welcomes;
 *   - bursts, staleness, 429 pauses and supergroup migration on send;
 *   - the coin flow's lines: tags built by code, one reply per message;
 *   - /forget, /forgetme, /groups and the command notices;
 *   - that no log line or model prompt carries ids, the token or message text
 *     where it must not, and that no method throws.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ResolvedConfig } from "../../settings";
import type { FetchLike, TgCallback, TgMemberUpdate, TgMessage, TgServiceMessage } from "../api";
import type { StateRef, TelegramState } from "../state";
import type { BotSelf } from "./detect";
import { createTgGroups, type TgGroups, type TgGroupsDeps } from "./handler";
import { __resetMemoryPassThrottleForTest } from "./memory";
import { TgGroupsStore, emptyTgGroupsState } from "./store";
import type { CoinLook, CoinOutcome, NominateResult, Nomination, TgCoinsPort, TrencherReadiness } from "./types";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const CHAT = -1001234567890;
const NEW_CHAT = -1009999999999;
const OTHER = -1005555555555;
const OWNER = 424242;
const ANN = 717171;
const BOB = 818181;
const TOKEN = "123456:SECRET-TOKEN-XYZ";
const BOT: BotSelf = { id: 999999, username: "pinebot", name: "Pine" };
const ca = (n: number) => "0x" + n.toString(16).padStart(4, "0").repeat(10);
const CA1 = ca(0xa1);

// ─── A fake Bot API ──────────────────────────────────────────────────────────

interface Call {
  method: string;
  body: Record<string, unknown>;
}

class FakeTg {
  calls: Call[] = [];
  private nextId = 5_000;
  /** Scripted envelopes per method, used in order before the default. */
  script = new Map<string, unknown[]>();

  fetchFn: FetchLike = async (url, init) => {
    const method = url.split("/").pop() ?? "";
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    this.calls.push({ method, body });
    const env = (this.script.get(method)?.shift() ?? this.defaultFor(method)) as { ok?: boolean; error_code?: number };
    return { ok: env.ok === true, status: env.ok === true ? 200 : (env.error_code ?? 400), json: async () => env };
  };

  private defaultFor(method: string): unknown {
    if (method === "sendMessage") return { ok: true, result: { message_id: this.nextId++ } };
    return { ok: true, result: true };
  }

  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
  sends(chatId?: number): Call[] {
    return this.of("sendMessage").filter((c) => chatId === undefined || c.body.chat_id === chatId);
  }
  texts(chatId?: number): string[] {
    return this.sends(chatId).map((c) => String(c.body.text));
  }
  reactions(chatId?: number): string[] {
    return this.of("setMessageReaction")
      .filter((c) => chatId === undefined || c.body.chat_id === chatId)
      .map((c) => ((c.body.reaction as Array<{ emoji: string }>)[0]?.emoji ?? ""));
  }
}

class FakePort implements TgCoinsPort {
  ready: TrencherReadiness = { kind: "ready-paper", ownerReason: "Trencher mode is ready." };
  looks = new Map<string, CoinLook>();
  nominations: Nomination[] = [];
  results: NominateResult[] = [];
  held: string[] = [];
  live = false;
  subs = new Set<(o: CoinOutcome) => void>();
  readiness(): TrencherReadiness {
    return this.ready;
  }
  async look(address: string): Promise<CoinLook> {
    return this.looks.get(address) ?? { kind: "candidate", name: "Froggy" };
  }
  nominate(n: Nomination): NominateResult {
    this.nominations.push({ ...n });
    return this.results.shift() ?? { ok: true };
  }
  onOutcome(cb: (o: CoinOutcome) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  emit(o: CoinOutcome): void {
    for (const cb of [...this.subs]) cb(o);
  }
  heldNames(): string[] {
    return this.held;
  }
  mode(): "paper" | "live" {
    return this.live ? "live" : "paper";
  }
}

// ─── The harness ─────────────────────────────────────────────────────────────

let home: string;
let clock: number;
let store: TgGroupsStore;
let tg: FakeTg;
let port: FakePort;
let tstate: TelegramState;
let cfg: Record<string, unknown>;
let envVars: Record<string, string | undefined>;
let privacy: boolean | null;
let self: BotSelf | null;
let notes: string[];
let logs: string[];
let dice: () => number;
let onSleep: ((ms: number) => void) | null;
let groups: TgGroups;
let nextMsg: number;
const realFetch = globalThis.fetch;

const stateRef: StateRef = {
  get: () => tstate,
  set: (s) => {
    tstate = s;
  },
};

function make(over: Partial<TgGroupsDeps> = {}): TgGroups {
  groups = createTgGroups({
    opts: () => ({ token: TOKEN, fetchFn: tg.fetchFn }),
    store,
    getCfg: () => cfg as unknown as ResolvedConfig,
    stateRef,
    port: () => port,
    self: () => self,
    privacyOff: () => privacy,
    note: (level, m) => notes.push(`${level}:${m}`),
    dashboardBase: () => "https://app.test",
    agentKey: () => "agent-1",
    now: () => clock,
    rand: () => dice(),
    env: envVars,
    hosted: true,
    sleep: async (ms) => {
      clock += Math.max(0, ms);
      onSleep?.(ms);
    },
    log: (s) => logs.push(s),
    ...over,
  });
  return groups;
}

function approveRoom(chatId = CHAT, title = "frens"): void {
  store.ensureRoom(chatId, { title, kind: "supergroup" });
  store.setStatus(chatId, "approved", OWNER);
  store.update(chatId, (r) => {
    r.helloSaid = true;
  });
}

function msg(text: string, over: Partial<TgMessage> = {}): TgMessage {
  const id = nextMsg++;
  return {
    updateId: id,
    chatId: CHAT,
    fromId: ANN,
    fromFirstName: "Ann",
    fromIsBot: false,
    text,
    messageId: id,
    dateSec: Math.floor(clock / 1000),
    chatType: "supergroup",
    chatTitle: "frens",
    ...over,
  };
}

function member(over: Partial<TgMemberUpdate> = {}): TgMemberUpdate {
  return {
    updateId: nextMsg++,
    chatId: CHAT,
    chatType: "supergroup",
    chatTitle: "frens",
    fromId: OWNER,
    fromFirstName: "Mike",
    oldStatus: "left",
    newStatus: "member",
    dateSec: Math.floor(clock / 1000),
    ...over,
  };
}

function press(data: string, over: Partial<TgCallback> = {}): TgCallback {
  return { updateId: nextMsg++, id: `cb${nextMsg}`, chatId: OWNER, fromId: OWNER, messageId: 77, data, ...over };
}

/** Say something and let everything it started finish. */
async function said(m: TgMessage): Promise<void> {
  groups.onMessage(m);
  await groups.drain();
}

const replyOf = (c: Call | undefined): number | undefined => (c?.body.reply_parameters as { message_id?: number } | undefined)?.message_id;

/** Lines from two other people a minute ago, so the chat reads as live. */
function liven(chatId = CHAT): void {
  store.addLine(chatId, { messageId: 1, fromId: BOB, name: "Bob", text: "what a day", atMs: clock - 2 * MIN });
  store.addLine(chatId, { messageId: 2, fromId: OWNER, name: "Mike", text: "fr", atMs: clock - MIN });
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "tg-handler-"));
  clock = T0;
  store = new TgGroupsStore(path.join(home, "tg-groups.json"), emptyTgGroupsState(), { now: () => clock, debounceMs: 60_000 });
  tg = new FakeTg();
  port = new FakePort();
  tstate = { ownerId: OWNER } as unknown as TelegramState;
  cfg = { telegramGroupsEnabled: true, telegramGroupCoinsEnabled: true, telegramGroupsChattiness: "normal", telegramAllowlist: [OWNER] };
  envVars = {};
  privacy = true;
  self = { ...BOT };
  notes = [];
  logs = [];
  dice = () => 0.99;
  onSleep = null;
  nextMsg = 100;
  __resetMemoryPassThrottleForTest();
});

afterEach(async () => {
  groups?.stop();
  await groups?.drain();
  globalThis.fetch = realFetch;
  store.close();
  rmSync(home, { recursive: true, force: true });
});

// ─── A fake model behind the real gate ───────────────────────────────────────

const MODEL_ENV = {
  MERRYMEN_TG_GROUPS_LLM_KEY: "k-test",
  MERRYMEN_TG_GROUPS_LLM_PROVIDER: "openai",
  MERRYMEN_TG_GROUPS_LLM_BASE_URL: "https://llm.test/v1",
  MERRYMEN_TG_GROUPS_MODEL: "fake",
};

/** Answer every model call with `reply()`, recording each prompt. */
function fakeModel(reply: () => string): Array<{ system: string; prompt: string }> {
  envVars = { ...MODEL_ENV };
  const seen: Array<{ system: string; prompt: string }> = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    assert.ok(String(url).startsWith("https://llm.test/"), "only the fake model is reached through global fetch");
    const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    seen.push({ system: body.messages[0]?.content ?? "", prompt: body.messages[1]?.content ?? "" });
    return { ok: true, json: async () => ({ choices: [{ message: { content: reply() } }] }) };
  }) as never;
  return seen;
}

// ─── Which groups it talks in ────────────────────────────────────────────────

describe("membership", () => {
  it("added by the owner: approved, one hello (not a reply), and the privacy steps DM'd once when privacy mode is on", async () => {
    privacy = false;
    make();
    groups.onMember(member());
    await groups.drain();
    const room = store.room(CHAT);
    assert.equal(room?.status, "approved");
    assert.equal(room?.addedById, OWNER);
    assert.equal(room?.helloSaid, true);
    const hello = tg.sends(CHAT);
    assert.equal(hello.length, 1);
    assert.match(String(hello[0]?.body.text), /Pine/);
    assert.match(String(hello[0]?.body.text), /lurk/);
    assert.equal(hello[0]?.body.reply_parameters, undefined);
    // Typing first, like a person.
    const typing = tg.calls.findIndex((c) => c.method === "sendChatAction");
    assert.ok(typing >= 0 && typing < tg.calls.indexOf(hello[0]!));
    const dm = tg.sends(OWNER);
    assert.equal(dm.length, 1);
    assert.match(String(dm[0]?.body.text), /BotFather/);
    assert.match(String(dm[0]?.body.text), /«frens»/);
    assert.equal(room?.privacyHintSent, true);

    // Promoted to admin by the owner later: no second hello, no second DM.
    groups.onMember(member({ oldStatus: "member", newStatus: "administrator" }));
    await groups.drain();
    assert.equal(tg.sends(CHAT).length, 1);
    assert.equal(tg.sends(OWNER).length, 1);
    assert.ok(notes.some((n) => /added to a group by the owner/.test(n)));
    assert.ok(!notes.some((n) => n.includes("frens")), "the feed never carries a group's title");
  });

  it("no privacy DM when getMe says privacy is off, or cannot say", async () => {
    for (const p of [true, null]) {
      privacy = p;
      make();
      groups.onMember(member({ chatId: p ? CHAT : OTHER }));
      await groups.drain();
      groups.stop();
    }
    assert.equal(tg.sends(OWNER).length, 0);
  });

  it("added by a stranger: pending, silent in the group, one DM with Stay / Leave", async () => {
    make();
    groups.onMember(member({ fromId: BOB, fromFirstName: "Bob" }));
    await groups.drain();
    assert.equal(store.room(CHAT)?.status, "pending");
    assert.equal(store.room(CHAT)?.addedById, BOB);
    assert.equal(tg.sends(CHAT).length, 0);
    const dm = tg.sends(OWNER);
    assert.equal(dm.length, 1);
    assert.equal(dm[0]?.body.text, "someone added me to «frens». want me to hang out there?");
    assert.deepEqual(dm[0]?.body.reply_markup, {
      inline_keyboard: [
        [
          { text: "Stay", callback_data: `tgg:stay:${CHAT}` },
          { text: "Leave", callback_data: `tgg:leave:${CHAT}` },
        ],
      ],
    });
    assert.equal(store.room(CHAT)?.askedOwnerAtMs, T0);

    // A line in a pending room is neither answered nor remembered.
    await said(msg("@pinebot hello?"));
    assert.equal(tg.sends(CHAT).length, 0);
    assert.equal(store.room(CHAT)?.lines.length, 0);

    // The sweep does not ask twice.
    await groups.sweep();
    assert.equal(tg.sends(OWNER).length, 1);
  });

  it("never linked: pending and silent, nobody to ask", async () => {
    tstate = { ownerId: null } as unknown as TelegramState;
    make();
    groups.onMember(member({ fromId: BOB }));
    await groups.drain();
    await groups.sweep();
    assert.equal(store.room(CHAT)?.status, "pending");
    assert.equal(tg.calls.filter((c) => c.method === "sendMessage").length, 0);
  });

  it("Stay from the owner in their DM approves and says hello; the question becomes its answer", async () => {
    make();
    groups.onMember(member({ fromId: BOB }));
    await groups.drain();
    assert.equal(await groups.onCallback(press(`tgg:stay:${CHAT}`)), true);
    await groups.drain();
    assert.equal(store.room(CHAT)?.status, "approved");
    assert.equal(tg.sends(CHAT).length, 1, "the hello");
    assert.deepEqual(tg.of("answerCallbackQuery").map((c) => c.body.text), ["Staying"]);
    const edit = tg.of("editMessageText")[0];
    assert.equal(edit?.body.chat_id, OWNER);
    assert.equal(edit?.body.message_id, 77);
    assert.match(String(edit?.body.text), /Staying in «frens»/);
  });

  it("a press from anyone but the owner, or from the owner outside their DM, decides nothing and is still answered", async () => {
    make();
    groups.onMember(member({ fromId: BOB }));
    await groups.drain();
    for (const cb of [press(`tgg:stay:${CHAT}`, { fromId: BOB, chatId: BOB }), press(`tgg:stay:${CHAT}`, { chatId: CHAT })]) {
      assert.equal(await groups.onCallback(cb), true);
    }
    assert.equal(store.room(CHAT)?.status, "pending");
    assert.deepEqual(tg.of("answerCallbackQuery").map((c) => c.body.text), ["Only my owner can do that.", "Only my owner can do that."]);
    // Not ours: left for the service.
    assert.equal(await groups.onCallback(press("cf:y:abc")), false);
    // Ours but malformed: answered, nothing done.
    assert.equal(await groups.onCallback(press("tgg:stay:abc")), true);
  });

  it("Leave: leaveChat, blocked; a stranger adding it back is undone without asking again", async () => {
    make();
    groups.onMember(member({ fromId: BOB }));
    await groups.drain();
    await groups.onCallback(press(`tgg:leave:${CHAT}`));
    assert.deepEqual(tg.of("leaveChat").map((c) => c.body.chat_id), [CHAT]);
    assert.equal(store.room(CHAT)?.status, "blocked");
    // Our own leave arriving back keeps it blocked.
    groups.onMember(member({ fromId: BOT.id, oldStatus: "member", newStatus: "left" }));
    assert.equal(store.room(CHAT)?.status, "blocked");
    groups.onMember(member({ fromId: BOB }));
    await groups.drain();
    assert.equal(tg.of("leaveChat").length, 2);
    assert.equal(store.room(CHAT)?.status, "blocked");
    assert.equal(tg.sends(OWNER).length, 1, "no second question");
    // The owner adding it back overrides their own no.
    groups.onMember(member());
    await groups.drain();
    assert.equal(store.room(CHAT)?.status, "approved");
  });

  it("no answer within 24 h: it leaves on its own", async () => {
    make();
    groups.onMember(member({ fromId: BOB }));
    await groups.drain();
    clock = T0 + 23 * HOUR;
    await groups.sweep();
    assert.equal(tg.of("leaveChat").length, 0);
    clock = T0 + 24 * HOUR;
    await groups.sweep();
    assert.deepEqual(tg.of("leaveChat").map((c) => c.body.chat_id), [CHAT]);
    assert.equal(store.room(CHAT)?.status, "blocked");
  });

  it("a Stay/Leave DM that did not go out does not start the 24 h clock", async () => {
    tg.script.set("sendMessage", [{ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }]);
    make();
    groups.onMember(member({ fromId: BOB }));
    await groups.drain();
    assert.equal(store.room(CHAT)?.askedOwnerAtMs, undefined);
    clock = T0 + 30 * HOUR;
    await groups.sweep();
    assert.equal(tg.of("leaveChat").length, 0, "never left over a question nobody received");
    assert.equal(store.room(CHAT)?.askedOwnerAtMs, clock, "asked again once the retry window passed");
  });

  it("removed or kicked: left, memory kept; the service's left_chat_member says the same", async () => {
    make();
    approveRoom();
    store.addLine(CHAT, { messageId: 1, fromId: ANN, name: "Ann", text: "hi", atMs: clock });
    groups.onMember(member({ fromId: BOB, oldStatus: "member", newStatus: "kicked" }));
    assert.equal(store.room(CHAT)?.status, "left");
    assert.equal(store.room(CHAT)?.lines.length, 1);
    assert.equal(store.room(CHAT)?.helloSaid, undefined, "a re-add says hello again");

    approveRoom(OTHER);
    groups.onService({ updateId: 1, chatId: OTHER, chatType: "supergroup", messageId: 3, dateSec: 1, leftChatMember: { id: BOT.id, isBot: true } });
    assert.equal(store.room(OTHER)?.status, "left");
  });

  it("a negative id on the allowlist is approved on first sight", async () => {
    cfg.telegramAllowlist = [OWNER, CHAT];
    make();
    await said(msg("morning all"));
    assert.equal(store.room(CHAT)?.status, "approved");
    assert.equal(store.room(CHAT)?.lines.length, 1);
  });

  it("a group first seen through a line (added before this feature) is pending, and the owner is asked", async () => {
    make();
    await said(msg("hey"));
    assert.equal(store.room(CHAT)?.status, "pending");
    await groups.sweep();
    assert.equal(tg.sends(OWNER).length, 1);
  });

  it("the operator switch: membership is recorded, nothing is said, asked or remembered", async () => {
    envVars = { MERRYMEN_TG_GROUPS: "0" };
    privacy = false;
    make();
    groups.onMember(member());
    groups.onMember(member({ chatId: OTHER, fromId: BOB }));
    await groups.drain();
    await groups.sweep();
    assert.equal(store.room(CHAT)?.status, "approved");
    assert.equal(store.room(OTHER)?.status, "pending");
    await said(msg("@pinebot hi"));
    assert.equal(store.room(CHAT)?.lines.length, 0);
    assert.equal(tg.calls.filter((c) => c.method !== "getUpdates").length, 0, JSON.stringify(tg.calls.map((c) => c.method)));
  });

  it("groups switched off in Settings: silent, nothing remembered, membership still recorded", async () => {
    cfg.telegramGroupsEnabled = false;
    make();
    groups.onMember(member());
    await groups.drain();
    assert.equal(store.room(CHAT)?.status, "approved");
    await said(msg("@pinebot hi"));
    assert.equal(store.room(CHAT)?.lines.length, 0);
    assert.equal(tg.sends().length, 0);
  });
});

// ─── Lines ───────────────────────────────────────────────────────────────────

describe("answering", () => {
  it("an @mention gets a reply: typing in the topic, reply_parameters, then its own line remembered", async () => {
    make();
    approveRoom();
    const m = msg("@pinebot what do you think", { isTopicMessage: true, messageThreadId: 77 });
    await said(m);
    const s = tg.sends(CHAT);
    assert.equal(s.length, 1);
    assert.equal(replyOf(s[0]), m.messageId);
    assert.equal(s[0]?.body.message_thread_id, 77);
    assert.equal(s[0]?.body.parse_mode, "HTML");
    assert.deepEqual(s[0]?.body.link_preview_options, { is_disabled: true });
    const typing = tg.of("sendChatAction")[0];
    assert.equal(typing?.body.message_thread_id, 77);
    assert.ok(clock - T0 >= 2 * SEC, "it waited like a person typing");
    const room = store.room(CHAT)!;
    const own = room.lines.filter((l) => l.own);
    assert.equal(own.length, 1);
    assert.equal(own[0]?.replyTo, m.messageId);
    assert.equal(own[0]?.fromId, BOT.id);
    assert.equal(room.people.find((p) => p.id === ANN)?.answers?.count, 1);
    assert.equal(typeof room.lastOwnAtMs, "number");
  });

  it("a reply to its own message and its name are addressed too", async () => {
    make();
    approveRoom();
    await said(msg("fair", { replyTo: { messageId: 55, fromId: BOT.id, fromIsBot: true } }));
    await said(msg("pine what's up"));
    assert.equal(tg.sends(CHAT).length, 2);
  });

  it("another bot's line is ignored and not remembered; an anonymous admin is a person", async () => {
    make();
    approveRoom();
    await said(msg("@pinebot hi", { fromId: 5555, fromIsBot: true, fromFirstName: "Scanner" }));
    assert.equal(tg.sends().length, 0);
    assert.equal(store.room(CHAT)?.lines.length, 0);
    const anon = msg("@pinebot hi", { fromId: 1087968824, fromIsBot: true, senderChatId: CHAT, fromFirstName: "Group" });
    await said(anon);
    assert.equal(tg.sends(CHAT).length, 1);
    assert.equal(replyOf(tg.sends(CHAT)[0]), anon.messageId);
  });

  it("a redelivered update is remembered once and answered once", async () => {
    make();
    approveRoom();
    const m = msg("@pinebot hi");
    await said(m);
    await said({ ...m });
    assert.equal(tg.sends(CHAT).length, 1);
  });

  it("slash commands are the service's, and voice notes with no text are ignored", async () => {
    make();
    approveRoom();
    await said(msg("/status@pinebot"));
    await said(msg("", { voiceFileId: "f1" }));
    assert.equal(tg.sends().length, 0);
    assert.equal(store.room(CHAT)?.lines.length, 0);
  });

  it("the owner's first name is learned from their own lines, and a private DM never happens", async () => {
    make();
    approveRoom();
    await said(msg("hey everyone", { fromId: OWNER, fromFirstName: "Mike" }));
    assert.equal(store.room(CHAT)?.ownerName, "Mike");
    // Someone else's name is never taken for the owner's.
    await said(msg("hey", { fromFirstName: "Impostor" }));
    assert.equal(store.room(CHAT)?.ownerName, "Mike");
  });

  it("a burst of mentions gets one answer, to the last one", async () => {
    make();
    approveRoom();
    const a = msg("@pinebot yo");
    const b = msg("@pinebot helloooo");
    const c = msg("@pinebot answer me");
    groups.onMessage(a);
    groups.onMessage(b);
    groups.onMessage(c);
    await groups.drain();
    const s = tg.sends(CHAT);
    assert.equal(s.length, 1);
    assert.equal(replyOf(s[0]), c.messageId);
  });

  it("flood: after three answers to one person in two minutes, the fourth call is skipped", async () => {
    make();
    approveRoom();
    for (const t of ["@pinebot one", "@pinebot two", "@pinebot three", "@pinebot four"]) await said(msg(t));
    assert.equal(tg.sends(CHAT).length, 3);
  });

  it("an answer that waited longer than 90 s is dropped", async () => {
    make();
    approveRoom();
    // Typing takes the fake clock past the staleness window before the send.
    groups.onMessage(msg("@pinebot hi"));
    clock += 91 * SEC;
    await groups.drain();
    assert.equal(tg.sends(CHAT).length, 0);
  });
});

describe("shush, banter and kindness", () => {
  it("shush: 'ok ok 🤐' as a reply, quiet 30 min for everyone but the owner calling it", async () => {
    make();
    approveRoom();
    const m = msg("@pinebot shut up");
    await said(m);
    assert.equal(tg.texts(CHAT)[0], "ok ok 🤐");
    assert.equal(replyOf(tg.sends(CHAT)[0]), m.messageId);
    const until = store.room(CHAT)?.shushedUntilMs ?? 0;
    assert.ok(until >= T0 + 30 * MIN && until < T0 + 31 * MIN);
    await said(msg("@pinebot you there?", { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(tg.sends(CHAT).length, 1);
    await said(msg("@pinebot you there?", { fromId: OWNER, fromFirstName: "Mike" }));
    assert.equal(tg.sends(CHAT).length, 2, "the owner still gets an answer");
  });

  it("the owner's shush lasts 2 h, and a 🙈 can stand in for the words", async () => {
    make();
    approveRoom();
    dice = () => 0.1; // under the 🙈 odds
    await said(msg("@pinebot shush", { fromId: OWNER, fromFirstName: "Mike" }));
    assert.deepEqual(tg.reactions(CHAT), ["🙈"]);
    assert.equal(tg.sends(CHAT).length, 0);
    assert.ok((store.room(CHAT)?.shushedUntilMs ?? 0) >= T0 + 2 * HOUR);
  });

  it("an insult gets a roast, twice per person per 30 min; then silence (or a 🥱)", async () => {
    make();
    approveRoom();
    for (const t of ["@pinebot you're an idiot", "@pinebot you're so dumb"]) await said(msg(t));
    assert.equal(tg.sends(CHAT).length, 2);
    assert.equal(store.room(CHAT)?.people.find((p) => p.id === ANN)?.roasts?.count, 2);
    clock += 3 * MIN; // out of the flood window, inside the roast one
    await said(msg("@pinebot you're useless"));
    assert.equal(tg.sends(CHAT).length, 2, "past the cap with dice that roll no 🥱: silence");
    dice = () => 0.3;
    await said(msg("@pinebot you're trash"));
    assert.deepEqual(tg.reactions(CHAT), ["🥱"]);
    // Half an hour later the window is fresh.
    clock += 31 * MIN;
    dice = () => 0.99;
    await said(msg("@pinebot you're a clown"));
    assert.equal(tg.sends(CHAT).length, 3);
  });

  it("the owner's tease gets an affectionate roast", async () => {
    make();
    approveRoom();
    await said(msg("@pinebot you're so slow lol", { fromId: OWNER, fromFirstName: "Mike" }));
    assert.equal(tg.texts(CHAT)[0], "rude. i trade for you 😤");
  });

  it("a hateful line gets a 🤡 and no words", async () => {
    make();
    approveRoom();
    await said(msg("@pinebot kys"));
    assert.deepEqual(tg.reactions(CHAT), ["🤡"]);
    assert.equal(tg.sends(CHAT).length, 0);
    assert.equal(store.room(CHAT)?.ambient, undefined, "an answer in emoji is not an ambient reaction");
  });

  it("distress: a short kind line, once an hour", async () => {
    make();
    approveRoom();
    await said(msg("i just lost everything"));
    assert.equal(tg.sends(CHAT).length, 1);
    assert.match(tg.texts(CHAT)[0] ?? "", /heavy|rough|alone|sorry|hard/);
    await said(msg("i just lost everything man"));
    assert.equal(tg.sends(CHAT).length, 1);
  });

  it("distress asked of the room is not held back like an ordinary question", async () => {
    make();
    approveRoom();
    await said(msg("anyone else want to die after this dump?"));
    assert.equal(tg.sends(CHAT).length, 1);
    assert.ok(clock - T0 < MIN, "the kind line did not wait out the question delay");
  });

  it("gm: sometimes answered once per person per day, counted as an ambient line", async () => {
    make();
    approveRoom();
    dice = () => 0.1;
    const g = msg("gm fam");
    await said(g);
    assert.equal(tg.sends(CHAT).length, 1);
    assert.equal(replyOf(tg.sends(CHAT)[0]), g.messageId);
    const room = store.room(CHAT)!;
    assert.equal(room.people.find((p) => p.id === ANN)?.greetedDay, "2026-09-28");
    assert.equal(room.ambient?.n, 1);
    await said(msg("gm again"));
    assert.equal(tg.sends(CHAT).length, 1, "once per person per day");
  });
});

describe("joining in", () => {
  it("with a model: an ambient line after a person's reading pause, not a reply, counted; then the cooldown holds", async () => {
    const prompts = fakeModel(() => "ngl this chart is fun to watch");
    cfg.telegramGroupsChattiness = "chatty";
    make();
    approveRoom();
    liven();
    dice = () => 0.01;
    await said(msg("this chart is wild today"));
    const s = tg.sends(CHAT);
    assert.equal(s.length, 1);
    assert.equal(s[0]?.body.text, "ngl this chart is fun to watch");
    assert.equal(s[0]?.body.reply_parameters, undefined);
    assert.ok(clock - T0 >= 5 * SEC + 2 * SEC, "reading pause plus typing");
    const room = store.room(CHAT)!;
    assert.equal(room.ambient?.n, 1);
    assert.equal(typeof room.lastAmbientAtMs, "number");
    assert.equal(prompts.length, 1);

    // Inside the cooldown: no second line (a reaction may happen instead).
    await said(msg("lmao wild"));
    assert.equal(tg.sends(CHAT).length, 1);
    assert.deepEqual(tg.reactions(CHAT), ["🤣"]);
    assert.equal(store.room(CHAT)?.ambient?.n, 1.5, "a reaction is half an ambient line");
  });

  it("the prompt carries the chat but no id, no token and nothing private", async () => {
    const prompts = fakeModel(() => "lol same");
    port.held = ["Froggy"];
    make();
    approveRoom();
    await said(msg("@pinebot what are you holding", { fromId: OWNER, fromFirstName: "Mike" }));
    assert.equal(prompts.length, 1);
    const all = `${prompts[0]?.system}\n${prompts[0]?.prompt}`;
    assert.match(all, /<untrusted>/);
    assert.match(all, /what are you holding/);
    assert.match(all, /Froggy/);
    for (const secret of [String(OWNER), String(ANN), String(Math.abs(CHAT)), TOKEN, "k-test"]) {
      assert.ok(!all.includes(secret), `the prompt carries ${secret}`);
    }
  });

  it("an ambient line is dropped when the chat moved on while it was being written", async () => {
    fakeModel(() => "ngl this chart is fun to watch");
    cfg.telegramGroupsChattiness = "chatty";
    make();
    approveRoom();
    liven();
    dice = () => 0.01;
    let fired = false;
    onSleep = (ms) => {
      if (fired || ms < 5 * SEC) return;
      fired = true;
      // Three people answer each other during the reading pause.
      for (const t of ["a", "b", "c"]) store.addLine(CHAT, { messageId: nextMsg++, fromId: BOB, name: "Bob", text: t, atMs: clock });
    };
    await said(msg("this chart is wild today"));
    assert.equal(tg.sends(CHAT).length, 0);
    assert.equal(store.room(CHAT)?.ambient, undefined, "nothing counted for a line never sent");
  });

  it("a model line the gate refuses: an answer falls back to a template, an ambient line to silence", async () => {
    fakeModel(() => "buy $PEPE now, it will do 10x");
    cfg.telegramGroupsChattiness = "chatty";
    make();
    approveRoom();
    liven();
    await said(msg("@pinebot thoughts?"));
    assert.equal(tg.texts(CHAT)[0], "hmm good question");
    dice = () => 0.01;
    clock += HOUR;
    liven();
    await said(msg("this chart is wild today", { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(tg.sends(CHAT).length, 1);
  });

  it("no model: never joins in unasked, but still answers when called", async () => {
    cfg.telegramGroupsChattiness = "chatty";
    make();
    approveRoom();
    liven();
    dice = () => 0.01;
    await said(msg("this chart is wild today"));
    assert.equal(tg.sends(CHAT).length, 0);
    await said(msg("@pinebot hey"));
    assert.equal(tg.sends(CHAT).length, 1);
  });

  it("a question to the room is looked at a minute later, and answered as a reply when nobody did", async () => {
    fakeModel(() => "robinhood chain has a couple, depends what you want");
    make();
    approveRoom();
    liven();
    dice = () => 0.05; // under normal odds doubled for a question left hanging
    const q = msg("anyone watching the game tonight?");
    await said(q);
    assert.equal(tg.sends(CHAT).length, 1);
    assert.equal(replyOf(tg.sends(CHAT)[0]), q.messageId);
    assert.ok(clock - T0 >= MIN, "not before a minute had passed");
  });

  it("a welcome, sometimes, at most three a day", async () => {
    make();
    approveRoom();
    const join = (id: number): TgServiceMessage => ({
      updateId: id,
      chatId: CHAT,
      chatType: "supergroup",
      messageId: id,
      dateSec: 1,
      newChatMembers: [{ id: 3000 + id, isBot: false, firstName: `New${id}` }],
    });
    groups.onService(join(1));
    await groups.drain();
    assert.equal(tg.sends(CHAT).length, 0, "dice above 25%: no welcome");
    dice = () => 0.1;
    for (const id of [2, 3, 4, 5]) {
      groups.onService(join(id));
      await groups.drain();
    }
    assert.equal(tg.sends(CHAT).length, 3);
    assert.equal(replyOf(tg.sends(CHAT)[0]), 2);
    assert.equal(store.room(CHAT)?.welcomes?.n, 3);
    // A bot joining is never welcomed.
    groups.onService({ ...join(9), newChatMembers: [{ id: 1, isBot: true, firstName: "Bot" }] });
    await groups.drain();
    assert.equal(tg.sends(CHAT).length, 3);
  });
});

// ─── Flood control and migration ─────────────────────────────────────────────

describe("sending", () => {
  it("a 429 pauses group sends for retry_after, then the line goes out", async () => {
    tg.script.set("sendMessage", [{ ok: false, error_code: 429, description: "Too Many Requests: retry after 5", parameters: { retry_after: 5 } }]);
    make();
    approveRoom();
    await said(msg("@pinebot hi"));
    assert.equal(tg.sends(CHAT).length, 2);
    assert.ok(notes.some((n) => /slow down/.test(n)));
  });

  it("a long 429 pause makes a line stale: it is dropped, not sent late", async () => {
    tg.script.set("sendMessage", [{ ok: false, error_code: 429, description: "Too Many Requests: retry after 200", parameters: { retry_after: 200 } }]);
    make();
    approveRoom();
    await said(msg("@pinebot hi"));
    assert.equal(tg.sends(CHAT).length, 1);
  });

  it("a group that became a supergroup mid-send: state moves, the line goes to the new id without the old reply", async () => {
    tg.script.set("sendMessage", [{ ok: false, error_code: 400, description: "Bad Request: the group was upgraded to a supergroup", parameters: { migrate_to_chat_id: NEW_CHAT } }]);
    make();
    approveRoom();
    await said(msg("@pinebot hi"));
    const s = tg.sends();
    assert.equal(s.length, 2);
    assert.equal(s[1]?.body.chat_id, NEW_CHAT);
    assert.equal(s[1]?.body.reply_parameters, undefined);
    assert.equal(store.room(CHAT), undefined);
    assert.equal(store.room(NEW_CHAT)?.status, "approved");
    assert.ok(store.room(NEW_CHAT)?.lines.some((l) => l.own));
  });

  it("the migration notice moves the room too", async () => {
    make();
    approveRoom();
    groups.onService({ updateId: 1, chatId: CHAT, chatType: "group", messageId: 5, dateSec: 1, migrateToChatId: NEW_CHAT });
    assert.equal(store.room(CHAT), undefined);
    assert.equal(store.room(NEW_CHAT)?.status, "approved");
    // The twin notice in the new chat finds nothing left to move.
    groups.onService({ updateId: 2, chatId: NEW_CHAT, chatType: "supergroup", messageId: 1, dateSec: 1, migrateFromChatId: CHAT });
    assert.equal(store.room(NEW_CHAT)?.status, "approved");
  });

  it("at least 3 s between two lines to one chat", async () => {
    make();
    approveRoom();
    const at: number[] = [];
    const orig = tg.fetchFn;
    tg.fetchFn = async (url, init) => {
      if (url.endsWith("/sendMessage")) at.push(clock);
      return orig(url, init);
    };
    groups.onMessage(msg("@pinebot one", { fromId: ANN }));
    await groups.drain();
    groups.onMessage(msg("@pinebot two", { fromId: BOB, fromFirstName: "Bob" }));
    await groups.drain();
    assert.equal(at.length, 2);
    assert.ok((at[1] ?? 0) - (at[0] ?? 0) >= 3 * SEC);
  });
});

// ─── Coins ───────────────────────────────────────────────────────────────────

describe("coins", () => {
  it("ready: the ack tags the sender by code; bought on paper tags them again, no figure", async () => {
    make();
    approveRoom();
    const post = msg(`@pinebot look at ${CA1}`, { fromFirstName: "Ann <b>" });
    await said(post);
    assert.equal(port.nominations.length, 1);
    assert.deepEqual(port.nominations[0], { address: CA1, chatId: CHAT, messageId: post.messageId, senderId: ANN, atMs: post.dateSec! * 1000 });
    const ack = tg.sends(CHAT);
    assert.equal(ack.length, 1, "one reply to the post: the coin line, not an answer as well");
    assert.equal(replyOf(ack[0]), post.messageId);
    assert.match(String(ack[0]?.body.text), new RegExp(`^<a href="tg://user\\?id=${ANN}">Ann &lt;b&gt;</a> `));

    port.emit({ kind: "bought", address: CA1, chatId: CHAT, messageId: post.messageId!, paper: true, decisionId: "d1", notes: ["new buyers keep showing up"] });
    await groups.drain();
    const bought = tg.sends(CHAT)[1];
    assert.ok(bought);
    assert.equal(replyOf(bought), post.messageId, "an outcome replies to the post again, by design");
    const text = String(bought.body.text);
    assert.match(text, /^<a href="tg:\/\/user\?id=717171">/);
    const plain = text.replace(/^<a [^>]+>[^<]*<\/a> /, "");
    assert.match(plain, /paper|practice/);
    assert.ok(!/\d/.test(plain), plain);
  });

  it("passed: a fade line tagging the sender", async () => {
    make();
    approveRoom();
    const post = msg(CA1);
    await said(post);
    port.emit({ kind: "passed", address: CA1, chatId: CHAT, messageId: post.messageId!, decisionId: "d2", notes: [] });
    await groups.drain();
    const fade = tg.texts(CHAT)[1] ?? "";
    assert.match(fade, /^<a href="tg:\/\/user\?id=717171">Ann<\/a> nah i'll pass/);
  });

  it("an outcome survives a flood pause that would make an ordinary line stale", async () => {
    make();
    approveRoom();
    const post = msg(CA1);
    await said(post);
    tg.script.set("sendMessage", [{ ok: false, error_code: 429, description: "Too Many Requests: retry after 200", parameters: { retry_after: 200 } }]);
    port.emit({ kind: "skipped", address: CA1, chatId: CHAT, messageId: post.messageId! });
    await groups.drain();
    assert.equal(tg.sends(CHAT).length, 3, "the ack, the refused try, and the outcome after the pause");
  });

  it("not ready: the owner is tagged in the group, and DM'd the reason with a Settings button", async () => {
    port.ready = { kind: "off", ownerReason: "Trencher mode is off." };
    make();
    approveRoom();
    await said(msg("hey all", { fromId: OWNER, fromFirstName: "Mike" }));
    await said(msg(CA1));
    const line = tg.texts(CHAT)[0] ?? "";
    assert.match(line, new RegExp(`^<a href="tg://user\\?id=${OWNER}">Mike</a> .*trencher mode`));
    assert.ok(!/Trencher mode is off/.test(line), "never the reason in the group");
    const dm = tg.sends(OWNER)[0];
    assert.match(String(dm?.body.text), /Trencher mode is off/);
    assert.deepEqual(dm?.body.reply_markup, { inline_keyboard: [[{ text: "⚙️ Open Settings", url: "https://app.test/settings#trencher-mode" }]] });
  });

  it("coins switched off: a 👀 at most", async () => {
    cfg.telegramGroupCoinsEnabled = false;
    make();
    approveRoom();
    await said(msg(CA1));
    assert.deepEqual(tg.reactions(CHAT), ["👀"]);
    assert.equal(tg.sends(CHAT).length, 0);
    assert.equal(port.nominations.length, 0);
  });

  it("a faded coin hyped again: maybe one 'still not sold' line", async () => {
    make();
    approveRoom();
    store.rememberCoin(CHAT, { address: CA1, name: "Froggy", byId: BOB, byName: "Bob", messageId: 3, atMs: clock - HOUR, verdict: "passed" });
    dice = () => 0.05;
    const hype = msg("froggy is pumping again");
    await said(hype);
    assert.equal(tg.sends(CHAT).length, 1);
    assert.match(tg.texts(CHAT)[0] ?? "", /still/);
    assert.equal(replyOf(tg.sends(CHAT)[0]), hype.messageId);
    assert.deepEqual(tg.reactions(CHAT), [], "the line instead of the reaction pacing rolled, never both");
    await said(msg("froggy froggy froggy"));
    assert.equal(tg.sends(CHAT).length, 1, "once per coin per few hours");
  });
});

// ─── Forgetting, /groups, command notices ────────────────────────────────────

describe("forgetting and the owner's controls", () => {
  it("/forgetme: their lines and note go, their name leaves the coin memos and the summary, 'done 🫡'", async () => {
    make();
    approveRoom();
    await said(msg("hi all"));
    await said(msg("yo", { fromId: BOB, fromFirstName: "Bob" }));
    store.rememberCoin(CHAT, { address: CA1, byId: ANN, byName: "Ann", messageId: 3, atMs: clock, verdict: "passed" });
    store.update(CHAT, (r) => {
      r.summary = "Ann shills frogs. Bob is funny.";
    });
    await groups.forgetMe(CHAT, ANN, 900);
    const room = store.room(CHAT)!;
    assert.ok(!room.lines.some((l) => l.fromId === ANN));
    assert.ok(!room.people.some((p) => p.id === ANN));
    assert.ok(room.lines.some((l) => l.fromId === BOB));
    assert.equal(room.coins[0]?.byName, "");
    assert.equal(room.coins[0]?.byId, 0, "the user id names them as well as the name does");
    assert.equal(room.coins[0]?.verdict, "passed", "the coin and its verdict stay");
    assert.equal(room.summary, "");
    assert.equal(tg.texts(CHAT).at(-1), "done 🫡");
    assert.equal(replyOf(tg.sends(CHAT).at(-1)), 900);
  });

  it("/forgetme is honoured even where it may not speak", async () => {
    cfg.telegramGroupsEnabled = false;
    make();
    approveRoom();
    store.addLine(CHAT, { messageId: 1, fromId: ANN, name: "Ann", text: "hi", atMs: clock });
    await groups.forgetMe(CHAT, ANN);
    assert.equal(store.room(CHAT)?.lines.length, 0);
    assert.equal(tg.sends().length, 0);
  });

  it("/forget (owner): that chat's memory only, and a clean-slate line", async () => {
    make();
    approveRoom();
    approveRoom(OTHER, "others");
    store.addLine(CHAT, { messageId: 1, fromId: ANN, name: "Ann", text: "hi", atMs: clock });
    store.addLine(OTHER, { messageId: 1, fromId: ANN, name: "Ann", text: "hi", atMs: clock });
    groups.forgetChat(CHAT, 901);
    await groups.drain();
    assert.equal(store.room(CHAT)?.lines.filter((l) => !l.own).length, 0);
    assert.equal(store.room(OTHER)?.lines.length, 1);
    assert.equal(tg.texts(CHAT)[0], "done, clean slate 🫡");
    assert.equal(store.room(CHAT)?.status, "approved");
  });

  it("/groups lists every group with its buttons; a press re-renders the list", async () => {
    make();
    approveRoom(CHAT, "frens");
    store.ensureRoom(OTHER, { title: "strangers", kind: "supergroup" });
    await groups.groupsCommand(OWNER);
    const list = tg.sends(OWNER)[0];
    assert.match(String(list?.body.text), /1\. «strangers» — waiting for your ok\n2\. «frens» — talking there/);
    assert.deepEqual(list?.body.reply_markup, {
      inline_keyboard: [
        [
          { text: "1 · Stay", callback_data: `tgg:stay:${OTHER}` },
          { text: "1 · Leave", callback_data: `tgg:leave:${OTHER}` },
          { text: "1 · Forget", callback_data: `tgg:forget:${OTHER}` },
        ],
        [
          { text: "2 · Leave", callback_data: `tgg:leave:${CHAT}` },
          { text: "2 · Forget", callback_data: `tgg:forget:${CHAT}` },
        ],
      ],
    });
    const listId = 5_000; // the fake's first message id
    await groups.onCallback(press(`tgg:forget:${CHAT}`, { messageId: listId }));
    const edit = tg.of("editMessageText")[0];
    assert.equal(edit?.body.message_id, listId);
    assert.match(String(edit?.body.text), /Your Telegram groups/);
    assert.ok(edit?.body.reply_markup, "the buttons stay under a re-rendered list");
  });

  it("/groups with none, and with privacy mode on, says so", async () => {
    privacy = false;
    make();
    await groups.groupsCommand(OWNER);
    const text = String(tg.sends(OWNER)[0]?.body.text);
    assert.match(text, /not in any Telegram groups yet/);
    assert.match(text, /BotFather/);
  });

  it("command notices: 'sent it to your DMs', and refusals at most once per person per hour", async () => {
    make();
    approveRoom();
    await groups.commandNotice(CHAT, 10, OWNER, "dm-sent");
    await groups.commandNotice(CHAT, 11, BOB, "private-refused");
    await groups.commandNotice(CHAT, 12, BOB, "private-refused");
    await groups.commandNotice(CHAT, 13, BOB, "owner-only");
    await groups.commandNotice(CHAT, 14, BOB, "owner-only");
    const t = tg.texts(CHAT);
    assert.equal(t.length, 3);
    assert.equal(t[0], "sent it to your DMs 🤫");
    assert.match(t[1] ?? "", /my owner/);
    assert.match(t[2] ?? "", /owner/);
    clock += HOUR;
    await groups.commandNotice(CHAT, 15, BOB, "owner-only");
    assert.equal(tg.texts(CHAT).length, 4);
  });

  it("no notice in a room it does not talk in", async () => {
    make();
    store.ensureRoom(CHAT, { title: "x", kind: "supergroup" });
    await groups.commandNotice(CHAT, 10, BOB, "owner-only");
    assert.equal(tg.sends().length, 0);
  });
});

// ─── Hygiene ─────────────────────────────────────────────────────────────────

describe("hygiene", () => {
  it("no log or feed line carries message text, names, titles or the token", async () => {
    fakeModel(() => "lol");
    make();
    groups.onMember(member({ fromId: BOB }));
    await groups.onCallback(press(`tgg:stay:${CHAT}`));
    await said(msg("@pinebot my secret plan is xyzzy", { fromFirstName: "Zelda" }));
    await said(msg(`${CA1} xyzzy`));
    const all = [...logs, ...notes].join("\n");
    for (const s of ["xyzzy", "Zelda", "frens", TOKEN, CA1]) assert.ok(!all.includes(s), `a log carries ${s}`);
  });

  it("no method throws on garbage", async () => {
    make();
    const bad: unknown[] = [null, undefined, {}, { chatId: "x" }, { chatId: CHAT, text: 5 }, 42];
    for (const b of bad) {
      groups.onMessage(b as TgMessage);
      groups.onMember(b as TgMemberUpdate);
      groups.onService(b as TgServiceMessage);
      assert.equal(typeof (await groups.onCallback(b as TgCallback)), "boolean");
    }
    await groups.forgetMe(NaN, NaN);
    groups.forgetChat(NaN);
    await groups.groupsCommand(NaN);
    await groups.commandNotice(NaN, undefined, NaN, "owner-only");
    await groups.drain();
    assert.equal(groups.isApproved(NaN), false);
  });

  it("a Telegram transport that throws is silence, never a crash", async () => {
    make();
    approveRoom();
    tg.fetchFn = async () => {
      throw new Error(`boom ${TOKEN}`);
    };
    await said(msg("@pinebot hi"));
    assert.ok(!logs.join("\n").includes(TOKEN));
  });

  it("a slow chat does not hold up another chat", async () => {
    make();
    approveRoom(CHAT);
    approveRoom(OTHER, "others");
    let release: () => void = () => {};
    const gateOpen = new Promise<void>((r) => {
      release = r;
    });
    port.look = async () => {
      await gateOpen;
      return { kind: "too-quiet", name: "Slowcoin" };
    };
    groups.onMessage(msg(CA1));
    groups.onMessage(msg("@pinebot hi", { chatId: OTHER }));
    // Let the second chat's line through while the first chat's look hangs.
    for (let i = 0; i < 50 && tg.sends(OTHER).length === 0; i++) await new Promise((r) => setImmediate(r));
    assert.equal(tg.sends(OTHER).length, 1);
    assert.equal(tg.sends(CHAT).length, 0);
    release();
    await groups.drain();
    assert.equal(tg.sends(CHAT).length, 1);
  });

  it("stop(): nothing more is sent", async () => {
    make();
    approveRoom();
    groups.stop();
    await said(msg("@pinebot hi"));
    assert.equal(tg.sends().length, 0);
  });
});
