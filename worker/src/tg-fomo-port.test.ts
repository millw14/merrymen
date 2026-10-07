/**
 * THE GROUP RESEARCH PORT (tg-fomo-port.ts), against the real planner,
 * renderer, subject memory and research service over a fixture-backed
 * provider, through the real in-process broker (tenant fixed by trusted
 * context), and end to end through the real group handler and its gate.
 *
 * What these pin:
 *   - a group research question is a registered READ tool invoked with the
 *     group audience, the group surface, the trusted chat id as the group id
 *     and a per-room conversation key; the tenant is the broker's, whatever
 *     the text says;
 *   - what reaches the room has no handle, address, link or cashtag, and is
 *     attributed in words the group gate admits;
 *   - a trader question and an owner-state question are deflected before
 *     anything is looked up or written, and no watch can be made from a group;
 *   - no broker: a research question is told research is unavailable, and
 *     anything else is left alone.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";

import { wrapSqlite } from "./db";
import { createDirectBroker } from "./fomo/broker";
import { FomoBudget, MemoryAllowance } from "./fomo/budget";
import type { BrokerCallOptions, FomoBroker } from "./fomo/contract";
import { createFomoClient } from "./fomo/provider";
import { FOMO_ATTRIBUTION, FOMO_CAPABILITIES_GROUP, FOMO_GROUP_ON, NOT_PERMISSION_LINE } from "./fomo/render";
import { createFomoService } from "./fomo/service";
import * as fstore from "./fomo/store";
import type { FomoToolName } from "./fomo/types";
import type { ResolvedConfig } from "./settings";
import type { FetchLike, TgMessage } from "./telegram/api";
import type { StateRef, TelegramState } from "./telegram/state";
import { admitTgLine } from "./telegram/tg-groups/gate";
import { createTgGroups, type TgGroups } from "./telegram/tg-groups/handler";
import { __resetMemoryPassThrottleForTest } from "./telegram/tg-groups/memory";
import { TgGroupsStore, emptyTgGroupsState } from "./telegram/tg-groups/store";
import type { CoinLook, NominateResult, TgCoinsPort, TrencherReadiness } from "./telegram/tg-groups/types";
import { classifyFomoQuestion } from "./fomo/intent";
import { isMutationTool } from "./fomo/tools";
import {
  createTgFomoPort,
  groupWords,
  ownerMoves,
  requestText,
  tgGroupConversationKey,
  TG_FOMO_DEFLECTION,
  TG_FOMO_NOT_PERMISSION,
  TG_FOMO_UNAVAILABLE,
} from "./tg-fomo-port";

type Rec = Record<string, unknown>;

const NOW = Date.UTC(2026, 9, 4, 16, 5);
const ALERTS_NEWEST = 1788378000000;
const TENANT = "0xowner00000000000000000000000000000000001";
const GROUP = -100123;

const fixture = (name: string): Rec => JSON.parse(readFileSync(new URL(`./fomo/testdata/${name}.json`, import.meta.url), "utf8")) as Rec;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-credits-cost": "250" } });

interface Setup {
  raw: DatabaseSync;
  broker: FomoBroker;
  calls: { tool: FomoToolName; args: Rec; opts: BrokerCallOptions }[];
  provider: string[];
  tenants: string[];
  memory: { get: string[]; clear: string[] };
  clock: { now: number };
}

async function setup(): Promise<Setup> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await fstore.ensureFomoSchema(db, "sqlite");
  const clock = { now: NOW };
  const provider: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    provider.push(u.pathname);
    const p = u.pathname;
    if (p === "/v2/tokens/search") return json(fixture("tokens-search"));
    if (p === "/v2/search") return json(fixture("search"));
    if (p === "/v2/alerts") {
      const b = fixture("alerts");
      const shift = clock.now - 60_000 - ALERTS_NEWEST;
      for (const a of b.alerts as Rec[]) {
        if (typeof a.ts === "number") a.ts += shift;
        if (typeof a.execTs === "number") a.execTs += shift;
      }
      return json(b);
    }
    if (p.startsWith("/v2/thesis/token/")) return json(fixture("theses-token"));
    if (/\/stats$/.test(p)) return json(fixture("token-stats"));
    if (/\/balances$/.test(p)) return json(fixture("balances"));
    if (p.startsWith("/v2/leaderboard/tokens/")) return json(fixture("token-board-trending"));
    if (p.startsWith("/v2/leaderboard/")) {
      // The board answers for the window asked, captured a minute ago.
      return json({ ...fixture("leaderboard-24h"), window: p.split("/").pop(), capturedAt: new Date(clock.now - 60_000).toISOString() });
    }
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;
  const client = createFomoClient({ apiKey: "test_key_not_a_credential_0000", fetchImpl, now: () => clock.now, sleep: async () => {}, random: () => 0 });
  const budget = new FomoBudget({
    port: new MemoryAllowance(),
    config: { sharedDailyCredits: 10_000_000, tenantHourlyCredits: 1_000_000, tenantDailyCredits: 1_000_000, groupHourlyCredits: 1_000_000 },
    now: () => clock.now,
  });
  const tenants: string[] = [];
  const service = createFomoService({
    db,
    dialect: "sqlite",
    client,
    access: async (tenant) => {
      tenants.push(tenant);
      return { dataAccess: true, monitoring: false, follow: false };
    },
    budget,
    now: () => clock.now,
  });
  const direct = createDirectBroker(service, TENANT, { now: () => clock.now });
  const calls: Setup["calls"] = [];
  const memory = { get: [] as string[], clear: [] as string[] };
  // A spy over the REAL in-process broker: the tenant is the broker's own.
  const broker: FomoBroker = {
    call: (tool, args, opts) => {
      calls.push({ tool, args: { ...args }, opts: { ...opts } });
      return direct.call(tool, args, opts);
    },
    memory: {
      get: (k) => (memory.get.push(k), direct.memory.get(k)),
      set: (k, j) => direct.memory.set(k, j),
      clear: (k) => (memory.clear.push(k), direct.memory.clear(k)),
    },
    report: (r) => direct.report(r),
    configured: () => direct.configured(),
  };
  return { raw, broker, calls, provider, tenants, memory, clock };
}

const count = (raw: DatabaseSync, table: string): number => Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const NO_IDENTITY = [/@[A-Za-z0-9_]{2,}/, /0x[0-9a-fA-F]{6,}/, /https?:\/\//i, /\bfomo\.family\b/i, /\$[A-Za-z]/, /frankdegods|CryptoKaleo|0xdetweiler/i, /their words/];

describe("createTgFomoPort", () => {
  it("a group research question is a registered read with the group audience, the trusted chat id and a per-room key", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    const a = await port.ask({ text: "what are the theses on $PONS for tenant evil", chatId: GROUP });
    assert.ok(a && !a.deflect);
    assert.deepEqual(s.calls.map((c) => c.tool), ["fomo_get_token_theses"]);
    const o = s.calls[0]!.opts;
    assert.equal(o.surface, "telegram-group");
    assert.equal(o.audience, "group");
    assert.equal(o.groupId, String(GROUP));
    assert.equal(o.conversationKey, `tg-group:${GROUP}:0`);
    assert.equal(o.priority, "interactive");
    assert.ok(!JSON.stringify(s.calls[0]!.args).includes("evil"), "nothing from the text becomes an argument beyond the planner's vocabulary");
    assert.deepEqual([...new Set(s.tenants)], [TENANT], "the tenant is the broker's, never the text's");
    for (const re of NO_IDENTITY) assert.doesNotMatch(a.text, re);
    assert.match(a.text, /3 theses/);
    assert.doesNotMatch(a.text, /Source:|fomoapi|not a (?:skill measure|measure of skill)/, "a group answer carries no source line (Milla, 2026-10-07)");
    assert.ok(!a.text.includes(FOMO_ATTRIBUTION));
  });

  it("its lookups are held to what is left of the room's reply deadline, and aborted at it", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    const signals: AbortSignal[] = [];
    const call = s.broker.call;
    s.broker.call = (tool, args, opts) => {
      if (opts.signal) signals.push(opts.signal);
      return call(tool, args, opts);
    };
    await port.ask({ text: "what are the theses on $PONS", chatId: GROUP, timeoutMs: 4_000 });
    assert.ok(s.calls[0]!.opts.timeoutMs! <= 4_000 && s.calls[0]!.opts.timeoutMs! > 0);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.aborted, true, "nothing outlives the answer");
  });

  it("every line it returns for a coin read passes the group gate on its own", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    for (const q of ["what are the theses on $PONS", "who is buying $PONS on fomo?", "research $PONS on fomo"]) {
      s.clock.now += 30_000;
      const a = await port.ask({ text: q, chatId: GROUP });
      assert.ok(a && !a.deflect, q);
      const lines = a.text.split("\n").filter(Boolean);
      const admitted = lines.filter((l) => admitTgLine(l, { agentName: "Pine", kind: "research", recentOwn: [] }).ok);
      // The answer-first line is always sayable; a long coverage line may be dropped by the gate.
      assert.ok(admitted.includes(lines[0]!), `${q}: the answer is sayable (${a.text})`);
      assert.doesNotMatch(a.text, /Source:|fomoapi|not a (?:skill measure|measure of skill)/, q);
      for (const re of NO_IDENTITY) assert.doesNotMatch(a.text, re, q);
    }
  });

  it("a trader question is deflected before anything is looked up", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    for (const q of ["what is @CryptoKaleo holding on fomo?", "what has @frankdegods bought on fomo this week?", "who's the top of our watched traders on fomo today"]) {
      const a = await port.ask({ text: q, chatId: GROUP });
      assert.deepEqual(a, { text: TG_FOMO_DEFLECTION, deflect: true }, q);
    }
    assert.equal(s.calls.length, 0);
    assert.equal(s.provider.length, 0);
  });

  it("the public leaderboard is answered in a group: Fomo handles and short P&L, never who Merrymen follows, every line sayable", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    for (const q of ["who's the top trader on fomo today?", "who's the top on fomo today", "show me the leading traders this week on fomo"]) {
      s.clock.now += 30_000;
      const before = s.calls.length;
      const a = await port.ask({ text: q, chatId: GROUP });
      assert.ok(a && !a.deflect, q);
      assert.equal(s.calls[before]!.tool, "fomo_get_rankings", q);
      assert.equal(s.calls[before]!.args.board, "traders", q);
      assert.match(a.text, /\n1\. CryptoKaleo \+\$151\.4k\n2\. frankdegods -\$4\.2k$/, q);
      assert.ok(!/followed|@|0x[0-9a-fA-F]{6}|https?:/.test(a.text), a.text);
      assert.doesNotMatch(a.text, /Source:|fomoapi|not a (?:skill measure|measure of skill)/, q);
      for (const l of a.text.split("\n")) assert.ok(admitTgLine(l, { agentName: "Pine", kind: "research", recentOwn: [] }).ok, `${q}: ${l}`);
    }
  });

  it("a board's market caps reach the room in short form instead of being dropped", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    const a = await port.ask({ text: "what's trending on fomo?", chatId: GROUP });
    assert.ok(a && !a.deflect);
    assert.match(a.text, /1\. PONS on robinhood, market cap \$2\.1M/);
    for (const l of a.text.split("\n")) assert.ok(admitTgLine(l, { agentName: "Pine", kind: "research", recentOwn: [] }).ok, l);
  });

  it("an owner-state or watch question is deflected, and no watch is ever made from a group", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    for (const q of ["research status on fomo", "keep an eye on $PONS for me on fomo", "watch $PONS on fomo for 3 days", "why did you skip $PONS on fomo?"]) {
      const a = await port.ask({ text: q, chatId: GROUP });
      assert.ok(a?.deflect, q);
    }
    assert.ok(!s.calls.some((c) => c.tool === "fomo_watch_coin" || c.tool === "fomo_unwatch_coin" || c.tool === "fomo_get_research_status"));
    assert.equal(count(s.raw, "fomo_watches"), 0);
  });

  it("C8: the bot's own @username, anywhere in the line, addresses the bot and is never researched as a trader", async () => {
    const selfNames = ["Pine", "@pinebot"];
    for (const [q, tool] of [
      ["@pinebot theses on $PONS?", "fomo_get_token_theses"],
      ["hey @pinebot what's trending on fomo?", "fomo_get_rankings"],
      ["what are the theses on $PONS @pinebot", "fomo_get_token_theses"],
      ["@pinebot trending on fomo?", "fomo_get_rankings"],
      ["@PineBot who is buying $PONS on fomo?", "fomo_get_token_activity"],
      ["pine, theses on $PONS?", "fomo_get_token_theses"],
    ] as const) {
      const s = await setup();
      const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
      const a = await port.ask({ text: q, chatId: GROUP, selfNames });
      assert.ok(a, q);
      assert.equal(a.deflect, false, `${q}: deflected as if the bot were a trader`);
      assert.deepEqual(s.calls.map((c) => c.tool), [tool], q);
      assert.ok(!s.calls.some((c) => typeof c.args.trader === "string"), q);
      // The room's remembered subjects never include the bot.
      const stored = await s.broker.memory.get(`tg-group:${GROUP}:0`);
      assert.doesNotMatch(String(stored), /pinebot/i, q);
    }
    // Another account's handle is still a trader, and still deflected.
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    assert.deepEqual(await port.ask({ text: "@pinebot what is @CryptoKaleo holding on fomo?", chatId: GROUP, selfNames }), { text: TG_FOMO_DEFLECTION, deflect: true });
    assert.equal(s.calls.length, 0);
  });

  it("a line that is not research is left to the desk and the persona, with no lookup", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    for (const q of ["gm frens", "I have fomo lol", "buy 50 USDG of PEPE", "how's the market?"]) assert.equal(await port.ask({ text: q, chatId: GROUP }), null, q);
    assert.equal(s.calls.length, 0);
  });

  it("follow-ups keep the room's coin, per room and topic", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    await port.ask({ text: "what are the theses on $PONS", chatId: GROUP, threadId: 77 });
    s.clock.now += 30_000;
    const a = await port.ask({ text: "What about the sellers?", chatId: GROUP, threadId: 77 });
    assert.ok(a && !a.deflect);
    const last = s.calls[s.calls.length - 1]!;
    assert.equal(last.tool, "fomo_get_token_activity");
    assert.deepEqual(last.args, { token: "0x39dbed3a00000000000000000000000000000c0d", chain: "robinhood", side: "sell" });
    assert.equal(last.opts.conversationKey, `tg-group:${GROUP}:77`);
    // Another room has no "it".
    const other = await port.ask({ text: "What about the sellers?", chatId: GROUP - 1 });
    assert.ok(other === null || !s.calls.slice(-1)[0]!.opts.conversationKey?.endsWith(":77"));
  });

  it("the owner's forget clears every topic's subject memory it used in that room", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    await port.ask({ text: "what are the theses on $PONS", chatId: GROUP, threadId: 77 });
    await port.forget!(GROUP);
    assert.deepEqual(s.memory.clear.sort(), [`tg-group:${GROUP}:0`, `tg-group:${GROUP}:77`].sort());
    assert.equal(await s.broker.memory.get(`tg-group:${GROUP}:77`), null);
  });

  it("no broker: a research question hears that research is unavailable here; anything else is left alone", async () => {
    const port = createTgFomoPort(() => null);
    assert.deepEqual(await port.ask({ text: "what are fomo traders buying?", chatId: GROUP }), { text: TG_FOMO_UNAVAILABLE, deflect: false });
    assert.equal(await port.ask({ text: "gm", chatId: GROUP }), null);
    const throwing = createTgFomoPort(() => {
      throw new Error("not wired");
    });
    assert.deepEqual(await throwing.ask({ text: "what are fomo traders buying?", chatId: GROUP }), { text: TG_FOMO_UNAVAILABLE, deflect: false });
  });

  it("refuses an unusable chat id rather than inventing a group", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker);
    assert.equal(await port.ask({ text: "what are fomo traders buying?", chatId: 0 }), null);
    assert.equal(await port.ask({ text: "what are fomo traders buying?", chatId: Number.NaN }), null);
    assert.equal(s.calls.length, 0);
  });
});

describe("a model's checked choice, asked as the planner's own question", () => {
  // Every request plans exactly the intended read, and never a write: the model reaches the provider only through these.
  const cases: Array<[Parameters<typeof requestText>[0], string, Record<string, unknown>]> = [
    [{ kind: "leaderboard" }, "fomo_get_rankings", { board: "traders", window: "24h" }],
    [{ kind: "leaderboard", window: "7d" }, "fomo_get_rankings", { board: "traders", window: "7d" }],
    [{ kind: "leaderboard", window: "30d" }, "fomo_get_rankings", { board: "traders", window: "30d" }],
    [{ kind: "leaderboard", window: "all" }, "fomo_get_rankings", { board: "traders", window: "all" }],
    [{ kind: "board", board: "trending" }, "fomo_get_rankings", { board: "trending-tokens" }],
    [{ kind: "board", board: "graduated" }, "fomo_get_rankings", { board: "graduated-tokens" }],
    [{ kind: "board", board: "most-held" }, "fomo_get_rankings", { board: "most-held-tokens" }],
    [{ kind: "coin", symbol: "PONS", aspect: "theses" }, "fomo_get_token_theses", { token: "PONS" }],
    [{ kind: "coin", symbol: "pons", aspect: "buyers" }, "fomo_get_token_activity", { token: "PONS", side: "buy" }],
    [{ kind: "coin", symbol: "PONS", aspect: "sellers" }, "fomo_get_token_activity", { token: "PONS", side: "sell" }],
    [{ kind: "coin", symbol: "PONS", aspect: "activity" }, "fomo_get_token_activity", { token: "PONS" }],
    [{ kind: "coin", symbol: "PONS", aspect: "research" }, "fomo_research_coin", { token: "PONS", depth: "standard" }],
    [{ kind: "crowd", side: "buy" }, "fomo_get_token_activity", { side: "buy" }],
    [{ kind: "crowd", side: "sell", window: "7d" }, "fomo_get_token_activity", { side: "sell", window: "7d" }],
    [{ kind: "small-coins" }, "fomo_find_opportunities", {}],
    [{ kind: "status" }, "fomo_get_research_status", {}],
  ];
  for (const [r, tool, args] of cases) {
    it(`${JSON.stringify(r)} → ${tool} ${JSON.stringify(args)}`, () => {
      const plan = classifyFomoQuestion(requestText(r)!, { memory: null, now: NOW });
      assert.ok(plan, requestText(r)!);
      assert.deepEqual(plan.toolCalls.map((c) => [c.tool, c.args]), [[tool, args]]);
      assert.ok(!plan.toolCalls.some((c) => isMutationTool(c.tool)));
    });
  }
  it("'about' is the fixed capabilities answer, and a trader or a ticker that is not one has no question", () => {
    assert.equal(classifyFomoQuestion(requestText({ kind: "about" })!, { memory: null, now: NOW })?.intent, "capabilities");
    assert.equal(requestText({ kind: "trader" }), null);
    assert.equal(requestText({ kind: "coin", symbol: "not a ticker!", aspect: "theses" }), null);
  });

  it("a trader request is deflected before anything is planned or spent", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    assert.deepEqual(await port.ask({ text: "", request: { kind: "trader" }, chatId: GROUP }), { text: TG_FOMO_DEFLECTION, deflect: true });
    assert.equal(s.calls.length, 0);
  });

  it("a request is answered from its fixed question, whatever the line said", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    const a = await port.ask({ text: "yo who's cooking on that app today", request: { kind: "leaderboard" }, chatId: GROUP });
    assert.ok(a && !a.deflect);
    assert.match(a.text, /^Top traders on Fomo, last 24h/);
    assert.equal(s.calls[0]!.tool, "fomo_get_rankings");
    assert.equal(a.moves, undefined, "no moves unless the owner asked");
  });
});

describe("the owner's moves", () => {
  it("after the trader board: the questions that open each trader's book, for her DM; the room hears only that it went", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    const a = await port.ask({ text: "who's the top trader on fomo today?", owner: true, chatId: GROUP });
    assert.ok(a?.moves);
    assert.equal(a.moves.kind, "traders");
    assert.match(a.moves.dm, /<code>what is trader CryptoKaleo holding<\/code>/);
    assert.match(a.moves.dm, /<code>what has trader frankdegods bought this week<\/code>/);
    assert.ok(admitTgLine(a.moves.room, { agentName: "Pine", kind: "research", recentOwn: [] }).ok);
    assert.doesNotMatch(a.moves.room, /CryptoKaleo|frankdegods|tail/i, "the room line names nobody");
    // Every suggested question plans the intended read when she types it.
    assert.equal(classifyFomoQuestion("what is trader CryptoKaleo holding", { memory: null, now: NOW })?.intent, "trader-holdings");
    assert.equal(classifyFomoQuestion("what has trader frankdegods bought this week", { memory: null, now: NOW })?.intent, "trader-activity");
  });

  it("after a coin board: /buy only where /buy resolves, the CA to post for a review on Robinhood Chain, watch and theses", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now, buyable: (sym) => sym === "PONS" });
    const a = await port.ask({ text: "what's trending on fomo?", owner: true, chatId: GROUP });
    assert.ok(a?.moves);
    assert.equal(a.moves.kind, "coins");
    assert.match(a.moves.dm, /<code>\/buy PONS 5<\/code>/);
    assert.match(a.moves.dm, /<code>0x39dbed3a00000000000000000000000000000c0d<\/code>/i);
    assert.match(a.moves.dm, /<code>watch PONS on fomo<\/code>/);
    assert.match(a.moves.dm, /FU2O<\/b> \(solana\)\n• not tradeable from here/);
    assert.doesNotMatch(a.moves.dm, /\/buy FU2O|\/buy CACHE/, "never /buy for a coin /buy would refuse");
    assert.equal(classifyFomoQuestion("watch PONS on fomo", { memory: null, now: NOW })?.intent, "watch");
  });

  it("nothing for a stranger, a deflection or an answer with no usable row", async () => {
    const s = await setup();
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    assert.equal((await port.ask({ text: "what's trending on fomo?", chatId: GROUP }))?.moves, undefined);
    assert.equal((await port.ask({ text: "what is @CryptoKaleo holding on fomo?", owner: true, chatId: GROUP }))?.moves, undefined);
    assert.equal(ownerMoves({ handled: false }), null);
  });
});

describe("groupWords", () => {
  it("puts the renderer's fixed wording into words the group gate admits", () => {
    const out = groupWords(
      [
        "PONS on robinhood in the last 24h: 1 distinct buyer and 0 sellers observed (positions above about $3,000; a floor, not a census).",
        "No sells: the feed only shows positions above roughly $3,000.",
        "Flow (provider-reported). From a copy fetched 2m ago.",
        NOT_PERMISSION_LINE,
        FOMO_ATTRIBUTION,
        "P&L is the provider-reported realised P&L for the window, not a measure of skill; follower counts are not used.",
        "Trending on Fomo (board position is popularity, not quality):",
      ].join("\n"),
    ).split("\n");
    assert.equal(out[0], "PONS on robinhood in the last 24h: 1 distinct buyer and 0 sellers observed (large positions only; a floor, not a census).");
    assert.equal(out[1], "No sells: the feed only shows large positions.");
    assert.equal(out[2], "Flow (source-reported). From a copy fetched 2 min ago.");
    assert.equal(out[3], TG_FOMO_NOT_PERMISSION);
    // The owner's attribution and skill caveat are dropped, never reworded into the room.
    assert.equal(out[4], "Trending on Fomo (board position is popularity, not quality):");
    assert.equal(out.length, 5);
    for (const l of out) assert.ok(admitTgLine(l, { agentName: "Pine", kind: "answer", recentOwn: [] }).ok, l);
  });

  it("the conversation key is per room and topic, from numbers only", () => {
    assert.equal(tgGroupConversationKey(-100123), "tg-group:-100123:0");
    assert.equal(tgGroupConversationKey(-100123, 9), "tg-group:-100123:9");
    assert.equal(tgGroupConversationKey(-100123, -1), "tg-group:-100123:0");
  });
});

// ─── End to end: the real handler, the real port, the real research ─────────

class FakeTg {
  calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  private nextId = 5_000;
  fetchFn: FetchLike = async (url, init) => {
    const method = url.split("/").pop() ?? "";
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    this.calls.push({ method, body });
    const env = method === "sendMessage" ? { ok: true, result: { message_id: this.nextId++ } } : { ok: true, result: true };
    return { ok: true, status: 200, json: async () => env };
  };
  texts(chatId: number): string[] {
    return this.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId).map((c) => String(c.body.text));
  }
}

const coins: TgCoinsPort = {
  readiness: (): TrencherReadiness => ({ kind: "ready-paper", ownerReason: "ready" }),
  look: async (): Promise<CoinLook> => ({ kind: "candidate", name: "Froggy" }),
  nominate: (): NominateResult => ({ ok: true }),
  onOutcome: () => () => {},
  heldNames: () => [],
  mode: () => "paper",
};

describe("a group research question, end to end", () => {
  let home: string;
  let store: TgGroupsStore;
  let groups: TgGroups | null = null;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tg-fomo-e2e-"));
    __resetMemoryPassThrottleForTest();
  });
  afterEach(async () => {
    groups?.stop();
    await groups?.drain();
    store?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("the room gets coin-level aggregates through the group gate: no handles, addresses, links or cashtags; a trader question is deflected", async () => {
    const s = await setup();
    let clock = NOW;
    store = new TgGroupsStore(path.join(home, "tg-groups.json"), emptyTgGroupsState(), { now: () => clock, debounceMs: 60_000 });
    store.ensureRoom(GROUP, { title: "frens", kind: "supergroup" });
    store.setStatus(GROUP, "approved", 4242);
    store.update(GROUP, (r) => { r.helloSaid = true; });
    const tg = new FakeTg();
    let tstate = { ownerId: 4242 } as unknown as TelegramState;
    const stateRef: StateRef = { get: () => tstate, set: (x) => { tstate = x; } };
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    groups = createTgGroups({
      opts: () => ({ token: "123:TOKEN", fetchFn: tg.fetchFn }),
      store,
      getCfg: () => ({ telegramGroupsEnabled: true, telegramGroupCoinsEnabled: true, telegramGroupsChattiness: "normal", telegramAllowlist: [4242] }) as unknown as ResolvedConfig,
      stateRef,
      port: () => coins,
      fomo: () => port,
      self: () => ({ id: 999, username: "pinebot", name: "Pine" }),
      privacyOff: () => false,
      note: () => {},
      dashboardBase: () => "https://app.test",
      agentKey: () => "agent-1",
      now: () => clock,
      rand: () => 0.99,
      env: {},
      hosted: true,
      sleep: async (ms) => { clock += Math.max(0, ms); },
      timer: () => new Promise(() => {}),
      log: () => {},
    });
    let id = 100;
    const msg = (text: string): TgMessage => ({ updateId: id, chatId: GROUP, fromId: 777 + id, fromFirstName: "Ann", fromIsBot: false, text, date: Math.floor(clock / 1000), messageId: id++, dateSec: Math.floor(clock / 1000), chatType: "supergroup", chatTitle: "frens" });

    groups.onMessage(msg("pine what are the theses on $PONS?"));
    await groups.drain();
    const first = tg.texts(GROUP);
    assert.equal(first.length, 1);
    assert.match(first[0]!, /3 theses/);
    assert.doesNotMatch(first[0]!, /Source:|fomoapi|not a (?:skill measure|measure of skill)/);
    for (const re of NO_IDENTITY) assert.doesNotMatch(first[0]!, re);
    assert.equal(s.calls[0]!.opts.audience, "group");
    assert.equal(s.calls[0]!.opts.groupId, String(GROUP));

    clock += 60_000;
    s.clock.now += 60_000;
    groups.onMessage(msg("pine what is @CryptoKaleo holding on fomo?"));
    await groups.drain();
    const second = tg.texts(GROUP);
    assert.equal(second.length, 2);
    assert.equal(second[1], TG_FOMO_DEFLECTION);
    assert.equal(s.calls.length, 1, "the trader question cost no lookup");

    // C8: addressed by @username (privacy mode's usual form), leading or trailing, it is still a coin question.
    for (const line of ["@pinebot theses on $PONS?", "what are the theses on $PONS @pinebot"]) {
      clock += 120_000;
      s.clock.now += 120_000;
      const before = tg.texts(GROUP).length;
      const looked: number = s.calls.length;
      groups!.onMessage(msg(line));
      await groups!.drain();
      const out = tg.texts(GROUP);
      assert.equal(out.length, before + 1, line);
      assert.notEqual(out[out.length - 1], TG_FOMO_DEFLECTION, `${line}: the bot's handle was read as a trader`);
      assert.match(out[out.length - 1]!, /3 theses/, line);
      assert.equal(s.calls.length, looked + 1, line);
      assert.equal(s.calls[s.calls.length - 1]!.tool, "fomo_get_token_theses", line);
    }
  });

  it("the room hears Fomo's public leaderboard with its figures, and a trending board with its market caps", async () => {
    const s = await setup();
    let clock = NOW;
    store = new TgGroupsStore(path.join(home, "tg-groups.json"), emptyTgGroupsState(), { now: () => clock, debounceMs: 60_000 });
    store.ensureRoom(GROUP, { title: "frens", kind: "supergroup" });
    store.setStatus(GROUP, "approved", 4242);
    store.update(GROUP, (r) => { r.helloSaid = true; });
    const tg = new FakeTg();
    let tstate = { ownerId: 4242 } as unknown as TelegramState;
    const stateRef: StateRef = { get: () => tstate, set: (x) => { tstate = x; } };
    const port = createTgFomoPort(() => s.broker, { now: () => s.clock.now });
    const logs: string[] = [];
    groups = createTgGroups({
      opts: () => ({ token: "123:TOKEN", fetchFn: tg.fetchFn }),
      store,
      getCfg: () => ({ telegramGroupsEnabled: true, telegramGroupCoinsEnabled: true, telegramGroupsChattiness: "normal", telegramAllowlist: [4242] }) as unknown as ResolvedConfig,
      stateRef,
      port: () => coins,
      fomo: () => port,
      self: () => ({ id: 999, username: "pinebot", name: "Pine" }),
      privacyOff: () => false,
      note: () => {},
      dashboardBase: () => "https://app.test",
      agentKey: () => "agent-1",
      now: () => clock,
      rand: () => 0.99,
      env: {},
      hosted: true,
      sleep: async (ms) => { clock += Math.max(0, ms); },
      timer: () => new Promise(() => {}),
      log: (l) => logs.push(l),
    });
    let id = 100;
    const msg = (text: string): TgMessage => ({ updateId: id, chatId: GROUP, fromId: 777 + id, fromFirstName: "Ann", fromIsBot: false, text, date: Math.floor(clock / 1000), messageId: id++, dateSec: Math.floor(clock / 1000), chatType: "supergroup", chatTitle: "frens" });

    groups.onMessage(msg("pine who's the top on fomo today"));
    await groups.drain();
    const board = tg.texts(GROUP);
    assert.equal(board.length, 1);
    assert.deepEqual(board[0]!.split("\n"), ["Top traders on Fomo, last 24h, by money made on closed trades:", "1. CryptoKaleo +$151.4k", "2. frankdegods -$4.2k"]);
    assert.doesNotMatch(board[0]!, /Source:|fomoapi|not a (?:skill measure|measure of skill)/, "no source line and no skill caveat in the room");
    assert.doesNotMatch(board[0]!, /followed|@|0x[0-9a-fA-F]{6}|https?:/);
    assert.ok(!logs.some((l) => /research lines dropped/.test(l)), "no line of the board was refused");

    clock += 120_000;
    s.clock.now += 120_000;
    groups.onMessage(msg("pine what's trending on fomo?"));
    await groups.drain();
    const trending = tg.texts(GROUP);
    assert.equal(trending.length, 2);
    assert.match(trending[1]!, /\n1\. PONS on robinhood, market cap \$2\.1M\n/);
    assert.doesNotMatch(trending[1]!, /Source:|fomoapi|not a (?:skill measure|measure of skill)/);

    // The lines the room actually asked on 2026-10-07, answered by code with no lookup.
    const looked = s.calls.length;
    clock += 120_000;
    s.clock.now += 120_000;
    groups.onMessage(msg("pine what can you do with fomo"));
    await groups.drain();
    clock += 120_000;
    s.clock.now += 120_000;
    groups.onMessage(msg("pine is fomo working"));
    await groups.drain();
    const said = tg.texts(GROUP);
    assert.equal(said.length, 4);
    assert.equal(said[2], FOMO_CAPABILITIES_GROUP);
    assert.equal(said[3], FOMO_GROUP_ON);
    assert.equal(s.calls.length, looked, "neither cost a lookup");
  });
});
