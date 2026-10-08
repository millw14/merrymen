/**
 * A REQUEST IS NEVER SILENTLY LOST (docs/tg-groups.md "When it speaks"): the
 * live 2026-10-07 22:58-22:59 silences, replayed through the real handler,
 * store, gate and router against a fake Bot API, a desk whose reads a test
 * can hold, a spy research port and a scripted model. Each case is a d1
 * probe (scratchpad diag/d1-silence-misread.test.ts) with its outcome
 * reversed:
 *
 *   - "what's trending", then "shogun" ten seconds in: the slow read was
 *     dropped as a burst. Now the poke gets a 👀 and the read lands.
 *   - "i asked a question" under "yo": searched as the coin "yo", or a
 *     market read nobody asked for. Now her lost ask runs again, once, as
 *     the reply to it; with nothing open, "which question?".
 *   - typing shows for as long as a read runs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ResolvedConfig } from "../../settings";
import type { FetchLike, TgMessage } from "../api";
import type { StateRef, TelegramState } from "../state";
import type { BotSelf } from "./detect";
import { admitTgLine } from "./gate";
import { createTgGroups, type TgGroups, type TgGroupsDeps } from "./handler";
import { __resetMemoryPassThrottleForTest } from "./memory";
import { TgGroupsStore, emptyTgGroupsState } from "./store";
import type {
  CoinLook,
  CoinOutcome,
  NominateResult,
  TgCoinsPort,
  TgDeskAsk,
  TgDeskEvidence,
  TgDeskOutcome,
  TgDeskPort,
  TgFomoAnswer,
  TgFomoPort,
  TgFomoRequest,
  TrencherReadiness,
} from "./types";

const SEC = 1_000;
const MIN = 60 * SEC;
const T0 = Date.UTC(2026, 9, 7, 22, 57, 0);
const CHAT = -1009876543210;
const MILLA = 424242;
const BOB = 515151;
const TOKEN = "123456:SECRET-TOKEN-XYZ";
const BOT: BotSelf = { id: 999999, username: "Merrymanme_bot", name: "Shogun" };
const CA = "0xabab00000000000000000000000000000000c0de";

class FakeTg {
  calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  /** Sends to the room refused (a 400) before the next one goes through. */
  failNext = 0;
  private nextId = 5_000;
  fetchFn: FetchLike = async (url, init) => {
    const method = url.split("/").pop() ?? "";
    const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    this.calls.push({ method, body });
    if ((method === "sendMessage" || method === "sendPhoto") && body.chat_id === CHAT && this.failNext > 0) {
      this.failNext--;
      return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: "Bad Request: message to be replied not found" }) };
    }
    const env = method === "sendMessage" || method === "sendPhoto" ? { ok: true, result: { message_id: this.nextId++ } } : { ok: true, result: true };
    return { ok: true, status: 200, json: async () => env };
  };
  /** The room's lines, with the message each replies to. */
  out(): Array<{ text: string; replyTo?: number }> {
    return this.calls
      .filter((c) => (c.method === "sendMessage" || c.method === "sendPhoto") && c.body.chat_id === CHAT)
      .slice()
      .map((c) => ({ text: String(c.body.text ?? c.body.caption ?? ""), replyTo: (c.body.reply_parameters as { message_id?: number } | undefined)?.message_id }));
  }
  reactions(): Array<{ messageId: number; emoji: string }> {
    return this.calls
      .filter((c) => c.method === "setMessageReaction")
      .map((c) => ({ messageId: Number(c.body.message_id), emoji: String((c.body.reaction as Array<{ emoji?: string }>)?.[0]?.emoji ?? "") }));
  }
  actions(): string[] {
    return this.calls.filter((c) => c.method === "sendChatAction").map((c) => String(c.body.action));
  }
}

const coinCalls: string[] = [];
class FakePort implements TgCoinsPort {
  readiness(): TrencherReadiness {
    return { kind: "ready-paper", ownerReason: "ready" };
  }
  async look(address: string): Promise<CoinLook> {
    coinCalls.push(`look:${address}`);
    return { kind: "candidate", name: "Froggy" };
  }
  nominate(): NominateResult {
    coinCalls.push("nominate");
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

type SpyAsk = { text: string; request?: TgFomoRequest; chatId: number; threadId?: number; timeoutMs?: number; owner?: boolean };
const BOARD = "Trending on Fomo (board position is popularity, not quality):\n1. ETAC on solana, market cap $874.6k";
class SpyFomo implements TgFomoPort {
  asks: SpyAsk[] = [];
  hold: Promise<void> | null = null;
  async ask(q: SpyAsk): Promise<TgFomoAnswer | null> {
    this.asks.push({ ...q });
    if (this.hold) await this.hold;
    if (q.request?.kind === "board" || /trending on fomo/i.test(q.text)) return { text: BOARD, deflect: false, status: "ok" };
    if (q.request?.kind === "trader") return { text: `${q.request.handle} on Fomo holds 3 coins worth $12k (source-reported snapshot, valued at current prices).`, deflect: false, status: "ok" };
    return null;
  }
  async forget(): Promise<void> {}
}

const MARKET: TgDeskEvidence = {
  kind: "market",
  subject: "market",
  header: ["Robinhood Chain market", "24h: 12 up / 30 down"],
  brief: "market breadth 24h: 12 up, 30 down. top gainer PONS +40%.",
  floor: { read: "the chain is mostly red today, a few runners like pons carrying it.", stance: "cautious", watch: "breadth turning green", invalidation: "" },
  source: "GeckoTerminal 22:58 UTC",
  observedAtMs: T0,
  chart: null,
};

class CtlDesk implements TgDeskPort {
  asks: TgDeskAsk[] = [];
  /** Null: answers at once; else a gate the test opens. */
  hold: Promise<void> | null = null;
  async look(ask: TgDeskAsk): Promise<TgDeskOutcome> {
    this.asks.push(ask);
    if (this.hold) await this.hold;
    if (ask.kind === "market") return { ok: true, evidence: MARKET };
    return { ok: false, why: "not-found" };
  }
}

let home: string;
let clock: number;
let store: TgGroupsStore;
let tg: FakeTg;
let fomo: SpyFomo | null;
let desk: CtlDesk;
let envVars: Record<string, string | undefined>;
let logs: string[];
let groups: TgGroups;
let nextMsg: number;
let tstate: TelegramState;
let picks: Array<Record<string, unknown>>;
let routePrompts: string[];
let chatReply: string;
const stateRef: StateRef = { get: () => tstate, set: (s) => { tstate = s; } };
const realFetch = globalThis.fetch;
const cfg = { telegramGroupsEnabled: true, telegramGroupCoinsEnabled: true, telegramGroupsChattiness: "normal", telegramAllowlist: [MILLA] };

function make(over: Partial<TgGroupsDeps> = {}): TgGroups {
  groups = createTgGroups({
    opts: () => ({ token: TOKEN, fetchFn: tg.fetchFn }),
    store,
    getCfg: () => cfg as unknown as ResolvedConfig,
    stateRef,
    port: () => new FakePort(),
    desk: () => desk,
    fomo: () => fomo,
    facts: () => ({ tradesToday: async () => ({ day: "2026-10-07", complete: true, trades: [] }) }),
    self: () => BOT,
    privacyOff: () => false,
    note: () => {},
    dashboardBase: () => "https://app.test",
    agentKey: () => "agent-1",
    now: () => clock,
    rand: () => 0.99,
    env: envVars,
    hosted: true,
    sleep: async (ms) => { clock += Math.max(0, ms); },
    timer: () => new Promise(() => {}),
    tick: () => new Promise(() => {}),
    log: (s) => logs.push(s),
    ...over,
  });
  return groups;
}

function msg(text: string, over: Partial<TgMessage> = {}): TgMessage {
  const id = nextMsg++;
  return { updateId: id, chatId: CHAT, fromId: MILLA, fromFirstName: "Milla", fromIsBot: false, text, date: Math.floor(clock / 1000), messageId: id, dateSec: Math.floor(clock / 1000), chatType: "supergroup", chatTitle: "frens", ...over };
}
const under = (text: string, own: { id: number; text: string }, over: Partial<TgMessage> = {}): TgMessage =>
  msg(text, { replyTo: { messageId: own.id, fromId: BOT.id, fromIsBot: true, text: own.text }, ...over });

async function said(m: TgMessage): Promise<void> {
  groups.onMessage(m);
  await groups.drain();
}
/** Let detached work run to its next await without moving the clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
}
function lastOwn(): { id: number; text: string } {
  const l = (store.room(CHAT)?.lines ?? []).filter((x) => x.own).slice(-1)[0]!;
  return { id: l.messageId, text: l.text };
}
/** One of its own lines, as if it had said it: "yo" to a poke, as live. */
function ownLine(id: number, text: string): { id: number; text: string } {
  store.update(CHAT, (r) => { r.lines.push({ messageId: id, fromId: BOT.id, name: "Shogun", text, atMs: clock, own: true }); });
  return { id, text };
}
const quiet = (): string[] => logs.filter((l) => l.startsWith("[tg-groups] addressed line got nothing"));

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "tg-lost-asks-"));
  clock = T0;
  store = new TgGroupsStore(path.join(home, "tg-groups.json"), emptyTgGroupsState(), { now: () => clock, debounceMs: 60_000 });
  tg = new FakeTg();
  fomo = null;
  desk = new CtlDesk();
  tstate = { ownerId: MILLA } as unknown as TelegramState;
  envVars = {
    MERRYMEN_TG_GROUPS_LLM_KEY: "k-test",
    MERRYMEN_TG_GROUPS_LLM_PROVIDER: "openai",
    MERRYMEN_TG_GROUPS_LLM_BASE_URL: "https://llm.test/v1",
    MERRYMEN_TG_GROUPS_MODEL: "fake",
  };
  picks = [];
  routePrompts = [];
  chatReply = "ngl no clue";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { tools?: unknown; messages: Array<{ role: string; content: string }> };
    if (body.tools) {
      routePrompts.push(body.messages.find((m) => m.role === "user")?.content ?? "");
      const pick = picks.shift() ?? { action: "chat" };
      return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: "route", arguments: JSON.stringify(pick) } }] } }] }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: chatReply } }] }) };
  }) as never;
  logs = [];
  nextMsg = 100;
  coinCalls.length = 0;
  __resetMemoryPassThrottleForTest();
  store.ensureRoom(CHAT, { title: "frens", kind: "supergroup" });
  store.setStatus(CHAT, "approved", MILLA);
  store.update(CHAT, (r) => { r.helloSaid = true; r.ownerName = "Milla"; });
});

afterEach(async () => {
  groups?.stop();
  await groups?.drain();
  globalThis.fetch = realFetch;
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/** Shogun's trades answer (22:57), produced the real way: what the live "what's trending" replied to. */
async function tradesLine(): Promise<{ id: number; text: string }> {
  await said(msg("shogun what did you trade today?"));
  const own = lastOwn();
  assert.match(own.text, /no confirmed buys or sells/);
  logs.length = 0;
  return own;
}

describe("a poke while its read runs never drops the read (d1 probe 1b reversed)", () => {
  for (const poke of ["shogun", "hello??", "?"]) {
    it(`the desk read is held 20 s and ${JSON.stringify(poke)} arrives 10 s in: 👀 on the poke, the read lands on the ask`, async () => {
      make();
      const trades = await tradesLine();
      clock += 30 * SEC;
      let open!: () => void;
      desk.hold = new Promise<void>((r) => { open = r; });
      const ask = under("what's trending", trades);
      groups.onMessage(ask);
      await settle();
      clock += 10 * SEC;
      const nudge = under(poke, trades);
      groups.onMessage(nudge);
      await settle();
      clock += 10 * SEC;
      open();
      await groups.drain();
      assert.deepEqual(desk.asks, [{ kind: "market" }], "one read, never a second");
      const out = tg.out();
      assert.equal(out.length, 2, JSON.stringify(out));
      assert.equal(out[1]!.replyTo, ask.messageId, "the read is the reply to her question");
      assert.match(out[1]!.text, /mostly red/);
      assert.deepEqual(tg.reactions(), [{ messageId: nudge.messageId, emoji: "👀" }]);
      assert.deepEqual(quiet(), [], "no 'got nothing (burst)'");
      assert.ok(logs.includes("[tg-groups] addressed line got 👀 (poke-while-working)"));
    });
  }

  it("with Fomo wired, the trending board held 20 s and 'shogun' 10 s in: the board lands on the ask", async () => {
    fomo = new SpyFomo();
    make();
    let open!: () => void;
    fomo.hold = new Promise<void>((r) => { open = r; });
    const ask = msg("shogun what's trending");
    groups.onMessage(ask);
    await settle();
    clock += 10 * SEC;
    const nudge = msg("shogun");
    groups.onMessage(nudge);
    await settle();
    clock += 10 * SEC;
    open();
    await groups.drain();
    assert.deepEqual(tg.out(), [{ text: BOARD, replyTo: ask.messageId }]);
    assert.deepEqual(tg.reactions(), [{ messageId: nudge.messageId, emoji: "👀" }]);
    assert.deepEqual(desk.asks, []);
  });

  it("three pokes while it runs: one 👀, and still one answer, to the question", async () => {
    make();
    let open!: () => void;
    desk.hold = new Promise<void>((r) => { open = r; });
    const ask = msg("shogun how's the market?");
    groups.onMessage(ask);
    await settle();
    for (const poke of ["?", "shogun", "hello??"]) {
      clock += 3 * SEC;
      groups.onMessage(msg(poke));
      await settle();
    }
    open();
    await groups.drain();
    assert.equal(tg.reactions().length, 1);
    assert.deepEqual(tg.out().map((o) => o.replyTo), [ask.messageId]);
  });

  it("two real questions five seconds apart: only the last is answered (the burst is unchanged)", async () => {
    make();
    let open!: () => void;
    desk.hold = new Promise<void>((r) => { open = r; });
    const first = msg("shogun how's the market?");
    groups.onMessage(first);
    await settle();
    clock += 5 * SEC;
    const second = msg("shogun what's pumping today");
    groups.onMessage(second);
    await settle();
    open();
    await groups.drain();
    const out = tg.out();
    assert.equal(out.length, 1);
    assert.equal(out[0]!.replyTo, second.messageId);
    assert.deepEqual(quiet(), ["[tg-groups] addressed line got nothing (burst)"]);
  });
});

describe("'i asked a question' after nothing answered runs her ask again, once (d1 probe 2 reversed)", () => {
  for (const nudge of ["i asked a question", "you didn't answer", "shogun"]) {
    it(`her lost 'what's trending', then ${JSON.stringify(nudge)} under 'yo': the desk is asked again, and the read replies to her question`, async () => {
      make();
      const trades = await tradesLine();
      clock += 30 * SEC;
      tg.failNext = 1;
      const ask = under("what's trending", trades);
      await said(ask);
      assert.deepEqual(desk.asks, [{ kind: "market" }]);
      assert.equal(quiet().length, 1, "the first read was lost on its way");
      const yo = ownLine(7_100, "yo");
      clock += 20 * SEC;
      const complaint = under(nudge, yo);
      await said(complaint);
      assert.deepEqual(desk.asks, [{ kind: "market" }, { kind: "market" }], "asked again, as the market, never as a coin called 'yo'");
      const out = tg.out().slice(-1)[0]!;
      assert.equal(out.replyTo, ask.messageId);
      assert.match(out.text, /mostly red/);
      assert.ok(logs.some((l) => l.startsWith("[tg-groups] an unanswered ask re-asked")));
      // Once: a second complaint is not a second re-run (the desk's own
      // follow-up of this chat's last read may still answer it).
      clock += 20 * SEC;
      await said(under("i asked a question", yo));
      assert.equal(logs.filter((l) => l.startsWith("[tg-groups] an unanswered ask re-asked")).length, 1);
    });
  }

  it("a re-run that is lost again is not run a third time", async () => {
    make();
    tg.failNext = 2;
    const ask = msg("shogun how's the market?");
    await said(ask);
    clock += 20 * SEC;
    await said(msg("shogun i asked a question"));
    assert.equal(desk.asks.length, 2);
    clock += 20 * SEC;
    await said(msg("shogun answer me"));
    assert.equal(desk.asks.length, 2, "never re-run twice");
  });

  it("nothing asked before: 'which question?', and no desk call (d1 probe 2e reversed)", async () => {
    make();
    const hey = ownLine(7_300, "hey there");
    clock += MIN;
    const complaint = under("i asked a question", hey);
    await said(complaint);
    assert.deepEqual(desk.asks, []);
    assert.deepEqual(tg.out(), [{ text: "which question? i might've missed it, ask me again", replyTo: complaint.messageId }]);
  });

  it("a lost Fomo ask is re-run the same way", async () => {
    fomo = new SpyFomo();
    make();
    tg.failNext = 1;
    const ask = msg("shogun what's trending on fomo?");
    await said(ask);
    clock += 20 * SEC;
    await said(msg("shogun you there?"));
    assert.equal(fomo.asks.length, 2);
    assert.deepEqual(tg.out().slice(-1)[0], { text: BOARD, replyTo: ask.messageId });
  });

  it("with nothing ever asked, a nudge under 'yo' is never a market read (d1 probe 2c reversed)", async () => {
    make();
    const yo = ownLine(7_200, "yo");
    for (const t of ["i asked a question", "you didn't answer", "hello??", "answer me", "answer the question", "?"]) {
      clock += 3 * MIN;
      const before = tg.out().length;
      await said(under(t, yo));
      const said1 = tg.out().slice(before).map((o) => o.text);
      assert.equal(said1.length, 1, t);
      if (/answer|asked/.test(t)) assert.equal(said1[0], "which question? i might've missed it, ask me again", t);
      else assert.doesNotMatch(said1[0]!, /market|mostly red/, t);
    }
    assert.deepEqual(desk.asks, []);
  });

  it("'vibes?' and 'how are the vibes' with nothing open are still the market read; 'just vibes?' and a complaint are not", async () => {
    for (const [t, want] of [["shogun vibes?", [{ kind: "market" }]], ["shogun how are the vibes on robinhood chain", [{ kind: "market" }]], ["shogun just vibes?", []], ["shogun i asked a question", []]] as const) {
      make();
      desk.asks.length = 0;
      clock += 11 * MIN;
      const m = msg(t, { fromId: BOB + Math.floor(clock / MIN) });
      await said(m);
      assert.deepEqual(desk.asks, want, t);
      if (t === "shogun i asked a question") assert.deepEqual(tg.out().slice(-1), [{ text: "which question? i might've missed it, ask me again", replyTo: m.messageId }]);
      groups.stop();
      await groups.drain();
    }
  });

  it("past ten minutes her question is no longer open: 'which question?'", async () => {
    fomo = new SpyFomo();
    make();
    tg.failNext = 1;
    await said(msg("shogun what's trending on fomo?"));
    clock += 11 * MIN;
    await said(msg("shogun i asked a question"));
    assert.equal(fomo.asks.length, 1);
    assert.match(tg.out().slice(-1)[0]!.text, /which question/);
  });

  it("someone else's complaint never re-runs her line", async () => {
    fomo = new SpyFomo();
    make();
    tg.failNext = 1;
    const ask = msg("shogun what's trending on fomo?");
    await said(ask);
    clock += 20 * SEC;
    await said(msg("shogun i asked a question", { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(fomo.asks.length, 1);
    assert.match(tg.out().slice(-1)[0]!.text, /which question/, "Bob has nothing open");
    assert.equal(tg.out().filter((o) => o.replyTo === ask.messageId).length, 1, "only her first, refused, send");
  });

  it("/forgetme in between: nothing is re-run and nothing is sent for her line; her complaint asks which question", async () => {
    make();
    tg.failNext = 1;
    await said(msg("shogun how's the market?"));
    clock += 10 * SEC;
    await groups.forgetMe(CHAT, MILLA);
    const before = tg.out().length;
    const looks = desk.asks.length;
    clock += 10 * SEC;
    const complaint = msg("shogun i asked a question");
    await said(complaint);
    assert.equal(desk.asks.length, looks, "her forgotten line is never read again");
    for (const o of tg.out().slice(before)) assert.doesNotMatch(o.text, /mostly red/);
    assert.deepEqual(tg.out().slice(before).filter((o) => o.replyTo === complaint.messageId), [{ text: "which question? i might've missed it, ask me again", replyTo: complaint.messageId }]);
  });

  it("/forgetme while her ask is read, then 'shogun', 'shogun?' or 'hello?? shogun': its hail, never a 👀 promising the forgotten ask (review r2)", async () => {
    const HAILS = ["hey 👋", "yo", "sup", "hey hey", "heyy", "yo 👋", "hey there", "hi 👋", "ayy", "oh hey", "sup 👀", "hey, what's up"];
    for (const poke of ["shogun", "shogun?", "hello?? shogun"]) {
      for (const after of [10, 100]) {
        fomo = new SpyFomo();
        make();
        // Her read is held, then forgotten while it runs.
        let open: () => void = () => {};
        fomo.hold = new Promise<void>((r) => { open = r; });
        groups.onMessage(msg("shogun what's trending on fomo?"));
        await settle();
        clock += 5 * SEC;
        await groups.forgetMe(CHAT, MILLA);
        await settle();
        clock += after * SEC;
        const before = tg.out().length;
        const eyes = tg.reactions().length;
        const hail = msg(poke);
        groups.onMessage(hail);
        await settle();
        const answered = tg.out().slice(before).filter((o) => o.replyTo === hail.messageId);
        const eyed = tg.reactions().slice(eyes).filter((r) => r.emoji === "👀").length;
        const rerun = logs.some((l) => l.startsWith("[tg-groups] an unanswered ask re-asked"));
        // Released before anything is asserted, so a failure never leaves the read held.
        open();
        await groups.drain();
        // Its hail template (it never says the same one twice running in a room).
        assert.equal(answered.length, 1, `${poke} at +${after}s`);
        assert.ok(HAILS.includes(answered[0]!.text), `${poke} at +${after}s: ${answered[0]!.text}`);
        assert.equal(eyed, 0, `${poke} at +${after}s: no 👀`);
        assert.ok(!rerun, "nothing forgotten is re-run");
        for (const o of tg.out()) assert.doesNotMatch(o.text, /Trending on Fomo/, "the forgotten read never lands");
        assert.equal(fomo.asks.length, 1, "never read again");
        groups.stop();
        await groups.drain();
        clock += 11 * MIN;
        tg.calls.length = 0;
        logs.length = 0;
      }
    }
  });

  it("after /forget, an answered ask is not 'lost': 'shogun' gets its hail and a complaint asks which question", async () => {
    make();
    await said(msg("shogun how's the market?"));
    assert.match(tg.out().slice(-1)[0]!.text, /mostly red/);
    groups.forgetChat(CHAT);
    clock += 40 * SEC;
    const looks = desk.asks.length;
    const hail = msg("shogun");
    await said(hail);
    assert.deepEqual(tg.out().slice(-1), [{ text: "hey 👋", replyTo: hail.messageId }]);
    assert.ok(!logs.some((l) => l.startsWith("[tg-groups] an unanswered ask re-asked")), "nothing forgotten is re-run");
    clock += 40 * SEC;
    const complaint = msg("shogun i asked a question");
    await said(complaint);
    assert.deepEqual(tg.out().slice(-1), [{ text: "which question? i might've missed it, ask me again", replyTo: complaint.messageId }]);
    assert.equal(desk.asks.length, looks);
  });

  it("a forgotten line never reaches the router as their earlier question, after /forget or /forgetme", async () => {
    for (const forget of [() => groups.forgetChat(CHAT), () => groups.forgetMe(CHAT, MILLA)]) {
      make();
      routePrompts.length = 0;
      tg.failNext = 1;
      await said(msg("shogun how's the market looking for robinhood?"));
      await forget();
      clock += 20 * SEC;
      await said(msg("shogun what do you think of the new logo lol"));
      assert.ok(routePrompts.every((p) => !p.includes("how's the market looking for robinhood")), routePrompts.join("\n---\n"));
      groups.stop();
      await groups.drain();
      clock += 11 * MIN;
    }
  });

  it("a re-asked line that carried a CA is never claimed or nominated again (rule 1)", async () => {
    make({ desk: () => null });
    tg.failNext = 5;
    await said(msg(`shogun ${CA} wdyt`));
    const nominated = coinCalls.filter((c) => c === "nominate").length;
    const looked = coinCalls.filter((c) => c.startsWith("look:")).length;
    assert.ok(looked >= 1);
    tg.failNext = 0;
    clock += 20 * SEC;
    await said(msg("shogun i asked a question"));
    assert.equal(coinCalls.filter((c) => c === "nominate").length, nominated, "no second nomination");
    assert.equal(coinCalls.filter((c) => c.startsWith("look:")).length, looked, "no second look by the coin flow");
  });

  it("'why can't you answer in the group?' under the deflection: no desk ask", async () => {
    fomo = new SpyFomo();
    make();
    await said(msg("shogun what is frankdegods holding on fomo?"));
    const deflection = { id: 7_400, text: "That one is for a direct message, not the group." };
    ownLine(deflection.id, deflection.text);
    clock += 30 * SEC;
    await said(under("why can't you answer in the group?", deflection, { fromId: BOB, fromFirstName: "Bob" }));
    assert.deepEqual(desk.asks, []);
  });
});

describe("a coin post the coin flow keeps quiet on is never re-run by a poke (review 2026-10-08)", () => {
  const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  for (const post of [`shogun ${MINT} wdyt`, "shogun https://dexscreener.com/solana/7xkxtg2cw87d97txjsdpbd5jbkhetqa83tzrujosgasu"]) {
    for (const after of [20, 45, 100]) {
      it(`${post.slice(0, 32)}…, then 'shogun ?' ${after} s later: 'hey 👋' to the poke, nothing about the coin`, async () => {
        make();
        const coin = msg(post);
        await said(coin);
        const before = tg.out().length;
        clock += after * SEC;
        const poke = msg("shogun ?");
        await said(poke);
        const outs = tg.out().slice(before);
        assert.ok(!outs.some((o) => o.replyTo === coin.messageId), `nothing replies to the coin post: ${JSON.stringify(outs)}`);
        assert.ok(!logs.some((l) => l.startsWith("[tg-groups] an unanswered ask re-asked")), "never re-asked");
        assert.deepEqual(outs, [{ text: "hey 👋", replyTo: poke.messageId }]);
      });
    }
  }

  it("a complaint after it asks which question; the router is never offered a re-ask of it", async () => {
    make();
    await said(msg(`shogun ${MINT} wdyt`));
    clock += 40 * SEC;
    const complaint = msg("shogun i asked a question");
    await said(complaint);
    assert.deepEqual(tg.out().slice(-1), [{ text: "which question? i might've missed it, ask me again", replyTo: complaint.messageId }]);
    clock += 40 * SEC;
    await said(msg("shogun what do you think of the new logo lol"));
    assert.ok(routePrompts.every((p) => !p.includes(MINT)), "the coin post is never put to the router as unanswered");
  });
});

describe("other words for 'you missed it' go to the router (route.ts reask)", () => {
  it("a lost ask, then 'bro you skipped mine earlier': the router may re-run it", async () => {
    make();
    tg.failNext = 1;
    const ask = msg("shogun how's the market?");
    await said(ask);
    clock += 20 * SEC;
    picks.push({ action: "reask" });
    await said(msg("shogun bro you skipped mine earlier"));
    assert.equal(routePrompts.length, 1);
    assert.match(routePrompts[0]!, /\(an earlier question of theirs that got no answer yet: «shogun how's the market\?»\)/);
    assert.equal(desk.asks.length, 2);
    assert.equal(tg.out().slice(-1)[0]!.replyTo, ask.messageId);
  });

  it("a lost ask, then a hail: routed once, and a chat pick gets the hail's template, never a model-written answer", async () => {
    make();
    tg.failNext = 1;
    await said(msg("shogun how's the market?"));
    clock += 20 * SEC;
    chatReply = "MODEL WROTE THIS";
    const hail = msg("shogun you good?");
    await said(hail);
    assert.equal(routePrompts.length, 1, "routed for a possible reask");
    assert.deepEqual(tg.out().slice(-1), [{ text: "all good, just lurking 👀", replyTo: hail.messageId }]);
    assert.ok(!tg.out().some((o) => o.text.includes("MODEL WROTE THIS")));
  });

  it("a lost ask, then a hail the router reads as a reask: the ask runs again", async () => {
    make();
    tg.failNext = 1;
    const ask = msg("shogun how's the market?");
    await said(ask);
    clock += 20 * SEC;
    picks.push({ action: "reask" });
    await said(msg("yo shogun"));
    assert.equal(desk.asks.length, 2);
    assert.equal(tg.out().slice(-1)[0]!.replyTo, ask.messageId);
  });

  it("a lost ask, then a line with a question of its own: the prompt never says they complained", async () => {
    make();
    tg.failNext = 1;
    await said(msg("shogun how's the market?"));
    clock += 20 * SEC;
    await said(msg("shogun what do you think of the new logo lol"));
    assert.equal(routePrompts.length, 1);
    assert.match(routePrompts[0]!, /\(an earlier question of theirs that got no answer yet: «shogun how's the market\?»\)/);
    assert.doesNotMatch(routePrompts[0]!, /they say/);
  });

  it("a misread reask on a line with its own question leaves that line open, so it can be re-run in turn", async () => {
    make();
    tg.failNext = 1;
    await said(msg("shogun how's the market?"));
    clock += 20 * SEC;
    picks.push({ action: "reask" });
    const own = msg("shogun what do you think of the new logo lol");
    await said(own);
    assert.equal(desk.asks.length, 2, "the earlier ask ran again");
    clock += 2 * MIN;
    await said(msg("shogun i asked a question"));
    assert.ok(tg.out().some((o) => o.replyTo === own.messageId), "the dropped line is re-run, not lost for good");
  });

  it("a newer question of hers while the complaint is routed wins: the reask is not run and the newer question is answered (review r2)", async () => {
    make();
    tg.failNext = 1;
    const ask = msg("shogun how's the market?");
    await said(ask);
    clock += 20 * SEC;
    // The routing call is held until her newer question has arrived and been read.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      if ((JSON.parse(init.body) as { tools?: unknown }).tools) await held;
      return (inner as unknown as (u: string, i: { body: string }) => Promise<unknown>)(url, init);
    }) as never;
    picks.push({ action: "reask" });
    groups.onMessage(msg("shogun bro you skipped mine earlier"));
    await settle();
    clock += 3 * SEC;
    // Her newer question's read is still running when the router answers.
    let readDone!: () => void;
    desk.hold = new Promise<void>((r) => { readDone = r; });
    const newer = msg("shogun how are the vibes on robinhood chain today?");
    groups.onMessage(newer);
    await settle();
    release();
    await settle();
    readDone();
    desk.hold = null;
    await groups.drain();
    assert.equal(routePrompts.length, 1, "the complaint was routed");
    const toNewer = tg.out().filter((o) => o.replyTo === newer.messageId);
    assert.equal(toNewer.length, 1, JSON.stringify(tg.out()));
    assert.match(toNewer[0]!.text, /mostly red/);
    assert.equal(tg.out().filter((o) => o.replyTo === ask.messageId).length, 1, "only her first, refused, send: the old ask is not re-run over the newer one");
    assert.ok(!logs.includes("[tg-groups] an unanswered ask re-asked (routed)"), JSON.stringify(logs));
  });

  const HAILS = ["hey 👋", "yo", "sup", "hey hey", "heyy", "yo 👋", "hey there", "hi 👋", "ayy", "oh hey", "sup 👀", "hey, what's up"];

  it("a reask whose re-run landed: 'shogun' 20 s and 120 s later gets its hail, never a 👀 for nothing in flight (review r2)", async () => {
    make();
    tg.failNext = 1;
    const ask = msg("shogun how's the market?");
    await said(ask);
    clock += 20 * SEC;
    picks.push({ action: "reask" });
    await said(msg("shogun bro you skipped mine earlier"));
    assert.equal(tg.out().slice(-1)[0]!.replyTo, ask.messageId, "the re-run landed on her ask");
    const looks = desk.asks.length;
    for (const after of [20, 100]) {
      clock += after * SEC;
      const eyes = tg.reactions().length;
      const hail = msg("shogun");
      await said(hail);
      const answered = tg.out().filter((o) => o.replyTo === hail.messageId);
      assert.equal(answered.length, 1, `+${after}s: ${JSON.stringify(tg.out().slice(-2))}`);
      assert.ok(HAILS.includes(answered[0]!.text), answered[0]!.text);
      assert.equal(tg.reactions().length, eyes, `+${after}s: no 👀`);
    }
    assert.equal(desk.asks.length, looks, "nothing is read again");
  });

  it("a poke while the routed re-run is still being read gets its 👀 (review r2)", async () => {
    make();
    tg.failNext = 1;
    const ask = msg("shogun how's the market?");
    await said(ask);
    clock += 20 * SEC;
    let open!: () => void;
    desk.hold = new Promise<void>((r) => { open = r; });
    picks.push({ action: "reask" });
    groups.onMessage(msg("shogun bro you skipped mine earlier"));
    await settle();
    clock += 5 * SEC;
    const poke = msg("shogun?");
    groups.onMessage(poke);
    await settle();
    const eyed = tg.reactions().filter((r) => r.emoji === "👀").map((r) => r.messageId);
    open();
    await groups.drain();
    assert.deepEqual(eyed, [poke.messageId]);
    assert.equal(tg.out().slice(-1)[0]!.replyTo, ask.messageId, "the re-run lands on her ask");
  });

  it("a second tail ask from someone else, silent by rule: 'shogun' 20 s and 100 s later gets its hail (review r2)", async () => {
    fomo = new SpyFomo();
    make();
    const TAIL = "shogun tail unipcs for 3 hours";
    await said(msg(TAIL, { fromId: BOB, fromFirstName: "Bob" }));
    const notices = tg.out().length;
    assert.ok(notices >= 1, "the owner-only line, once");
    clock += 2 * MIN;
    await said(msg(TAIL, { fromId: BOB, fromFirstName: "Bob" }));
    assert.equal(tg.out().length, notices, "the owner-only line is said once an hour");
    for (const after of [20, 80]) {
      clock += after * SEC;
      const eyes = tg.reactions().length;
      const hail = msg("shogun", { fromId: BOB, fromFirstName: "Bob" });
      await said(hail);
      const answered = tg.out().filter((o) => o.replyTo === hail.messageId);
      assert.equal(answered.length, 1, `+${after}s: ${JSON.stringify(tg.out().slice(-2))}`);
      assert.ok(HAILS.includes(answered[0]!.text), answered[0]!.text);
      assert.equal(tg.reactions().length, eyes, `+${after}s: no 👀`);
    }
    assert.ok(!logs.some((l) => l.startsWith("[tg-groups] an unanswered ask re-asked")), "the silent tail line is never re-run");
  });

  it("with nothing of hers unanswered, reask is not even on the menu, and a reask pick is refused", async () => {
    make();
    picks.push({ action: "reask" });
    await said(msg("shogun what's the best trader doing lately?"));
    assert.ok(logs.includes("[tg-groups] route no-answer"), JSON.stringify(logs));
    assert.equal(desk.asks.length, 0);
  });

  it("'you didn't answer' under a Fomo answer to her question costs one routing call, not two", async () => {
    fomo = new SpyFomo();
    make();
    await said(msg("shogun what's trending on fomo?"));
    const board = lastOwn();
    clock += 30 * SEC;
    picks.push({ action: "chat" });
    await said(under("you didn't answer", board));
    assert.equal(routePrompts.length, 1);
  });

  it("'you didn't answer' under its answer to her question: the router reads that question again", async () => {
    fomo = new SpyFomo();
    make();
    // Answered with the desk's market read when she meant Fomo's board.
    const ask = msg("shogun how's the market looking");
    await said(ask);
    const read = lastOwn();
    clock += 30 * SEC;
    picks.push({ action: "fomo_board", board: "trending" });
    await said(under("you didn't answer", read));
    assert.match(routePrompts[0]!, /their earlier question, which they say you did not answer: «shogun how's the market looking»/);
    assert.deepEqual(fomo.asks.map((a) => a.request), [{ kind: "board", board: "trending" }]);
    assert.equal(tg.out().slice(-1)[0]!.text, BOARD);
  });
});

describe("progress you can see: typing repeats while a read runs", () => {
  let ticks: Array<() => void>;
  const tick = (): Promise<void> => new Promise((r) => { ticks.push(r); });
  /** Let the clock run `ms` in typing steps, releasing each pause. */
  async function run(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 4 * SEC) {
      clock += 4 * SEC;
      const due = ticks.splice(0);
      for (const r of due) r();
      await settle();
    }
  }
  beforeEach(() => {
    ticks = [];
  });

  it("a desk read held 12 s: 'sending a photo…' at least three times, and none after the read lands", async () => {
    make({ tick });
    let open!: () => void;
    desk.hold = new Promise<void>((r) => { open = r; });
    groups.onMessage(msg("shogun how's the market?"));
    await settle();
    await run(12 * SEC);
    open();
    await groups.drain();
    const during = tg.actions().filter((a) => a === "upload_photo").length;
    assert.ok(during >= 3, `${during} actions`);
    await run(12 * SEC);
    assert.equal(tg.actions().filter((a) => a === "upload_photo").length, during, "none after delivery");
  });

  it("a Fomo read held 8 s: 'typing…' at least twice, and none after the answer", async () => {
    fomo = new SpyFomo();
    make({ tick });
    let open!: () => void;
    fomo.hold = new Promise<void>((r) => { open = r; });
    groups.onMessage(msg("shogun what's trending on fomo?"));
    await settle();
    await run(8 * SEC);
    open();
    await groups.drain();
    const during = tg.actions().filter((a) => a === "typing").length;
    assert.ok(during >= 2, `${during} actions`);
    await run(8 * SEC);
    assert.equal(tg.actions().filter((a) => a === "typing").length, during);
    assert.deepEqual(tg.out().map((o) => o.text), [BOARD]);
  });

  it("stops on /forgetme", async () => {
    fomo = new SpyFomo();
    make({ tick });
    let open!: () => void;
    fomo.hold = new Promise<void>((r) => { open = r; });
    groups.onMessage(msg("shogun what's trending on fomo?"));
    await settle();
    await run(4 * SEC);
    const typed = tg.actions().filter((a) => a === "typing").length;
    assert.ok(typed >= 1);
    await groups.forgetMe(CHAT, MILLA);
    // Its "done 🫡" types for itself; nothing after it types for her line.
    const after = tg.calls.length;
    await run(12 * SEC);
    assert.deepEqual(tg.calls.slice(after).filter((c) => c.method === "sendChatAction"), [], "no typing for a forgotten line");
    open();
    await groups.drain();
    assert.ok(!tg.out().some((o) => o.text === BOARD), "and no answer");
  });
});

describe("the fixed line for a complaint with nothing open", () => {
  it("passes the gate as the fixed line it is sent as", () => {
    const v = admitTgLine("which question? i might've missed it, ask me again", { agentName: "Shogun", kind: "fixed", recentOwn: [] });
    assert.deepEqual(v, { ok: true, text: "which question? i might've missed it, ask me again" });
  });
});
