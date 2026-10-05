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
const { createFomoService, runPendingJobs } = await import("../fomo/service");
const fstore = await import("../fomo/store");
const { recentChatTurns } = await import("../store");

type Rec = Record<string, unknown>;

const T0 = Date.UTC(2026, 9, 4, 16, 5);
const ALERTS_NEWEST = 1788378000000;
const OWNER = 5150;
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
async function fomoFixture() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await fstore.ensureFomoSchema(db, "sqlite");
  const provider: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    provider.push(u.pathname);
    const p = u.pathname;
    if (p === "/v2/tokens/search") return fjson(fixture("tokens-search"));
    if (p === "/v2/search") return fjson(fixture("search"));
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
  const service = createFomoService({ db, dialect: "sqlite", client, access: async () => ({ ...access }), budget, now: () => Date.now() });
  const direct = createDirectBroker(service, TENANT, { now: () => Date.now() });
  const calls: { tool: FomoToolName; args: Rec; opts: BrokerCallOptions }[] = [];
  const cleared: string[] = [];
  const broker: FomoBroker = {
    call: (tool, args, opts) => {
      calls.push({ tool, args: { ...args }, opts: { ...opts, signal: undefined } });
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
  return { raw, db, service, broker, calls, cleared, provider, access };
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
  /** A live DM from `from`, optionally replying to a message (Telegram's reply_to_message). */
  say: (text: string, from?: number, replyTo?: Record<string, unknown>) => void;
  /** The message_id Telegram gave each sendMessage, in order. */
  sentIds: (chat: number) => number[];
  sentTo: (chat: number) => string[];
  /** Tick the mocked clock until `done()` or `ms` have passed. */
  until: (done: () => boolean, ms?: number) => Promise<void>;
  advance: (ms: number) => Promise<void>;
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

async function withDm(
  opts: { llm?: boolean; broker?: "fixture" | "absent" | "null"; composeReply?: string | null; fomoOff?: boolean },
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const llm: string[] = [];
  const composed: Harness["composed"] = [];
  const cfg: Record<string, unknown> = {
    telegramEnabled: true,
    telegramBotToken: "111:a",
    telegramAllowlist: [OWNER, FRIEND],
    telegramControlEnabled: true,
    telegramTransferEnabled: false,
    telegramPcControlEnabled: false,
    telegramAgentEnabled: false,
    telegramCapabilities: [],
    telegramMaxActionUsdg: 25,
    customTokens: [],
    ...(opts.llm ? { groqApiKey: "gsk_test_not_a_real_key", groqModel: "test-model" } : {}),
  };
  let state = blankState();
  const queue: unknown[] = [];
  let updateId = 1;
  let nextMessageId = 50_000;
  const realFetch = globalThis.fetch;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const m = /\/bot([^/]+)\/(\w+)$/.exec(String(url));
    if (!m) {
      llm.push(String(url));
      return { ok: false, status: 500, json: async () => ({ error: { message: "no model in this test" } }), text: async () => "no model in this test" };
    }
    const call: Call = { method: m[2]!, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} };
    calls.push(call);
    const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
    if (call.method === "getMe") return ok({ id: 111, username: "bot111", first_name: "Pine" });
    if (call.method === "getUpdates") return ok(queue.splice(0));
    if (call.method === "sendMessage") {
      const message_id = nextMessageId++;
      call.body.__message_id = message_id;
      return ok({ message_id });
    }
    return ok(true);
  }) as typeof fetch;
  const fx = await fomoFixture();
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
