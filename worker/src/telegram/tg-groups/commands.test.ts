/**
 * docs/tg-groups.md "Commands in groups", through the real poll service.
 *
 * The rows scenarios.test.ts does not pin: which slash commands typed in a
 * group are this bot's at all, when the room may be told "sent it to your
 * DMs", that nothing is run for someone whose DM the bot cannot reach, and
 * that the live link code is replaced wherever a group line shows it.
 * Same harness as scenarios.test.ts's poll-service block: every Telegram call
 * is answered by a fake behind global fetch, the child's home is a temp dir,
 * and the group handler runs on a fake clock with no waits.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { resolveConfig, type ResolvedConfig } from "../../settings";
import { getMe, type FetchLike } from "../api";
import { isPaused, setPaused, startTelegram } from "../service";
import { ensureLinkCode, loadTelegramState, type TelegramState } from "../state";
import { TG_GROUPS_FORGET_FILE, TgGroupsStore, emptyTgGroupsState, parseTgForgets } from "./store";
import type { CoinLook, CoinOutcome, NominateResult, Nomination, TgCoinsPort, TrencherReadiness } from "./types";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const CHAT = -1001234567890;
const OWNER = 424242;
const ANN = 717171;
const BOB = 818181;
const CAT = 919191;
/** Allowlisted by id in the dashboard; the bot can never write to them. */
const DAN = 616161;
/** Allowlisted, DM open, but the receipt of their command is lost on the way. */
const EVE = 515151;
const TOKEN = "123456:SECRET-TOKEN-XYZ";
const BOT = { id: 999999, username: "pinebot", firstName: "Zorblax" };

interface Call {
  method: string;
  body: Record<string, unknown>;
}

class FakePort implements TgCoinsPort {
  ready: TrencherReadiness = { kind: "ready-paper", ownerReason: "Trencher mode is ready." };
  readiness(): TrencherReadiness {
    return this.ready;
  }
  async look(): Promise<CoinLook> {
    return { kind: "candidate", name: "Froggy" };
  }
  nominate(_n: Nomination): NominateResult {
    return { ok: true };
  }
  onOutcome(_cb: (o: CoinOutcome) => void): () => void {
    return () => {};
  }
  heldNames(): string[] {
    return [];
  }
  mode(): "paper" | "live" {
    return "paper";
  }
}

const replyOf = (c: Call | undefined): number | undefined => (c?.body.reply_parameters as { message_id?: number } | undefined)?.message_id;

describe("docs/tg-groups.md Commands in groups, through the poll service", () => {
  let home: string;
  let clock: number;
  let store: TgGroupsStore;
  let stop: () => void;
  let tstate: TelegramState;
  let cfg: ResolvedConfig;
  const calls: Call[] = [];
  const batches: unknown[][] = [];
  /** DMs Telegram refuses: people who never opened a DM with the bot. */
  const neverStarted = new Set<number>();
  /** DMs whose "typing…" lands but whose messages are lost (a blip, or blocked in between). */
  const receiptLost = new Set<number>();
  /** Every order that reached trading. */
  const trades: string[] = [];
  let nextUpdate = 1;
  let nextMid = 1_000;
  let nextSent = 90_000;
  const saved: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;

  const tgFetch = async (url: string, init?: { body?: string }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => {
    const u = String(url);
    if (!u.startsWith("https://api.telegram.org/")) throw new Error("no network in tests");
    const method = u.split("/").pop() ?? "";
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, body });
    let env: unknown = { ok: true, result: true };
    if (method === "getMe") {
      env = { ok: true, result: { id: BOT.id, is_bot: true, first_name: BOT.firstName, username: BOT.username, can_read_all_group_messages: true } };
    } else if (method === "getUpdates") {
      const b = batches.shift();
      if (!b) await new Promise((r) => setTimeout(r, 20));
      env = { ok: true, result: b ?? [] };
    } else if (method === "sendMessage" && neverStarted.has(Number(body.chat_id))) {
      const refused = { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" };
      return { ok: false, status: 403, json: async () => refused };
    } else if (method === "sendChatAction" && neverStarted.has(Number(body.chat_id))) {
      const refused = { ok: false, error_code: 400, description: "Bad Request: chat not found" };
      return { ok: false, status: 400, json: async () => refused };
    } else if (method === "sendMessage" && receiptLost.has(Number(body.chat_id))) {
      throw new Error("ECONNRESET");
    } else if (method === "sendMessage") env = { ok: true, result: { message_id: nextSent++ } };
    return { ok: true, status: 200, json: async () => env };
  };

  const sendsTo = (chatId: number): Call[] => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);
  const typingTo = (chatId: number): Call[] => calls.filter((c) => c.method === "sendChatAction" && c.body.chat_id === chatId);
  const allSends = (): Call[] => calls.filter((c) => c.method === "sendMessage");

  async function waitFor(pred: () => boolean, ms = 6_000): Promise<void> {
    const until = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > until) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  /** Hand the service one batch and wait until it has been read and a poll cycle has passed. */
  async function deliver(...updates: unknown[]): Promise<void> {
    const before = calls.filter((c) => c.method === "getUpdates").length;
    batches.push(updates);
    await waitFor(() => batches.length === 0 && calls.filter((c) => c.method === "getUpdates").length >= before + 2);
  }
  const groupMsg = (text: string, from: { id: number; first: string }, date = Math.floor(clock / 1000)) => {
    const mid = nextMid++;
    return {
      mid,
      update: {
        update_id: nextUpdate++,
        message: {
          message_id: mid,
          date,
          chat: { id: CHAT, type: "supergroup", title: "frens" },
          from: { id: from.id, is_bot: false, first_name: from.first },
          text,
        },
      },
    };
  };

  before(async () => {
    for (const k of ["MERRYMEN_HOME", "MERRYMEN_SETTINGS_FILE", "MERRYMEN_HOSTED", "MERRYMEN_TG_GROUPS_LLM_KEY"]) saved[k] = process.env[k];
    home = mkdtempSync(path.join(tmpdir(), "tg-commands-"));
    process.env.MERRYMEN_HOME = home;
    process.env.MERRYMEN_SETTINGS_FILE = path.join(home, "settings.json");
    delete process.env.MERRYMEN_HOSTED;
    delete process.env.MERRYMEN_TG_GROUPS_LLM_KEY;
    globalThis.fetch = tgFetch as never;
    clock = T0;
    store = new TgGroupsStore(path.join(home, "tg-groups.json"), emptyTgGroupsState(), { now: () => clock, debounceMs: 60_000 });
    tstate = { ...loadTelegramState(), ownerId: OWNER };
    cfg = {
      ...resolveConfig(),
      telegramEnabled: true,
      telegramBotToken: TOKEN,
      telegramAllowlist: [OWNER],
      telegramControlEnabled: true,
      telegramMaxActionUsdg: 10,
      groqApiKey: undefined,
      anthropicApiKey: undefined,
      llmApiKey: undefined,
      llmProvider: undefined,
      telegramGroupsEnabled: true,
      telegramGroupCoinsEnabled: true,
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
      submitTrade: async (side, symbol, usdg) => {
        trades.push(`${side} ${symbol} ${usdg}`);
        return `✅ ${side} ${usdg} USDG of ${symbol} (paper)`;
      },
      submitTransfer: async () => "refused in tests",
      kill: () => ({ ok: false }) as never,
      tgGroupsStore: store,
      tgCoins: new FakePort(),
      tgGroupsTest: { now: () => clock, rand: () => 0.99, sleep: async () => {}, env: {}, log: () => {} },
      // The poll's own clock too: its backlog rule dates every update against
      // when it began listening, and these updates are dated by `clock`.
      now: () => Math.floor(clock / 1000),
    });
    stop = h.stop;
    // The owner adds it: approved, with its hello.
    await deliver({
      update_id: nextUpdate++,
      my_chat_member: {
        chat: { id: CHAT, type: "supergroup", title: "frens" },
        from: { id: OWNER, is_bot: false, first_name: "Mike" },
        date: Math.floor(clock / 1000),
        old_chat_member: { status: "left" },
        new_chat_member: { status: "member" },
      },
    });
    await waitFor(() => sendsTo(CHAT).length === 1);
    assert.equal(store.room(CHAT)?.status, "approved");
  });

  beforeEach(() => {
    // Every row starts from the ordinary setup, a few minutes on, so one
    // row's pacing never mutes the next.
    clock += 10 * MIN;
    cfg = { ...cfg, telegramAllowlist: [OWNER] };
    tstate = { ...tstate, ownerId: OWNER };
    neverStarted.clear();
    receiptLost.clear();
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

  it("the live code in '/link@SomeOtherBot CODE' is replaced and the owner told; the room hears nothing from us", async () => {
    tstate = ensureLinkCode(tstate);
    const live = tstate.linkCode;
    const dmBefore = sendsTo(OWNER).length;
    const groupBefore = sendsTo(CHAT).length;
    await deliver(groupMsg(`/link@someotherbot ${live}`, { id: CAT, first: "Cat" }).update);
    await waitFor(() => sendsTo(OWNER).length === dmBefore + 1);
    assert.notEqual(tstate.linkCode, live, "the code the whole room just saw no longer works");
    assert.equal(tstate.ownerId, OWNER);
    assert.ok(!tstate.linkedChats.includes(CHAT));
    assert.match(String(sendsTo(OWNER).at(-1)?.body.text), /link code got posted/);
    assert.equal(sendsTo(CHAT).length, groupBefore, "another bot's command gets no 'no code needed' from this one");
  });

  it("the live code followed by more words is replaced too, and our own /link still hears 'no code needed'", async () => {
    tstate = ensureLinkCode(tstate);
    const live = tstate.linkCode;
    const dmBefore = sendsTo(OWNER).length;
    const groupBefore = sendsTo(CHAT).length;
    await deliver(groupMsg(`/link ${live.toLowerCase()} pls`, { id: CAT, first: "Cat" }).update);
    await waitFor(() => sendsTo(OWNER).length === dmBefore + 1 && sendsTo(CHAT).length === groupBefore + 1);
    assert.notEqual(tstate.linkCode, live);
    assert.ok(!tstate.linkedChats.includes(CHAT));
    assert.match(String(sendsTo(CHAT).at(-1)?.body.text), /code/);
  });

  it("the live code with punctuation, backticks or brackets round it after /link is replaced, once per showing", async () => {
    const shapes: ((code: string) => string)[] = [
      (c) => `/link ${c}.`,
      (c) => `/link \`${c}\``,
      (c) => `/link (${c})`,
      (c) => `/link ${c}!`,
      // Glued inside a longer run: a handful of guesses finds where it starts.
      (c) => `/link x${c.toLowerCase()}y`,
    ];
    for (const shape of shapes) {
      tstate = ensureLinkCode(tstate);
      const live = tstate.linkCode;
      const dmBefore = sendsTo(OWNER).length;
      await deliver(groupMsg(shape(live), { id: CAT, first: "Cat" }).update);
      await waitFor(() => sendsTo(OWNER).length === dmBefore + 1);
      assert.notEqual(tstate.linkCode, live, `${shape("CODE")}: the code the room just saw no longer works`);
      assert.ok(!tstate.linkedChats.includes(CHAT));
      assert.match(String(sendsTo(OWNER).at(-1)?.body.text), /link code got posted/);
    }
    // One showing, one replacement and one DM: the line check and the /link
    // check never both fire on the same code.
    const dmAfter = sendsTo(OWNER).length;
    await deliver();
    assert.equal(sendsTo(OWNER).length, dmAfter);
  });

  it("the live code shown as a word in any group line is replaced; an ordinary line leaves it alone", async () => {
    tstate = ensureLinkCode(tstate);
    const kept = tstate.linkCode;
    const quietBefore = sendsTo(OWNER).length;
    await deliver(groupMsg("anyone around? market's slow today", { id: BOB, first: "Bob" }).update);
    assert.equal(tstate.linkCode, kept, "no code in the line, nothing replaced");
    assert.equal(sendsTo(OWNER).length, quietBefore);

    const photo = (caption: string) => {
      const mid = nextMid++;
      return {
        update_id: nextUpdate++,
        message: {
          message_id: mid,
          date: Math.floor(clock / 1000),
          chat: { id: CHAT, type: "supergroup", title: "frens" },
          from: { id: BOB, is_bot: false, first_name: "Bob" },
          photo: [{ file_id: "p1", file_unique_id: "u1", width: 90, height: 90 }],
          caption,
        },
      };
    };
    const shapes: ((code: string) => unknown)[] = [
      (c) => groupMsg(`try /link ${c}`, { id: CAT, first: "Cat" }).update,
      (c) => groupMsg(`the code is ${c.toLowerCase()}, go`, { id: CAT, first: "Cat" }).update,
      // Not a /link at all as far as parseSlash goes ("link:…" is no command).
      (c) => groupMsg(`/link:${c}`, { id: CAT, first: "Cat" }).update,
      (c) => photo(`dm the bot ${c} lol`),
    ];
    for (const shape of shapes) {
      tstate = ensureLinkCode(tstate);
      const live = tstate.linkCode;
      const dmBefore = sendsTo(OWNER).length;
      await deliver(shape(live));
      await waitFor(() => sendsTo(OWNER).length === dmBefore + 1);
      assert.notEqual(tstate.linkCode, live, JSON.stringify(shape("CODE")));
      assert.ok(!tstate.linkedChats.includes(CHAT));
      assert.equal(tstate.ownerId, OWNER);
    }
  });

  it("a bare command that is not ours ('/ban @spammer') is another bot's: nothing in the DM, nothing in the room", async () => {
    const before = allSends().length;
    await deliver(groupMsg("/ban @spammer", { id: OWNER, first: "Mike" }).update);
    await deliver(groupMsg("/warn @spammer", { id: BOB, first: "Bob" }).update);
    const after = allSends().slice(before);
    assert.deepEqual(
      after.map((c) => c.body.text),
      [],
      "no 'unknown command' DM, no 'sent it to your DMs', no 'only my owner can do that'",
    );
  });

  it("a usage slip on one of ours ('/buy') still goes to the owner's DM, with 'sent it to your DMs 🤫' in the room", async () => {
    const dmBefore = sendsTo(OWNER).length;
    const groupBefore = sendsTo(CHAT).length;
    const { mid, update } = groupMsg("/buy", { id: OWNER, first: "Mike" });
    await deliver(update);
    await waitFor(() => sendsTo(OWNER).length === dmBefore + 1 && sendsTo(CHAT).length === groupBefore + 1);
    assert.match(String(sendsTo(OWNER).at(-1)?.body.text), /usage: \/buy/);
    assert.equal(sendsTo(CHAT).at(-1)?.body.text, "sent it to your DMs 🤫");
    assert.equal(replyOf(sendsTo(CHAT).at(-1)), mid);
  });

  it("the owner's /groups typed in the group lists the groups in their DM; the room hears nothing", async () => {
    const dmBefore = sendsTo(OWNER).length;
    const groupBefore = sendsTo(CHAT).length;
    await deliver(groupMsg("/groups", { id: OWNER, first: "Mike" }).update);
    await waitFor(() => sendsTo(OWNER).length === dmBefore + 1);
    assert.match(String(sendsTo(OWNER).at(-1)?.body.text), /«frens»/);
    assert.ok(!sendsTo(OWNER).slice(dmBefore).some((c) => /unknown command/.test(String(c.body.text))));
    assert.equal(sendsTo(CHAT).length, groupBefore);
  });

  it("an owner whose DM is not on the allowlist (linked from the group long ago) is asked to DM first, never told 'sent it to your DMs'", async () => {
    cfg = { ...cfg, telegramAllowlist: [CHAT] };
    const dmBefore = sendsTo(OWNER).length;
    const groupBefore = sendsTo(CHAT).length;
    const { mid, update } = groupMsg("/pnl", { id: OWNER, first: "Mike" });
    await deliver(update);
    await waitFor(() => sendsTo(CHAT).length === groupBefore + 1);
    assert.equal(sendsTo(OWNER).length, dmBefore, "no '🚫 not authorized' DM");
    const line = sendsTo(CHAT).at(-1);
    assert.match(String(line?.body.text), /\/start/);
    assert.doesNotMatch(String(line?.body.text), /sent it to your DMs/);
    assert.equal(replyOf(line), mid);
  });

  it("an allowlisted member who never opened a DM with the bot is asked to DM first, never told 'sent it to your DMs'", async () => {
    cfg = { ...cfg, telegramAllowlist: [OWNER, ANN] };
    neverStarted.add(ANN);
    const dmTries = sendsTo(ANN).length;
    const groupBefore = sendsTo(CHAT).length;
    const { mid, update } = groupMsg("/status", { id: ANN, first: "Ann" });
    await deliver(update);
    await waitFor(() => sendsTo(ANN).length > dmTries && sendsTo(CHAT).length === groupBefore + 1);
    const line = sendsTo(CHAT).at(-1);
    assert.doesNotMatch(String(line?.body.text), /sent it to your DMs/);
    assert.match(String(line?.body.text), /\/start/);
    assert.equal(replyOf(line), mid);
  });

  it("an allowlisted member the bot cannot DM types /buy: nothing is bought, and the room is asked to DM first", async () => {
    cfg = { ...cfg, telegramAllowlist: [OWNER, DAN] };
    neverStarted.add(DAN);
    const tradesBefore = trades.length;
    const groupBefore = sendsTo(CHAT).length;
    const { mid, update } = groupMsg("/buy NVDA 5", { id: DAN, first: "Dan" });
    await deliver(update);
    await waitFor(() => sendsTo(CHAT).length === groupBefore + 1);
    assert.deepEqual(trades.slice(tradesBefore), [], "nothing runs whose receipt cannot land");
    assert.equal(typingTo(DAN).length, 1, "their DM was tried first");
    assert.equal(sendsTo(DAN).length, 0, "and no receipt was written");
    const line = sendsTo(CHAT).at(-1);
    assert.match(String(line?.body.text), /\/start/);
    assert.doesNotMatch(String(line?.body.text), /sent it to your DMs/);
    assert.equal(replyOf(line), mid);
  });

  it("the owner's /buy with their DM open: the DM is proved, the order runs once, the receipt lands, and the room hears it's in their DMs", async () => {
    const tradesBefore = trades.length;
    const dmBefore = sendsTo(OWNER).length;
    const groupBefore = sendsTo(CHAT).length;
    await deliver(groupMsg("/buy NVDA 5", { id: OWNER, first: "Mike" }).update);
    await waitFor(() => sendsTo(OWNER).length === dmBefore + 1 && sendsTo(CHAT).length === groupBefore + 1);
    assert.deepEqual(trades.slice(tradesBefore), ["buy NVDA 5"]);
    const probe = calls.lastIndexOf(typingTo(OWNER).at(-1)!);
    const receipt = calls.lastIndexOf(sendsTo(OWNER).at(-1)!);
    assert.ok(probe >= 0 && probe < receipt, "the DM is proved before the order runs");
    assert.match(String(sendsTo(OWNER).at(-1)?.body.text), /NVDA/);
    const line = String(sendsTo(CHAT).at(-1)?.body.text);
    assert.match(line, /DM/, "one of the 'sent it to your DMs 🤫' lines");
    assert.doesNotMatch(line, /\bfirst\b|NVDA|USDG|\d/, "no 'dm me first', and nothing of the receipt in the room");
  });

  it("an order that ran but whose receipt was lost tells the room it went through, never 'dm me first'", async () => {
    cfg = { ...cfg, telegramAllowlist: [OWNER, EVE] };
    receiptLost.add(EVE);
    const tradesBefore = trades.length;
    const groupBefore = sendsTo(CHAT).length;
    const { mid, update } = groupMsg("/buy NVDA 5", { id: EVE, first: "Eve" });
    await deliver(update);
    await waitFor(() => sendsTo(CHAT).length === groupBefore + 1);
    assert.deepEqual(trades.slice(tradesBefore), ["buy NVDA 5"], "it ran, once");
    assert.ok(sendsTo(EVE).length > 0, "the receipt was tried");
    const line = String(sendsTo(CHAT).at(-1)?.body.text);
    assert.doesNotMatch(line, /\bfirst\b/, "'dm me /start first' reads as 'it did not run', and invites a second /buy");
    assert.doesNotMatch(line, /sent it to your DMs/);
    assert.match(line, /\b(done|got it|went through|handled)\b/i);
    assert.equal(replyOf(sendsTo(CHAT).at(-1)), mid);
  });

  it("the bot's display name from getMe calls it like its name does", async () => {
    const groupBefore = sendsTo(CHAT).length;
    const { mid, update } = groupMsg("zorblax, what do you think?", { id: BOB, first: "Bob" });
    await deliver(update);
    await waitFor(() => sendsTo(CHAT).length === groupBefore + 1);
    assert.equal(replyOf(sendsTo(CHAT).at(-1)), mid);
  });

  // ── The poll's backlog rule, in a group ──────────────────────────────────
  //
  // Listening began at the first poll, at T0. A line dated before it waited
  // out a silence (a restart, a redeploy, an outage): the room has moved on,
  // so it is dropped, not answered hours late, and none of a DM's backlog
  // notes go to a room.
  const BEFORE_LISTENING = Math.floor(T0 / 1000) - 3_600;

  it("a group line from before the bot was listening is not answered, remembered or run, and the room hears no DM note", async () => {
    const tradesBefore = trades.length;
    const groupBefore = sendsTo(CHAT).length;
    const dmBefore = sendsTo(OWNER).length;
    const catBefore = sendsTo(CAT).length;
    const typingBefore = typingTo(OWNER).length;
    const lines = store.room(CHAT)?.lines.length ?? 0;
    const late = [
      groupMsg("zorblax, what do you think?", { id: BOB, first: "Bob" }, BEFORE_LISTENING),
      groupMsg("/buy NVDA 5", { id: OWNER, first: "Mike" }, BEFORE_LISTENING),
      groupMsg("/status", { id: CAT, first: "Cat" }, BEFORE_LISTENING),
      groupMsg("/link WRONGCODE", { id: CAT, first: "Cat" }, BEFORE_LISTENING),
      groupMsg("/buy@someotherbot NVDA 5", { id: OWNER, first: "Mike" }, BEFORE_LISTENING),
    ];
    await deliver(...late.map((m) => m.update));
    await waitFor(() => sendsTo(OWNER).length === dmBefore + 1);
    await deliver();
    assert.equal(sendsTo(CHAT).length, groupBefore, "nothing said in the room");
    assert.deepEqual(trades.slice(tradesBefore), [], "an order typed into the room during the silence never runs");
    assert.equal(typingTo(OWNER).length, typingBefore, "nor is the owner's DM probed for it");
    assert.equal(store.room(CHAT)?.lines.length ?? 0, lines, "nor remembered");
    // The owner's /buy would have been answered in their DM, so that is where
    // they hear it was held back: one note, as for a late /buy sent there.
    // Another bot's command is not counted.
    const said = sendsTo(OWNER).slice(dmBefore).map((c) => String(c.body.text));
    assert.equal(said.length, 1, said.join("\n"));
    assert.match(said[0]!, /^I was offline; 1 message arrived late \(oldest .+\)\. I didn't act on it/);
    assert.equal(sendsTo(CAT).length, catBefore, "someone not on the allowlist hears nothing, in the room or their DM");
    assert.ok(
      !allSends().some((c) => /not authorized|reached me after|just been connected/.test(String(c.body.text))),
      "no refusal or late-code prompt anywhere",
    );
  });

  it("a late /pause or /kill the owner typed in the room runs in their DM, as a late DM one does, and the room hears nothing", async () => {
    const groupBefore = sendsTo(CHAT).length;
    const dmBefore = sendsTo(OWNER).length;
    const catBefore = sendsTo(CAT).length;
    assert.equal(isPaused(), false, "premise");
    try {
      await deliver(
        groupMsg("/kill", { id: CAT, first: "Cat" }, BEFORE_LISTENING).update,
        groupMsg("/pause@someotherbot", { id: OWNER, first: "Mike" }, BEFORE_LISTENING).update,
        groupMsg("/pause", { id: OWNER, first: "Mike" }, BEFORE_LISTENING).update,
        groupMsg("/kill@pinebot", { id: OWNER, first: "Mike" }, BEFORE_LISTENING).update,
      );
      await waitFor(() => sendsTo(OWNER).length === dmBefore + 2);
      await deliver();
      assert.equal(isPaused(), true, "a /pause typed during an outage still pauses: it only reduces risk");
      const said = sendsTo(OWNER).slice(dmBefore).map((c) => String(c.body.text));
      assert.equal(said.length, 2, said.join("\n"));
      assert.match(said[0]!, /paused/);
      assert.match(said[1]!, /confirm kill/, "a /kill still only asks, and the /confirm must be sent live");
      assert.ok(!said.some((t) => /offline|arrived late/.test(t)), "nothing was held back, so no note");
      assert.equal(sendsTo(CHAT).length, groupBefore, "no 'sent it to your DMs' for a late one");
      assert.equal(sendsTo(CAT).length, catBefore, "a /kill from someone not on the allowlist reaches nobody");
    } finally {
      setPaused(false);
      // The parked kill is not left for a later row's /confirm.
      await deliver({
        update_id: nextUpdate++,
        message: { message_id: nextMid++, date: Math.floor(clock / 1000), chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "Mike" }, text: "/cancel" },
      });
    }
  });

  it("A LATE /forgetme STILL WIPES: every /forgetme does, and a redeploy's restart is a silence", async () => {
    const bobs = () => (store.room(CHAT)?.lines ?? []).filter((l) => l.fromId === BOB).length;
    await deliver(groupMsg("gm frens, anyone watching NVDA today?", { id: BOB, first: "Bob" }).update);
    await waitFor(() => bobs() > 0 && store.person(CHAT, BOB) !== undefined);
    const said = sendsTo(CHAT).length;
    // Another bot's /forgetme is that bot's to honour, late or live.
    await deliver(groupMsg("/forgetme@someotherbot", { id: BOB, first: "Bob" }, BEFORE_LISTENING).update);
    await deliver();
    assert.ok(bobs() > 0, "another bot's command wipes nothing here");
    await deliver(groupMsg("/forgetme", { id: BOB, first: "Bob" }, BEFORE_LISTENING).update);
    await deliver();
    assert.equal(bobs(), 0, "their lines are gone");
    assert.equal(store.person(CHAT, BOB), undefined, "and so is their entry");
    const records = parseTgForgets(readFileSync(path.join(home, TG_GROUPS_FORGET_FILE), "utf8"));
    assert.ok(records.some((r) => r.chatId === CHAT && r.userId === BOB), "and the request is written down for the stored copy");
    assert.equal(sendsTo(CHAT).length, said, "a late one is done, not answered: the room has moved on");
  });

  it("the owner's late /forget still wipes that group, and says nothing", async () => {
    await deliver(groupMsg("anyone around?", { id: ANN, first: "Ann" }).update);
    await waitFor(() => (store.room(CHAT)?.lines ?? []).some((l) => l.fromId === ANN));
    const said = sendsTo(CHAT).length;
    const dmBefore = sendsTo(OWNER).length;
    // Someone else's /forget is not theirs to give.
    await deliver(groupMsg("/forget", { id: CAT, first: "Cat" }, BEFORE_LISTENING).update);
    await deliver();
    assert.ok((store.room(CHAT)?.lines ?? []).some((l) => l.fromId === ANN));
    await deliver(groupMsg("/forget", { id: OWNER, first: "Mike" }, BEFORE_LISTENING).update);
    await deliver();
    assert.deepEqual(store.room(CHAT)?.lines ?? [], [], "the whole chat's memory");
    assert.equal(store.room(CHAT)?.status, "approved", "and nothing about whether it talks there");
    assert.equal(sendsTo(CHAT).length, said, "nothing in the room");
    assert.equal(sendsTo(OWNER).length, dmBefore, "nor in the owner's DM: a forget is not a command held back");
  });

  it("from before the switch to this agent, a /forgetme still wipes, but nothing runs and nobody is told", async () => {
    const boundBefore = tstate.boundAt;
    const dmBefore = sendsTo(OWNER).length;
    const bobs = () => (store.room(CHAT)?.lines ?? []).filter((l) => l.fromId === BOB).length;
    await deliver(groupMsg("still here", { id: BOB, first: "Bob" }).update);
    await waitFor(() => bobs() > 0);
    const said = sendsTo(CHAT).length;
    try {
      // This agent was switched onto the bot after these were sent.
      tstate = { ...tstate, boundAt: BEFORE_LISTENING + 60 };
      await deliver(
        groupMsg("/pause", { id: OWNER, first: "Mike" }, BEFORE_LISTENING).update,
        groupMsg("/buy NVDA 5", { id: OWNER, first: "Mike" }, BEFORE_LISTENING).update,
        groupMsg("/forgetme", { id: BOB, first: "Bob" }, BEFORE_LISTENING).update,
      );
      await deliver();
    } finally {
      tstate = { ...tstate, boundAt: boundBefore };
    }
    assert.equal(bobs(), 0, "a wipe is nobody else's to stop");
    assert.equal(isPaused(), false, "on a bot that served another agent, a /pause was that agent's");
    assert.equal(sendsTo(OWNER).length, dmBefore, "and no note: holdEarly's rule");
    assert.equal(sendsTo(CHAT).length, said);
  });

  it("a late line still gives the live code up: it is replaced, and only the owner hears why", async () => {
    tstate = ensureLinkCode(tstate);
    const live = tstate.linkCode;
    const groupBefore = sendsTo(CHAT).length;
    const dmBefore = sendsTo(OWNER).length;
    await deliver(groupMsg(`try /link ${live}`, { id: CAT, first: "Cat" }, BEFORE_LISTENING).update);
    await waitFor(() => sendsTo(OWNER).length === dmBefore + 1);
    assert.notEqual(tstate.linkCode, live, "the room saw it whenever it was typed");
    assert.match(String(sendsTo(OWNER).at(-1)?.body.text), /link code got posted/);
    assert.equal(sendsTo(CHAT).length, groupBefore);
    assert.ok(!tstate.linkedChats.includes(CHAT));
  });

  it("the owner adding it while nobody listened is recorded, without a hello hours late", async () => {
    const LATE_ROOM = -1009876543210;
    await deliver({
      update_id: nextUpdate++,
      my_chat_member: {
        chat: { id: LATE_ROOM, type: "supergroup", title: "late frens" },
        from: { id: OWNER, is_bot: false, first_name: "Mike" },
        date: BEFORE_LISTENING,
        old_chat_member: { status: "left" },
        new_chat_member: { status: "member" },
      },
    });
    await deliver();
    assert.equal(store.room(LATE_ROOM)?.status, "approved", "the owner's add stands");
    assert.deepEqual(sendsTo(LATE_ROOM), [], "and nothing is said about it now");
    // A live line afterwards is answered as in any approved group.
    const { mid, update } = groupMsg("zorblax, you there?", { id: BOB, first: "Bob" });
    const withChat = { ...update, message: { ...update.message, chat: { id: LATE_ROOM, type: "supergroup", title: "late frens" } } };
    await deliver(withChat);
    await waitFor(() => sendsTo(LATE_ROOM).length === 1);
    assert.equal(replyOf(sendsTo(LATE_ROOM)[0]), mid);
  });

  it("a Stay pressed on a question asked before a restart still counts: the group's buttons are durable", async () => {
    const ASKED = -1004444444444;
    const dmBefore = sendsTo(OWNER).length;
    // A stranger adds it, live: pending, and the owner is asked in their DM.
    await deliver({
      update_id: nextUpdate++,
      my_chat_member: {
        chat: { id: ASKED, type: "supergroup", title: "asked" },
        from: { id: CAT, is_bot: false, first_name: "Cat" },
        date: Math.floor(clock / 1000),
        old_chat_member: { status: "left" },
        new_chat_member: { status: "member" },
      },
    });
    await waitFor(() => sendsTo(OWNER).length === dmBefore + 1);
    assert.equal(store.room(ASKED)?.status, "pending");
    const ask = sendsTo(OWNER).at(-1)!;
    const rows = (ask.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }).inline_keyboard;
    const stay = rows.flat().find((b) => b.callback_data?.startsWith("tgg:stay:"))?.callback_data;
    assert.ok(stay, "premise: the ask carries a Stay button");
    // The press arrives on a message dated before listening began, as it does
    // after any restart: a DM's parked question would be expired by now, this
    // one is not.
    await deliver({
      update_id: nextUpdate++,
      callback_query: { id: "q-late", data: stay, from: { id: OWNER }, message: { message_id: 1, chat: { id: OWNER }, date: BEFORE_LISTENING } },
    });
    await waitFor(() => store.room(ASKED)?.status === "approved");
    const answered = calls.filter((c) => c.method === "answerCallbackQuery" && c.body.callback_query_id === "q-late");
    assert.ok(!answered.some((c) => /expired/.test(String(c.body.text))), "not answered as expired");
  });
});

describe("getMe exposes the bot's display name", () => {
  const fetchOf =
    (result: unknown): FetchLike =>
    async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

  it("first_name becomes firstName, trimmed", async () => {
    const { bot } = await getMe({ token: "t", fetchFn: fetchOf({ id: 42, is_bot: true, first_name: " Pine Bot ", username: "pine_bot" }) });
    assert.equal(bot?.firstName, "Pine Bot");
  });

  it("a missing or blank first_name leaves it out", async () => {
    const a = await getMe({ token: "t", fetchFn: fetchOf({ id: 42, username: "pine_bot" }) });
    assert.equal(a.bot !== null && "firstName" in a.bot, false);
    const b = await getMe({ token: "t", fetchFn: fetchOf({ id: 42, username: "pine_bot", first_name: "  " }) });
    assert.equal(b.bot !== null && "firstName" in b.bot, false);
  });
});
