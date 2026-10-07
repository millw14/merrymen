/**
 * SOCIAL-TRADING RESEARCH IN A TELEGRAM DM, end to end through the real
 * startTelegram over a scripted Bot API and a mocked clock, with the real
 * planner, renderer, subject memory and research service over a
 * fixture-backed provider, reached through the real in-process broker (the
 * tenant is the broker's, fixed by trusted context).
 *
 * What these pin:
 *   - a research question is answered by a REGISTERED tool through the broker
 *     (the DM surface, the owner audience only for the linked owner, this
 *     chat's conversation), from the envelope, before the classifier;
 *   - a factual question makes no model call; an analysis is worded by the
 *     DM's model from fenced evidence, with the not-permission line;
 *   - follow-ups keep the coin and its chain; a correction replaces it;
 *   - data access switched off: an honest refusal and no data; no broker: an
 *     honest "not available";
 *   - a watch comes only from the owner's own DM, through the planner;
 *   - a deep job's result is delivered once, to the same chat, and not after
 *     the owner changes;
 *   - slash commands, orders and /forget behave as before (and /forget also
 *     clears what the research remembers).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it, mock } from "node:test";

import type { BrokerCallOptions, FomoAccess, FomoBroker } from "../fomo/contract";
import type { FomoToolName } from "../fomo/types";
import type { FollowReadiness } from "../fomo-child";
import type { TelegramState } from "./state";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-fomo-dm-"));
process.env.MERRYMEN_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

const { startTelegram } = await import("./service");
const { FOMO_UNAVAILABLE_TEXT, FOMO_OWNER_ONLY_TEXT } = await import("./answer");
const { wrapSqlite } = await import("../db");
const { createDirectBroker } = await import("../fomo/broker");
const { FomoBudget, MemoryAllowance } = await import("../fomo/budget");
const { createFomoClient } = await import("../fomo/provider");
const { FOMO_ATTRIBUTION, NOT_PERMISSION_LINE } = await import("../fomo/render");
const { TAIL_CAP_SPENT_LINE } = await import("../fomo/tail-notices");
const { TAIL_MUTED_LINE } = await import("./fomo-tail");
const { createFomoService, runPendingJobs } = await import("../fomo/service");
const fstore = await import("../fomo/store");
const { recentChatTurns } = await import("../store");
const { createTgFomoPort } = await import("../tg-fomo-port");
const { TgGroupsStore, emptyTgGroupsState } = await import("./tg-groups/store");

type Rec = Record<string, unknown>;

const T0 = Date.UTC(2026, 9, 4, 16, 5);
const ALERTS_NEWEST = 1788378000000;
const OWNER = 5150;
const GROUP = -1001234567890;
const FRIEND = 6160;
const PONS = "0x39dbed3a00000000000000000000000000000c0d";
const OTHER = "0x" + "b2".repeat(20);
const TENANT = "0xowner00000000000000000000000000000000001";

const fixture = (name: string): Rec => JSON.parse(readFileSync(new URL(`../fomo/testdata/${name}.json`, import.meta.url), "utf8")) as Rec;
const fjson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-credits-cost": "250" } });
/** Telegram HTML back to plain text. */
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function blankState(over: Partial<TelegramState> = {}): TelegramState {
  return {
    offset: 0, botId: null, priorBots: [], tokenTag: null, boundAt: null, chatSettings: null, linkCode: "",
    linkRound: 0, ownerId: OWNER, linkedAt: null,
    linkedChats: [OWNER], linkedChatAt: {}, messageCount: 0, lastNotifiedTradeId: -1, lastTradeDigestAt: 0, lastRemedyRule: null,
    firedAlerts: {}, signWatch: null, lastDigestDate: "", lastJournalDate: "", priceAlerts: [], reminders: [],
    watchers: [], nextId: 1, poll: null, ...over,
  };
}

/** The research side: a real service over fixtures, behind the real in-process broker, with a spy in front. */
async function fomoFixture(o: { liveFeed?: boolean; search?: Rec } = {}) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await fstore.ensureFomoSchema(db, "sqlite");
  const provider: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    provider.push(u.pathname);
    const p = u.pathname;
    if (p === "/v2/tokens/search") return fjson(fixture("tokens-search"));
    if (p === "/v2/search") return fjson(o.search ?? fixture("search"));
    if (p === "/v2/alerts") {
      const b = fixture("alerts");
      const shift = Date.now() - 60_000 - ALERTS_NEWEST;
      for (const a of b.alerts as Rec[]) {
        if (typeof a.ts === "number") a.ts += shift;
        if (typeof a.execTs === "number") a.execTs += shift;
      }
      return fjson(b);
    }
    if (p.startsWith("/v2/thesis/token/")) return fjson(fixture("theses-token"));
    if (/\/stats$/.test(p)) return fjson(fixture("token-stats"));
    if (/\/balances$/.test(p)) return fjson(fixture("balances"));
    return fjson({ error: "not_found" }, 404);
  }) as typeof fetch;
  const client = createFomoClient({ apiKey: "test_key_not_a_credential_0000", fetchImpl, now: () => Date.now(), sleep: async () => {}, random: () => 0 });
  const budget = new FomoBudget({
    port: new MemoryAllowance(),
    config: { sharedDailyCredits: 10_000_000, tenantHourlyCredits: 1_000_000, tenantDailyCredits: 1_000_000, groupHourlyCredits: 1_000_000 },
    now: () => Date.now(),
  });
  const access: FomoAccess = { dataAccess: true, monitoring: false, follow: false };
  const service = createFomoService({ db, dialect: "sqlite", client, access: async () => ({ ...access }), budget, now: () => Date.now(), ...(o.liveFeed ? { liveFeed: true } : {}) });
  const direct = createDirectBroker(service, TENANT, { now: () => Date.now() });
  const calls: { tool: FomoToolName; args: Rec; opts: BrokerCallOptions }[] = [];
  const cleared: string[] = [];
  /** A lookup can be held open (hold.until), to act while it runs. */
  const hold: { until: Promise<void> | null } = { until: null };
  const broker: FomoBroker = {
    call: async (tool, args, opts) => {
      calls.push({ tool, args: { ...args }, opts: { ...opts, signal: undefined } });
      if (hold.until) await hold.until;
      return direct.call(tool, args, opts);
    },
    memory: {
      get: (k) => direct.memory.get(k),
      set: (k, j) => direct.memory.set(k, j),
      clear: (k) => (cleared.push(k), direct.memory.clear(k)),
    },
    report: (r) => direct.report(r),
    configured: () => direct.configured(),
  };
  return { raw, db, service, broker, calls, cleared, provider, access, hold };
}
type Fixture = Awaited<ReturnType<typeof fomoFixture>>;

interface Call {
  method: string;
  body: Record<string, unknown>;
}

interface Harness {
  calls: Call[];
  /** Every request to anything that is not the Bot API: a model call, in this file. */
  llm: string[];
  composed: { system: string; prompt: string }[];
  fx: Fixture;
  state: () => TelegramState;
  setState: (s: TelegramState) => void;
  cfg: Record<string, unknown>;
  /** A live line in the group from `from`. */
  sayInGroup: (text: string, from?: number) => void;
  /** From now on, messages to her DM fail (the typing action still goes through). */
  ownerSendsFail: (fail: boolean) => void;
  /** A live DM from `from`, optionally replying to a message (Telegram's reply_to_message). */
  say: (text: string, from?: number, replyTo?: Record<string, unknown>) => void;
  /** The message_id Telegram gave each sendMessage, in order. */
  sentIds: (chat: number) => number[];
  sentTo: (chat: number) => string[];
  /** The raw body of the last sendMessage to a chat (its reply_markup included). */
  lastBody: (chat: number) => Record<string, unknown> | undefined;
  /** A live button press by `from` on message `messageId` of chat `chat`. */
  press: (data: string, messageId: number, from?: number, chat?: number) => void;
  /** Tick the mocked clock until `done()` or `ms` have passed. */
  until: (done: () => boolean, ms?: number) => Promise<void>;
  advance: (ms: number) => Promise<void>;
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

async function withDm(
  opts: {
    llm?: boolean;
    broker?: "fixture" | "absent" | "null";
    composeReply?: string | null;
    fomoOff?: boolean;
    /** Groups on, with a group model whose routing calls answer with this pick. */
    groupPick?: Record<string, unknown>;
    /** The owner never pressed /start: Telegram refuses anything sent to her DM. */
    dmBlocked?: boolean;
    allowlist?: number[];
    /** The hosted live feed (tails need it). */
    liveFeed?: boolean;
    /** A /v2/search body instead of the fixture's. */
    search?: Rec;
    /** What following would do with a buy now (the child's followReadiness). */
    readiness?: () => FollowReadiness | null;
    /** Whether a tail's 30 notices are spent (the child's tail notifier). */
    capSpent?: (userId: string) => Promise<boolean | null>;
    /** Whether a tail can work here (index.ts fomoTailsState). */
    tailsState?: () => "on" | "switched-off" | "no-live-feed";
    /** Records the child's tailRevoked calls (index.ts onFomoTailRevoked). */
    revoked?: Array<string | null>;
  },
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const llm: string[] = [];
  const composed: Harness["composed"] = [];
  const cfg: Record<string, unknown> = {
    telegramEnabled: true,
    telegramBotToken: "111:a",
    telegramAllowlist: opts.allowlist ?? [OWNER, FRIEND],
    telegramControlEnabled: true,
    telegramTransferEnabled: false,
    telegramPcControlEnabled: false,
    telegramAgentEnabled: false,
    telegramCapabilities: [],
    telegramMaxActionUsdg: 25,
    // Her "all Telegram messages" on, as by default (core settings.ts).
    telegramNotifyEnabled: true,
    // Research runs for her coins (a tail's "my read"): data access and monitoring on.
    fomoDataAccess: true,
    fomoMonitoringEnabled: true,
    fomoFollowEnabled: false,
    customTokens: [],
    ...(opts.llm ? { groqApiKey: "gsk_test_not_a_real_key", groqModel: "test-model" } : {}),
  };
  let state = blankState();
  /** Telegram takes the typing action but refuses messages to her DM. */
  const ownerSends = { fail: false };
  const queue: unknown[] = [];
  let updateId = 1;
  let nextMessageId = 50_000;
  const realFetch = globalThis.fetch;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const m = /\/bot([^/]+)\/(\w+)$/.exec(String(url));
    if (!m && opts.groupPick && String(url).startsWith("https://llm.test/")) {
      // The group's own model: a routing call gets the pick, anything else a short line.
      const tools = (JSON.parse(init?.body ?? "{}") as { tools?: unknown }).tools;
      llm.push(tools ? "group-route" : "group-line");
      const message = tools ? { tool_calls: [{ function: { name: "route", arguments: JSON.stringify(opts.groupPick) } }] } : { content: "ngl no clue" };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
    }
    if (!m) {
      llm.push(String(url));
      return { ok: false, status: 500, json: async () => ({ error: { message: "no model in this test" } }), text: async () => "no model in this test" };
    }
    const call: Call = { method: m[2]!, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} };
    calls.push(call);
    const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
    if ((opts.dmBlocked && (call.method === "sendChatAction" || call.method === "sendMessage") || (ownerSends.fail && call.method === "sendMessage")) && call.body.chat_id === OWNER) {
      return { ok: false, status: 403, json: async () => ({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" }) };
    }
    if (call.method === "getMe") return ok({ id: 111, username: "bot111", first_name: "Pine" });
    if (call.method === "getUpdates") return ok(queue.splice(0));
    if (call.method === "sendMessage") {
      const message_id = nextMessageId++;
      call.body.__message_id = message_id;
      return ok({ message_id });
    }
    return ok(true);
  }) as typeof fetch;
  const fx = await fomoFixture({ ...(opts.liveFeed ? { liveFeed: true } : {}), ...(opts.search ? { search: opts.search } : {}) });
  const groupHome = opts.groupPick ? mkdtempSync(path.join(os.tmpdir(), "merrymen-fomo-group-")) : null;
  const groupStore = groupHome ? new TgGroupsStore(path.join(groupHome, "tg-groups.json"), emptyTgGroupsState(), { debounceMs: 60_000 }) : null;
  if (groupStore) {
    cfg.telegramGroupsEnabled = true;
    cfg.telegramGroupCoinsEnabled = false;
    cfg.telegramGroupsChattiness = "normal";
    groupStore.ensureRoom(GROUP, { title: "frens", kind: "supergroup" });
    groupStore.setStatus(GROUP, "approved", OWNER);
    groupStore.update(GROUP, (r) => {
      r.helloSaid = true;
    });
  }
  const h: Harness = {
    calls,
    llm,
    composed,
    fx,
    state: () => state,
    setState: (s) => {
      state = s;
    },
    cfg,
    ownerSendsFail: (fail) => {
      ownerSends.fail = fail;
    },
    sayInGroup: (text, from = OWNER) => {
      const id = updateId++;
      queue.push({
        update_id: id,
        message: {
          message_id: 1000 + id,
          text,
          date: Math.floor(Date.now() / 1000),
          chat: { id: GROUP, type: "supergroup", title: "frens" },
          from: { id: from, is_bot: false, first_name: from === OWNER ? "Milla" : "Friend" },
        },
      });
    },
    say: (text, from = OWNER, replyTo) => {
      const id = updateId++;
      queue.push({
        update_id: id,
        message: {
          message_id: 1000 + id,
          text,
          date: Math.floor(Date.now() / 1000),
          chat: { id: from, type: "private" },
          from: { id: from, is_bot: false, first_name: "Owner" },
          ...(replyTo ? { reply_to_message: replyTo } : {}),
        },
      });
    },
    sentTo: (chat) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chat).map((c) => plain(String(c.body.text))),
    sentIds: (chat) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chat).map((c) => Number(c.body.__message_id)),
    lastBody: (chat) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chat).at(-1)?.body,
    press: (data, messageId, from = OWNER, chat = from) => {
      const id = updateId++;
      queue.push({
        update_id: id,
        callback_query: { id: `cb${id}`, data, from: { id: from }, message: { message_id: messageId, chat: { id: chat }, date: Math.floor(Date.now() / 1000) } },
      });
    },
    until: async (done, ms = 20_000) => {
      for (let t = 0; t < ms && !done(); t += 250) {
        mock.timers.tick(250);
        await settle();
      }
    },
    advance: async (ms) => {
      for (let t = 0; t < ms; t += 250) {
        mock.timers.tick(Math.min(250, ms - t));
        await settle();
      }
    },
  };
  const svc = startTelegram({
    getCfg: () => ({ ...cfg, telegramAllowlist: [...(cfg.telegramAllowlist as number[])] }) as never,
    stateRef: { get: () => state, set: (s) => { state = s; } },
    note: () => {},
    buildStatusContext: () => ({ agentId: null }) as never,
    setStrategy: () => ({ ok: true }),
    grantPerTradeUsdg: () => undefined,
    grantHasTransfer: () => false,
    readDepth: async () => "",
    submitTrade: async () => "no trades in this test",
    submitTransfer: async () => "no transfers in this test",
    kill: () => ({ ok: true }),
    ...(opts.broker === "absent" ? {} : { fomo: () => (opts.broker === "null" ? null : fx.broker) }),
    ...(opts.fomoOff ? { fomoOff: true } : {}),
    ...(opts.readiness ? { fomoFollowReadiness: opts.readiness } : {}),
    ...(opts.capSpent ? { fomoTailCapSpent: opts.capSpent } : {}),
    ...(opts.tailsState ? { fomoTailsState: opts.tailsState } : {}),
    ...(opts.revoked ? { onFomoTailRevoked: (u: string | null) => void opts.revoked!.push(u) } : {}),
    ...(groupStore
      ? {
          tgGroupsStore: groupStore,
          fomoGroupPort: () => createTgFomoPort(() => fx.broker),
          tgGroupsTest: {
            rand: () => 0.99,
            sleep: async () => {},
            log: () => {},
            env: {
              MERRYMEN_TG_GROUPS_LLM_KEY: "k-test",
              MERRYMEN_TG_GROUPS_LLM_PROVIDER: "openai",
              MERRYMEN_TG_GROUPS_LLM_BASE_URL: "https://llm.test/v1",
              MERRYMEN_TG_GROUPS_MODEL: "fake",
            },
          },
        }
      : {}),
    fomoComposeText: async (_creds, o) => {
      composed.push({ system: o.system, prompt: o.prompt });
      return opts.composeReply === undefined ? "On the evidence read, the support is thin and mostly one trader." : (opts.composeReply ?? "");
    },
  });
  try {
    await settle();
    await body(h);
  } finally {
    svc.stop();
    mock.timers.reset();
    globalThis.fetch = realFetch;
    groupStore?.close();
    if (groupHome) rmSync(groupHome, { recursive: true, force: true });
  }
}

/** Say it, and wait for the next reply to that chat. */
async function ask(h: Harness, text: string, from = OWNER, replyTo?: Record<string, unknown>): Promise<string> {
  const before = h.sentTo(from).length;
  h.say(text, from, replyTo);
  await h.until(() => h.sentTo(from).length > before);
  const out = h.sentTo(from);
  assert.ok(out.length > before, `no reply to ${JSON.stringify(text)}`);
  return out[out.length - 1]!;
}

const count = (raw: DatabaseSync, table: string): number => Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe("social-trading research in a DM", () => {
  it("a research question is a registered tool through the broker, answered from its envelope, with no model call when it is factual", async () => {
    await withDm({ llm: true }, async (h) => {
      const reply = await ask(h, "what are the theses on $PONS");
      assert.deepEqual(h.fx.calls.map((c) => c.tool), ["fomo_get_token_theses"]);
      const o = h.fx.calls[0]!.opts;
      assert.equal(o.surface, "telegram-dm");
      assert.equal(o.audience, "owner");
      assert.equal(o.conversationKey, `tg-dm:${OWNER}`);
      assert.equal(o.priority, "interactive");
      assert.ok(typeof o.timeoutMs === "number" && o.timeoutMs <= 15_000);
      assert.match(reply, /^\$PONS on robinhood \(0x39db…0c0d\): 3 theses/);
      assert.ok(reply.endsWith(FOMO_ATTRIBUTION));
      assert.deepEqual(h.llm, [], "a factual research question never reaches a model");
      assert.equal(h.composed.length, 0);
      // Kept in the DM's history like any other answer.
      const turns = await recentChatTurns(OWNER, 4);
      assert.ok(turns.some((t) => t.role === "user" && t.content === "what are the theses on $PONS"));
      assert.ok(turns.some((t) => t.role === "assistant" && /3 theses/.test(t.content)));
    });
  });

  it("a follow-up keeps the coin and its chain; a correction replaces the subject", async () => {
    await withDm({}, async (h) => {
      await ask(h, "what are the theses on $PONS");
      await ask(h, "What about the sellers?");
      assert.equal(h.fx.calls[1]!.tool, "fomo_get_token_activity");
      assert.deepEqual(h.fx.calls[1]!.args, { token: PONS, chain: "robinhood", side: "sell" });
      await ask(h, `no I meant ${OTHER}`);
      const last = h.fx.calls[h.fx.calls.length - 1]!;
      assert.equal(last.args.token, OTHER);
      assert.ok(!("chain" in last.args), "the old coin's chain is not carried onto the new address");
    });
  });

  it("an analysis is worded by the DM's model from fenced evidence, under the research rules, with the not-permission line", async () => {
    await withDm({ llm: true }, async (h) => {
      await ask(h, "what are the theses on $PONS");
      const reply = await ask(h, "should we follow this?");
      assert.equal(h.composed.length, 1);
      assert.match(h.composed[0]!.system, /FOMO RESEARCH RULES/);
      assert.match(h.composed[0]!.prompt, /```fomo-evidence\nFOMO EVIDENCE/);
      assert.ok(reply.startsWith("On the evidence read"));
      assert.ok(reply.includes(NOT_PERMISSION_LINE));
      assert.ok(reply.endsWith(FOMO_ATTRIBUTION));
      assert.deepEqual(h.llm, [], "the composer is the only model call, through the injected seam");
      assert.equal(count(h.fx.raw, "fomo_assessments"), 0, "analysis is not an assessment");
    });
  });

  it("a composer that returns nothing leaves the deterministic answer", async () => {
    await withDm({ llm: true, composeReply: null }, async (h) => {
      await ask(h, "what are the theses on $PONS");
      const reply = await ask(h, "should we follow this?");
      assert.equal(h.composed.length, 1);
      assert.match(reply, /Merrymen's research/);
      assert.ok(reply.includes(NOT_PERMISSION_LINE));
    });
  });

  it("data access switched off: an honest refusal, no data, no provider request", async () => {
    await withDm({}, async (h) => {
      h.fx.access.dataAccess = false;
      const reply = await ask(h, "what are the theses on $PONS");
      assert.match(reply, /Fomo data access is switched off for this account\./);
      assert.doesNotMatch(reply, /theses from|their words|0x39db/);
      assert.deepEqual(h.fx.provider, []);
    });
  });

  it("no broker, or a null one: a research question is told research is unavailable; anything else goes on as before", async () => {
    for (const broker of ["absent", "null"] as const) {
      await withDm({ broker }, async (h) => {
        assert.equal(await ask(h, "what are fomo traders buying?"), FOMO_UNAVAILABLE_TEXT);
        assert.match(await ask(h, "hello there"), /pick an AI provider/);
      });
    }
  });

  it("FOMO OFF IN THIS PROCESS: a research question goes on exactly as before Fomo existed, and nothing is asked of the broker", async () => {
    await withDm({ fomoOff: true }, async (h) => {
      // No brain in this harness: the classifier's own answer for any free text.
      assert.match(await ask(h, "what are fomo traders buying?"), /pick an AI provider/);
      assert.match(await ask(h, "theses on $PONS?"), /pick an AI provider/);
      assert.match(await ask(h, "hello there"), /pick an AI provider/);
      assert.deepEqual(h.fx.provider, [], "no provider request");
    });
  });

  it("a watch comes only from the owner's own DM, through the planner", async () => {
    await withDm({}, async (h) => {
      const friend = await ask(h, "watch $PONS on fomo for 3 days", FRIEND);
      assert.equal(friend, FOMO_OWNER_ONLY_TEXT);
      assert.ok(!h.fx.calls.some((c) => c.tool === "fomo_watch_coin"));
      assert.equal(count(h.fx.raw, "fomo_watches"), 0);
      await ask(h, "watch $PONS on fomo for 3 days");
      const watch = h.fx.calls.find((c) => c.tool === "fomo_watch_coin");
      assert.ok(watch, "the owner's watch went through the planner");
      assert.equal(watch.opts.audience, "owner");
      assert.equal(count(h.fx.raw, "fomo_watches"), 1);
    });
  });

  it("an allowlisted sender who is not the owner is answered as a group would be: public research only", async () => {
    await withDm({}, async (h) => {
      const reply = await ask(h, "what are the theses on $PONS", FRIEND);
      assert.equal(h.fx.calls[0]!.opts.audience, "group");
      assert.equal(h.fx.calls[0]!.opts.conversationKey, `tg-dm:${FRIEND}`);
      assert.doesNotMatch(reply, /frankdegods|CryptoKaleo|0x39db|their words/);
      assert.equal(await ask(h, "research status on fomo", FRIEND), FOMO_OWNER_ONLY_TEXT);
    });
  });

  it("a deep research job is delivered once, to the same chat, when it is done", async () => {
    await withDm({}, async (h) => {
      const first = await ask(h, "do a deep dive research on $PONS on fomo");
      const research = h.fx.calls.find((c) => c.tool === "fomo_research_coin")!;
      assert.equal(research.args.depth, "deep");
      assert.match(first, /PONS/);
      assert.equal(count(h.fx.raw, "fomo_jobs"), 1);
      // The orchestrator runs the job.
      const ran = await runPendingJobs(h.fx.service, h.fx.db, { now: () => Date.now() });
      assert.equal(ran.done, 1);
      const before = h.sentTo(OWNER).length;
      await h.advance(61_000);
      const after = h.sentTo(OWNER).slice(before);
      assert.equal(after.length, 1);
      assert.match(after[0]!, /^The deeper Fomo research on \$PONS is done\./);
      assert.ok(after[0]!.endsWith(FOMO_ATTRIBUTION));
      const polls = h.fx.calls.filter((c) => c.tool === "fomo_get_research_status");
      assert.ok(polls.length >= 1 && polls.every((c) => c.opts.audience === "owner" && c.opts.conversationKey === `tg-dm:${OWNER}`));
      await h.advance(5 * 60_000);
      assert.equal(h.sentTo(OWNER).length, before + 1, "delivered once");
      assert.equal(h.sentTo(FRIEND).length, 0, "never to another chat");
    });
  });

  it("a deep research job is not delivered after the owner changes", async () => {
    await withDm({}, async (h) => {
      await ask(h, "do a deep dive research on $PONS on fomo");
      await runPendingJobs(h.fx.service, h.fx.db, { now: () => Date.now() });
      h.setState({ ...h.state(), ownerId: 777 });
      const before = h.sentTo(OWNER).length;
      const polls = h.fx.calls.length;
      await h.advance(3 * 60_000);
      assert.equal(h.sentTo(OWNER).length, before);
      assert.equal(h.fx.calls.length, polls, "nothing is even looked up for a recipient that is no longer the owner");
    });
  });

  it("a deep research job is not delivered when data access is switched off meanwhile", async () => {
    await withDm({}, async (h) => {
      await ask(h, "do a deep dive research on $PONS on fomo");
      await runPendingJobs(h.fx.service, h.fx.db, { now: () => Date.now() });
      h.fx.access.dataAccess = false;
      const before = h.sentTo(OWNER).length;
      await h.advance(3 * 60_000);
      assert.equal(h.sentTo(OWNER).length, before);
    });
  });

  it("C13: a reply to one of my non-research messages is not answered from the research's memory; a reply to a research answer is", async () => {
    await withDm({}, async (h) => {
      await ask(h, "what are the theses on $PONS");
      const researchId = h.sentIds(OWNER).at(-1)!;
      const looked = h.fx.calls.length;
      // The owner replies to a trade receipt of mine: "the sellers" are that coin's, not PONS's.
      const receipt = { message_id: 777, from: { id: 111, is_bot: true, first_name: "Pine" }, text: "Bought $PEPE for $5.00 (trade #3, from the fomo-follow review)." };
      for (const t of ["What about the sellers?", "should we follow this?"]) {
        const r = await ask(h, t, OWNER, receipt);
        assert.match(r, /pick an AI provider/, `${t}: went on to the existing path`);
      }
      // Position management is the owner's book even with no reply at all.
      for (const t of ["should we take profit?", "should we exit?", "is it worth holding?"]) {
        assert.match(await ask(h, t), /pick an AI provider/, t);
      }
      assert.equal(h.fx.calls.length, looked, "nothing was looked up for any of them");
      // A reply to the research answer itself continues the research.
      await ask(h, "What about the sellers?", OWNER, { message_id: researchId, from: { id: 111, is_bot: true, first_name: "Pine" }, text: "PONS on robinhood: 3 theses" });
      const last = h.fx.calls.at(-1)!;
      assert.equal(last.tool, "fomo_get_token_activity");
      assert.deepEqual(last.args, { token: PONS, chain: "robinhood", side: "sell" });
      // So does a reply to an older research answer this process never sent (after a restart): it carries the attribution.
      const n = h.fx.calls.length;
      await ask(h, "and the buyers?", OWNER, { message_id: 12, from: { id: 111, is_bot: true, first_name: "Pine" }, text: `PONS on robinhood: 3 theses\n${FOMO_ATTRIBUTION}` });
      assert.equal(h.fx.calls.length, n + 1);
      assert.deepEqual(h.fx.calls.at(-1)!.args, { token: PONS, chain: "robinhood", side: "buy" });
    });
  });

  it("C10: the agent's own name is the owner's book, never a Fomo trader, even inside a research conversation", async () => {
    await withDm({}, async (h) => {
      await ask(h, "what are the theses on $PONS");
      const looked = h.fx.calls.length;
      for (const t of ["show me Robin's trades", "what are Robin's holdings?", "how is Robin's pnl?"]) {
        assert.match(await ask(h, t), /pick an AI provider/, t);
      }
      assert.equal(h.fx.calls.length, looked, "no trader search for the agent's own (default) name");
    });
  });

  it("C29: a research answer is sent without a link preview card; an ordinary reply is unchanged", async () => {
    await withDm({}, async (h) => {
      await ask(h, "what are the theses on $PONS");
      const research = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
      assert.deepEqual(research.body.link_preview_options, { is_disabled: true });
      await ask(h, "hello there");
      const other = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
      assert.equal(other.body.link_preview_options, undefined);
    });
  });

  it("slash commands, orders and the classifier's kinds go on as before; /forget also clears the research's memory", async () => {
    await withDm({}, async (h) => {
      const help = await ask(h, "/help");
      assert.match(help, /\//);
      const order = await ask(h, "buy 10 of PEPE");
      assert.match(order, /pick an AI provider/, "an order is not research: it reaches the existing path");
      const ledger = await ask(h, "what did you buy today?");
      assert.match(ledger, /pick an AI provider/);
      assert.equal(h.fx.calls.length, 0, "none of them asked the research");
      await ask(h, "what are the theses on $PONS");
      await ask(h, "/forget");
      await h.until(() => h.fx.cleared.length > 0, 2_000);
      assert.deepEqual(h.fx.cleared, [`tg-dm:${OWNER}`]);
      // "it" no longer points at PONS.
      const calls = h.fx.calls.length;
      await ask(h, "What about the sellers?");
      assert.ok(!h.fx.calls.slice(calls).some((c) => c.args.token === PONS), "the forgotten coin is not looked up again");
    });
  });
});

describe("the owner's group ask about one trader, answered in her DM", () => {
  it("'do you know unipcs on fomo' in a group: routed, looked up read-only in her DM, and the room hears only that it went", async () => {
    await withDm({ groupPick: { action: "fomo_trader", trader: "unipcs" } }, async (h) => {
      h.sayInGroup("pine do you know unipcs on fomo");
      await h.until(() => h.sentTo(GROUP).length > 0 && h.sentTo(OWNER).length > 0);
      assert.ok(h.llm.includes("group-route"), "the line was routed by the group's model");
      const lookups = h.fx.calls.map((c) => c.tool);
      assert.deepEqual(lookups, ["fomo_get_trader_context"], "one read; nothing that changes anything");
      const o = h.fx.calls[0]!.opts;
      assert.equal(o.surface, "telegram-dm");
      assert.equal(o.audience, "owner");
      assert.equal(o.conversationKey, `tg-dm:${OWNER}`);
      assert.deepEqual(h.fx.calls[0]!.args, { trader: "unipcs" });
      const dm = h.sentTo(OWNER);
      assert.equal(dm.length, 1);
      assert.match(dm[0]!, /^You asked about Fomo trader unipcs in a group, so here it is privately\./);
      const room = h.sentTo(GROUP);
      assert.equal(room.length, 1);
      assert.doesNotMatch(room[0]!, /unipcs/i);
      // Only the fixed question code wrote enters her DM history, never the group's words.
      const turns = await recentChatTurns(OWNER, 4);
      assert.ok(turns.some((t) => t.role === "user" && t.content === "who is trader unipcs on fomo?"));
      assert.ok(!turns.some((t) => /do you know/.test(t.content)));
    });
  });

  it("her plain wording, 'who is trader unipcs on fomo?': the real port names the trader, and her DM gets it", async () => {
    await withDm({ groupPick: { action: "chat" } }, async (h) => {
      h.sayInGroup("pine what is trader unipcs holding on fomo?");
      await h.until(() => h.sentTo(GROUP).length > 0 && h.sentTo(OWNER).length > 0);
      assert.deepEqual(h.fx.calls.map((c) => c.tool), ["fomo_get_trader_context"]);
      assert.equal(h.fx.calls[0]!.opts.audience, "owner");
      assert.match(h.sentTo(OWNER)[0]!, /^You asked about Fomo trader unipcs in a group/);
      assert.doesNotMatch(h.sentTo(GROUP)[0]!, /unipcs/i);
      const turns = await recentChatTurns(OWNER, 4);
      assert.ok(turns.some((t) => t.role === "user" && t.content === "what is trader unipcs holding on fomo?"));
    });
  });

  it("her DM unreachable: nothing is looked up, nothing enters her history, and the room is told to /start", async () => {
    // A handle no other test here asks about: the DM history is the file's own.
    await withDm({ groupPick: { action: "fomo_trader", trader: "bobbyx" }, dmBlocked: true }, async (h) => {
      h.sayInGroup("pine do you know bobbyx on fomo");
      await h.until(() => h.sentTo(GROUP).length > 0);
      assert.deepEqual(h.fx.calls, []);
      assert.match(h.sentTo(GROUP)[0]!, /\/start/);
      const turns = await recentChatTurns(OWNER, 8);
      assert.ok(!turns.some((t) => /bobbyx/.test(t.content)));
    });
  });

  it("not on the allowlist: her DM would not answer her, so nothing is looked up or sent there", async () => {
    await withDm({ groupPick: { action: "fomo_trader", trader: "unipcs" }, allowlist: [FRIEND] }, async (h) => {
      h.sayInGroup("pine do you know unipcs on fomo");
      await h.until(() => h.sentTo(GROUP).length > 0);
      assert.deepEqual(h.fx.calls, []);
      assert.deepEqual(h.sentTo(OWNER), []);
    });
  });

  it("a DM that fails after the lookup leaves her DM's research subject as it was", async () => {
    await withDm({ groupPick: { action: "fomo_trader", trader: "unipcs" } }, async (h) => {
      await ask(h, "what are the theses on $PONS");
      h.ownerSendsFail(true);
      const before = h.fx.calls.length;
      h.sayInGroup("pine do you know unipcs on fomo");
      await h.until(() => h.sentTo(GROUP).length > 0);
      assert.deepEqual(h.fx.calls.slice(before).map((c) => c.tool), ["fomo_get_trader_context"], "the lookup ran");
      h.ownerSendsFail(false);
      await ask(h, "What about the sellers?");
      const last = h.fx.calls[h.fx.calls.length - 1]!;
      assert.equal(last.tool, "fomo_get_token_activity", "the follow-up is still about the coin she last asked about");
      assert.equal(last.args.token, PONS);
    });
  });

  it("an ask forgotten while its lookup runs is not answered: no DM, nothing in her history", async () => {
    await withDm({ groupPick: { action: "fomo_trader", trader: "zedtrader" } }, async (h) => {
      let release!: () => void;
      h.fx.hold.until = new Promise<void>((r) => {
        release = r;
      });
      h.sayInGroup("pine do you know zedtrader on fomo");
      await h.until(() => h.fx.calls.length > 0);
      h.sayInGroup("/forgetme");
      await h.advance(2_000);
      h.fx.hold.until = null;
      release();
      await h.advance(5_000);
      assert.deepEqual(h.fx.calls.map((c) => c.tool), ["fomo_get_trader_context"]);
      assert.ok(!h.sentTo(OWNER).some((t) => /zedtrader/.test(t)), "no DM for a forgotten ask");
      const turns = await recentChatTurns(OWNER, 8);
      assert.ok(!turns.some((t) => /zedtrader/.test(t.content)));
    });
  });

  it("the same line from anyone else: the room's deflection, no lookup, nothing in the owner's DM", async () => {
    await withDm({ groupPick: { action: "fomo_trader", trader: "unipcs" } }, async (h) => {
      h.sayInGroup("pine do you know unipcs on fomo", FRIEND);
      await h.until(() => h.sentTo(GROUP).length > 0);
      assert.deepEqual(h.fx.calls, []);
      assert.deepEqual(h.sentTo(OWNER), []);
      assert.match(h.sentTo(GROUP)[0]!, /direct message/);
    });
  });
});

/** The inline keyboard under a sent message, flat. */
function buttonsOf(body: Record<string, unknown> | undefined): { text: string; callback_data: string }[] {
  const m = body?.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined;
  return (m?.inline_keyboard ?? []).flat();
}
const edits = (h: Harness) => h.calls.filter((c) => c.method === "editMessageText").map((c) => plain(String(c.body.text)));
const toasts = (h: Harness) => h.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.body.text ?? ""));
const KALEO_ID = "1f08e6ab-5c73-5443-9225-bfc496cde51f";
const READY: FollowReadiness = { mode: "paper", blockers: [] };
const FOLLOW_OFF: FollowReadiness = { mode: "off", blockers: ["follow-off"] };

/** Ask for a tail, and press one of the card's buttons. */
async function tailAndPress(h: Harness, line: string, which: "tell" | "consider" | "no" | { forged: "consider" }): Promise<string> {
  await ask(h, line);
  return pressLastCard(h, which);
}

describe("a Fomo tail in the owner's DM: the card, and nothing until she presses", () => {
  it("/tail resolves read-only and shows the card; with following able to act, consider is offered and honoured", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      h.fx.access.follow = true;
      const card = await ask(h, "/tail CryptoKaleo 2h");
      assert.deepEqual(h.fx.calls.map((c) => c.tool), ["fomo_get_research_status", "fomo_resolve_subject"], "read-only first: her running tails (local), then the trader");
      for (const c of h.fx.calls) assert.equal(c.opts.audience, "owner");
      assert.equal(count(h.fx.raw, "fomo_tails"), 0, "nothing is stored by asking");
      assert.match(card, /^👀 Tail CryptoKaleo on Fomo for 2 hours \(until \d\d:\d\d UTC\)\?/);
      assert.match(card, /each buy, sell or thesis Fomo's live feed shows from them, with their thesis when there is one and my read of the coin/);
      assert.match(card, /only shows larger positions.*no alert is not proof they didn't trade/s);
      assert.match(card, /Following is on, on paper/);
      assert.doesNotMatch(card, /\bcopy/i);
      assert.deepEqual(buttonsOf(h.lastBody(OWNER)).map((b) => b.text), ["👀 Tell me only", "👀 + consider their buys", "✖ No"]);
      const done = await pressLastCard(h, "consider");
      assert.deepEqual(h.fx.calls.at(-1)!.args, { trader: KALEO_ID, hours: 2, consider: true });
      assert.equal(count(h.fx.raw, "fomo_tails"), 1);
      assert.match(done, /^Tailing CryptoKaleo on Fomo until \d\d:\d\d UTC \(2 h\)\./);
      assert.match(done, /one signal into my normal review/);
      assert.doesNotMatch(done, /tell you only/);
    });
  });

  it("tell only: stored without consider; No: nothing stored", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      const no = await tailAndPress(h, "/tail CryptoKaleo", "no");
      assert.match(no, /cancelled/);
      assert.equal(count(h.fx.raw, "fomo_tails"), 0);
      assert.ok(!h.fx.calls.some((c) => c.tool === "fomo_tail_trader"));
      const tell = await tailAndPress(h, "/tail CryptoKaleo", "tell");
      assert.deepEqual(h.fx.calls.at(-1)!.args, { trader: KALEO_ID, hours: 3, consider: false });
      assert.match(tell, /You asked me to tell you only/);
      assert.equal(Number((h.fx.raw.prepare("SELECT consider FROM fomo_tails").get() as { consider: number }).consider), 0);
    });
  });

  it("following can't act: no consider button, the reason on the card, and a forged consider press is tell-only with a note", async () => {
    await withDm({ liveFeed: true, readiness: () => FOLLOW_OFF }, async (h) => {
      const card = await ask(h, "/tail CryptoKaleo 2h");
      assert.match(card, /Following is off, so this tail can only tell you/);
      assert.deepEqual(buttonsOf(h.lastBody(OWNER)).map((b) => b.text), ["👀 Tell me only", "✖ No"]);
      const done = await pressLastCard(h, { forged: "consider" });
      assert.deepEqual(h.fx.calls.at(-1)!.args, { trader: KALEO_ID, hours: 2, consider: false });
      assert.match(done, /Tailing CryptoKaleo/);
      assert.match(done, /Following can't act right now \(following is off\), so I've set this up to tell you only\./);
    });
  });

  it("a stale consider press (following stopped being able to act after the card) is tell-only with a note", async () => {
    let readiness: FollowReadiness = READY;
    await withDm({ liveFeed: true, readiness: () => readiness }, async (h) => {
      await ask(h, "/tail CryptoKaleo 2h");
      assert.equal(buttonsOf(h.lastBody(OWNER)).length, 3);
      readiness = { mode: "paper", blockers: ["paused"] };
      const done = await pressLastCard(h, "consider");
      assert.deepEqual(h.fx.calls.at(-1)!.args, { trader: KALEO_ID, hours: 2, consider: false });
      assert.match(done, /Following can't act right now \(entries are paused\)/);
    });
  });

  it("her 'all Telegram messages' off: the card, the press, +1h and /tails say no notice will reach her, never what she'd get (review 2026-10-07)", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      h.cfg.telegramNotifyEnabled = false;
      const card = await ask(h, "/tail CryptoKaleo 2h");
      assert.ok(card.includes(TAIL_MUTED_LINE), card);
      assert.doesNotMatch(card, /What you'll get, here/);
      assert.match(TAIL_MUTED_LINE, /won't send you any of these notices, the end summary included, until you turn it back on/);
      const done = await pressLastCard(h, "tell");
      assert.match(done, /^Tailing CryptoKaleo/);
      assert.ok(done.endsWith(TAIL_MUTED_LINE), done);
      assert.ok((await ask(h, "/tails")).includes(TAIL_MUTED_LINE));
      h.press(`ftl:ext:${KALEO_ID}`, 77_000);
      await h.until(() => /now\./.test(h.sentTo(OWNER).at(-1) ?? ""));
      assert.ok(h.sentTo(OWNER).at(-1)!.endsWith(TAIL_MUTED_LINE));
      // On again: the card says what she'll get, and nothing about the setting.
      h.cfg.telegramNotifyEnabled = true;
      const again = await ask(h, "/tail CryptoKaleo 3h");
      assert.match(again, /What you'll get, here/);
      assert.ok(!again.includes(TAIL_MUTED_LINE));
    });
  });

  it("monitoring and following off (the defaults): the card promises no read of the coin, and the tell-only answer says why (review 2026-10-07)", async () => {
    await withDm({ liveFeed: true, readiness: () => FOLLOW_OFF }, async (h) => {
      h.cfg.fomoMonitoringEnabled = false;
      h.fx.access.monitoring = false;
      const card = await ask(h, "/tail CryptoKaleo 2h");
      assert.doesNotMatch(card, /my read of the coin/);
      assert.match(card, /With monitoring and following off I don't research their coins, so I won't give my own read of them\./);
      const done = await pressLastCard(h, "tell");
      assert.match(done, /You asked me to tell you only/);
      assert.match(done, /Monitoring and following are both off, so I won't have my own read of their coins/);
    });
  });

  it("more than 12 hours: clamped to 12, and the card says so", async () => {
    await withDm({ liveFeed: true, readiness: () => FOLLOW_OFF }, async (h) => {
      const card = await ask(h, "/tail CryptoKaleo 30");
      assert.match(card, /for 12 hours/);
      assert.match(card, /You asked for more than 12 hours; a tail runs 12 at most\./);
    });
  });

  it("an expired card starts nothing", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      await ask(h, "/tail CryptoKaleo");
      await h.advance(10 * 60_000 + 2_000);
      const done = await pressLastCard(h, "consider");
      assert.match(done, /expired/);
      assert.ok(!h.fx.calls.some((c) => c.tool === "fomo_tail_trader"));
      assert.equal(count(h.fx.raw, "fomo_tails"), 0);
    });
  });

  it("anyone else: the owner-only line, no lookup; and they cannot press her card", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      assert.equal(await ask(h, "/tail CryptoKaleo 2h", FRIEND), "Only my owner can set up a tail.");
      assert.equal(await ask(h, "/untail all", FRIEND), "Only my owner can set up a tail.");
      assert.equal(await ask(h, "/tails", FRIEND), "Only my owner can set up a tail.");
      assert.equal(h.fx.calls.length, 0);
      await ask(h, "/tail CryptoKaleo 2h");
      const body = h.lastBody(OWNER)!;
      const consider = buttonsOf(body).find((b) => /consider/.test(b.text))!.callback_data;
      h.press(consider, Number(body.__message_id), FRIEND, OWNER);
      await h.until(() => toasts(h).length > 0);
      assert.match(toasts(h)[0]!, /nothing waiting for you/);
      assert.ok(!h.fx.calls.some((c) => c.tool === "fomo_tail_trader"));
    });
  });

  it("a trader Fomo doesn't know, or two that answer to the handle: said plainly, nothing parked", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      assert.equal(await ask(h, "/tail unipcs 3h"), "I couldn't find a Fomo trader called unipcs.");
      assert.equal(buttonsOf(h.lastBody(OWNER)).length, 0);
    });
    const row = (fixture("search").results as Rec[])[0]!;
    const twin = { ...row, handle: "cryptokaleo", userId: "2b08e6ab-5c73-5443-9225-bfc496cde51f", displayName: "Kaleo Fan" };
    await withDm({ liveFeed: true, readiness: () => READY, search: { results: [row, twin] } }, async (h) => {
      const r = await ask(h, "/tail CryptoKaleo");
      assert.match(r, /^More than one Fomo trader answers to CryptoKaleo: CryptoKaleo \(K A L E O\), cryptokaleo \(Kaleo Fan\)\. Which one\?/);
      assert.equal(buttonsOf(h.lastBody(OWNER)).length, 0);
    });
  });

  it("/tails lists what runs; /untail stops it; the bot's own name is never a trader", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      assert.match(await ask(h, "/tails"), /^You aren't tailing anyone on Fomo\./);
      await tailAndPress(h, "/tail CryptoKaleo 2h", "tell");
      assert.match(await ask(h, "/tails"), /Tailing on Fomo\n• CryptoKaleo until \d\d:\d\d UTC \(tell only\)/);
      assert.match(await ask(h, "/untail CryptoKaleo"), /^Stopped tailing CryptoKaleo\./);
      assert.equal(count(h.fx.raw, "fomo_tails"), 0);
      assert.match(await ask(h, "/untail all"), /^You weren't tailing anyone\./);
      assert.match(await ask(h, "/tail pine 2h"), /^usage: \/tail <trader>/);
    });
  });

  it("no live feed on this install: /tail says so up front, with no lookup, no provider request and no card (review 2026-10-07)", async () => {
    await withDm({ readiness: () => READY, tailsState: () => "no-live-feed" }, async (h) => {
      const r = await ask(h, "/tail CryptoKaleo 2h");
      assert.equal(r, "Tailing needs Fomo's live feed, which only the hosted service has; this install can answer Fomo questions but can't tail.");
      assert.deepEqual(h.fx.calls, [], "nothing resolved: no 250-credit search");
      assert.deepEqual(h.fx.provider, []);
      assert.equal(buttonsOf(h.lastBody(OWNER)).length, 0, "no card, nothing parked");
      assert.equal(count(h.fx.raw, "fomo_tails"), 0);
      // Her words go on to research as before tails existed, never a card.
      const words = await ask(h, "keep tabs on trader CryptoKaleo for a couple hours");
      assert.doesNotMatch(words, /^👀 Tail /);
      assert.equal(buttonsOf(h.lastBody(OWNER)).length, 0);
    });
    // Unknown here (no state given): the service still refuses at the press.
    await withDm({ readiness: () => READY }, async (h) => {
      const done = await tailAndPress(h, "/tail CryptoKaleo 2h", "tell");
      assert.match(done, /Tailing needs Fomo's live feed/);
      assert.equal(count(h.fx.raw, "fomo_tails"), 0);
    });
  });

  it("MERRYMEN_FOMO_TAILS=0: /tail is refused up front with no search; a start in words goes on as before; a stored tail can still be stopped (review 2026-10-07)", async () => {
    let state: "on" | "switched-off" = "on";
    await withDm({ liveFeed: true, readiness: () => READY, tailsState: () => state }, async (h) => {
      await tailAndPress(h, "/tail CryptoKaleo 2h", "tell");
      assert.equal(count(h.fx.raw, "fomo_tails"), 1);
      state = "switched-off";
      const n = h.fx.calls.length;
      const p = h.fx.provider.length;
      assert.equal(await ask(h, "/tail CryptoKaleo 3h"), "Tailing is switched off on this service right now, so I haven't set up a tail; I can still answer Fomo questions.");
      assert.equal(h.fx.calls.length, n, "no lookup");
      assert.equal(h.fx.provider.length, p, "no provider request");
      assert.equal(buttonsOf(h.lastBody(OWNER)).length, 0, "no card");
      const words = await ask(h, "keep tabs on trader CryptoKaleo for a couple hours");
      assert.doesNotMatch(words, /^👀 Tail /, "not a tail card");
      assert.match(await ask(h, "stop tailing CryptoKaleo"), /^Stopped tailing CryptoKaleo\./, "a stored tail can still be stopped");
      assert.equal(count(h.fx.raw, "fomo_tails"), 0);
    });
  });

  it("three tails running: a fourth is refused before any lookup; renewing one of them is not (review 2026-10-07)", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      for (const [i, handle] of ["alpha1", "beta22", "gamma3"].entries()) {
        await fstore.addTail(h.fx.db, { tenant: TENANT, userId: `0000000${i}-5c73-5443-9225-bfc496cde51f`, handle, consider: false, nowMs: Date.now(), expiresAtMs: Date.now() + 3_600_000, createdVia: "telegram-dm" });
      }
      const r = await ask(h, "/tail CryptoKaleo 2h");
      assert.match(r, /^You already have 3 tails running, the most there can be; stop one first/);
      assert.ok(!h.fx.calls.some((c) => c.tool === "fomo_resolve_subject"), "no search spent");
      assert.deepEqual(h.fx.provider, []);
      assert.equal(buttonsOf(h.lastBody(OWNER)).length, 0);
      await ask(h, "/tail beta22 2h");
      assert.ok(h.fx.calls.some((c) => c.tool === "fomo_resolve_subject"), "one of hers is a renewal, not a fourth");
    });
  });
});

/** Press a button on the last card sent to her DM. */
async function pressLastCard(h: Harness, which: "tell" | "consider" | "no" | { forged: "consider" }): Promise<string> {
  const body = h.lastBody(OWNER)!;
  const kb = buttonsOf(body);
  const nonce = /^mm:[ycn]:([a-z2-7]{10})$/.exec(kb[0]?.callback_data ?? "")?.[1];
  assert.ok(nonce, "the last message is a card");
  const data =
    typeof which === "object" ? `mm:c:${nonce}` : which === "tell" ? `mm:y:${nonce}` : which === "consider" ? kb.find((b) => /consider/.test(b.text))!.callback_data : `mm:n:${nonce}`;
  const before = edits(h).length;
  h.press(data, Number(body.__message_id));
  await h.until(() => edits(h).length > before);
  return edits(h).at(-1)!;
}

/** A /v2/search body with one trader called unipcs. */
const UNIPCS_ID = "3c08e6ab-5c73-5443-9225-bfc496cde51f";
const unipcsSearch = (): Rec => ({ results: [{ ...(fixture("search").results as Rec[])[0]!, handle: "unipcs", userId: UNIPCS_ID, displayName: "uni" }] });
const MILLA = "can you tail unipcs trades for the next 3 hours, inform me of his thesis and if you like the trade as well, take it";

describe("a Fomo tail asked for in words, in the owner's DM", () => {
  it("Milla's line: the same card /tail unipcs 3h gives, saying a tail never skips my review; nothing bought, nothing stored by asking", async () => {
    await withDm({ liveFeed: true, readiness: () => READY, search: unipcsSearch() }, async (h) => {
      const card = await ask(h, MILLA);
      assert.deepEqual(h.fx.calls.map((c) => c.tool), ["fomo_get_research_status", "fomo_resolve_subject"], "read-only first; never the research planner's trader read");
      assert.match(card, /^👀 Tail unipcs on Fomo for 3 hours \(until \d\d:\d\d UTC\)\?/);
      assert.match(card, /You asked me to take the trade if I like it: a tail never skips my normal review\./);
      assert.deepEqual(buttonsOf(h.lastBody(OWNER)).map((b) => b.text), ["👀 Tell me only", "👀 + consider their buys", "✖ No"]);
      assert.equal(count(h.fx.raw, "fomo_tails"), 0);
      const done = await pressLastCard(h, "tell");
      assert.deepEqual(h.fx.calls.at(-1)!.args, { trader: UNIPCS_ID, hours: 3, consider: false });
      assert.match(done, /^Tailing unipcs on Fomo until/);
      assert.equal(h.llm.length, 0, "no model read her words");
      // Her words, and the card, are in her DM history like any turn.
      const turns = await recentChatTurns(OWNER, 6);
      assert.ok(turns.some((t) => t.role === "user" && t.content === MILLA));
    });
  });

  it("'keep tabs on trader X for a couple hours' is a tail, not a profile question; 'stop tailing X' stops it", async () => {
    await withDm({ liveFeed: true, readiness: () => FOLLOW_OFF, search: unipcsSearch() }, async (h) => {
      const card = await ask(h, "keep tabs on trader unipcs for a couple hours");
      assert.deepEqual(h.fx.calls.map((c) => c.tool), ["fomo_get_research_status", "fomo_resolve_subject"]);
      assert.match(card, /for 2 hours/);
      await pressLastCard(h, "tell");
      assert.match(await ask(h, "stop tailing unipcs"), /^Stopped tailing unipcs\./);
      assert.deepEqual(h.fx.calls.at(-1)!.args, { trader: "unipcs" });
      assert.equal(count(h.fx.raw, "fomo_tails"), 0);
    });
  });

  it("a stop is as narrow as a start: 'stop tracking $PONS on fomo' unwatches the coin and leaves her tail; 'stop tailing him' asks which (review 2026-10-07)", async () => {
    await withDm({ liveFeed: true, readiness: () => FOLLOW_OFF }, async (h) => {
      await ask(h, "watch $PONS on fomo for 3 days");
      assert.equal(count(h.fx.raw, "fomo_watches"), 1);
      await tailAndPress(h, "/tail CryptoKaleo 2h", "tell");
      assert.equal(count(h.fx.raw, "fomo_tails"), 1);
      const n = h.fx.calls.length;
      const unwatched = await ask(h, "stop tracking $PONS on fomo");
      assert.deepEqual(h.fx.calls.slice(n).map((c) => c.tool), ["fomo_unwatch_coin"], "the planner's unwatch, as before tails existed; never fomo_untail_trader");
      assert.match(unwatched, /^Stopped watching/);
      assert.equal(count(h.fx.raw, "fomo_watches"), 0);
      assert.equal(count(h.fx.raw, "fomo_tails"), 1, "her tail is untouched");
      const which = await ask(h, "ok stop tailing him");
      assert.match(which, /^Which tail should I stop\? I haven't stopped any yet\./);
      assert.match(which, /CryptoKaleo until/);
      assert.ok(!h.fx.calls.some((c) => c.tool === "fomo_untail_trader"), "nothing was stopped");
      assert.equal(count(h.fx.raw, "fomo_tails"), 1);
      // A lower-case coin reads like a handle; she isn't tailing anyone by
      // that name, so the line goes on below, never to an untail.
      await ask(h, "stop tracking pons");
      assert.ok(!h.fx.calls.some((c) => c.tool === "fomo_untail_trader"), JSON.stringify(h.fx.calls.map((c) => c.tool)));
      assert.equal(count(h.fx.raw, "fomo_tails"), 1);
      // Hers by name, with no tail word: still a stop of that tail.
      assert.match(await ask(h, "stop tracking cryptokaleo"), /^Stopped tailing CryptoKaleo\./);
      assert.equal(count(h.fx.raw, "fomo_tails"), 0);
    });
  });

  it("copy, mirror and follow are never a tail; nor is anyone else's line; nor any line where Fomo is off", async () => {
    await withDm({ liveFeed: true, readiness: () => READY, search: unipcsSearch() }, async (h) => {
      for (const line of ["copy unipcs trades for 3 hours", "mirror @unipcs", "follow unipcs for 3 hours"]) {
        await ask(h, line);
      }
      await ask(h, MILLA, FRIEND);
      assert.ok(!h.fx.calls.some((c) => c.tool === "fomo_resolve_subject" || c.tool === "fomo_tail_trader"), JSON.stringify(h.fx.calls.map((c) => c.tool)));
      assert.ok(!h.sentTo(FRIEND).some((t) => /Tail unipcs/.test(t)));
      assert.ok(!h.sentTo(OWNER).some((t) => /Tail unipcs/.test(t)));
    });
    await withDm({ fomoOff: true, liveFeed: true, readiness: () => READY }, async (h) => {
      assert.match(await ask(h, MILLA), /pick an AI provider/);
      assert.deepEqual(h.fx.calls, []);
    });
  });
});

describe("a running tail's Stop and +1h buttons", () => {
  /** The tail's expiry as stored. */
  const expiry = (h: Harness): number | null => {
    const r = h.fx.raw.prepare("SELECT expires_at_ms FROM fomo_tails").get() as { expires_at_ms: number } | undefined;
    return r ? Number(r.expires_at_ms) : null;
  };
  /** Press a notice button and wait for its toast. */
  const pressNotice = async (h: Harness, data: string, from = OWNER, chat = from): Promise<string> => {
    const before = toasts(h).length;
    h.press(data, 77_000, from, chat);
    await h.until(() => toasts(h).length > before);
    return toasts(h).at(-1)!;
  };

  it("a stop, Stop or a tell-only tail tells the follow child at once, for that trader (review on #301)", async () => {
    const revoked: Array<string | null> = [];
    await withDm({ liveFeed: true, readiness: () => READY, revoked }, async (h) => {
      await tailAndPress(h, "/tail CryptoKaleo 2h", "tell");
      assert.deepEqual(revoked, [KALEO_ID], "a tell-only tail lends no buys from the start");
      await ask(h, "/untail CryptoKaleo");
      assert.deepEqual(revoked, [KALEO_ID, KALEO_ID]);
      await ask(h, "/untail CryptoKaleo");
      assert.deepEqual(revoked, [KALEO_ID, KALEO_ID], "no tail was stopped: nothing to take back");
      await tailAndPress(h, "/tail CryptoKaleo 2h", "tell");
      assert.equal(await pressNotice(h, `ftl:stop:${KALEO_ID}`), "Stopped");
      assert.equal(revoked.at(-1), KALEO_ID);
      await ask(h, "/untail all");
      assert.equal(revoked.at(-1), null, "all of them");
    });
  });

  it("+1h adds an hour to her running tail, by its stored end, and says so; Stop stops it", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      await tailAndPress(h, "/tail CryptoKaleo 2h", "tell");
      const end = expiry(h)!;
      assert.equal(await pressNotice(h, `ftl:ext:${KALEO_ID}`), "+1h");
      assert.deepEqual(h.fx.calls.at(-1)!.args, { trader: KALEO_ID, hours: 1 });
      assert.equal(h.fx.calls.at(-1)!.tool, "fomo_extend_tail", "never fomo_tail_trader with one hour");
      assert.equal(expiry(h), end + 3_600_000);
      await h.until(() => /now\./.test(h.sentTo(OWNER).at(-1) ?? ""));
      assert.match(h.sentTo(OWNER).at(-1)!, /^Tailing CryptoKaleo until \d\d:\d\d UTC now\./);
      assert.equal((h.lastBody(OWNER)!.reply_parameters as { message_id: number }).message_id, 77_000, "a reply to the notice; the notice keeps its words");
      assert.equal(await pressNotice(h, `ftl:stop:${KALEO_ID}`), "Stopped");
      assert.equal(count(h.fx.raw, "fomo_tails"), 0);
      assert.equal(await pressNotice(h, `ftl:ext:${KALEO_ID}`), "That tail has ended.");
      assert.equal(count(h.fx.raw, "fomo_tails"), 0, "an ended tail is never revived by +1h");
      assert.equal(await pressNotice(h, `ftl:stop:${KALEO_ID}`), "That tail had already stopped.");
    });
  });

  it("a tail whose 30 notices are spent says so on +1h and on renewal, never promising notices the cap won't send (review 2026-10-07)", async () => {
    let spent = false;
    await withDm({ liveFeed: true, readiness: () => READY, capSpent: async (u) => (u === KALEO_ID ? spent : false) }, async (h) => {
      const first = await tailAndPress(h, "/tail CryptoKaleo 2h", "tell");
      assert.ok(!first.includes(TAIL_CAP_SPENT_LINE), "a fresh tail has its notices");
      spent = true;
      assert.equal(await pressNotice(h, `ftl:ext:${KALEO_ID}`), "+1h");
      await h.until(() => /now\./.test(h.sentTo(OWNER).at(-1) ?? ""));
      assert.ok(h.sentTo(OWNER).at(-1)!.endsWith(TAIL_CAP_SPENT_LINE), h.sentTo(OWNER).at(-1));
      const renewed = await tailAndPress(h, "/tail CryptoKaleo 3h", "tell");
      assert.match(renewed, /^Still tailing CryptoKaleo/);
      assert.ok(renewed.endsWith(TAIL_CAP_SPENT_LINE), renewed);
    });
  });

  it("Stop or /untail after a tail ended on its own: 'already ended', by name, never 'you weren't tailing' or an id; its row stays for the summary (review 2026-10-07)", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      await tailAndPress(h, "/tail CryptoKaleo 1h", "tell");
      mock.timers.tick(61 * 60_000);
      await h.advance(1_000);
      assert.equal(await pressNotice(h, `ftl:stop:${KALEO_ID}`), "That tail had already ended.");
      await h.until(() => /ended at/.test(h.sentTo(OWNER).at(-1) ?? ""));
      const said = h.sentTo(OWNER).at(-1)!;
      assert.match(said, /^Your tail on CryptoKaleo already ended at \d\d:\d\d UTC\./);
      assert.doesNotMatch(said, /weren't tailing|trader [0-9a-f]{8}…/);
      assert.match(await ask(h, "/untail CryptoKaleo"), /^Your tail on CryptoKaleo already ended at \d\d:\d\d UTC\./);
      assert.equal(count(h.fx.raw, "fomo_tails"), 1, "the ended row is kept for its end summary");
    });
  });

  it("+1h never shortens a tail and never passes 12 hours from now", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      await tailAndPress(h, "/tail CryptoKaleo 12h", "tell");
      const end = expiry(h)!;
      const toast = await pressNotice(h, `ftl:ext:${KALEO_ID}`);
      assert.match(toast, /12-hour limit|as long as a tail runs/);
      const after = expiry(h)!;
      assert.ok(after >= end, "never shortened");
      assert.ok(after <= Date.now() + 12 * 3_600_000, "never past 12 hours from now");
    });
  });

  it("only the owner, in her own DM: anyone else's press, or hers from a group, changes nothing", async () => {
    await withDm({ liveFeed: true, readiness: () => READY }, async (h) => {
      await tailAndPress(h, "/tail CryptoKaleo 2h", "tell");
      const end = expiry(h);
      const n = h.fx.calls.length;
      assert.equal(await pressNotice(h, `ftl:stop:${KALEO_ID}`, FRIEND), "Only my owner can change a tail.");
      assert.equal(await pressNotice(h, `ftl:ext:${KALEO_ID}`, FRIEND, OWNER), "Only my owner can change a tail.");
      assert.equal(await pressNotice(h, `ftl:stop:${KALEO_ID}`, OWNER, GROUP), "Only my owner can change a tail.");
      assert.equal(await pressNotice(h, "ftl:boom:x"), "That button has expired.");
      assert.equal(await pressNotice(h, "ftl:ext:not-a-user-id"), "That button has expired.");
      assert.equal(h.fx.calls.filter((c) => c.tool !== "fomo_extend_tail").length, n, "nothing but the malformed id reached the service");
      assert.equal(expiry(h), end);
      assert.equal(count(h.fx.raw, "fomo_tails"), 1);
    });
  });
});

describe("a Fomo tail asked for in a group, carded in the owner's DM", () => {
  it("Milla's line in the room: the card in her DM (nothing stored), the room hears only that it went; her press there starts it", async () => {
    await withDm({ groupPick: { action: "chat" }, liveFeed: true, readiness: () => READY, search: unipcsSearch() }, async (h) => {
      h.sayInGroup(`pine ${MILLA}`);
      await h.until(() => h.sentTo(GROUP).length > 0 && h.sentTo(OWNER).length > 0);
      assert.ok(!h.llm.includes("group-route"), "read by code, not routed by the model");
      assert.deepEqual(h.fx.calls.map((c) => c.tool), ["fomo_get_research_status", "fomo_resolve_subject"], "read-only, as her DM's /tail");
      for (const c of h.fx.calls) {
        assert.equal(c.opts.audience, "owner");
        assert.equal(c.opts.surface, "telegram-dm");
      }
      const dm = h.sentTo(OWNER);
      assert.equal(dm.length, 1);
      assert.match(dm[0]!, /^You asked in a group, so here it is privately\.\n\n👀 Tail unipcs on Fomo for 3 hours/);
      assert.match(dm[0]!, /a tail never skips my normal review/);
      assert.equal(buttonsOf(h.lastBody(OWNER)).length, 3);
      assert.equal(count(h.fx.raw, "fomo_tails"), 0, "nothing is created until she presses");
      const room = h.sentTo(GROUP);
      assert.equal(room.length, 1);
      assert.match(room[0]!, /DMs? 🤫/);
      for (const t of room) assert.doesNotMatch(t, /unipcs|tail/i);
      const turns = await recentChatTurns(OWNER, 8);
      assert.ok(!turns.some((t) => t.content.includes("inform me of his thesis")), "the group's words never enter her DM history");
      const done = await pressLastCard(h, "tell");
      assert.match(done, /^Tailing unipcs on Fomo until/);
      assert.equal(count(h.fx.raw, "fomo_tails"), 1);
    });
  });

  it("her DM unreachable: nothing looked up, nothing parked; the room is told to /start", async () => {
    await withDm({ groupPick: { action: "chat" }, liveFeed: true, readiness: () => READY, search: unipcsSearch(), dmBlocked: true }, async (h) => {
      h.sayInGroup("pine tail @unipcs for 2h");
      await h.until(() => h.sentTo(GROUP).length > 0);
      assert.deepEqual(h.fx.calls, []);
      assert.match(h.sentTo(GROUP)[0]!, /\/start/);
    });
  });

  it("anyone else's tail line in the room: the owner-only line, no lookup, nothing in her DM", async () => {
    await withDm({ groupPick: { action: "chat" }, liveFeed: true, readiness: () => READY, search: unipcsSearch() }, async (h) => {
      h.sayInGroup(`pine ${MILLA}`, FRIEND);
      await h.until(() => h.sentTo(GROUP).length > 0);
      assert.deepEqual(h.fx.calls, []);
      assert.deepEqual(h.sentTo(OWNER), []);
      assert.match(h.sentTo(GROUP)[0]!, /owner/);
      assert.doesNotMatch(h.sentTo(GROUP)[0]!, /unipcs|tail/i);
    });
  });

  it("the router's fomo_tail pick on her line that names no one: the /tail usage in her DM; on /tail typed in the room, the same card", async () => {
    await withDm({ groupPick: { action: "fomo_tail" }, liveFeed: true, readiness: () => READY, search: unipcsSearch() }, async (h) => {
      h.sayInGroup("pine can you shadow that trader for a few hours?");
      await h.until(() => h.sentTo(GROUP).length > 0 && h.sentTo(OWNER).length > 0);
      assert.ok(h.llm.includes("group-route"));
      assert.match(h.sentTo(OWNER)[0]!, /couldn't tell who\. usage: \/tail <trader> \[hours\]/);
      assert.deepEqual(h.fx.calls, []);
      h.sayInGroup("/tail unipcs 2h");
      await h.until(() => h.sentTo(OWNER).length > 1);
      assert.match(h.sentTo(OWNER).at(-1)!, /^👀 Tail unipcs on Fomo for 2 hours/);
      for (const t of h.sentTo(GROUP)) assert.doesNotMatch(t, /unipcs|tail/i);
      h.sayInGroup("/tail unipcs 2h", FRIEND);
      await h.until(() => h.sentTo(GROUP).length > 2);
      assert.match(h.sentTo(GROUP).at(-1)!, /owner/);
      assert.deepEqual(h.sentTo(FRIEND), [], "an allowlisted friend's /tail reaches no DM");
    });
  });
});
