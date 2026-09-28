/**
 * docs/tg-groups.md "Commands in groups", through the real poll service.
 *
 * The rows scenarios.test.ts does not pin: which slash commands typed in a
 * group are this bot's at all, when the room may be told "sent it to your
 * DMs", and that the live link code is replaced whoever the /link names.
 * Same harness as scenarios.test.ts's poll-service block: every Telegram call
 * is answered by a fake behind global fetch, the child's home is a temp dir,
 * and the group handler runs on a fake clock with no waits.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { resolveConfig, type ResolvedConfig } from "../../settings";
import { getMe, type FetchLike } from "../api";
import { startTelegram } from "../service";
import { ensureLinkCode, loadTelegramState, type TelegramState } from "../state";
import { TgGroupsStore, emptyTgGroupsState } from "./store";
import type { CoinLook, CoinOutcome, NominateResult, Nomination, TgCoinsPort, TrencherReadiness } from "./types";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const CHAT = -1001234567890;
const OWNER = 424242;
const ANN = 717171;
const BOB = 818181;
const CAT = 919191;
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
    } else if (method === "sendMessage") env = { ok: true, result: { message_id: nextSent++ } };
    return { ok: true, status: 200, json: async () => env };
  };

  const sendsTo = (chatId: number): Call[] => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);
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
  const groupMsg = (text: string, from: { id: number; first: string }) => {
    const mid = nextMid++;
    return {
      mid,
      update: {
        update_id: nextUpdate++,
        message: {
          message_id: mid,
          date: Math.floor(clock / 1000),
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
      submitTrade: async () => "refused in tests",
      submitTransfer: async () => "refused in tests",
      kill: () => ({ ok: false }) as never,
      tgGroupsStore: store,
      tgCoins: new FakePort(),
      tgGroupsTest: { now: () => clock, rand: () => 0.99, sleep: async () => {}, env: {}, log: () => {} },
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
    tstate = ensureLinkCode(tstate, TOKEN);
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
    tstate = ensureLinkCode(tstate, TOKEN);
    const live = tstate.linkCode;
    const dmBefore = sendsTo(OWNER).length;
    const groupBefore = sendsTo(CHAT).length;
    await deliver(groupMsg(`/link ${live.toLowerCase()} pls`, { id: CAT, first: "Cat" }).update);
    await waitFor(() => sendsTo(OWNER).length === dmBefore + 1 && sendsTo(CHAT).length === groupBefore + 1);
    assert.notEqual(tstate.linkCode, live);
    assert.ok(!tstate.linkedChats.includes(CHAT));
    assert.match(String(sendsTo(CHAT).at(-1)?.body.text), /code/);
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

  it("the bot's display name from getMe calls it like its name does", async () => {
    const groupBefore = sendsTo(CHAT).length;
    const { mid, update } = groupMsg("zorblax, what do you think?", { id: BOB, first: "Bob" });
    await deliver(update);
    await waitFor(() => sendsTo(CHAT).length === groupBefore + 1);
    assert.equal(replyOf(sendsTo(CHAT).at(-1)), mid);
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
