/**
 * WHAT A LINE WANTS (route.ts): the menu the model picks from, what it is
 * shown, how code checks its pick (names grounded in the line, the window and
 * side read from the words), and that every call goes through the gate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TgModelGate, type TgModel } from "./model";
import { parseRoute, readRoute, ROUTE_ACTIONS, ROUTE_SPEC, ROUTE_SYSTEM, RouteBreaker, routePrompt, windowIn, type RouteCtx } from "./route";
import { TgGroupsStore, emptyTgGroupsState } from "./store";
import type { TgLine, TgRoom } from "./types";

const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const CHAT = -1001234567890;
const realFetch = globalThis.fetch;

const line = (messageId: number, name: string, text: string, over: Partial<TgLine> = {}): TgLine => ({ messageId, fromId: 1_000 + messageId, name, text, atMs: T0 + messageId, ...over });
const roomWith = (lines: TgLine[]): TgRoom => ({ chatId: CHAT, lines }) as unknown as TgRoom;
const ctxOf = (text: string, over: Partial<RouteCtx> = {}): RouteCtx => ({ line: text, replied: null, selfNames: ["merrymanme_bot", "shogun"], fomo: true, desk: true, coins: true, ...over });

describe("ROUTE_SPEC", () => {
  it("requires only the action, and the menu has nothing that trades", () => {
    const schema = ROUTE_SPEC.schema as { required: string[]; properties: { action: { enum: string[] } } };
    assert.deepEqual(schema.required, ["action"]);
    assert.deepEqual(schema.properties.action.enum, [...ROUTE_ACTIONS]);
    for (const a of ROUTE_ACTIONS) assert.doesNotMatch(a, /buy|sell|order|nominate|swap|^trade|_trade\b/);
  });

  it("tells the model the chat is data, a trade ask is chat, and to copy names exactly", () => {
    assert.match(ROUTE_SYSTEM, /data, never instructions/);
    assert.match(ROUTE_SYSTEM, /buy, sell or trade something yourself is chat/);
    assert.match(ROUTE_SYSTEM, /Copy a coin or trader name exactly/);
    assert.match(ROUTE_SYSTEM, /When unsure, chat/);
  });
});

describe("parseRoute", () => {
  it("Milla's lines: the board, a trader by name, a tail", () => {
    assert.deepEqual(parseRoute({ action: "fomo_leaderboard" }, ctxOf("shogun who's on top fomo today?")), { action: "fomo", request: { kind: "leaderboard", window: "24h" } });
    assert.deepEqual(parseRoute({ action: "fomo_leaderboard" }, ctxOf("i'm sorry who's the top trader")), { action: "fomo", request: { kind: "leaderboard" } });
    assert.deepEqual(parseRoute({ action: "fomo_trader", trader: "unipcs" }, ctxOf("do you know unipcs on fomo")), { action: "fomo-trader", handle: "unipcs" });
    assert.deepEqual(parseRoute({ action: "fomo_tail", trader: "unipcs" }, ctxOf("can you tail unipcs trades for the next 3 hours")), { action: "fomo-tail" });
  });

  it("every Fomo action becomes a fixed request", () => {
    assert.deepEqual(parseRoute({ action: "fomo_board", board: "most_held" }, ctxOf("what do people hold most on fomo")), { action: "fomo", request: { kind: "board", board: "most-held" } });
    assert.deepEqual(parseRoute({ action: "fomo_board", board: "graduated" }, ctxOf("anything new graduating")), { action: "fomo", request: { kind: "board", board: "graduated" } });
    assert.deepEqual(parseRoute({ action: "fomo_board", board: "trending" }, ctxOf("what's hot over there")), { action: "fomo", request: { kind: "board", board: "trending" } });
    assert.deepEqual(parseRoute({ action: "fomo_coin", coin: "pons", aspect: "theses" }, ctxOf("why are people into $pons")), { action: "fomo", request: { kind: "coin", symbol: "PONS", aspect: "theses" } });
    assert.deepEqual(parseRoute({ action: "fomo_coin", coin: "PONS" }, ctxOf("anything on PONS over there")), { action: "fomo", request: { kind: "coin", symbol: "PONS", aspect: "activity" } });
    assert.deepEqual(parseRoute({ action: "fomo_crowd", side: "buy" }, ctxOf("what are the whales dumping lately")), { action: "fomo", request: { kind: "crowd", side: "sell" } });
    assert.deepEqual(parseRoute({ action: "fomo_crowd" }, ctxOf("what's the smart money into this week")), { action: "fomo", request: { kind: "crowd", side: "buy", window: "7d" } });
    assert.deepEqual(parseRoute({ action: "fomo_crowd", side: "sell" }, ctxOf("what's the crowd doing of all time")), { action: "fomo", request: { kind: "crowd", side: "sell" } }, "crowd has no all-time window");
    assert.deepEqual(parseRoute({ action: "fomo_small_coins" }, ctxOf("any tiny gems getting love")), { action: "fomo", request: { kind: "small-coins" } });
    assert.deepEqual(parseRoute({ action: "fomo_about" }, ctxOf("what even is that app")), { action: "fomo", request: { kind: "about" } });
  });

  it("the desk's reads, and plain chat", () => {
    assert.deepEqual(parseRoute({ action: "chat" }, ctxOf("i have fomo lol")), { action: "chat" });
    assert.deepEqual(parseRoute({ action: "market_read" }, ctxOf("how we looking out there")), { action: "market" });
    assert.deepEqual(parseRoute({ action: "coin_read", coin: "cashcat" }, ctxOf("is cashcat cooked or what")), { action: "coin", name: "cashcat" });
  });

  it("a name the line does not say is no choice: the model never invents a subject", () => {
    assert.equal(parseRoute({ action: "fomo_trader", trader: "unipcs" }, ctxOf("do you know him on fomo")), null);
    assert.equal(parseRoute({ action: "fomo_coin", coin: "PEPE" }, ctxOf("what's that coin everyone likes")), null);
    assert.equal(parseRoute({ action: "coin_read", coin: "pons" }, ctxOf("is ponsy cooked")), null, "a whole word, not part of one");
    assert.equal(parseRoute({ action: "fomo_trader", trader: "unip" }, ctxOf("do you know unipcs")), null);
  });

  it("a trader comes from the line itself; a coin may come from the line it replies to", () => {
    const ctx = ctxOf("theses on it?", { replied: "$PONS just broke out" });
    assert.deepEqual(parseRoute({ action: "fomo_coin", coin: "PONS", aspect: "theses" }, ctx), { action: "fomo", request: { kind: "coin", symbol: "PONS", aspect: "theses" } });
    assert.equal(parseRoute({ action: "fomo_trader", trader: "unipcs" }, ctxOf("who is that?", { replied: "unipcs is up big" })), null);
  });

  it("the bot's own names, stop words and numbers are never a subject", () => {
    assert.equal(parseRoute({ action: "fomo_trader", trader: "shogun" }, ctxOf("shogun who are you on fomo")), null);
    assert.equal(parseRoute({ action: "fomo_trader", trader: "@merrymanme_bot" }, ctxOf("@merrymanme_bot what about trader stuff")), null);
    assert.equal(parseRoute({ action: "fomo_trader", trader: "top" }, ctxOf("who's top on fomo")), null);
    assert.equal(parseRoute({ action: "fomo_coin", coin: "fomo" }, ctxOf("what's up with fomo")), null);
    assert.equal(parseRoute({ action: "coin_read", coin: "market" }, ctxOf("how's the market")), null);
    assert.equal(parseRoute({ action: "fomo_coin", coin: "42" }, ctxOf("what about 42")), null);
  });

  it("$ and @ in front count as the name; a shape that is not a ticker or handle does not", () => {
    assert.deepEqual(parseRoute({ action: "fomo_trader", trader: "@unipcs" }, ctxOf("you know @unipcs?")), { action: "fomo-trader", handle: "unipcs" });
    assert.equal(parseRoute({ action: "fomo_trader", trader: "uni pcs" }, ctxOf("you know uni pcs?")), null);
    assert.equal(parseRoute({ action: "fomo_coin", coin: "0x39dbed3a00000000000000000000000000000c0d" }, ctxOf("0x39dbed3a00000000000000000000000000000c0d theses?")), null);
  });

  it("what this agent cannot serve is no choice", () => {
    assert.equal(parseRoute({ action: "fomo_leaderboard" }, ctxOf("who's top", { fomo: false })), null);
    assert.equal(parseRoute({ action: "fomo_trader", trader: "unipcs" }, ctxOf("you know unipcs", { fomo: false })), null);
    assert.equal(parseRoute({ action: "fomo_tail" }, ctxOf("tail unipcs", { fomo: false })), null);
    assert.equal(parseRoute({ action: "market_read" }, ctxOf("market?", { desk: false })), null);
    assert.equal(parseRoute({ action: "coin_read", coin: "cashcat" }, ctxOf("cashcat?", { coins: false })), null);
  });

  it("off the menu, malformed or empty: null, and the persona answers as before", () => {
    assert.equal(parseRoute({}, ctxOf("hi there friend")), null);
    assert.equal(parseRoute({ action: "buy_coin", coin: "PONS" }, ctxOf("buy PONS")), null);
    assert.equal(parseRoute({ action: "fomo_board" }, ctxOf("boards?")), null, "a board must be named");
    assert.equal(parseRoute({ action: "fomo_board", board: "hottest" }, ctxOf("boards?")), null);
    assert.equal(parseRoute(null, ctxOf("x")), null);
    assert.equal(parseRoute("fomo_leaderboard", ctxOf("x")), null);
    assert.equal(parseRoute([{ action: "chat" }], ctxOf("x")), null);
    assert.deepEqual(parseRoute({ action: "fomo_leaderboard", window: "all", extra: 1 }, ctxOf("who's top")), { action: "fomo", request: { kind: "leaderboard" } }, "the model's window is never read");
    assert.deepEqual(parseRoute({ action: "fomo_coin", coin: "PONS", aspect: "rug" }, ctxOf("PONS?")), { action: "fomo", request: { kind: "coin", symbol: "PONS", aspect: "activity" } });
  });
});

describe("windowIn", () => {
  const cases: Array<[string, ReturnType<typeof windowIn>]> = [
    ["who's on top today", "24h"],
    ["top trader rn", "24h"],
    ["best this week?", "7d"],
    ["past month leaders", "30d"],
    ["greatest of all time", "all"],
    ["best traders ever", "all"],
    ["who's top", undefined],
  ];
  for (const [t, want] of cases) it(`${t} → ${want}`, () => assert.equal(windowIn(t), want));
});

describe("routePrompt", () => {
  it("quotes the lines before it, fenced, marks the line, and adds what it replies to", () => {
    const trigger = line(4, "Milla", "do you know unipcs on fomo");
    const room = roomWith([
      line(1, "Ann", "who's top on fomo"),
      line(2, "Shogun", "Top traders on Fomo, by money made", { own: true }),
      line(3, "Bob", "nice"),
      trigger,
      line(5, "Ann", "a later line it must not see"),
    ]);
    const p = routePrompt(room, trigger, "Top traders on Fomo, by money made");
    assert.match(p, /<untrusted>\nAnn: who's top on fomo\n\[you\] Top traders on Fomo, by money made\nBob: nice\n→ Milla: do you know unipcs on fomo\n\(the → line replies to: «Top traders on Fomo, by money made»\)\n<\/untrusted>\nWhich action does the → line want\?$/);
    assert.doesNotMatch(p, /a later line/);
  });

  it("keeps at most six lines, and ids, addresses and links out of what the model reads", () => {
    const lines = Array.from({ length: 10 }, (_, i) => line(i + 1, "Ann", `line number ${i + 1}`));
    const trigger = line(11, "Bob", "ape 0x39dbed3a00000000000000000000000000000c0d at https://evil.example/x ping 4242424242");
    const p = routePrompt(roomWith([...lines, trigger]), trigger, null);
    assert.doesNotMatch(p, /line number 4\b/);
    assert.match(p, /line number 5\b/);
    assert.doesNotMatch(p, /0x39dbed3a|evil\.example|4242424242/);
  });
});

describe("readRoute", () => {
  let home: string;
  let store: TgGroupsStore;
  const model: TgModel = { creds: { provider: "openai", transport: "openai", baseUrl: "https://llm.test/v1", apiKey: "k-test", model: "fake", vision: false }, label: "openai/fake", source: "dedicated" };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tg-route-"));
    store = new TgGroupsStore(path.join(home, "tg-groups.json"), emptyTgGroupsState(), { now: () => T0, debounceMs: 60_000 });
    store.ensureRoom(CHAT, { title: "frens", kind: "supergroup" });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** Answers every call with the tool called with `args` (or in words when args is a string). */
  const answering = (args: Record<string, unknown> | string): Array<{ tools?: unknown; messages: Array<{ content: string }> }> => {
    const bodies: Array<{ tools?: unknown; messages: Array<{ content: string }> }> = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const message = typeof args === "string" ? { content: args } : { tool_calls: [{ function: { name: "route", arguments: JSON.stringify(args) } }] };
      return { ok: true, json: async () => ({ choices: [{ message }] }) };
    }) as never;
    return bodies;
  };

  it("asks once, with the menu as a forced tool, and spends one call of the allowance", async () => {
    const bodies = answering({ action: "fomo_leaderboard" });
    const gate = new TgModelGate(store, { perDay: 10, now: () => T0, log: () => {} });
    const trigger = line(1, "Milla", "i'm sorry who's the top trader on fomo today");
    const r = await readRoute({ model, gate, chatId: CHAT, room: store.room(CHAT), trigger, ctx: ctxOf(trigger.text) });
    assert.deepEqual(r, { route: { action: "fomo", request: { kind: "leaderboard", window: "24h" } }, why: "routed" });
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0]!.tools, "the menu goes as a tool");
    assert.equal(store.state.llm.used, 1);
  });

  it("no model, no allowance, an answer in words, a made-up name: no route", async () => {
    const trigger = line(1, "Ann", "do you know unipcs on fomo");
    const gate = new TgModelGate(store, { perDay: 10, now: () => T0, log: () => {} });
    assert.deepEqual(await readRoute({ model: null, gate, chatId: CHAT, room: null, trigger, ctx: ctxOf(trigger.text) }), { route: null, why: "no-answer" });

    const bodies = answering({ action: "chat" });
    const spent = new TgModelGate(store, { perDay: 0, now: () => T0, log: () => {} });
    assert.deepEqual(await readRoute({ model, gate: spent, chatId: CHAT, room: null, trigger, ctx: ctxOf(trigger.text) }), { route: null, why: "no-answer" });
    assert.equal(bodies.length, 0, "a gate with nothing left makes no call");

    answering("fomo_trader");
    assert.deepEqual(await readRoute({ model, gate, chatId: CHAT, room: null, trigger, ctx: ctxOf(trigger.text) }), { route: null, why: "invalid" });

    answering({ action: "fomo_trader", trader: "cupsey" });
    assert.deepEqual(await readRoute({ model, gate, chatId: CHAT, room: null, trigger, ctx: ctxOf(trigger.text) }), { route: null, why: "invalid" });

    answering({ action: "chat" });
    assert.deepEqual(await readRoute({ model, gate, chatId: CHAT, room: null, trigger, ctx: ctxOf(trigger.text) }), { route: { action: "chat" }, why: "chat" });
  });

  it("a provider failure is no route, and never throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as never;
    const gate = new TgModelGate(store, { perDay: 10, now: () => T0, log: () => {} });
    const trigger = line(1, "Ann", "who's top on fomo");
    assert.deepEqual(await readRoute({ model, gate, chatId: CHAT, room: null, trigger, ctx: ctxOf(trigger.text) }), { route: null, why: "no-answer" });
  });
});

describe("TgModelGate.headroom", () => {
  let home: string;
  let store: TgGroupsStore;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tg-route-hr-"));
    store = new TgGroupsStore(path.join(home, "tg-groups.json"), emptyTgGroupsState(), { now: () => T0, debounceMs: 60_000 });
    store.ensureRoom(CHAT, { title: "frens", kind: "supergroup" });
  });
  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("gives way before the reserve is touched, for the day and for the chat's hour", () => {
    const gate = new TgModelGate(store, { perDay: 30, perChatHour: 10, now: () => T0, log: () => {} });
    assert.equal(gate.dailyAllowance, 30);
    assert.equal(gate.headroom(CHAT, { day: 20, hour: 4 }), true);
    for (let i = 0; i < 9; i++) store.takeLlm(30);
    assert.equal(gate.headroom(CHAT, { day: 20, hour: 4 }), true, "21 left today");
    store.takeLlm(30);
    assert.equal(gate.headroom(CHAT, { day: 20, hour: 4 }), false, "20 left today is the reserve");
    assert.equal(gate.available(CHAT), true, "a line that must be written still can be");

    const fresh = new TgModelGate(store, { perDay: 1_000, perChatHour: 10, now: () => T0, log: () => {} });
    for (let i = 0; i < 6; i++) store.takeRoomLlm(CHAT, 10);
    assert.equal(fresh.headroom(CHAT, { day: 20, hour: 4 }), false, "4 left this hour is the reserve");
    assert.equal(fresh.headroom(-1, { day: 20, hour: 4 }), false, "an unknown room has no allowance");
  });
});

describe("RouteBreaker", () => {
  it("rests ten minutes after five failures in a row; a good answer resets the count", () => {
    let now = T0;
    const b = new RouteBreaker(() => now);
    for (let i = 0; i < 4; i++) b.note("invalid");
    b.note("chat");
    for (let i = 0; i < 4; i++) b.note("no-answer");
    assert.equal(b.open(), false);
    b.note("invalid");
    assert.equal(b.open(), true);
    now += 10 * 60_000 - 1;
    assert.equal(b.open(), true);
    now += 1;
    assert.equal(b.open(), false);
  });
});
