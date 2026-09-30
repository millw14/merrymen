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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ResolvedConfig } from "../../settings";
import type { FetchLike, TgCallback, TgMemberUpdate, TgMessage, TgServiceMessage } from "../api";
import type { StateRef, TelegramState } from "../state";
import type { BotSelf } from "./detect";
import { createTgGroups, type TgGroups, type TgGroupsDeps } from "./handler";
import { FLOOD_ANSWERS, FLOOD_WINDOW_MS } from "./pacing";
import { __resetMemoryPassThrottleForTest } from "./memory";
import { TgGroupsStore, emptyTgGroupsState } from "./store";
import type { CoinLook, CoinOutcome, NominateResult, Nomination, TgCoinsPort, TrencherReadiness } from "./types";
import { templatePool, type SpeakCtx } from "./voice";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
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
/** Robinhood Chain coin kinds with a line each, in an order that never repeats a line's shape soon. */
const KINDS = ["too-quiet", "curve", "too-thin", "too-new", "no-pool", "v4-only", "stock", "cash"] as const;

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
    date: Math.floor(clock / 1000),
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
  return { updateId: nextMsg++, id: `cb${nextMsg}`, chatId: OWNER, fromId: OWNER, messageId: 77, data, date: 0, ...over };
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

  it("a LATE add by the owner (the service's backlog rule): approved all the same, no hello in the room, the privacy steps still DM'd", async () => {
    privacy = false;
    make();
    groups.onMember(member(), { late: true });
    await groups.drain();
    const room = store.room(CHAT);
    assert.equal(room?.status, "approved", "the owner's add stands");
    assert.equal(room?.addedById, OWNER);
    assert.deepEqual(tg.sends(CHAT), [], "no hello hours after the add");
    assert.equal(tg.calls.filter((c) => c.method === "sendChatAction" && c.body.chat_id === CHAT).length, 0, "not even typing");
    const dm = tg.sends(OWNER);
    assert.equal(dm.length, 1, "the owner's DM is not the room");
    assert.match(String(dm[0]?.body.text), /BotFather/);
    // A later, live re-add says its hello as ever.
    groups.onMember(member({ oldStatus: "member", newStatus: "left" }));
    groups.onMember(member());
    await groups.drain();
    assert.equal(tg.sends(CHAT).length, 1);
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

  it("added straight in as an admin: no privacy-mode DM (an admin hears every line); demoted later, the steps once", async () => {
    privacy = false;
    make();
    groups.onMember(member({ newStatus: "administrator" }));
    await groups.drain();
    assert.equal(store.room(CHAT)?.status, "approved");
    assert.equal(tg.sends(CHAT).length, 1, "the hello");
    assert.equal(tg.sends(OWNER).length, 0, "'I can't follow the chat' would be false");
    assert.equal(store.room(CHAT)?.privacyHintSent, undefined, "skipped, not sent: still due if it stops being an admin");

    // Demoted to a plain member (by anyone): privacy mode decides what it hears now.
    groups.onMember(member({ fromId: BOB, oldStatus: "administrator", newStatus: "member" }));
    await groups.drain();
    assert.equal(tg.sends(OWNER).length, 1);
    assert.match(String(tg.sends(OWNER)[0]?.body.text), /BotFather/);
    assert.equal(store.room(CHAT)?.privacyHintSent, true);
    // Promoted and demoted again: once per group.
    groups.onMember(member({ oldStatus: "member", newStatus: "administrator" }));
    groups.onMember(member({ oldStatus: "administrator", newStatus: "member" }));
    await groups.drain();
    assert.equal(tg.sends(OWNER).length, 1);
    assert.equal(tg.sends(CHAT).length, 1, "no second hello either");

    // A stranger's group it was made an admin of: Stay approves it without the steps.
    groups.onMember(member({ chatId: OTHER, chatTitle: "others", fromId: BOB, newStatus: "administrator" }));
    await groups.drain();
    assert.equal(tg.sends(OWNER).length, 2, "the Stay / Leave question");
    await groups.onCallback(press(`tgg:stay:${OTHER}`));
    await groups.drain();
    assert.equal(store.room(OTHER)?.status, "approved");
    assert.equal(tg.sends(OWNER).length, 2, "no privacy-mode steps");
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

  it("a group first seen through a line (added before this feature) is pending, and the owner is asked once — never 'someone added me', never left on its own", async () => {
    make();
    await said(msg("hey"));
    assert.equal(store.room(CHAT)?.status, "pending");
    await groups.sweep();
    assert.equal(tg.sends(OWNER).length, 1);
    assert.equal(tg.texts(OWNER)[0], "i'm in «frens» — want me to hang out there?");
    assert.ok(tg.sends(OWNER)[0]?.body.reply_markup, "Stay / Leave as ever");
    // Nobody is known to have added it: it waits for the owner, and asks once.
    clock += 25 * HOUR;
    await groups.sweep();
    assert.equal(tg.of("leaveChat").length, 0);
    assert.equal(tg.sends(OWNER).length, 1);
    assert.equal(store.room(CHAT)?.status, "pending");
  });

  it("…and approved as soon as the owner speaks in it: the hello, then the owner's answer as a reply", async () => {
    make();
    await said(msg("hey", { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(store.room(CHAT)?.status, "pending");
    const q = msg("@pinebot you there?", { fromId: OWNER, fromFirstName: "Mike" });
    await said(q);
    assert.equal(store.room(CHAT)?.status, "approved");
    assert.equal(store.room(CHAT)?.addedById, OWNER);
    const s = tg.sends(CHAT);
    assert.equal(s.length, 2);
    assert.match(String(s[0]?.body.text), /lurk/);
    assert.equal(s[0]?.body.reply_parameters, undefined);
    assert.equal(replyOf(s[1]), q.messageId);
    assert.ok(notes.some((n) => /the owner is talking in a group I was already in/.test(n)));
  });

  it("…but not by a stranger's words, an anonymous admin's, or the owner's in a group a stranger is known to have added", async () => {
    make();
    await said(msg("hey"));
    await said(msg("hi all", { fromId: OWNER, senderChatId: CHAT, fromFirstName: "Group" }));
    assert.equal(store.room(CHAT)?.status, "pending", "a line through a chat could be anyone");
    groups.onMember(member({ chatId: OTHER, fromId: BOB }));
    await groups.drain();
    await said(msg("hi", { chatId: OTHER, fromId: OWNER, fromFirstName: "Mike" }));
    assert.equal(store.room(OTHER)?.status, "pending", "Bob added it: that is the owner's Stay or Leave to give");
    assert.equal(tg.sends(CHAT).length + tg.sends(OTHER).length, 0);
  });

  it("a group the owner said Stay to, removed and re-added by someone else, is asked about afresh on a new 24 h clock", async () => {
    make();
    groups.onMember(member({ fromId: BOB }));
    await groups.drain();
    await groups.onCallback(press(`tgg:stay:${CHAT}`));
    await groups.drain();
    assert.equal(store.room(CHAT)?.status, "approved");
    clock = T0 + 2 * HOUR;
    groups.onMember(member({ fromId: BOB, oldStatus: "member", newStatus: "left" }));
    groups.onMember(member({ fromId: BOB }));
    await groups.drain();
    assert.equal(store.room(CHAT)?.status, "pending");
    assert.equal(tg.sends(OWNER).length, 2, "asked again, with fresh buttons");
    assert.equal(store.room(CHAT)?.askedOwnerAtMs, T0 + 2 * HOUR);
    clock = T0 + 24 * HOUR + MIN;
    await groups.sweep();
    assert.equal(tg.of("leaveChat").length, 0, "a day after the FIRST ask is not a day after this one");
    clock = T0 + 26 * HOUR;
    await groups.sweep();
    assert.deepEqual(tg.of("leaveChat").map((c) => c.body.chat_id), [CHAT]);
  });

  it("thirty groups, every one the owner's: a stranger's new group is left and none of the owner's is pushed out; the owner's own add makes room", async () => {
    make();
    for (let i = 1; i <= 30; i++) {
      store.ensureRoom(-2000 - i, { title: `g${i}`, kind: "supergroup" });
      store.setStatus(-2000 - i, i === 7 ? "blocked" : "approved", OWNER);
    }
    groups.onMember(member({ fromId: BOB }));
    await groups.drain();
    assert.equal(store.room(CHAT), undefined);
    assert.deepEqual(tg.of("leaveChat").map((c) => c.body.chat_id), [CHAT]);
    assert.equal(tg.sends(OWNER).length, 0, "nothing to ask about");
    for (let i = 1; i <= 30; i++) assert.ok(store.room(-2000 - i), `the owner's group ${i} is kept`);
    await said(msg("hello?", { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(store.room(CHAT), undefined, "nor does a stranger's line make room");

    groups.onMember(member());
    await groups.drain();
    assert.equal(store.room(CHAT)?.status, "approved");
    assert.equal(store.rooms().length, 30);
    assert.equal(store.room(-2007), undefined, "the owner's own act spends the blocked room first");
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

  it("its names as the room says them: the soul name, its first or last word as a call, the Telegram display name, 'merryman'", async () => {
    self = { ...BOT, name: "Amber Heron", aliases: ["Robinbot"] };
    make();
    approveRoom();
    const called = ["amber heron you there", "heron, thoughts?", "hey amber", "robinbot what's up", "merryman you alive"].map((t, i) =>
      msg(t, { fromId: 9_000 + i, fromFirstName: `P${i}` }),
    );
    for (const m of called) await said(m);
    assert.deepEqual(tg.sends(CHAT).map(replyOf), called.map((m) => m.messageId));
    // …and the word in a sentence is not a call.
    await said(msg("saw a heron at the lake", { fromId: 9_100, fromFirstName: "Q" }));
    assert.equal(tg.sends(CHAT).length, called.length);
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

  it("two people calling it seconds apart are two conversations: neither answer drops the other, even one already typing", async () => {
    make();
    approveRoom();
    // Both queued before either is looked at.
    const a = msg("@pinebot what's your take on eth today?");
    groups.onMessage(a);
    clock += 4 * SEC;
    const b = msg("@pinebot thoughts on sol?", { fromId: BOB, fromFirstName: "Bob" });
    groups.onMessage(b);
    await groups.drain();
    assert.deepEqual(tg.sends(CHAT).map(replyOf), [a.messageId, b.messageId]);

    // Bob calls it while Ann's next answer is already typing: hers still goes out.
    clock += 5 * MIN;
    let c: TgMessage | null = null;
    onSleep = () => {
      if (c) return;
      c = msg("@pinebot and btc?", { fromId: BOB, fromFirstName: "Bob" });
      groups.onMessage(c);
    };
    const d = msg("@pinebot and what about sol?");
    await said(d);
    assert.ok(c, "Bob's line landed mid-typing");
    assert.deepEqual(tg.sends(CHAT).slice(2).map(replyOf), [d.messageId, (c as TgMessage | null)?.messageId]);
  });

  it(`flood: after ${FLOOD_ANSWERS} answers to one person in two minutes, the next call is skipped, and the log says why`, async () => {
    make();
    approveRoom();
    for (let i = 0; i <= FLOOD_ANSWERS; i++) await said(msg(`@pinebot line ${i}`));
    assert.ok(clock - T0 < FLOOD_WINDOW_MS, "all inside one window");
    assert.equal(tg.sends(CHAT).length, FLOOD_ANSWERS);
    assert.deepEqual(logs.filter((l) => /got nothing/.test(l)), ["[tg-groups] addressed line got nothing (flood)"]);
  });

  it("the owner is never flooded: a back-and-forth with them is the conversation", async () => {
    make();
    approveRoom();
    for (let i = 0; i < FLOOD_ANSWERS + 4; i++) await said(msg(`@pinebot line ${i}`, { fromId: OWNER, fromFirstName: "Mike" }));
    assert.ok(clock - T0 < 2 * FLOOD_WINDOW_MS);
    assert.equal(tg.sends(CHAT).length, FLOOD_ANSWERS + 4);
    assert.ok(!logs.some((l) => /got nothing/.test(l)));
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

  it("the kind line goes out even while the chat is shushed", async () => {
    make();
    approveRoom();
    await said(msg("@pinebot shut up", { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(tg.texts(CHAT)[0], "ok ok 🤐");
    clock += 5 * MIN;
    await said(msg("honestly i want to die, i lost everything"));
    assert.equal(tg.sends(CHAT).length, 2);
    assert.match(tg.texts(CHAT)[1] ?? "", /heavy|rough|alone|sorry|hard|lot|ease|care/);
    // Anything else still waits out the quiet.
    await said(msg("@pinebot what do you think", { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(tg.sends(CHAT).length, 2);
  });

  it("distress with a coin in it: never nominated, no coin line, the kind line instead", async () => {
    make();
    approveRoom();
    await said(msg(`lost everything on ${CA1} i want to die`));
    assert.equal(port.nominations.length, 0);
    assert.deepEqual(store.room(CHAT)?.coins, []);
    const t = tg.texts(CHAT);
    assert.equal(t.length, 1);
    assert.match(t[0] ?? "", /heavy|rough|alone|sorry|hard|lot|ease|care/);
    assert.ok(!/^<a /.test(t[0] ?? ""), "no tag, no coin talk");
  });

  it("an insult by its name in the third person gets the roast: 'pine is trash', '@pinebot is useless'", async () => {
    make();
    approveRoom();
    await said(msg("pine is trash"));
    await said(msg("@pinebot is useless", { fromId: BOB, fromFirstName: "Bob" }));
    const roasts = /bold words|says the guy|cope|imagine|chest|hurt you|ngmi|timing|exit liquidity|green candles|best you've got|noted/;
    assert.deepEqual(
      tg.texts(CHAT).map((t) => roasts.test(t)),
      [true, true],
      JSON.stringify(tg.texts(CHAT)),
    );
    assert.equal(store.person(CHAT, ANN)?.roasts?.count, 1, "counted against the roast cap");
  });

  it("'stupid bot lol' right after its own line, unthreaded, is a roast — twice per 30 min, then it stays out", async () => {
    make();
    approveRoom();
    await said(msg("@pinebot what do you think"));
    for (let i = 0; i < 3; i++) await said(msg("stupid bot lol", { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(tg.sends(CHAT).length, 3, "the answer, then two roasts, then nothing");
    assert.equal(store.person(CHAT, BOB)?.roasts?.count, 2);
    assert.deepEqual(tg.reactions(CHAT), [], "nobody called it: no 🥱 either");
  });
});

describe("small talk", () => {
  it("a hail or thanks said to it gets small talk back as a reply, from a template: no model call, no 'good question'", async () => {
    const prompts = fakeModel(() => "should never be asked");
    make();
    approveRoom();
    const hi = msg("hi pine 👋");
    await said(hi);
    const ty = msg("thanks pine!", { fromId: BOB, fromFirstName: "Bob" });
    await said(ty);
    const how = msg("hey there pine, how are you?", { fromId: OWNER, fromFirstName: "Mike" });
    await said(how);
    const s = tg.sends(CHAT);
    assert.deepEqual(s.map(replyOf), [hi.messageId, ty.messageId, how.messageId]);
    const [a, b, c] = s.map((x) => String(x.body.text));
    assert.match(a ?? "", /hey|yo|sup|hi|ayy/i);
    assert.match(b ?? "", /np|anytime|got it|worries|all good|sure thing|happy to/i);
    assert.match(c ?? "", /all good|lurking|doing alright|can't complain|chillin|good good|not bad/i);
    for (const t of [a, b, c]) assert.ok(!/question|no idea|not sure|tough one/i.test(t ?? ""), t);
    assert.equal(prompts.length, 0, "small talk spends no allowance");
    assert.equal(store.person(CHAT, ANN)?.answers?.count, 1, "counted like any answer for the flood");
  });

  it("a room's welcome is small talk too: the chat's title after 'welcome to' is not a question", async () => {
    make();
    approveRoom(CHAT, "lust rage mode (the redemption)");
    const w = msg("Hey there Pine, and welcome to lust rage mode (the redemption)! How are you?", { chatTitle: "lust rage mode (the redemption)" });
    await said(w);
    const t = tg.texts(CHAT)[0] ?? "";
    assert.equal(replyOf(tg.sends(CHAT)[0]), w.messageId);
    assert.match(t, /all good|lurking|doing alright|can't complain|chillin|good good|not bad/i, t);
    // A message in a welcome is still a message.
    await said(msg("welcome to the group pine, what do you think of this chart?", { fromId: BOB, fromFirstName: "Bob" }));
    assert.match(tg.texts(CHAT)[1] ?? "", /question|no idea|not sure|tough one|idk|no clue|beats me|hard to say|think about|can't say|🤔|🤷/i);
  });

  it("'pine gm' said to it is its gm to them for the day", async () => {
    make();
    approveRoom();
    await said(msg("pine gm"));
    assert.equal(tg.sends(CHAT).length, 1);
    assert.equal(store.person(CHAT, ANN)?.greetedDay, "2026-09-28");
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

  it("a reply in a forum's General topic is answered without the reply thread's id, which Telegram refuses", async () => {
    make();
    approveRoom();
    store.ensureRoom(CHAT, { title: "frens", kind: "supergroup", isForum: true });
    // Telegram's side: a reply in General carries message_thread_id (the
    // thread of the message it replies to) and no is_topic_message, and a
    // send naming that id is refused.
    const orig = tg.fetchFn;
    tg.fetchFn = async (url, init) => {
      const r = await orig(url, init);
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (body.message_thread_id !== 60 && body.message_thread_id !== 61) return r;
      const refused = { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
      return { ok: false, status: 400, json: async () => refused };
    };
    const reply = msg("fair, but why", { isForum: true, messageThreadId: 60, replyTo: { messageId: 60, fromId: BOT.id, fromIsBot: true } });
    await said(reply);
    // A coin posted as a reply in General: its ack, and later its outcome, the same.
    const post = msg(CA1, { isForum: true, messageThreadId: 61, replyTo: { messageId: 61, fromId: BOB, fromIsBot: false } });
    await said(post);
    port.emit({ kind: "skipped", address: CA1, chatId: CHAT, messageId: post.messageId! });
    await groups.drain();
    const s = tg.sends(CHAT);
    assert.deepEqual(s.map(replyOf), [reply.messageId, post.messageId, post.messageId]);
    for (const c of [...s, ...tg.of("sendChatAction")]) assert.equal(c.body.message_thread_id, undefined, JSON.stringify(c.body));
  });

  it("a topic Telegram no longer knows: the line goes out once more without it, still as a reply", async () => {
    tg.script.set("sendMessage", [{ ok: false, error_code: 400, description: "Bad Request: message thread not found" }]);
    make();
    approveRoom();
    const m = msg("@pinebot hi", { isTopicMessage: true, messageThreadId: 77 });
    await said(m);
    const s = tg.sends(CHAT);
    assert.equal(s.length, 2);
    assert.equal(s[0]?.body.message_thread_id, 77);
    assert.equal(s[1]?.body.message_thread_id, undefined);
    assert.equal(replyOf(s[1]), m.messageId);
    assert.ok(store.room(CHAT)?.lines.some((l) => l.own), "and it is remembered as said");
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
    const post = msg(`@pinebot look at ${CA1}`, { fromFirstName: "Ann & co" });
    await said(post);
    assert.equal(port.nominations.length, 1);
    assert.deepEqual(port.nominations[0], { address: CA1, chatId: CHAT, messageId: post.messageId, senderId: ANN, atMs: post.dateSec! * 1000 });
    const ack = tg.sends(CHAT);
    assert.equal(ack.length, 1, "one reply to the post: the coin line, not an answer as well");
    assert.equal(replyOf(ack[0]), post.messageId);
    assert.match(String(ack[0]?.body.text), new RegExp(`^<a href="tg://user\\?id=${ANN}">Ann &amp; co</a> `));

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

  it("coins switched off: silence, not even a 👀, and no answer from the chatter path either", async () => {
    cfg.telegramGroupCoinsEnabled = false;
    make();
    approveRoom();
    await said(msg(CA1));
    await said(msg(`@pinebot thoughts on ${ca(0xb2)}?`, { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(tg.calls.length, 0, "no Bot API call at all");
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

  it("a sender whose display name is a shill call is tagged 'fren': the id still pings them, the words are never the agent's", async () => {
    make();
    approveRoom();
    await said(msg(CA1, { fromFirstName: "BUY $SCAM NOW 🚀 t.me/scamx" }));
    const t = tg.texts(CHAT)[0] ?? "";
    assert.match(t, new RegExp(`^<a href="tg://user\\?id=${ANN}">fren</a> `), t);
    assert.ok(!/SCAM|t\.me|🚀|BUY/.test(t), t);
    // A slur for a name is the same.
    await said(msg(ca(0xb2), { fromId: BOB, fromFirstName: "retard" }));
    assert.match(tg.texts(CHAT)[1] ?? "", new RegExp(`^<a href="tg://user\\?id=${BOB}">fren</a> `));
  });

  it(`one person posting CA after CA: ${FLOOD_ANSWERS} coin lines in two minutes, then one 👀, then silence; others are not held back`, async () => {
    make();
    approveRoom();
    const n = FLOOD_ANSWERS + 2;
    // One kind over and over, as in a bonding-curve group: its lines recur
    // rather than run dry, so only the flood holds them back.
    for (let i = 0; i < n; i++) port.looks.set(ca(0x10 + i), { kind: "curve", name: "Slowcoin" });
    for (let i = 0; i < n; i++) await said(msg(ca(0x10 + i), { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(tg.sends(CHAT).length, FLOOD_ANSWERS);
    assert.deepEqual(tg.reactions(CHAT), ["👀"]);
    assert.ok(clock - T0 < FLOOD_WINDOW_MS, "all inside one flood window");
    // Ann is not Bob.
    port.looks.set(ca(0x20), { kind: "too-quiet", name: "Slowcoin" });
    await said(msg(ca(0x20)));
    assert.equal(tg.sends(CHAT).length, FLOOD_ANSWERS + 1);
    // A fresh window for Bob.
    clock += FLOOD_WINDOW_MS;
    port.looks.set(ca(0x21), { kind: "too-quiet", name: "Slowcoin" });
    await said(msg(ca(0x21), { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(tg.sends(CHAT).length, FLOOD_ANSWERS + 2);
  });

  it("the owner posting CA after CA is never flooded", async () => {
    make();
    approveRoom();
    const n = FLOOD_ANSWERS + 2;
    for (let i = 0; i < n; i++) port.looks.set(ca(0x30 + i), { kind: KINDS[i % KINDS.length]!, name: "Curvy" });
    for (let i = 0; i < n; i++) await said(msg(ca(0x30 + i), { fromId: OWNER, fromFirstName: "Mike" }));
    assert.equal(tg.sends(CHAT).length, n);
    assert.deepEqual(tg.reactions(CHAT), []);
  });

  it("the owner asking about bonding-curve coin after bonding-curve coin: every one gets its line, the pool recurring rather than running dry", async () => {
    // The live report: "when I sent a ca she stopped responding", in a Pons
    // group. The curve pool's lines all say "curve", so four in a row used
    // them up and the gate's repeat clause refused the rest: nothing at all,
    // logged as model-null-and-no-template. The model makes no difference
    // (a look's line is template-only).
    make();
    approveRoom();
    const names = ["Froggy", "Doge Two", "AppShare", "Moonpie", "Rocket", "Pumpkin", "Zebra", "Lambo", "Kitten", "Sushi", "Waffle", "Mango"];
    const posts: TgMessage[] = [];
    for (let i = 0; i < names.length; i++) {
      port.looks.set(ca(0x30 + i), { kind: "curve", name: names[i]! });
      const m = msg(`@pinebot ${ca(0x30 + i)}`, { fromId: OWNER, fromFirstName: "Milla" });
      posts.push(m);
      await said(m);
      clock += 20 * SEC;
    }
    assert.deepEqual(tg.sends(CHAT).map(replyOf), posts.map((m) => m.messageId), "a line for every one, as a reply to it");
    for (const t of tg.texts(CHAT)) {
      assert.match(t, new RegExp(`^<a href="tg://user\\?id=${OWNER}">Milla</a> .*curve`), t);
      assert.ok(!/\d/.test(t.replace(/^<a [^>]*>[^<]*<\/a> /, "")), `no figure: ${t}`);
    }
    assert.deepEqual(quietLogs(), []);
    // With chat in between, the same.
    const chatter = ["nice", "what else is good", "lol ok", "you trading today"];
    for (let i = 0; i < chatter.length; i++) {
      port.looks.set(ca(0x50 + i), { kind: "curve", name: names[i]! });
      await said(msg(`@pinebot ${ca(0x50 + i)}`, { fromId: OWNER, fromFirstName: "Milla" }));
      clock += 30 * SEC;
      await said(msg(`@pinebot ${chatter[i]}`, { fromId: OWNER, fromFirstName: "Milla" }));
      clock += 30 * SEC;
    }
    assert.equal(tg.sends(CHAT).length, names.length + 2 * chatter.length);
    assert.deepEqual(quietLogs(), []);
  });

  it("a coin line that cannot be written for a post that asked it: a 👀 on the post instead of nothing; unasked, nothing", async () => {
    make();
    approveRoom();
    // Its own recent line holds every word of every ack it could say, so the
    // gate's repeat clause refuses them all (an ack is a model's intent: its
    // template fallback keeps that clause) and there is no line to send.
    const words = new Set(templatePool({ kind: "coin-ack" }, { coinName: "Froggy" } as SpeakCtx).join(" ").toLowerCase().match(/[a-z]+/g) ?? []);
    store.addLine(CHAT, { messageId: 1, fromId: BOT.id, name: "Pine", text: [...words].join(" "), atMs: clock - MIN, own: true });
    const asked = msg(`@pinebot ${CA1}`, { fromId: OWNER, fromFirstName: "Milla" });
    await said(asked);
    assert.equal(port.nominations.length, 1, "the nomination is made all the same");
    assert.equal(tg.sends(CHAT).length, 0);
    assert.deepEqual(tg.of("setMessageReaction").map((c) => c.body.message_id), [asked.messageId]);
    assert.deepEqual(tg.reactions(CHAT), ["👀"]);
    assert.deepEqual(quietLogs(), [], "something landed on it");
    // Nobody asked: nothing, no 👀 either.
    await said(msg(ca(0xb2), { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(tg.of("setMessageReaction").length, 1);
    assert.equal(tg.sends(CHAT).length, 0);
  });
});

// ─── A look that hangs; why an addressed line got nothing ───────────────────

/** A timer the test fires by hand: the look's bound, on the test's own clock. */
function handTimer(): { timer: (ms: number) => Promise<void>; waits: Array<{ ms: number; fire: () => void }> } {
  const waits: Array<{ ms: number; fire: () => void }> = [];
  return {
    waits,
    timer: (ms) =>
      new Promise<void>((fire) => {
        waits.push({
          ms,
          fire: () => {
            clock += ms;
            fire();
          },
        });
      }),
  };
}

/** Let queued work run (no timer fires meanwhile), until `done()` or a bound. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setImmediate(r));
}

const quietLogs = (): string[] => logs.filter((l) => /got nothing/.test(l));

describe("a coin look that never answers", () => {
  it("holds nothing in its own chat: the next addressed line is answered while the look is still out", async () => {
    const t = handTimer();
    make({ timer: t.timer });
    approveRoom();
    port.look = () => new Promise<CoinLook>(() => {});
    const post = msg(CA1);
    groups.onMessage(post);
    const ask = msg("@pinebot you there?");
    groups.onMessage(ask);
    await until(() => tg.sends(CHAT).length > 0);
    assert.deepEqual(tg.sends(CHAT).map(replyOf), [ask.messageId], "answered with the look still out");
    assert.equal(t.waits.length, 1, "the look is still being waited for");
    t.waits[0]!.fire();
    await groups.drain();
    assert.deepEqual(tg.sends(CHAT).map(replyOf), [ask.messageId], "the unaddressed CA whose look failed: silence");
    assert.deepEqual(quietLogs(), [], "only addressed lines are explained");
  });

  it("addressed: 'can't pull that one up rn', tagging them, once the look is let go", async () => {
    const t = handTimer();
    make({ timer: t.timer });
    approveRoom();
    port.look = () => new Promise<CoinLook>(() => {});
    const post = msg(`@pinebot what about ${CA1}`);
    groups.onMessage(post);
    await until(() => t.waits.length > 0);
    t.waits[0]!.fire();
    await groups.drain();
    const s = tg.sends(CHAT);
    assert.equal(s.length, 1);
    assert.equal(replyOf(s[0]), post.messageId);
    assert.match(String(s[0]?.body.text), new RegExp(`^<a href="tg://user\\?id=${ANN}">Ann</a> .*(?:can't|won't|not loading|blank)`));
    assert.deepEqual(store.room(CHAT)?.coins, [], "nothing remembered");
    // Another addressed CA inside ten minutes: nothing, and the log says why.
    const again = msg(`@pinebot and ${ca(0xb2)}?`, { fromId: BOB, fromFirstName: "Bob" });
    groups.onMessage(again);
    await until(() => t.waits.length > 1);
    t.waits[1]!.fire();
    await groups.drain();
    assert.equal(tg.sends(CHAT).length, 1);
    assert.deepEqual(quietLogs(), ["[tg-groups] addressed line got nothing (coin-unknown)"]);
  });
});

describe("a backlog on the coin lane", () => {
  it("a shill's CAs while the reads hang do not bury the owner's '@bot what about <CA>': served next, inside the send window; posts past theirs are not looked at", async () => {
    // Every look waits out its whole bound on the test's clock.
    make({
      timer: async (ms) => {
        await new Promise((r) => setImmediate(r));
        clock += ms;
      },
    });
    approveRoom();
    const looked: string[] = [];
    port.look = (address: string) => {
      looked.push(address);
      return new Promise<CoinLook>(() => {});
    };
    for (let i = 0; i < 5; i++) groups.onMessage(msg(`${ca(0x100 + 2 * i)} ${ca(0x101 + 2 * i)}`, { fromId: BOB, fromFirstName: "Bob" }));
    const mine = msg(`@pinebot what about ${CA1}`, { fromId: OWNER, fromFirstName: "Milla" });
    const askedAt = clock;
    let answeredAt: number | null = null;
    const send = tg.fetchFn;
    tg.fetchFn = async (url, init) => {
      if (url.endsWith("/sendMessage") && answeredAt === null) answeredAt = clock;
      return send(url, init);
    };
    groups.onMessage(mine);
    await groups.drain();
    const s = tg.sends(CHAT);
    assert.deepEqual(s.map(replyOf), [mine.messageId], "hers, and only hers: nobody asked about the rest");
    assert.match(String(s[0]?.body.text), /can't|won't|not loading|blank/);
    assert.ok(answeredAt !== null && answeredAt - askedAt < 90 * SEC, `inside the send window: ${(answeredAt ?? 0) - askedAt} ms`);
    assert.equal(looked[2], CA1, "the look after the one already out is hers");
    assert.ok(looked.length < 11, `a post whose reply window ran out is claimed, not looked at: ${looked.length} looks`);
    assert.deepEqual(quietLogs(), []);
  });
});

describe("a Bot API call that never answers", () => {
  it("fails after the call's time limit and lets the chat go: the next addressed lines are answered", async () => {
    make({ opts: () => ({ token: TOKEN, fetchFn: tg.fetchFn, timeoutMs: 20 }) });
    approveRoom();
    const hang = new Set<string>(["sendChatAction"]);
    const base = tg.fetchFn;
    tg.fetchFn = async (url, init) => {
      if (hang.delete(url.split("/").pop() ?? "")) return new Promise<never>(() => {});
      return base(url, init);
    };
    const hi = msg("@pinebot hi", { fromId: OWNER, fromFirstName: "Milla" });
    await said(hi);
    assert.deepEqual(tg.sends(CHAT).map(replyOf), [hi.messageId], "the typing action that hung does not cost the answer");
    // The send itself hangs: that line is lost (a send that timed out may
    // have landed, so it is not tried again), said so, and the lock let go.
    hang.add("sendMessage");
    await said(msg("@pinebot ??", { fromId: OWNER, fromFirstName: "Milla" }));
    assert.equal(tg.sends(CHAT).length, 1);
    assert.deepEqual(quietLogs(), ["[tg-groups] addressed line got nothing (send-failed)"]);
    assert.ok(logs.includes("[tg-groups] send failed (no answer)"));
    const again = msg("@pinebot you there", { fromId: OWNER, fromFirstName: "Milla" });
    await said(again);
    assert.deepEqual(tg.sends(CHAT).map(replyOf), [hi.messageId, again.messageId]);
  });
});

describe("an addressed line that gets nothing says why, and only why", () => {
  it("burst: the earlier lines of one person's burst", async () => {
    make();
    approveRoom();
    groups.onMessage(msg("@pinebot yo"));
    groups.onMessage(msg("@pinebot answer me"));
    await groups.drain();
    assert.equal(tg.sends(CHAT).length, 1);
    assert.deepEqual(quietLogs(), ["[tg-groups] addressed line got nothing (burst)"]);
  });

  it("stale: it waited past 90 s", async () => {
    make();
    approveRoom();
    groups.onMessage(msg("@pinebot hi"));
    clock += 91 * SEC;
    await groups.drain();
    assert.deepEqual(quietLogs(), ["[tg-groups] addressed line got nothing (stale)"]);
  });

  it("shushed: someone else calling it in a quiet chat", async () => {
    make();
    approveRoom();
    store.update(CHAT, (r) => {
      r.shushedUntilMs = clock + 10 * MIN;
    });
    await said(msg("@pinebot hey"));
    assert.equal(tg.sends(CHAT).length, 0);
    assert.deepEqual(quietLogs(), ["[tg-groups] addressed line got nothing (shushed)"]);
  });

  it("forgotten: /forgetme while it was queued", async () => {
    make();
    approveRoom();
    groups.onMessage(msg("@pinebot hey"));
    await groups.forgetMe(CHAT, ANN);
    await groups.drain();
    assert.ok(quietLogs().includes("[tg-groups] addressed line got nothing (forgotten)"));
  });

  it("send-failed: Telegram refused it", async () => {
    make();
    approveRoom();
    tg.script.set("sendMessage", [{ ok: false, error_code: 400, description: "Bad Request: chat not found" }]);
    await said(msg("@pinebot hey"));
    assert.deepEqual(quietLogs(), ["[tg-groups] addressed line got nothing (send-failed)"]);
  });

  it("room-not-approved and off: said to it where it may not talk", async () => {
    make();
    store.ensureRoom(CHAT, { title: "frens", kind: "supergroup" });
    await said(msg("@pinebot hello?"));
    assert.deepEqual(quietLogs(), ["[tg-groups] addressed line got nothing (room-not-approved)"]);
    approveRoom();
    envVars.MERRYMEN_TG_GROUPS = "0";
    await said(msg("@pinebot hello??"));
    assert.deepEqual(quietLogs().slice(1), ["[tg-groups] addressed line got nothing (off)"]);
    // Not addressed: nothing to explain.
    await said(msg("just chatting"));
    assert.equal(quietLogs().length, 2);
  });

  it("the coin flow's reasons: another chain's coin is 'coin-not-here'; a 👀 that landed is not 'nothing'; past it, the flood", async () => {
    make();
    approveRoom();
    port.looks.set(CA1, { kind: "wallet" });
    await said(msg(`@pinebot ${CA1}?`));
    assert.deepEqual(quietLogs(), ["[tg-groups] addressed line got nothing (coin-not-here)"]);
    await said(msg(`@pinebot https://bscscan.com/token/${ca(0xb3)}`));
    assert.deepEqual(quietLogs().slice(1), ["[tg-groups] addressed line got nothing (coin-not-here)"]);
    // Past the flood a coin line is one 👀: something landed, so no log line.
    for (let i = 0; i < FLOOD_ANSWERS; i++) {
      port.looks.set(ca(0x40 + i), { kind: KINDS[i % KINDS.length]!, name: "Meh" });
      await said(msg(ca(0x40 + i), { fromId: BOB, fromFirstName: "Bob" }));
    }
    port.looks.set(ca(0x60), { kind: "curve", name: "Meh" });
    await said(msg(`@pinebot ${ca(0x60)}`, { fromId: BOB, fromFirstName: "Bob" }));
    assert.deepEqual(tg.reactions(CHAT), ["👀"]);
    assert.equal(quietLogs().length, 2);
    // …and past the 👀, nothing: the flood, said so.
    port.looks.set(ca(0x61), { kind: "too-new", name: "Meh" });
    await said(msg(`@pinebot ${ca(0x61)}`, { fromId: BOB, fromFirstName: "Bob" }));
    assert.deepEqual(quietLogs().slice(2), ["[tg-groups] addressed line got nothing (flood)"]);
  });

  it("the log line is the code alone: no text, name, id or address", async () => {
    make();
    approveRoom();
    port.looks.set(CA1, { kind: "wallet" });
    await said(msg(`@pinebot xyzzy ${CA1}`, { fromFirstName: "Zelda" }));
    const lines = quietLogs();
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^\[tg-groups\] addressed line got nothing \([a-z-]+\)$/);
    for (const s of ["xyzzy", "Zelda", String(ANN), String(CHAT), CA1.slice(2, 12)]) assert.ok(!lines[0]!.includes(s), s);
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

  it("'dm me first' when the answer could not reach the asker's DM, as a reply, at most once per person per hour", async () => {
    make();
    approveRoom();
    await groups.commandNotice(CHAT, 10, OWNER, "dm-first");
    await groups.commandNotice(CHAT, 11, OWNER, "dm-first");
    const t = tg.texts(CHAT);
    assert.equal(t.length, 1);
    assert.match(t[0] ?? "", /\/start/, "names what opens the DM");
    assert.ok(!/sent it/.test(t[0] ?? ""), "never claims it was sent");
    assert.equal(replyOf(tg.sends(CHAT)[0]), 10);
  });

  it("'done, couldn't DM you' when an order ran but its receipt was lost: never 'first', one per order, as a reply, shushed or not", async () => {
    make();
    approveRoom();
    store.update(CHAT, (r) => {
      r.shushedUntilMs = clock + HOUR;
    });
    // Each start of the pool in turn: every line passes the gate.
    for (let i = 0; i < 5; i++) {
      dice = () => i / 5 + 0.01;
      await groups.commandNotice(CHAT, 10 + i, OWNER, "done-no-dm", 42);
    }
    const t = tg.texts(CHAT);
    assert.equal(t.length, 5, "every order that ran is answered: no hourly limit");
    assert.equal(new Set(t).size, 5);
    for (const line of t) {
      assert.match(line, /\b(done|got it|went through|handled)\b/i, line);
      assert.doesNotMatch(line, /\bfirst\b|sent it to your DMs|\/start|\d/, line);
    }
    assert.deepEqual(tg.sends(CHAT).map(replyOf), [10, 11, 12, 13, 14]);
    assert.ok(tg.sends(CHAT).every((c) => c.body.message_thread_id === 42), "in the topic the command came from");
  });

  it("/forgetme typed over and over: every one wipes, but 'done 🫡' comes once per person per ten minutes", async () => {
    make();
    approveRoom();
    for (let i = 0; i < 25; i++) {
      store.addLine(CHAT, { messageId: 200 + i, fromId: ANN, name: "Ann", text: `hi ${i}`, atMs: clock });
      await groups.forgetMe(CHAT, ANN, 300 + i);
      assert.ok(!store.room(CHAT)!.lines.some((l) => l.fromId === ANN), `wiped on try ${i}`);
    }
    await groups.drain();
    assert.deepEqual(tg.texts(CHAT), ["done 🫡"]);
    assert.equal(replyOf(tg.sends(CHAT)[0]), 300);
    // Someone else's is theirs.
    await groups.forgetMe(CHAT, BOB, 400);
    assert.deepEqual(tg.sends(CHAT).map(replyOf), [300, 400]);
    clock += 10 * MIN;
    await groups.forgetMe(CHAT, ANN, 500);
    assert.deepEqual(tg.sends(CHAT).map(replyOf), [300, 400, 500]);
  });

  it("a 'done 🫡' stuck behind a slow chat goes stale from when /forgetme arrived; the next one may say it", async () => {
    make();
    approveRoom();
    store.addLine(CHAT, { messageId: 1, fromId: ANN, name: "Ann", text: "hi", atMs: clock });
    // Bob's answer ahead of it in the queue takes 100 s (a long flood pause).
    let slowed = false;
    onSleep = () => {
      if (slowed) return;
      slowed = true;
      clock += 100 * SEC;
    };
    groups.onMessage(msg("@pinebot hey", { fromId: BOB, fromFirstName: "Bob" }));
    await groups.forgetMe(CHAT, ANN, 950);
    await groups.drain();
    assert.ok(slowed);
    assert.deepEqual(tg.texts(CHAT), [], "nothing past 90 s goes out");
    assert.ok(!store.room(CHAT)!.lines.some((l) => l.fromId === ANN), "the wipe did not wait for the words");
    await groups.forgetMe(CHAT, ANN, 951);
    assert.deepEqual(tg.texts(CHAT), ["done 🫡"]);
    assert.equal(replyOf(tg.sends(CHAT)[0]), 951);
  });

  it("/forgetme, /forget and the Forget button reach the memory even when this store is not holding it", async () => {
    // A hosted child whose memory could not be restored: groups held off, an
    // empty store. The sealed copy holds everything.
    envVars = { MERRYMEN_TG_GROUPS: "0" };
    make();
    await groups.forgetMe(CHAT, ANN, 5);
    groups.forgetChat(OTHER, 6);
    await groups.onCallback(press(`tgg:forget:${NEW_CHAT}`));
    await groups.drain();
    assert.equal(tg.sends().filter((c) => c.body.chat_id !== OWNER).length, 0, "nothing said in any group");

    // A later spawn restores the sealed copy into this home.
    const sealed = new TgGroupsStore(path.join(home, "sealed", "tg-groups.json"), emptyTgGroupsState(), { now: () => clock, debounceMs: 60_000 });
    for (const id of [CHAT, OTHER, NEW_CHAT]) {
      sealed.ensureRoom(id, { title: "frens", kind: "supergroup" });
      sealed.setStatus(id, "approved", OWNER);
      sealed.addLine(id, { messageId: 1, fromId: ANN, name: "Ann", text: "ann was here", atMs: clock - MIN });
      sealed.addLine(id, { messageId: 2, fromId: BOB, name: "Bob", text: "bob too", atMs: clock - MIN });
      sealed.upsertPerson(id, { id: ANN, name: "Ann", lastSeenMs: clock - MIN });
    }
    sealed.close();
    writeFileSync(path.join(home, "tg-groups.json"), JSON.stringify(sealed.state));
    const restored = TgGroupsStore.open(home, { now: () => clock, debounceMs: 60_000 });
    try {
      assert.deepEqual(restored.room(CHAT)?.lines.map((l) => l.fromId), [BOB], "/forgetme: her line goes, Bob's stays");
      assert.equal(restored.person(CHAT, ANN), undefined);
      assert.deepEqual(restored.room(OTHER)?.lines, [], "/forget: that chat's memory");
      assert.deepEqual(restored.room(NEW_CHAT)?.lines, [], "the Forget button: that chat's memory");
      assert.equal(restored.room(OTHER)?.status, "approved", "the owner's decision is not memory");
    } finally {
      restored.close();
    }
  });
});

// ─── Forgetting mid-flight, and the age limits ───────────────────────────────

describe("forgetting what is still in flight", () => {
  /** Ann's lines from four quiet hours ago: a memory pass is due. */
  const quietLines = (): void => {
    for (let i = 0; i < 3; i++) store.addLine(CHAT, { messageId: 10 + i, fromId: ANN, name: "Ann", text: `frogs ${i}`, atMs: clock - 4 * HOUR });
  };
  const PASS = JSON.stringify({ summary: "Ann shills frogs all day.", people: [{ id: "p1", note: "shills frogs" }] });

  it("a memory pass with nothing forgotten meanwhile writes its summary (the control)", async () => {
    fakeModel(() => PASS);
    make();
    approveRoom();
    quietLines();
    await groups.sweep();
    await groups.drain();
    assert.equal(store.room(CHAT)?.summary, "Ann shills frogs all day.");
  });

  it("/forget during the memory pass's model call: the summary of the wiped lines is not written back", async () => {
    fakeModel(() => {
      groups.forgetChat(CHAT);
      return PASS;
    });
    make();
    approveRoom();
    quietLines();
    await groups.sweep();
    await groups.drain();
    const room = store.room(CHAT)!;
    assert.equal(room.summary, "");
    assert.deepEqual(room.people, []);
    assert.equal(room.sinceSummary, 0);
    assert.equal(tg.texts(CHAT).at(-1), "done, clean slate 🫡");
  });

  it("/forgetme during the memory pass's model call: a summary naming them does not come back", async () => {
    fakeModel(() => {
      void groups.forgetMe(CHAT, ANN);
      return PASS;
    });
    make();
    approveRoom();
    quietLines();
    store.addLine(CHAT, { messageId: 20, fromId: BOB, name: "Bob", text: "lol", atMs: clock - 4 * HOUR });
    await groups.sweep();
    await groups.drain();
    const room = store.room(CHAT)!;
    assert.equal(room.summary, "");
    assert.equal(store.person(CHAT, ANN), undefined);
    assert.equal(room.sinceSummary, 0, "the next pass is written from the lines that are left");
  });

  it("/forgetme with their roast still queued: never sent, and their entry does not come back before 'done 🫡'", async () => {
    make();
    approveRoom();
    groups.onMessage(msg("@pinebot you're useless"));
    await groups.forgetMe(CHAT, ANN, 950);
    await groups.drain();
    assert.deepEqual(tg.texts(CHAT), ["done 🫡"]);
    assert.equal(store.person(CHAT, ANN), undefined);
    assert.ok(!store.room(CHAT)!.lines.some((l) => l.fromId === ANN));
  });

  it("/forgetme while their answer is already typing: dropped before the send", async () => {
    make();
    approveRoom();
    let asked = false;
    onSleep = () => {
      if (asked) return;
      asked = true;
      void groups.forgetMe(CHAT, ANN);
    };
    await said(msg("@pinebot hey"));
    assert.ok(asked, "the forget landed mid-typing");
    assert.deepEqual(tg.texts(CHAT), ["done 🫡"]);
    assert.equal(store.person(CHAT, ANN), undefined);
  });

  it("/forgetme with their coin post still queued: not claimed, looked at, nominated or answered, and no memo names them", async () => {
    make();
    approveRoom();
    groups.onMessage(msg(CA1));
    await groups.forgetMe(CHAT, ANN);
    await groups.drain();
    assert.equal(port.nominations.length, 0);
    assert.deepEqual(store.room(CHAT)?.coins, []);
    assert.deepEqual(store.room(CHAT)?.claims, {});
    assert.deepEqual(tg.texts(CHAT), ["done 🫡"]);
  });

  it("/forgetme from someone else cancels nothing of Ann's", async () => {
    make();
    approveRoom();
    groups.onMessage(msg("@pinebot you're useless"));
    await groups.forgetMe(CHAT, BOB);
    await groups.drain();
    assert.equal(tg.sends(CHAT).length, 2, "Ann's roast, then Bob's done");
    assert.equal(store.person(CHAT, ANN)?.roasts?.count, 1);
  });

  it("a later line from someone who ran /forgetme is a new line, answered as ever", async () => {
    make();
    approveRoom();
    await groups.forgetMe(CHAT, ANN);
    clock += MIN;
    await said(msg("@pinebot you're useless"));
    assert.equal(tg.sends(CHAT).length, 2, "'done 🫡', then the roast");
    assert.equal(tg.texts(CHAT)[0], "done 🫡");
    assert.equal(store.person(CHAT, ANN)?.roasts?.count, 1);
  });

  it("the sweep applies the age limits, at most hourly, whatever the switches say", async () => {
    make();
    approveRoom();
    clock = T0 - 31 * DAY;
    store.ensureRoom(OTHER, { title: "gone", kind: "supergroup" });
    store.setStatus(OTHER, "left");
    clock = T0;
    store.addLine(CHAT, { messageId: 1, fromId: ANN, name: "Ann", text: "old", atMs: clock - 15 * DAY });
    store.addLine(CHAT, { messageId: 2, fromId: ANN, name: "Ann", text: "new", atMs: clock - HOUR });
    envVars.MERRYMEN_TG_GROUPS = "0";
    await groups.sweep();
    assert.equal(store.room(OTHER), undefined, "a group left 31 days ago is deleted");
    assert.deepEqual(store.room(CHAT)?.lines.map((l) => l.text), ["new"]);
    // Within the hour: not again.
    store.addLine(CHAT, { messageId: 3, fromId: ANN, name: "Ann", text: "old too", atMs: clock - 15 * DAY });
    clock += 5 * MIN;
    await groups.sweep();
    assert.equal(store.room(CHAT)?.lines.length, 2);
    clock += HOUR;
    await groups.sweep();
    assert.deepEqual(store.room(CHAT)?.lines.map((l) => l.text), ["new"]);
  });

  it("a line or coin past the 14-day window never reaches the model, even before a sweep ages it out", async () => {
    const prompts = fakeModel(() => "lol same");
    make();
    approveRoom();
    store.addLine(CHAT, { messageId: 1, fromId: BOB, name: "Bob", text: "ancient xyzzy", atMs: clock - 15 * DAY });
    store.rememberCoin(CHAT, { address: CA1, name: "Oldfrog", byId: BOB, byName: "Bob", messageId: 1, atMs: clock - 15 * DAY, verdict: "passed" });
    store.addLine(CHAT, { messageId: 2, fromId: BOB, name: "Bob", text: "recent plugh", atMs: clock - HOUR });
    await said(msg("@pinebot what do you think"));
    assert.equal(prompts.length, 1);
    const all = `${prompts[0]?.system}\n${prompts[0]?.prompt}`;
    assert.ok(!all.includes("xyzzy"), "the old line");
    assert.ok(!all.includes("Oldfrog"), "the old coin memo");
    assert.match(all, /recent plugh/);
    assert.ok(store.room(CHAT)?.lines.some((l) => l.text === "ancient xyzzy"), "the store is the sweep's to prune");
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
