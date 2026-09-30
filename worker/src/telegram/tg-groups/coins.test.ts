/**
 * The coin flow (docs/tg-groups.md, "The coin flow"), against the real store
 * in a temp dir, a fake port and recording speak / react / dmOwner.
 *
 * What these pin, in the order it matters:
 *   - a CA is claimed on disk before anything else, and a replayed post is
 *     silent: nothing is looked at, nominated or said twice;
 *   - only the address and where it came from cross into a nomination, and a
 *     stale post is never nominated;
 *   - only a Robinhood Chain coin gets anything: a CA in another chain's link,
 *     a Solana mint, and an address the look does not show is one (a wallet,
 *     which is what an Ethereum token is here) get silence and no memo, ready
 *     or not, coins on or off;
 *   - nothing is said in a room that is not approved, and coins-off is
 *     silence;
 *   - every once-per-window line holds across time, and a line that failed to
 *     go out does not use up its window;
 *   - outcomes reach the chat and the person the coin came from, once;
 *   - a new port is subscribed and the old one dropped;
 *   - nothing throws, and no log line carries content.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { COIN_FLOW, CoinFlow, type CoinFlowDeps, type CoinIntent, type CoinPostInfo, type CoinSpeakOpts } from "./coins";
import { extractCaHits, extractCashtags, hasForeignMint, hasOtherChainLink } from "./detect";
import { TG_GROUPS_FILE, TgGroupsStore } from "./store";
import type {
  CoinKind,
  CoinLook,
  CoinOutcome,
  NominateResult,
  Nomination,
  TgCoinMemo,
  TgCoinsPort,
  TgLine,
  TrencherReadiness,
} from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const CHAT = -1001234567890;
const OTHER = -1009876543210;
const OWNER = 42;
const ANN = 7;
const BOB = 8;

/** A distinct, well-formed CA per n. */
const ca = (n: number) => "0x" + n.toString(16).padStart(4, "0").repeat(10);
const CA1 = ca(0xa1);
const CA2 = ca(0xb2);
const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";

class FakePort implements TgCoinsPort {
  ready: TrencherReadiness = { kind: "ready-paper", ownerReason: "Trencher mode is ready." };
  looks = new Map<string, CoinLook>();
  lookCalls: string[] = [];
  onLook: ((address: string) => void) | null = null;
  lookThrows = false;
  nominateThrows = false;
  nominations: Nomination[] = [];
  /** Nomination answers, in order; `{ ok: true }` once they run out. */
  results: NominateResult[] = [];
  subs = new Set<(o: CoinOutcome) => void>();

  readiness(): TrencherReadiness {
    return this.ready;
  }
  async look(address: string): Promise<CoinLook> {
    this.lookCalls.push(address);
    this.onLook?.(address);
    if (this.lookThrows) throw new Error(`look blew up on ${address}`);
    return this.looks.get(address) ?? { kind: "candidate", name: "Froggy" };
  }
  nominate(n: Nomination): NominateResult {
    if (this.nominateThrows) throw new Error(`nominate blew up on ${n.address}`);
    this.nominations.push({ ...n });
    return this.results.shift() ?? { ok: true };
  }
  onOutcome(cb: (o: CoinOutcome) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }
  emit(o: CoinOutcome): void {
    for (const cb of [...this.subs]) cb(o);
  }
  heldNames(): string[] {
    return [];
  }
  mode(): "paper" | "live" {
    return "paper";
  }
}

interface Spoken {
  chatId: number;
  intent: CoinIntent;
  o: CoinSpeakOpts;
}

let home: string;
let clock: number;
let store: TgGroupsStore;
let port: FakePort | null;
let coinsOn: boolean;
let owner: number | null;
let speakOk: boolean;
let dmOk: boolean;
let dash: string;
let spoken: Spoken[];
let reacts: Array<{ chatId: number; messageId: number; emoji: string }>;
let dms: Array<{ text: string; button?: { text: string; url: string } }>;
let logs: string[];
let flows: CoinFlow[];
let nextId: number;

function makeFlow(over: Partial<CoinFlowDeps> = {}): CoinFlow {
  const flow = new CoinFlow({
    store,
    port: () => port,
    coinsEnabled: () => coinsOn,
    ownerId: () => owner,
    speak: async (chatId, intent, o) => {
      spoken.push({ chatId, intent, o });
      return speakOk;
    },
    react: async (chatId, messageId, emoji) => {
      reacts.push({ chatId, messageId, emoji });
      return true;
    },
    dmOwner: async (text, button) => {
      dms.push(button ? { text, button } : { text });
      return dmOk;
    },
    dashboardUrl: () => dash,
    now: () => clock,
    log: (s) => logs.push(s),
    ...over,
  });
  flows.push(flow);
  return flow;
}

function approve(chatId: number, title: string): void {
  store.ensureRoom(chatId, { title, kind: "supergroup" });
  store.setStatus(chatId, "approved", OWNER);
}

interface MsgOpts {
  id?: number;
  from?: number;
  name?: string;
  dateSec?: number;
  addressed?: boolean;
}

/** A line as the handler would hand it over: remembered first, the readings from detect.ts. */
function msg(chatId: number, text: string, o: MsgOpts = {}): { line: TgLine; info: CoinPostInfo } {
  const id = o.id ?? nextId++;
  const from = o.from ?? ANN;
  const name = o.name ?? (from === BOB ? "bob" : "ann");
  const line: TgLine = { messageId: id, fromId: from, name, text, atMs: clock };
  store.addLine(chatId, line);
  const hits = extractCaHits(text);
  const otherChain = hits.filter((h) => h.chain === "other").map((h) => h.address);
  const info: CoinPostInfo = {
    senderId: from,
    senderName: name,
    dateSec: o.dateSec ?? Math.floor(clock / 1000),
    cas: hits.map((h) => h.address),
    ...(otherChain.length > 0 ? { otherChain } : {}),
    foreignMint: hasForeignMint(text) || hasOtherChainLink(text),
    cashtags: extractCashtags(text),
    addressed: o.addressed ?? false,
  };
  return { line, info };
}

async function post(flow: CoinFlow, chatId: number, text: string, o: MsgOpts = {}) {
  const { line, info } = msg(chatId, text, o);
  const r = await flow.onPost(chatId, line, info);
  return { r, line, info };
}

/** The handler's way in: owned at once, the rest on the chat's coin lane. */
function begin(flow: CoinFlow, chatId: number, text: string, o: MsgOpts = {}) {
  const { line, info } = msg(chatId, text, o);
  return flow.begin(chatId, line, info);
}

const intents = () => spoken.map((s) => s.intent);
const memoOf = (address: string, chatId = CHAT): TgCoinMemo | undefined => store.coin(chatId, address);
const onDisk = (): { rooms: Record<string, { claims: Record<string, number> }> } =>
  JSON.parse(readFileSync(path.join(home, TG_GROUPS_FILE), "utf8"));
/** Let callbacks the fake port fired run their awaits. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "tg-coins-"));
  clock = T0;
  store = TgGroupsStore.open(home, { now: () => clock, debounceMs: 60_000 });
  approve(CHAT, "Frog Pond");
  port = new FakePort();
  coinsOn = true;
  owner = OWNER;
  speakOk = true;
  dmOk = true;
  dash = "https://merrymen.example/";
  spoken = [];
  reacts = [];
  dms = [];
  logs = [];
  flows = [];
  nextId = 100;
});

afterEach(() => {
  for (const f of flows) f.stop();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

// ─── Lines with no CA ──────────────────────────────────────────────────────

describe("a line with no CA", () => {
  it("a Solana mint is another chain's coin: handled, so nothing else answers it, and silent — ready or not, coins on or off, fresh or stale", async () => {
    const flow = makeFlow();
    for (const [ready, on] of [[true, true], [false, true], [true, false], [false, false]] as const) {
      port!.ready = ready ? { kind: "ready-paper", ownerReason: "ready" } : { kind: "off", ownerReason: "off" };
      coinsOn = on;
      assert.equal((await post(flow, CHAT, `aping ${MINT}`)).r, "handled");
      assert.equal((await post(flow, CHAT, `https://pump.fun/coin/${MINT}`, { addressed: true })).r, "handled");
      assert.equal((await post(flow, CHAT, `$BONK ${MINT}`)).r, "handled", "not 'drop the ca': they did drop one");
      assert.equal((await post(flow, CHAT, MINT, { dateSec: Math.floor((clock - 20 * MIN) / 1000) })).r, "handled");
    }
    assert.equal(spoken.length + reacts.length + dms.length + port!.lookCalls.length + port!.nominations.length, 0);
    assert.deepEqual(store.room(CHAT)!.coins, []);
    assert.equal(store.room(CHAT)!.lastDropCaAtMs, undefined);
  });

  it("another chain's coin with no EVM address or mint shape (DexScreener's lowercase Solana, TON, Sui and v4 links, a TON address) is handled the same: silent", async () => {
    const flow = makeFlow();
    const h64 = "0x" + "ab12".repeat(16);
    const texts = [
      "https://dexscreener.com/solana/4hzthuyzrpwtvqgru8trxb5tkaslgphuamdgtks2rdai",
      "https://dexscreener.com/ton/eqcxe6mutqjkfngfarotkot1lzbdiix1kcixrv7nw2id_sds",
      `https://dexscreener.com/sui/${h64}`,
      `$FROG https://dexscreener.com/base/${h64}`,
      "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
    ];
    for (const [ready, on] of [[true, true], [false, true], [true, false], [false, false]] as const) {
      port!.ready = ready ? { kind: "ready-paper", ownerReason: "ready" } : { kind: "off", ownerReason: "off" };
      coinsOn = on;
      for (const [i, text] of texts.entries()) {
        assert.equal((await post(flow, CHAT, text, { addressed: i % 2 === 0 })).r, "handled", text);
      }
    }
    assert.equal(spoken.length + reacts.length + dms.length + port!.lookCalls.length + port!.nominations.length, 0);
    assert.deepEqual(store.room(CHAT)!.coins, []);
    assert.equal(store.room(CHAT)!.lastDropCaAtMs, undefined, "not 'drop the ca' for the ticker: they did drop one");
    // A Robinhood Chain v4 pool link is not another chain's: not owned here, the chatter path has it.
    assert.equal((await post(flow, CHAT, `https://dexscreener.com/robinhood/${h64}`)).r, "none");
  });

  it("'$PEPE?' alone gets 'drop the ca' at most once per chat per hour", async () => {
    const flow = makeFlow();
    const first = await post(flow, CHAT, "$PEPE?");
    assert.equal(first.r, "handled");
    assert.deepEqual(intents(), [{ kind: "drop-ca" }]);
    assert.equal(spoken[0]!.o.replyTo, first.line.messageId);
    assert.equal(store.room(CHAT)!.lastDropCaAtMs, T0);

    clock += 20 * MIN;
    assert.equal((await post(flow, CHAT, "$wif 🚀🚀")).r, "none", "rate-limited: ordinary chatter");
    assert.equal(spoken.length, 1);

    clock += 41 * MIN;
    await post(flow, CHAT, "$WIF $BONK");
    assert.deepEqual(intents(), [{ kind: "drop-ca" }, { kind: "drop-ca" }]);
  });

  it("a ticker inside a sentence is left alone unless the line addresses it", async () => {
    const flow = makeFlow();
    assert.equal((await post(flow, CHAT, "anyone still holding $PEPE lol")).r, "none");
    assert.equal(spoken.length, 0);
    assert.equal((await post(flow, CHAT, "yo what about $PEPE", { addressed: true })).r, "handled");
    assert.deepEqual(intents(), [{ kind: "drop-ca" }]);
  });

  it("a line with nothing coin-shaped is none", async () => {
    const flow = makeFlow();
    assert.equal((await post(flow, CHAT, "gm frens")).r, "none");
    assert.equal((await post(flow, CHAT, "it cost $5", { addressed: true })).r, "none");
    assert.equal(spoken.length, 0);
  });

  it("coins off: no 'drop the ca', and a ticker is ordinary chatter", async () => {
    coinsOn = false;
    const flow = makeFlow();
    assert.equal((await post(flow, CHAT, "$PEPE?")).r, "none");
    assert.equal(spoken.length + reacts.length, 0);
  });

  it("an old line from a redelivered batch gets no coin line", async () => {
    const flow = makeFlow();
    const old = Math.floor((clock - 20 * MIN) / 1000);
    assert.equal((await post(flow, CHAT, "$PEPE?", { dateSec: old })).r, "none");
    assert.equal(spoken.length, 0);
  });
});

// ─── Other chains ──────────────────────────────────────────────────────────

describe("a CA in another chain's link", () => {
  const LINKS = [
    (a: string) => `https://etherscan.io/token/${a}`,
    (a: string) => `https://bscscan.com/token/${a}`,
    (a: string) => `https://basescan.org/token/${a}#code`,
    (a: string) => `https://dexscreener.com/ethereum/${a}`,
    (a: string) => `https://www.geckoterminal.com/eth/pools/${a}`,
    (a: string) => `https://gmgn.ai/bsc/token/${a}`,
  ];

  it("gets nothing at all — no claim, no look, no line, no 👀, no ask, no DM, no memo — ready or not, coins on or off", async () => {
    const flow = makeFlow();
    let n = 0;
    for (const [ready, on] of [[true, true], [false, true], [true, false], [false, false]] as const) {
      port!.ready = ready ? { kind: "ready-paper", ownerReason: "ready" } : { kind: "off", ownerReason: "off" };
      coinsOn = on;
      for (const link of LINKS) {
        const r = await post(flow, CHAT, `aping this ${link(ca(0x300 + n++))}`, { addressed: n % 2 === 0 });
        assert.equal(r.r, "handled", "owned, so nothing else answers it either");
      }
    }
    assert.equal(port!.lookCalls.length + port!.nominations.length, 0);
    assert.equal(spoken.length + reacts.length + dms.length, 0);
    assert.deepEqual(store.room(CHAT)!.claims, {});
    assert.deepEqual(store.room(CHAT)!.coins, []);
  });

  it("is set aside before the first two are counted: a multichain post's Robinhood CAs are still looked at", async () => {
    const flow = makeFlow();
    await post(flow, CHAT, `live on eth ${LINKS[0]!(ca(1))} bsc ${LINKS[1]!(ca(2))} and robinhood ${ca(3)} ${ca(4)} ${ca(5)}`);
    assert.deepEqual(port!.lookCalls, [ca(3), ca(4)]);
    assert.deepEqual(port!.nominations.map((x) => x.address), [ca(3), ca(4)]);
    assert.deepEqual(intents(), [{ kind: "coin-ack" }, { kind: "coin-ack" }]);
  });

  it("a Robinhood chart link and a bare Robinhood coin are looked at as ever", async () => {
    const flow = makeFlow();
    await post(flow, CHAT, `https://dexscreener.com/robinhood/${CA1}`);
    await post(flow, CHAT, CA2, { from: BOB });
    assert.deepEqual(port!.lookCalls, [CA1, CA2]);
    assert.deepEqual(intents(), [{ kind: "coin-ack" }, { kind: "coin-ack" }]);
  });
});

// ─── Claims, staleness, rooms ──────────────────────────────────────────────

describe("claims", () => {
  it("the claim is on disk before the look, and a replayed post is silent", async () => {
    const flow = makeFlow();
    const { line, info } = msg(CHAT, `ape this ${CA1}`, { id: 500 });
    port!.onLook = () => {
      assert.ok(onDisk().rooms[String(CHAT)]!.claims[`500:${CA1}`], "claimed on disk before the look");
    };
    assert.equal(await flow.onPost(CHAT, line, info), "handled");
    assert.equal(port!.lookCalls.length, 1);
    assert.equal(port!.nominations.length, 1);
    assert.equal(spoken.length, 1);

    // The same update again (a redeploy mid-batch).
    assert.equal(await flow.onPost(CHAT, line, info), "handled");
    assert.equal(port!.lookCalls.length, 1, "no second look");
    assert.equal(port!.nominations.length, 1, "no second nomination");
    assert.equal(spoken.length, 1, "nothing said twice");
    assert.equal(reacts.length, 0);
  });

  it("a replay survives a restart: a new store and flow over the same file stay silent", async () => {
    const { line, info } = msg(CHAT, `ape this ${CA1}`, { id: 501 });
    await makeFlow().onPost(CHAT, line, info);
    store.close();
    store = TgGroupsStore.open(home, { now: () => clock, debounceMs: 60_000 });
    const again = new FakePort();
    port = again;
    assert.equal(await makeFlow().onPost(CHAT, line, info), "handled");
    assert.equal(again.lookCalls.length + again.nominations.length, 0);
    assert.equal(spoken.length, 1);
  });

  it("a stale post is claimed, never looked at, not remembered, and nothing is said", async () => {
    const flow = makeFlow();
    const r = await post(flow, CHAT, `ape ${CA1}`, { dateSec: Math.floor((clock - 11 * MIN) / 1000) });
    assert.equal(r.r, "handled");
    assert.ok(store.room(CHAT)!.claims[`${r.line.messageId}:${CA1}`], "claimed");
    assert.equal(port!.lookCalls.length + port!.nominations.length, 0);
    assert.equal(spoken.length + reacts.length + dms.length, 0);
    // Never looked at, so not known to be a Robinhood Chain coin: no memo
    // for the persona to talk from, and a fresh repost gets the real look.
    assert.equal(memoOf(CA1), undefined);
    await post(flow, CHAT, `ape ${CA1}`, { from: BOB });
    assert.equal(port!.lookCalls.length, 1);
  });

  it("a stale post keeps the memo already there", async () => {
    const flow = makeFlow();
    store.rememberCoin(CHAT, { address: CA1, byId: BOB, byName: "bob", messageId: 3, atMs: clock - HOUR, verdict: "bought", decisionId: "d-9" });
    await post(flow, CHAT, `ape ${CA1}`, { dateSec: Math.floor((clock - 30 * MIN) / 1000) });
    const memo = memoOf(CA1)!;
    assert.equal(memo.verdict, "bought");
    assert.equal(memo.byId, BOB);
    assert.equal(memo.decisionId, "d-9");
  });

  it("a room that is not approved: nothing claimed, looked at or said", async () => {
    const flow = makeFlow();
    store.ensureRoom(OTHER, { title: "Strangers", kind: "group" });
    assert.equal(store.room(OTHER)!.status, "pending");
    assert.equal((await post(flow, OTHER, `ape ${CA1}`)).r, "none");
    assert.equal((await post(flow, OTHER, MINT)).r, "none");
    assert.equal((await post(flow, OTHER, "$PEPE?")).r, "none");
    assert.equal(port!.lookCalls.length + spoken.length + reacts.length + dms.length, 0);
    assert.deepEqual(store.room(OTHER)!.claims, {});

    store.setStatus(CHAT, "left");
    assert.equal((await post(flow, CHAT, `ape ${CA2}`)).r, "none");
    assert.equal(spoken.length, 0);
  });

  it("an unknown chat is none", async () => {
    const flow = makeFlow();
    const line: TgLine = { messageId: 1, fromId: ANN, name: "ann", text: CA1, atMs: clock };
    const r = await flow.onPost(-1, line, {
      senderId: ANN, senderName: "ann", cas: [CA1], foreignMint: false, cashtags: [], addressed: false,
    });
    assert.equal(r, "none");
    assert.equal(spoken.length, 0);
  });

  it("only well-formed CAs are considered, and at most two", async () => {
    const flow = makeFlow();
    const line: TgLine = { messageId: 900, fromId: ANN, name: "ann", text: "three", atMs: clock };
    store.addLine(CHAT, line);
    await flow.onPost(CHAT, line, {
      senderId: ANN,
      senderName: "ann",
      dateSec: Math.floor(clock / 1000),
      cas: ["0x1234", CA1.toUpperCase().replace("0X", "0x"), CA1, CA2, ca(0xc3)],
      foreignMint: false,
      cashtags: [],
      addressed: false,
    });
    assert.deepEqual(port!.lookCalls, [CA1, CA2]);
  });
});

// ─── Seen before ───────────────────────────────────────────────────────────

describe("seen before in this chat", () => {
  it("within 24 h it answers from memory, replying to the new post, with no new look", async () => {
    const flow = makeFlow();
    const first = await post(flow, CHAT, `ape ${CA1}`, { id: 300 });
    await flow.onOutcome({ kind: "passed", address: CA1, chatId: CHAT, messageId: 300, decisionId: "d-1", notes: [] });
    spoken = [];

    clock += 2 * HOUR;
    const again = await post(flow, CHAT, `${CA1} sending`, { from: BOB });
    assert.equal(again.r, "handled");
    assert.deepEqual(intents(), [{ kind: "coin-seen", verdict: "passed" }]);
    assert.equal(spoken[0]!.o.replyTo, again.line.messageId);
    assert.equal(spoken[0]!.o.coinName, "Froggy");
    assert.equal(port!.lookCalls.length, 1, "no new look");
    const memo = memoOf(CA1)!;
    assert.equal(memo.byId, ANN, "the memo still names who posted it first");
    assert.equal(memo.messageId, first.line.messageId);
  });

  it("after 24 h it is looked at again", async () => {
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`, { id: 300 });
    await flow.onOutcome({ kind: "passed", address: CA1, chatId: CHAT, messageId: 300, decisionId: "d-1", notes: [] });
    clock += 25 * HOUR;
    await post(flow, CHAT, `ape ${CA1}`, { from: BOB });
    assert.equal(port!.lookCalls.length, 2);
    assert.equal(memoOf(CA1)!.byId, BOB);
  });

  it("a coin only remembered as not-ready is not an answer from memory", async () => {
    port!.ready = { kind: "off", ownerReason: "not in trencher mode" };
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`);
    assert.equal(memoOf(CA1)!.verdict, "not-ready");
    port!.ready = { kind: "ready-live", ownerReason: "ready" };
    clock += MIN;
    spoken = [];
    await post(flow, CHAT, `ape ${CA1}`, { from: BOB });
    assert.equal(port!.nominations.length, 1);
    assert.deepEqual(intents(), [{ kind: "coin-ack" }]);
    assert.equal(memoOf(CA1)!.verdict, "candidate");
  });

  it("a candidate whose outcome never came reads as expired, not 'still looking'", async () => {
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`);
    clock += 10 * MIN;
    spoken = [];
    await post(flow, CHAT, `${CA1}?`, { from: BOB });
    assert.deepEqual(intents(), [{ kind: "coin-seen", verdict: "candidate" }], "still under review");
    // Past the hour an answer from memory waits for (see below).
    clock += 61 * MIN;
    spoken = [];
    await post(flow, CHAT, `${CA1}??`, { from: BOB, id: 900 });
    assert.deepEqual(intents(), [{ kind: "coin-seen", verdict: "expired" }]);
  });

  it("a reposted CA is answered from memory once an hour: then one 👀, then nothing", async () => {
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`, { id: 300 });
    await flow.onOutcome({ kind: "passed", address: CA1, chatId: CHAT, messageId: 300, decisionId: "d-1", notes: [] });
    spoken = [];
    const reposts: number[] = [];
    for (let i = 0; i < 8; i++) {
      clock += 20_000;
      reposts.push((await post(flow, CHAT, CA1, { from: BOB })).line.messageId);
    }
    assert.deepEqual(intents(), [{ kind: "coin-seen", verdict: "passed" }], "eight reposts, one line");
    assert.equal(spoken[0]!.o.replyTo, reposts[0]);
    assert.deepEqual(reacts, [{ chatId: CHAT, messageId: reposts[1]!, emoji: "👀" }], "one 👀, on the first repost past the line");
    assert.equal(port!.lookCalls.length, 1, "and never a new look");

    // Its own clock per coin and per chat.
    approve(OTHER, "Other");
    await post(flow, OTHER, `ape ${CA1}`, { id: 301 });
    await flow.onOutcome({ kind: "passed", address: CA1, chatId: OTHER, messageId: 301, decisionId: "d-2", notes: [] });
    await post(flow, OTHER, CA1, { from: BOB });
    assert.equal(spoken.filter((s) => s.intent.kind === "coin-seen").length, 2);

    clock += HOUR;
    spoken = [];
    await post(flow, CHAT, CA1, { from: BOB });
    assert.deepEqual(intents(), [{ kind: "coin-seen", verdict: "passed" }], "an hour on, again");
  });

  it("an answer from memory that did not go out does not use up the hour", async () => {
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`, { id: 300 });
    await flow.onOutcome({ kind: "passed", address: CA1, chatId: CHAT, messageId: 300, decisionId: "d-1", notes: [] });
    speakOk = false;
    spoken = [];
    await post(flow, CHAT, CA1, { from: BOB });
    speakOk = true;
    clock += MIN;
    await post(flow, CHAT, CA1, { from: BOB });
    assert.equal(spoken.length, 2);
    assert.deepEqual(reacts, []);
  });
});

describe("a sender forgotten mid-flow (/forgetme)", () => {
  it("forgotten while the look was out: no nomination, nothing said, and no memo naming them", async () => {
    const flow = makeFlow();
    let gone = false;
    port!.onLook = () => {
      gone = true;
    };
    const { line, info } = msg(CHAT, `ape ${CA1}`);
    assert.equal(await flow.onPost(CHAT, line, { ...info, forgotten: () => gone }), "handled");
    assert.equal(port!.nominations.length, 0, "their id is not handed across");
    assert.deepEqual(spoken, []);
    assert.equal(memoOf(CA1), undefined, "a candidate never nominated leaves no memo");
  });

  it("a coin that is not a candidate keeps its verdict, but not who posted it", async () => {
    const flow = makeFlow();
    port!.looks.set(CA1, { kind: "too-quiet", name: "Slowcoin" });
    let gone = false;
    port!.onLook = () => {
      gone = true;
    };
    const { line, info } = msg(CHAT, CA1);
    await flow.onPost(CHAT, line, { ...info, forgotten: () => gone });
    const m = memoOf(CA1)!;
    assert.equal(m.verdict, "too-quiet");
    assert.equal(m.byId, 0);
    assert.equal(m.byName, "");
    assert.deepEqual(spoken, [], "no line tagging someone who asked to be forgotten");
    assert.deepEqual(reacts, []);
  });

  it("not forgotten: the same post is looked at, nominated and answered as ever", async () => {
    const flow = makeFlow();
    const { line, info } = msg(CHAT, `ape ${CA1}`);
    await flow.onPost(CHAT, line, { ...info, forgotten: () => false });
    assert.equal(port!.nominations.length, 1);
    assert.deepEqual(intents(), [{ kind: "coin-ack" }]);
    assert.equal(memoOf(CA1)!.byId, ANN);
  });

  it("a forgotten() that throws reads as forgotten: silence is the safe side", async () => {
    const flow = makeFlow();
    const { line, info } = msg(CHAT, `ape ${CA1}`);
    await flow.onPost(CHAT, line, {
      ...info,
      forgotten: () => {
        throw new Error("boom");
      },
    });
    assert.equal(port!.nominations.length, 0);
    assert.deepEqual(spoken, []);
  });
});

// ─── Coins off ─────────────────────────────────────────────────────────────

describe("coins off", () => {
  it("silence: no 👀 (nothing shows it is a Robinhood Chain coin without a look), no look, no ask, no DM, no memo", async () => {
    coinsOn = false;
    const flow = makeFlow();
    const r = await post(flow, CHAT, `${CA1} and ${CA2}`);
    assert.equal(r.r, "handled", "still the coin flow's: nothing else talks about it");
    assert.equal(spoken.length + reacts.length + dms.length + port!.lookCalls.length + port!.nominations.length, 0);
    assert.equal(memoOf(CA1), undefined);
    assert.equal(memoOf(CA2), undefined);
  });

  it("coins off also silences the answer from memory, and keeps the memory", async () => {
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`, { id: 300 });
    await flow.onOutcome({ kind: "passed", address: CA1, chatId: CHAT, messageId: 300, decisionId: "d-1", notes: [] });
    spoken = [];
    coinsOn = false;
    clock += HOUR;
    await post(flow, CHAT, `${CA1}`, { from: BOB });
    assert.equal(spoken.length + reacts.length, 0);
    assert.equal(memoOf(CA1)!.verdict, "passed");
  });

  it("a switch that cannot be read counts as off", async () => {
    const flow = makeFlow({
      coinsEnabled: () => {
        throw new Error("settings unreadable");
      },
    });
    await post(flow, CHAT, `ape ${CA1}`);
    assert.equal(spoken.length + reacts.length + port!.lookCalls.length, 0);
  });
});

// ─── Not ready: the owner ask ──────────────────────────────────────────────

describe("not ready: the owner ask", () => {
  it("a Robinhood Chain candidate: the group line tags the owner, the DM carries the reason and the Settings button", async () => {
    port!.ready = { kind: "off", ownerReason: "Trencher mode is off, so I can't look at coins people post." };
    const flow = makeFlow();
    const r = await post(flow, CHAT, `ape ${CA1}`);
    assert.equal(r.r, "handled");
    assert.deepEqual(port!.lookCalls, [CA1], "looked at first: only a Robinhood Chain coin is worth asking about");
    assert.deepEqual(intents(), [{ kind: "ready-ask" }]);
    assert.deepEqual(spoken[0]!.o.mention, { id: OWNER, name: "boss" });
    assert.equal(spoken[0]!.o.replyTo, r.line.messageId);
    assert.equal(dms.length, 1);
    assert.match(dms[0]!.text, /«Frog Pond»/);
    assert.match(dms[0]!.text, /Trencher mode is off/);
    assert.deepEqual(dms[0]!.button, { text: "⚙️ Open Settings", url: "https://merrymen.example/settings#trencher-mode" });
    assert.equal(memoOf(CA1)!.verdict, "not-ready");
    assert.equal(memoOf(CA1)!.name, "Froggy");
    assert.equal(port!.nominations.length, 0);
    assert.doesNotMatch(dms[0]!.text, new RegExp(CA1, "i"), "the DM does not need the address");
  });

  it("no port: nothing can show it is a Robinhood Chain coin, so nothing at all", async () => {
    port = null;
    const flow = makeFlow();
    assert.equal((await post(flow, CHAT, `ape ${CA1}`)).r, "handled");
    assert.equal(spoken.length + reacts.length + dms.length, 0);
    assert.equal(memoOf(CA1), undefined);
  });

  it("not a candidate: the grounded line as when ready, never the owner ask or the DM", async () => {
    port!.ready = { kind: "slow", ownerReason: "fast path off" };
    port!.looks.set(CA1, { kind: "too-quiet", name: "Slowcoin" });
    port!.looks.set(CA2, { kind: "held", name: "Froggy" });
    port!.looks.set(ca(3), { kind: "stock", name: "TSLA" });
    const flow = makeFlow();
    await post(flow, CHAT, CA1);
    await post(flow, CHAT, CA2, { from: BOB });
    await post(flow, CHAT, ca(3));
    assert.deepEqual(intents(), [
      { kind: "coin-look", look: "too-quiet" },
      { kind: "coin-seen", verdict: "held" },
      { kind: "coin-look", look: "stock" },
    ]);
    assert.deepEqual(spoken[0]!.o.mention, { id: ANN, name: "ann" }, "tags the sender, not the owner");
    assert.equal(dms.length, 0);
    assert.equal(store.room(CHAT)!.lastReadyAskAtMs, undefined);
    assert.equal(memoOf(CA1)!.verdict, "too-quiet");
    assert.equal(memoOf(CA2)!.verdict, "held");
    assert.equal(port!.nominations.length, 0);
  });

  it("ask once per 12 h, a nudge at most hourly, a 👀 otherwise; the DM once per 12 h", async () => {
    port!.ready = { kind: "live-off", ownerReason: "Trencher isn't allowed to trade for real yet." };
    store.update(CHAT, (r) => {
      r.ownerName = "milla";
    });
    const flow = makeFlow();

    await post(flow, CHAT, `ape ${ca(1)}`);
    assert.deepEqual(intents(), [{ kind: "ready-ask" }]);
    assert.deepEqual(spoken[0]!.o.mention, { id: OWNER, name: "milla" });
    assert.equal(dms.length, 1);
    assert.match(dms[0]!.text, /Trencher isn't allowed to trade for real yet\./);
    assert.equal(port!.lookCalls.length, 1, "looked at even while not ready");

    clock += 10 * MIN;
    const second = await post(flow, CHAT, `ape ${ca(2)}`);
    assert.equal(spoken.length, 1, "no second line minutes after the ask");
    assert.deepEqual(reacts, [{ chatId: CHAT, messageId: second.line.messageId, emoji: "👀" }]);
    assert.equal(dms.length, 1);

    clock += 51 * MIN;
    await post(flow, CHAT, `ape ${ca(3)}`);
    assert.deepEqual(intents()[1], { kind: "ready-nudge" });
    assert.equal(spoken[1]!.o.mention, undefined, "the nudge does not tag the owner");
    assert.equal(dms.length, 1);

    clock += 30 * MIN;
    await post(flow, CHAT, `ape ${ca(4)}`);
    assert.equal(spoken.length, 2);
    assert.equal(reacts.length, 2);

    clock += 31 * MIN;
    await post(flow, CHAT, `ape ${ca(5)}`);
    assert.deepEqual(intents()[2], { kind: "ready-nudge" });

    clock = T0 + 12 * HOUR + MIN;
    await post(flow, CHAT, `ape ${ca(6)}`);
    assert.deepEqual(intents()[3], { kind: "ready-ask" });
    assert.equal(dms.length, 2);
    const room = store.room(CHAT)!;
    assert.equal(room.lastReadyAskAtMs, clock);
    assert.equal(room.lastReadyDmAtMs, clock);
  });

  it("two CAs in one post while not ready: one ask, one DM, and both remembered", async () => {
    port!.ready = { kind: "no-brain", ownerReason: "Trencher needs Brain connected." };
    const flow = makeFlow();
    await post(flow, CHAT, `${CA1} ${CA2}`);
    assert.deepEqual(intents(), [{ kind: "ready-ask" }]);
    assert.equal(reacts.length, 0);
    assert.equal(dms.length, 1);
    assert.equal(memoOf(CA1)!.verdict, "not-ready");
    assert.equal(memoOf(CA2)!.verdict, "not-ready");
  });

  it("never linked: nobody to tag or DM, a 👀 at most", async () => {
    owner = null;
    port!.ready = { kind: "off", ownerReason: "off" };
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`);
    assert.equal(spoken.length + dms.length, 0);
    assert.equal(reacts.length, 1);
    assert.equal(memoOf(CA1)!.verdict, "not-ready");
  });

  it("an ask that failed to go out does not burn the 12 h", async () => {
    port!.ready = { kind: "off", ownerReason: "off" };
    speakOk = false;
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`);
    assert.deepEqual(intents(), [{ kind: "ready-ask" }, { kind: "ready-nudge" }], "tried the ask, then the lighter line");
    assert.equal(reacts.length, 1, "then settled for a 👀");
    assert.equal(store.room(CHAT)!.lastReadyAskAtMs, undefined);
    assert.equal(store.room(CHAT)!.lastReadyNudgeAtMs, undefined);

    speakOk = true;
    clock += MIN;
    await post(flow, CHAT, `ape ${CA2}`);
    assert.deepEqual(intents()[2], { kind: "ready-ask" });
  });

  it("a DM that failed is tried again on the next CA; a DM with no dashboard URL has no button", async () => {
    port!.ready = { kind: "off", ownerReason: "off" };
    dmOk = false;
    dash = "";
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`);
    assert.equal(dms.length, 1);
    assert.equal(dms[0]!.button, undefined);
    assert.equal(store.room(CHAT)!.lastReadyDmAtMs, undefined);
    dmOk = true;
    clock += MIN;
    await post(flow, CHAT, `ape ${CA2}`);
    assert.equal(dms.length, 2);
    assert.equal(store.room(CHAT)!.lastReadyDmAtMs, clock);
  });

  it("an untitled group is named plainly in the DM", async () => {
    port!.ready = { kind: "off", ownerReason: "off" };
    store.update(CHAT, (r) => {
      r.title = "";
    });
    await post(makeFlow(), CHAT, `ape ${CA1}`);
    assert.match(dms[0]!.text, /one of your groups/);
  });
});

// ─── The quick look ────────────────────────────────────────────────────────

describe("the quick look", () => {
  /** The kinds a Robinhood Chain coin (or its own money, cash, energy, a stock) can be, candidate and held aside. */
  const LOOK_KINDS: CoinKind[] = [
    "own", "cash", "energy", "stock", "curve", "v4-only", "no-pool", "too-new", "too-thin", "too-quiet",
  ];
  /** The kinds that do not show a Robinhood Chain coin. */
  const NOT_HERE: CoinKind[] = ["wallet", "not-token", "unknown"];

  it("every Robinhood Chain non-candidate kind is a line tagging the sender, replying to the post, remembered with its kind", async () => {
    const flow = makeFlow();
    for (const [i, kind] of LOOK_KINDS.entries()) {
      const address = ca(0x100 + i);
      port!.looks.set(address, { kind, name: "Frog Cash" });
      spoken = [];
      const r = await post(flow, CHAT, `what about ${address}`);
      assert.equal(r.r, "handled");
      assert.deepEqual(intents(), [{ kind: "coin-look", look: kind }], kind);
      assert.deepEqual(spoken[0]!.o.mention, { id: ANN, name: "ann" });
      assert.equal(spoken[0]!.o.replyTo, r.line.messageId);
      assert.equal(spoken[0]!.o.coinName, "Frog Cash");
      assert.equal(spoken[0]!.o.trigger?.messageId, r.line.messageId);
      const memo = memoOf(address)!;
      assert.equal(memo.verdict, kind);
      assert.equal(memo.name, "Frog Cash");
    }
    assert.equal(port!.nominations.length, 0, "no look kind but candidate is nominated");
  });

  it("wallet (an Ethereum or BNB token has no code here), not-token and unknown: nothing, ready or not, and nothing remembered", async () => {
    const flow = makeFlow();
    for (const ready of [true, false]) {
      port!.ready = ready ? { kind: "ready-live", ownerReason: "ready" } : { kind: "off", ownerReason: "off" };
      for (const [i, kind] of NOT_HERE.entries()) {
        const address = ca(0x200 + i + (ready ? 0 : 0x10));
        port!.looks.set(address, { kind, name: "Frog Cash" });
        // Addressed for the two that are not a Robinhood Chain coin: silence
        // all the same. `unknown` unaddressed: silence (addressed, below).
        const addressed = kind !== "unknown";
        const r = await post(flow, CHAT, `${addressed ? "@pine " : ""}what about ${address}`, { addressed });
        assert.equal(r.r, "handled", `${kind}: owned, so nothing else answers it either`);
        assert.equal(memoOf(address), undefined, kind);
      }
    }
    assert.equal(port!.lookCalls.length, NOT_HERE.length * 2);
    assert.equal(spoken.length + reacts.length + dms.length + port!.nominations.length, 0);
    assert.equal(store.room(CHAT)!.lastReadyAskAtMs, undefined, "the owner is never asked about another chain's coin");
  });

  it("unknown ADDRESSED (the reads failed): one 'can't pull that one up rn', tagging the sender, as a reply; nothing remembered; once per chat per 10 minutes", async () => {
    const flow = makeFlow();
    port!.looks.set(CA1, { kind: "unknown" });
    port!.looks.set(CA2, { kind: "unknown" });
    const first = await post(flow, CHAT, `@pine thoughts on ${CA1}?`, { addressed: true });
    assert.equal(first.r, "handled");
    assert.deepEqual(intents(), [{ kind: "coin-unknown" }]);
    assert.deepEqual(spoken[0]!.o.mention, { id: ANN, name: "ann" });
    assert.equal(spoken[0]!.o.replyTo, first.line.messageId);
    assert.equal(spoken[0]!.o.coinName, undefined, "nothing was looked at: no name to say");
    assert.equal(memoOf(CA1), undefined, "a failed look leaves no memo: a repost gets a fresh look");
    assert.equal(store.room(CHAT)!.lastCoinUnknownAtMs, T0);
    assert.equal(port!.nominations.length + dms.length, 0);

    // Inside the 10 minutes: silence, from anyone, and the room says why.
    clock += 9 * MIN;
    const second = await begin(flow, CHAT, `@pine and ${CA2}?`, { from: BOB, addressed: true });
    assert.deepEqual(await second.done, { acted: false, quiet: "coin-unknown", looks: ["unknown"] });
    assert.equal(spoken.length, 1);
    // Past them: said again.
    clock += MIN;
    await post(flow, CHAT, `@pine ${CA1}??`, { from: BOB, addressed: true });
    assert.equal(spoken.length, 2);
    assert.deepEqual(spoken[1]!.o.mention, { id: BOB, name: "bob" });
  });

  it("the unknown line is only for a post nothing else was said about, and a line that did not go out does not use up the 10 minutes", async () => {
    const flow = makeFlow();
    port!.looks.set(CA1, { kind: "unknown" });
    port!.looks.set(CA2, { kind: "curve", name: "Curvy" });
    // One CA failed, the other is a curve coin: the curve line is the answer.
    await post(flow, CHAT, `@pine ${CA1} or ${CA2}?`, { addressed: true });
    assert.deepEqual(intents(), [{ kind: "coin-look", look: "curve" }]);
    assert.equal(store.room(CHAT)!.lastCoinUnknownAtMs, undefined);
    // A wallet beside a failed look: the failed look still gets its line.
    spoken = [];
    port!.looks.set(ca(0x301), { kind: "wallet" });
    port!.looks.set(ca(0x302), { kind: "unknown" });
    speakOk = false;
    await post(flow, CHAT, `@pine ${ca(0x301)} ${ca(0x302)}`, { addressed: true });
    assert.deepEqual(intents(), [{ kind: "coin-unknown" }]);
    assert.equal(store.room(CHAT)!.lastCoinUnknownAtMs, undefined, "not sent: the window is given back");
    speakOk = true;
    await post(flow, CHAT, `@pine ${ca(0x302)}`, { addressed: true });
    assert.equal(spoken.length, 2);
    // Coins switched off meanwhile, or the sender forgotten: nothing.
    clock += 11 * MIN;
    const { line, info } = msg(CHAT, `@pine ${ca(0x303)}`, { addressed: true });
    port!.looks.set(ca(0x303), { kind: "unknown" });
    await flow.onPost(CHAT, line, { ...info, forgotten: () => false });
    assert.equal(spoken.length, 3);
    clock += 11 * MIN;
    port!.onLook = () => {
      coinsOn = false;
    };
    await post(flow, CHAT, `@pine ${ca(0x304)}`, { addressed: true });
    assert.equal(spoken.length, 3);
  });

  it("an Ethereum token posted again is looked at again (the look's cache makes it free), and still gets nothing", async () => {
    const flow = makeFlow();
    port!.looks.set(CA1, { kind: "wallet" });
    await post(flow, CHAT, CA1);
    clock += MIN;
    await post(flow, CHAT, `${CA1} ser`, { from: BOB });
    assert.deepEqual(port!.lookCalls, [CA1, CA1]);
    assert.equal(spoken.length + reacts.length, 0);
  });

  it("a memo from an older build that called another chain's token a wallet is never answered from", async () => {
    const flow = makeFlow();
    store.rememberCoin(CHAT, { address: CA1, byId: BOB, byName: "bob", messageId: 3, atMs: clock - HOUR, verdict: "wallet" });
    store.rememberCoin(CHAT, { address: CA2, byId: BOB, byName: "bob", messageId: 4, atMs: clock - HOUR, verdict: "not-token" });
    port!.looks.set(CA1, { kind: "wallet" });
    port!.looks.set(CA2, { kind: "not-token" });
    await post(flow, CHAT, `${CA1} ${CA2}`);
    assert.deepEqual(port!.lookCalls, [CA1, CA2], "looked at afresh");
    assert.equal(spoken.length + reacts.length, 0);
  });

  it("held: 'already got some', tagging the sender", async () => {
    port!.looks.set(CA1, { kind: "held", name: "Froggy" });
    const flow = makeFlow();
    await post(flow, CHAT, CA1, { from: BOB });
    assert.deepEqual(intents(), [{ kind: "coin-seen", verdict: "held" }]);
    assert.deepEqual(spoken[0]!.o.mention, { id: BOB, name: "bob" });
    assert.equal(memoOf(CA1)!.verdict, "held");
    assert.equal(port!.nominations.length, 0);
  });

  it("a look that throws is 'unknown': silence, logged without the address", async () => {
    port!.lookThrows = true;
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`);
    assert.deepEqual(intents(), []);
    assert.equal(memoOf(CA1), undefined);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /look failed/);
    assert.ok(!logs[0]!.includes(CA1.slice(2, 12)));
  });

  it("a malformed look is 'unknown' (silence); an address-shaped name is never passed on", async () => {
    port!.looks.set(CA1, { kind: "moon" as CoinKind });
    port!.looks.set(CA2, { kind: "too-thin", name: "0xdeadbeefcafe" });
    const flow = makeFlow();
    await post(flow, CHAT, CA1);
    await post(flow, CHAT, CA2);
    assert.deepEqual(intents(), [{ kind: "coin-look", look: "too-thin" }]);
    assert.equal(spoken[0]!.o.coinName, undefined);
    assert.equal(memoOf(CA1), undefined);
    assert.equal(memoOf(CA2)!.name, undefined);
  });

  it(`a look that never answers is 'unknown' after ${COIN_FLOW.lookMs / 1000} s: the post is let go, and the room hears it only when it was asked`, async () => {
    const waits: Array<{ ms: number; fire: () => void }> = [];
    const flow = makeFlow({
      timer: (ms) =>
        new Promise<void>((fire) => {
          waits.push({ ms, fire });
        }),
    });
    port!.look = (address: string) => {
      port!.lookCalls.push(address);
      return new Promise<CoinLook>(() => {});
    };
    const quiet = await begin(flow, CHAT, CA1);
    assert.equal(quiet.owned, "handled", "owned at once: nothing else answers it meanwhile");
    await settle();
    assert.deepEqual(port!.lookCalls, [CA1]);
    assert.deepEqual(waits.map((w) => w.ms), [COIN_FLOW.lookMs]);
    waits.shift()!.fire();
    assert.deepEqual(await quiet.done, { acted: false, quiet: "coin-unknown", looks: ["unknown"] });
    assert.deepEqual(spoken, [], "unaddressed: silence");
    assert.ok(logs.some((l) => /look timed out/.test(l)));
    assert.ok(!logs.join("\n").includes(CA1.slice(2, 12)), "never the address");

    const asked = await begin(flow, CHAT, `@pine ${CA2}`, { addressed: true });
    await settle();
    waits.shift()!.fire();
    assert.deepEqual(await asked.done, { acted: true, looks: ["unknown"] });
    assert.deepEqual(intents(), [{ kind: "coin-unknown" }]);
    assert.equal(memoOf(CA1), undefined);
    assert.equal(memoOf(CA2), undefined);
  });

  it("the real timer: a look that answers in time is not cut short; one that does not is let go at the bound", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const flow = makeFlow();
      let answer!: (l: CoinLook) => void;
      port!.look = () => new Promise<CoinLook>((r) => (answer = r));
      const p = begin(flow, CHAT, CA1);
      const started = await p;
      await settle();
      mock.timers.tick(COIN_FLOW.lookMs - 1);
      answer({ kind: "too-quiet", name: "Slowcoin" });
      assert.deepEqual(await started.done, { acted: true, looks: ["too-quiet"] });
      assert.deepEqual(intents(), [{ kind: "coin-look", look: "too-quiet" }]);
      // …and one that does not answer is let go at the bound.
      port!.look = () => new Promise<CoinLook>(() => {});
      const late = await begin(flow, CHAT, CA2);
      await settle();
      mock.timers.tick(COIN_FLOW.lookMs);
      assert.deepEqual(await late.done, { acted: false, quiet: "coin-unknown", looks: ["unknown"] });
    } finally {
      mock.timers.reset();
    }
  });

  it("the room was left during the look: nothing said, nothing nominated, the next CA not even claimed", async () => {
    port!.onLook = () => store.setStatus(CHAT, "left");
    const flow = makeFlow();
    const r = await post(flow, CHAT, `${CA1} ${CA2}`);
    assert.equal(spoken.length + port!.nominations.length, 0);
    assert.deepEqual(port!.lookCalls, [CA1]);
    assert.deepEqual(Object.keys(store.room(CHAT)!.claims), [`${r.line.messageId}:${CA1}`]);
  });

  it("the room was left while the owner ask was going out: no DM about it", async () => {
    port!.ready = { kind: "off", ownerReason: "off" };
    const flow = makeFlow({
      speak: async (chatId, intent, o) => {
        spoken.push({ chatId, intent, o });
        store.setStatus(CHAT, "left");
        return true;
      },
    });
    await post(flow, CHAT, `ape ${CA1}`);
    assert.deepEqual(intents(), [{ kind: "ready-ask" }]);
    assert.equal(dms.length, 0);
  });
});

// ─── The coin lane ─────────────────────────────────────────────────────────

describe("the coin lane: a post's reads never hold the chat's queue", () => {
  /** A look that answers only when the test says so. */
  function heldLooks(): { release: (address: string, l: CoinLook) => void; waiting: () => string[] } {
    const open = new Map<string, (l: CoinLook) => void>();
    port!.look = (address: string) => {
      port!.lookCalls.push(address);
      return new Promise<CoinLook>((r) => open.set(address, r));
    };
    return {
      release: (address, l) => {
        open.get(address)?.(l);
        open.delete(address);
      },
      waiting: () => [...open.keys()],
    };
  }

  it("begin owns a CA line at once, before any read answers; the claim is on disk before the look; done is the rest", async () => {
    const looks = heldLooks();
    const flow = makeFlow();
    const started = await begin(flow, CHAT, `ape ${CA1}`, { id: 700 });
    assert.equal(started.owned, "handled");
    await settle();
    assert.deepEqual(looks.waiting(), [CA1], "the look is out, and begin did not wait for it");
    assert.ok(onDisk().rooms[String(CHAT)]!.claims[`700:${CA1}`], "claimed before the look");
    assert.equal(spoken.length, 0);
    looks.release(CA1, { kind: "candidate", name: "Froggy" });
    assert.deepEqual(await started.done, { acted: true, looks: ["candidate"] });
    assert.deepEqual(intents(), [{ kind: "coin-ack" }]);
    assert.equal(port!.nominations.length, 1);
  });

  it("posts in one chat are worked in order: the coin's second post waits for the first and is answered from memory, one look", async () => {
    const looks = heldLooks();
    const flow = makeFlow();
    port!.ready = { kind: "off", ownerReason: "off" };
    const a = await begin(flow, CHAT, CA1);
    const b = await begin(flow, CHAT, `${CA1} again`, { from: BOB });
    await settle();
    assert.deepEqual(looks.waiting(), [CA1], "the second post has not been looked at yet");
    looks.release(CA1, { kind: "too-quiet", name: "Slowcoin" });
    await a.done;
    await b.done;
    assert.deepEqual(port!.lookCalls, [CA1], "one look for both posts");
    assert.deepEqual(intents(), [
      { kind: "coin-look", look: "too-quiet" },
      { kind: "coin-seen", verdict: "too-quiet" },
    ]);
  });

  it("a look hanging in one chat holds nothing in another", async () => {
    approve(OTHER, "Toad Hall");
    const looks = heldLooks();
    const flow = makeFlow();
    const stuck = await begin(flow, CHAT, CA1);
    const other = await begin(flow, OTHER, CA2);
    await settle();
    assert.deepEqual(looks.waiting().sort(), [CA1, CA2].sort(), "both looked at together");
    looks.release(CA2, { kind: "curve" });
    assert.deepEqual(await other.done, { acted: true, looks: ["curve"] });
    assert.equal(spoken.filter((s) => s.chatId === OTHER).length, 1);
    looks.release(CA1, { kind: "curve" });
    await stuck.done;
  });

  it("someone forgotten while their post waited on the lane: not claimed, looked at or answered", async () => {
    const looks = heldLooks();
    const flow = makeFlow();
    const first = await begin(flow, CHAT, CA1, { from: BOB });
    let gone = false;
    const { line, info } = msg(CHAT, CA2, { id: 701 });
    const second = await flow.begin(CHAT, line, { ...info, forgotten: () => gone });
    await settle();
    gone = true;
    looks.release(CA1, { kind: "curve" });
    await first.done;
    assert.deepEqual(await second.done, { acted: false, quiet: "forgotten" });
    assert.deepEqual(port!.lookCalls, [CA1]);
    assert.equal(store.room(CHAT)!.claims[`701:${CA2}`], undefined);
  });

  it("stop(): what is still on a lane does nothing more", async () => {
    const looks = heldLooks();
    const flow = makeFlow();
    const first = await begin(flow, CHAT, CA1);
    const second = await begin(flow, CHAT, CA2);
    await settle();
    flow.stop();
    looks.release(CA1, { kind: "curve" });
    await first.done;
    await second.done;
    assert.deepEqual(port!.lookCalls, [CA1], "the second post is not even looked at");
  });

  it("whoever asked goes first: a post that addresses it, or the owner's, before the posts already waiting; equals in arrival order", async () => {
    const looks = heldLooks();
    const flow = makeFlow();
    port!.ready = { kind: "off", ownerReason: "off" };
    const [c1, c2, c3, c4, c5, c6] = [ca(0x11), ca(0x12), ca(0x13), ca(0x14), ca(0x15), ca(0x16)];
    const posts = [
      await begin(flow, CHAT, c1, { from: BOB }), // being worked
      await begin(flow, CHAT, c2, { from: BOB }), // anyone's
      await begin(flow, CHAT, c3, { from: OWNER, name: "mike" }), // the owner's
      await begin(flow, CHAT, c4, { from: BOB }), // anyone's, later
      await begin(flow, CHAT, `@pine ${c5}`, { from: ANN, addressed: true }), // asked
      await begin(flow, CHAT, `@pine ${c6}`, { from: OWNER, name: "mike", addressed: true }), // the owner asking
    ];
    for (let i = 0; i < posts.length; i++) {
      await settle();
      const out = looks.waiting();
      assert.equal(out.length, 1, "one look at a time in a chat");
      looks.release(out[0]!, { kind: "too-quiet", name: "Slowcoin" });
    }
    for (const p of posts) await p.done;
    assert.deepEqual(port!.lookCalls, [c1, c6, c5, c3, c2, c4]);
  });

  it("a post that waited past its reply window is claimed and not looked at; a look is cut to fit the window", async () => {
    const waits: number[] = [];
    let answer!: (l: CoinLook) => void;
    const flow = makeFlow({
      timer: (ms) => {
        waits.push(ms);
        return new Promise<void>(() => {});
      },
    });
    port!.look = (address: string) => {
      port!.lookCalls.push(address);
      return new Promise<CoinLook>((r) => (answer = r));
    };
    const window = (text: string, id: number, o: MsgOpts = {}) => {
      const { line, info } = msg(CHAT, text, { id, ...o });
      return flow.begin(CHAT, line, { ...info, replyByMs: clock + 90_000 });
    };
    const first = await window(CA1, 800);
    const late = await window(CA2, 801, { from: BOB });
    const tight = await window(`@pine ${ca(0xc3)}`, 802, { addressed: true });
    await settle();
    assert.deepEqual(waits, [COIN_FLOW.lookMs], "the first look: its whole bound, the window is wide open");
    // The first look takes most of the window; the two behind it are left with little.
    clock += 90_000 - COIN_FLOW.lineMs - COIN_FLOW.lookMinMs - 1_000;
    answer({ kind: "too-quiet", name: "Slowcoin" });
    await first.done;
    await settle();
    // The addressed one goes next, with just room for a short look: cut to fit.
    assert.deepEqual(port!.lookCalls, [CA1, ca(0xc3)]);
    assert.deepEqual(waits, [COIN_FLOW.lookMs, COIN_FLOW.lookMinMs + 1_000]);
    clock += COIN_FLOW.lookMinMs;
    answer({ kind: "curve" });
    await tight.done;
    // Bob's: its window has no room for a look and a line. Claimed, nothing more.
    assert.deepEqual(await late.done, { acted: false, quiet: "coin-stale" });
    assert.deepEqual(port!.lookCalls, [CA1, ca(0xc3)], "never looked at");
    assert.ok(store.room(CHAT)!.claims[`801:${CA2}`], "but claimed: a replay repeats nothing");
    assert.equal(memoOf(CA2), undefined);
  });

  it(`a full lane (${COIN_FLOW.laneMax} waiting) lets go of posts nobody asked about — claimed, never looked at — and still takes the asked and the owner's`, async () => {
    const looks = heldLooks();
    const flow = makeFlow();
    const stuck = await begin(flow, CHAT, ca(0x200), { from: BOB });
    const waiting = [];
    for (let i = 1; i <= COIN_FLOW.laneMax; i++) waiting.push(await begin(flow, CHAT, ca(0x200 + i), { from: BOB }));
    const shed = await begin(flow, CHAT, ca(0x2ff), { from: BOB, id: 900 });
    assert.equal(shed.owned, "handled", "still owned: nothing else answers it");
    assert.deepEqual(await shed.done, { acted: false, quiet: "coin-busy" });
    assert.ok(store.room(CHAT)!.claims[`900:${ca(0x2ff)}`], "claimed");
    const asked = await begin(flow, CHAT, `@pine ${ca(0x2fe)}`, { from: ANN, addressed: true });
    const owners = await begin(flow, CHAT, ca(0x2fd), { from: OWNER, name: "mike" });
    await settle();
    looks.release(ca(0x200), { kind: "curve" });
    await stuck.done;
    await settle();
    assert.deepEqual(looks.waiting(), [ca(0x2fe)], "the asked one next");
    looks.release(ca(0x2fe), { kind: "curve" });
    assert.deepEqual(await asked.done, { acted: true, looks: ["curve"] });
    await settle();
    assert.deepEqual(looks.waiting(), [ca(0x2fd)], "then the owner's");
    looks.release(ca(0x2fd), { kind: "curve" });
    await owners.done;
    for (let i = 1; i <= COIN_FLOW.laneMax; i++) {
      await settle();
      looks.release(ca(0x200 + i), { kind: "curve" });
    }
    for (const w of waiting) await w.done;
    assert.ok(!port!.lookCalls.includes(ca(0x2ff)), "the shed post is never looked at");
  });

  it("drain() waits for every lane", async () => {
    const looks = heldLooks();
    const flow = makeFlow();
    await begin(flow, CHAT, CA1);
    await settle();
    let drained = false;
    const d = flow.drain().then(() => {
      drained = true;
    });
    await settle();
    assert.equal(drained, false);
    looks.release(CA1, { kind: "curve" });
    await d;
    assert.equal(drained, true);
    assert.equal(spoken.length, 1);
  });

  it("an outcome that arrives while its ack is still going out waits for the ack", async () => {
    const order: string[] = [];
    let ackSent!: () => void;
    const flow = makeFlow({
      speak: async (chatId, intent, o) => {
        spoken.push({ chatId, intent, o });
        if (intent.kind === "coin-ack") await new Promise<void>((r) => (ackSent = r));
        order.push(intent.kind);
        return true;
      },
    });
    flow.start();
    const started = await begin(flow, CHAT, CA1, { id: 702 });
    await settle();
    assert.equal(port!.nominations.length, 1);
    // The Brain is fast today: the outcome lands while the ack is still typing.
    port!.emit({ kind: "passed", address: CA1, chatId: CHAT, messageId: 702, decisionId: "d-1", notes: [] });
    await settle();
    assert.deepEqual(order, [], "the outcome waits");
    assert.equal(memoOf(CA1)!.verdict, "passed", "the verdict moved at once, so a duplicate finds it moved");
    ackSent();
    await started.done;
    await settle();
    assert.deepEqual(order, ["coin-ack", "coin-passed"]);
  });

  it("done says why a post got nothing: a stable code, never the address", async () => {
    const flow = makeFlow();
    const code = async (text: string, o: MsgOpts = {}) => (await (await begin(flow, CHAT, text, o)).done).quiet;
    port!.looks.set(CA1, { kind: "wallet" });
    assert.equal(await code(CA1), "coin-not-here");
    assert.equal(await code(`https://etherscan.io/token/${CA2}`), "coin-not-here", "another chain's link");
    assert.equal(await code(`${MINT} 🚀`), "coin-not-here", "a Solana mint");
    assert.equal(await code(ca(0x401), { dateSec: Math.floor((clock - 11 * MIN) / 1000) }), "coin-stale");
    assert.equal(await code(ca(0x402), { id: 703 }), undefined, "said: no code");
    assert.equal(await code(ca(0x402), { id: 703 }), "coin-replay");
    port = null;
    assert.equal(await code(ca(0x403)), "coin-no-port");
    port = new FakePort();
    coinsOn = false;
    assert.equal(await code(ca(0x404)), "coin-off");
    coinsOn = true;
    port.looks.set(ca(0x405), { kind: "unknown" });
    assert.equal(await code(ca(0x405)), "coin-unknown");
    speakOk = false;
    port.looks.set(ca(0x406), { kind: "curve" });
    assert.equal(await code(ca(0x406)), "send-failed");
  });
});

// ─── A chart link ──────────────────────────────────────────────────────────

describe("a chart link carries the pool: the coin it trades is the coin", () => {
  // The look (tg-coin-look.ts) proves a posted pool is a coin's canonical
  // pool and says which coin; here the port just answers that way.
  const POOL = ca(0xd1);
  const PAIR = ca(0xd2);
  const COIN_A = ca(0xe1);
  const COIN_B = ca(0xe2);
  const GECKO = `https://www.geckoterminal.com/robinhood/pools/${POOL}`;
  const DEX = `https://dexscreener.com/robinhood/${PAIR}?maker=1`;
  beforeEach(() => {
    port!.looks.set(POOL, { kind: "candidate", name: "Froggy", address: COIN_A });
    port!.looks.set(PAIR, { kind: "candidate", name: "Toady", address: COIN_B });
  });

  it("a GeckoTerminal pool link and a DexScreener pair link nominate the coin, remembered under the coin", async () => {
    const flow = makeFlow();
    for (const [id, text, pool, coin] of [
      [600, `this one is sending ${GECKO}`, POOL, COIN_A],
      [601, `look at this chart ${DEX}`, PAIR, COIN_B],
    ] as const) {
      spoken = [];
      const r = await post(flow, CHAT, text, { id, from: BOB });
      assert.equal(r.r, "handled");
      assert.equal(port!.lookCalls.at(-1), pool, "the look is asked about what was posted");
      assert.deepEqual(port!.nominations.at(-1), { address: coin, chatId: CHAT, messageId: id, senderId: BOB, atMs: clock });
      assert.deepEqual(intents(), [{ kind: "coin-ack" }]);
      assert.deepEqual(spoken[0]!.o.mention, { id: BOB, name: "bob" });
      assert.equal(spoken[0]!.o.replyTo, id);
      assert.equal(memoOf(coin)?.verdict, "candidate");
      assert.equal(memoOf(coin)?.messageId, id);
      assert.equal(memoOf(pool), undefined, "the pool is not a coin to remember");
      const claims = store.room(CHAT)!.claims;
      assert.ok(claims[`${id}:${pool}`] && claims[`${id}:${coin}`], "the post's pool, and its coin");
    }
    // The outcome for the coin reaches the chart link's post and its poster.
    spoken = [];
    await flow.onOutcome({ kind: "bought", address: COIN_A, chatId: CHAT, messageId: 600, paper: true, decisionId: "d-1", notes: [] });
    assert.deepEqual(intents(), [{ kind: "coin-bought", paper: true, notes: [] }]);
    assert.equal(spoken[0]!.o.replyTo, 600);
    assert.deepEqual(spoken[0]!.o.mention, { id: BOB, name: "bob" });
  });

  it("the coin posted beside its own chart link is one coin: one nomination, one line, either order", async () => {
    const flow = makeFlow();
    await post(flow, CHAT, `${COIN_A} chart ${GECKO}`, { id: 610 });
    await post(flow, CHAT, `${DEX} ca ${COIN_B}`, { id: 611 });
    assert.deepEqual(port!.nominations.map((n) => [n.address, n.messageId]), [[COIN_A, 610], [COIN_B, 611]]);
    assert.deepEqual(intents(), [{ kind: "coin-ack" }, { kind: "coin-ack" }]);
    assert.deepEqual(port!.lookCalls, [COIN_A, POOL, PAIR], "the coin claimed through its pool is not looked at again");
  });

  it("a repost of the coin, or of its chart link, is answered from memory", async () => {
    const flow = makeFlow();
    await post(flow, CHAT, `sending ${GECKO}`, { id: 620 });
    await flow.onOutcome({ kind: "passed", address: COIN_A, chatId: CHAT, messageId: 620, decisionId: "d-1", notes: [] });
    spoken = [];

    clock += 2 * HOUR;
    await post(flow, CHAT, `${COIN_A} again`, { from: BOB });
    assert.deepEqual(intents(), [{ kind: "coin-seen", verdict: "passed" }]);
    assert.deepEqual(port!.lookCalls, [POOL], "the coin itself: no new look");

    clock += 2 * HOUR;
    await post(flow, CHAT, `still sending ${GECKO}`, { from: BOB });
    assert.deepEqual(intents(), [{ kind: "coin-seen", verdict: "passed" }, { kind: "coin-seen", verdict: "passed" }]);
    assert.equal(port!.nominations.length, 1, "never nominated twice");
    assert.equal(memoOf(COIN_A)!.byId, ANN, "the memo still names who posted it first");
  });

  it("a look that names no coin, or not a well-formed one, keeps the posted address", async () => {
    port!.looks.set(POOL, { kind: "not-token" });
    port!.looks.set(PAIR, { kind: "too-thin", address: "0x1234" });
    const flow = makeFlow();
    await post(flow, CHAT, GECKO);
    await post(flow, CHAT, DEX);
    assert.equal(memoOf(POOL), undefined, "a pool the factory does not name is not a coin: silence, no memo");
    assert.equal(memoOf(PAIR)?.verdict, "too-thin");
    assert.deepEqual(intents(), [{ kind: "coin-look", look: "too-thin" }]);
    assert.equal(port!.nominations.length, 0);
  });

  it("a pool whose coin is not a coin here (one level only) is silence, and its coin is not claimed", async () => {
    port!.looks.set(POOL, { kind: "not-token", address: COIN_A });
    const flow = makeFlow();
    const r = await post(flow, CHAT, GECKO);
    assert.equal(spoken.length + reacts.length, 0);
    assert.deepEqual(Object.keys(store.room(CHAT)!.claims), [`${r.line.messageId}:${POOL}`]);
  });
});

// ─── Nominating ────────────────────────────────────────────────────────────

describe("nominating", () => {
  it("only the address and where it came from cross, and the ack tags the sender", async () => {
    const flow = makeFlow();
    const dateSec = Math.floor(clock / 1000) - 30;
    const r = await post(flow, CHAT, `ape 100 now ${CA1} buy buy`, { id: 777, from: BOB, dateSec });
    assert.equal(r.r, "handled");
    assert.deepEqual(port!.nominations, [{ address: CA1, chatId: CHAT, messageId: 777, senderId: BOB, atMs: dateSec * 1000 }]);
    assert.deepEqual(intents(), [{ kind: "coin-ack" }]);
    assert.deepEqual(spoken[0]!.o.mention, { id: BOB, name: "bob" });
    assert.equal(spoken[0]!.o.replyTo, 777);
    assert.equal(spoken[0]!.o.coinName, "Froggy");
    const memo = memoOf(CA1)!;
    assert.equal(memo.verdict, "candidate");
    assert.equal(memo.byId, BOB);
    assert.equal(memo.messageId, 777);
    assert.equal(memo.atMs, dateSec * 1000);
  });

  it("caps: 'one at a time lol' at most once per chat per hour, and no memo", async () => {
    const flow = makeFlow();
    port!.results = [{ ok: false, reason: "busy" }];
    await post(flow, CHAT, `ape ${ca(1)}`);
    assert.deepEqual(intents(), [{ kind: "coin-cap" }]);
    assert.equal(memoOf(ca(1)), undefined);

    for (const reason of ["chat-rate", "sender-rate", "daily"] as const) {
      clock += 5 * MIN;
      port!.results = [{ ok: false, reason }];
      await post(flow, CHAT, `ape ${ca(clock)}`);
    }
    assert.equal(spoken.length, 1, "within the hour: silence");

    clock = T0 + HOUR;
    port!.results = [{ ok: false, reason: "daily" }];
    await post(flow, CHAT, `ape ${ca(9)}`);
    assert.deepEqual(intents(), [{ kind: "coin-cap" }, { kind: "coin-cap" }]);
    // A capped coin gets its turn on a repost once there is room.
    clock += MIN;
    await post(flow, CHAT, `ape ${ca(1)}`);
    assert.equal(memoOf(ca(1))!.verdict, "candidate");
  });

  it("recent, invalid and not-ready refusals are silent", async () => {
    const flow = makeFlow();
    for (const reason of ["recent", "invalid", "not-ready"] as const) {
      port!.results = [{ ok: false, reason }];
      await post(flow, CHAT, `ape ${ca(clock)}`);
      clock += MIN;
    }
    assert.equal(spoken.length + reacts.length, 0);
  });

  it("recent, when the memory is this chat's, answers from memory", async () => {
    const flow = makeFlow();
    store.rememberCoin(CHAT, { address: CA1, byId: BOB, byName: "bob", messageId: 5, atMs: clock - 25 * HOUR, verdict: "passed", name: "Froggy" });
    port!.results = [{ ok: false, reason: "recent" }];
    await post(flow, CHAT, `ape ${CA1}`);
    assert.deepEqual(intents(), [{ kind: "coin-seen", verdict: "passed" }]);
  });

  it("two CAs in one message: each is claimed, looked at and nominated", async () => {
    const flow = makeFlow();
    const r = await post(flow, CHAT, `${CA1} or ${CA2}?`);
    assert.deepEqual(port!.lookCalls, [CA1, CA2]);
    assert.deepEqual(port!.nominations.map((n) => n.address), [CA1, CA2]);
    assert.deepEqual(intents(), [{ kind: "coin-ack" }, { kind: "coin-ack" }]);
    const claims = store.room(CHAT)!.claims;
    assert.ok(claims[`${r.line.messageId}:${CA1}`]);
    assert.ok(claims[`${r.line.messageId}:${CA2}`]);
  });

  it("a nominate that throws is silent and logged without content", async () => {
    port!.nominateThrows = true;
    const flow = makeFlow();
    assert.equal((await post(flow, CHAT, `ape ${CA1}`)).r, "handled");
    assert.equal(spoken.length, 0);
    assert.equal(memoOf(CA1), undefined);
    assert.match(logs.join("\n"), /nominate failed \(Error\)/);
    assert.ok(!logs.join("\n").includes(CA1.slice(2)));
  });
});

// ─── Outcomes ──────────────────────────────────────────────────────────────

describe("outcomes", () => {
  async function nominated(flow: CoinFlow, address = CA1, id = 300, from = ANN) {
    await post(flow, CHAT, `ape ${address}`, { id, from });
    spoken = [];
  }

  it("bought: tags the original sender, replies to their post, and says paper", async () => {
    const flow = makeFlow();
    await nominated(flow);
    await post(flow, CHAT, "lfg", { from: BOB });
    await flow.onOutcome({
      kind: "bought", address: CA1, chatId: CHAT, messageId: 300, paper: true, decisionId: "d-1",
      notes: ["new buyers keep showing up"],
    });
    assert.deepEqual(intents(), [{ kind: "coin-bought", paper: true, notes: ["new buyers keep showing up"] }]);
    const o = spoken[0]!.o;
    assert.deepEqual(o.mention, { id: ANN, name: "ann" });
    assert.equal(o.replyTo, 300);
    assert.equal(o.trigger?.messageId, 300);
    assert.equal(o.coinName, "Froggy");
    const memo = memoOf(CA1)!;
    assert.equal(memo.verdict, "bought");
    assert.equal(memo.decisionId, "d-1");
    assert.equal(memo.paper, true);
  });

  it("bought live is not said as paper", async () => {
    const flow = makeFlow();
    await nominated(flow);
    await flow.onOutcome({ kind: "bought", address: CA1, chatId: CHAT, messageId: 300, paper: false, decisionId: "d-1", notes: [] });
    assert.deepEqual(intents(), [{ kind: "coin-bought", paper: false, notes: [] }]);
    assert.equal(memoOf(CA1)!.paper, undefined);
  });

  it("passed: a fade grounded in the notes; skipped: 'sitting this one out'", async () => {
    const flow = makeFlow();
    await nominated(flow, CA1, 300, ANN);
    await nominated(flow, CA2, 301, BOB);
    await flow.onOutcome({
      kind: "passed", address: CA1, chatId: CHAT, messageId: 300, decisionId: "d-1",
      notes: ["same few wallets passing it around"],
    });
    await flow.onOutcome({ kind: "skipped", address: CA2, chatId: CHAT, messageId: 301, decisionId: "d-2" });
    assert.deepEqual(intents(), [
      { kind: "coin-passed", notes: ["same few wallets passing it around"] },
      { kind: "coin-skipped" },
    ]);
    assert.deepEqual(spoken[0]!.o.mention, { id: ANN, name: "ann" });
    assert.deepEqual(spoken[1]!.o.mention, { id: BOB, name: "bob" });
    assert.equal(spoken[1]!.o.replyTo, 301);
    assert.equal(memoOf(CA1)!.verdict, "passed");
    assert.equal(memoOf(CA1)!.decisionId, "d-1");
    assert.equal(memoOf(CA2)!.verdict, "skipped");
    assert.equal(memoOf(CA2)!.decisionId, "d-2");
  });

  it("expired: silent when the chat moved on, 'sitting this one out' while it is live", async () => {
    const flow = makeFlow();
    await nominated(flow, CA1, 300);
    clock += 31 * MIN;
    await flow.onOutcome({ kind: "expired", address: CA1, chatId: CHAT, messageId: 300 });
    assert.equal(spoken.length, 0);
    assert.equal(memoOf(CA1)!.verdict, "expired");

    await nominated(flow, CA2, 301);
    clock += 20 * MIN;
    await post(flow, CHAT, "anyone around", { from: BOB });
    spoken = [];
    clock += 11 * MIN;
    await flow.onOutcome({ kind: "expired", address: CA2, chatId: CHAT, messageId: 301 });
    assert.deepEqual(intents(), [{ kind: "coin-skipped" }]);
  });

  it("exited: one line, only for a coin the chat heard bought", async () => {
    const flow = makeFlow();
    await nominated(flow, CA1, 300);
    await flow.onOutcome({ kind: "bought", address: CA1, chatId: CHAT, messageId: 300, paper: true, decisionId: "d-1", notes: [] });
    spoken = [];
    clock += 2 * HOUR;
    const exit: CoinOutcome = { kind: "exited", address: CA1, chatId: CHAT, messageId: 300, notes: ["it ran out of steam"] };
    await flow.onOutcome(exit);
    await flow.onOutcome(exit);
    assert.deepEqual(intents(), [{ kind: "coin-exited", notes: ["it ran out of steam"] }]);
    assert.deepEqual(spoken[0]!.o.mention, { id: ANN, name: "ann" });
    assert.equal(memoOf(CA1)!.exitSaid, true);

    await nominated(flow, CA2, 301);
    await flow.onOutcome({ kind: "passed", address: CA2, chatId: CHAT, messageId: 301, decisionId: "d-2", notes: [] });
    spoken = [];
    await flow.onOutcome({ kind: "exited", address: CA2, chatId: CHAT, messageId: 301, notes: [] });
    assert.equal(spoken.length, 0);
  });

  it("each outcome goes to the chat and the person its coin came from", async () => {
    approve(OTHER, "Other Pond");
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`, { id: 10, from: ANN });
    await post(flow, OTHER, `ape ${CA2}`, { id: 10, from: BOB });
    spoken = [];
    await flow.onOutcome({ kind: "passed", address: CA2, chatId: OTHER, messageId: 10, decisionId: "d-2", notes: [] });
    await flow.onOutcome({ kind: "bought", address: CA1, chatId: CHAT, messageId: 10, paper: true, decisionId: "d-1", notes: [] });
    assert.equal(spoken.length, 2);
    assert.equal(spoken[0]!.chatId, OTHER);
    assert.deepEqual(spoken[0]!.o.mention, { id: BOB, name: "bob" });
    assert.equal(spoken[1]!.chatId, CHAT);
    assert.deepEqual(spoken[1]!.o.mention, { id: ANN, name: "ann" });
    // The address in the other chat is not the one that was bought.
    assert.equal(store.coin(OTHER, CA1), undefined);
  });

  it("ignored: an unknown chat, another post, a non-approved room, a second outcome, a malformed one", async () => {
    const flow = makeFlow();
    await nominated(flow, CA1, 300);
    await flow.onOutcome({ kind: "passed", address: CA1, chatId: -5, messageId: 300, decisionId: "d-1", notes: [] });
    await flow.onOutcome({ kind: "passed", address: CA1, chatId: CHAT, messageId: 299, decisionId: "d-1", notes: [] });
    await flow.onOutcome({ kind: "passed", address: CA2, chatId: CHAT, messageId: 300, decisionId: "d-1", notes: [] });
    await flow.onOutcome({ kind: "rugged", address: CA1, chatId: CHAT, messageId: 300 } as unknown as CoinOutcome);
    await flow.onOutcome(null as unknown as CoinOutcome);
    assert.equal(spoken.length, 0);
    assert.equal(memoOf(CA1)!.verdict, "candidate");

    await flow.onOutcome({ kind: "bought", address: CA1.toUpperCase().replace("0X", "0x"), chatId: CHAT, messageId: 300, paper: true, decisionId: "d-1", notes: [] });
    await flow.onOutcome({ kind: "bought", address: CA1, chatId: CHAT, messageId: 300, paper: true, decisionId: "d-1", notes: [] });
    await flow.onOutcome({ kind: "skipped", address: CA1, chatId: CHAT, messageId: 300 });
    assert.equal(spoken.length, 1, "one outcome per nomination");

    await nominated(flow, CA2, 301);
    store.setStatus(CHAT, "pending");
    await flow.onOutcome({ kind: "passed", address: CA2, chatId: CHAT, messageId: 301, decisionId: "d-2", notes: [] });
    assert.equal(spoken.length, 0, "never a line in a room that is not approved");
  });

  it("two outcomes for one nomination arriving at once: one line", async () => {
    const flow = makeFlow();
    await nominated(flow, CA1, 300);
    const o: CoinOutcome = { kind: "passed", address: CA1, chatId: CHAT, messageId: 300, decisionId: "d-1", notes: [] };
    await Promise.all([flow.onOutcome(o), flow.onOutcome(o)]);
    assert.equal(spoken.length, 1);
  });

  it("a note carrying a figure, a sign or an address is dropped whole", async () => {
    const flow = makeFlow();
    await nominated(flow, CA1, 300);
    await flow.onOutcome({
      kind: "passed", address: CA1, chatId: CHAT, messageId: 300, decisionId: "d-1",
      notes: ["up 5x today", "costs $ to get in", "ninety percent held by 0xabc", "the same few wallets trade it", 7 as unknown as string],
    });
    assert.deepEqual(intents(), [{ kind: "coin-passed", notes: ["the same few wallets trade it"] }]);
  });

  it("coins switched off after the nomination: the verdict is kept, nothing is said", async () => {
    const flow = makeFlow();
    await nominated(flow, CA1, 300);
    coinsOn = false;
    await flow.onOutcome({ kind: "bought", address: CA1, chatId: CHAT, messageId: 300, paper: true, decisionId: "d-1", notes: [] });
    assert.equal(spoken.length, 0);
    assert.equal(memoOf(CA1)!.verdict, "bought");
  });

  it("a sender whose name was blanked is not tagged, and the reply still goes to their post", async () => {
    const flow = makeFlow();
    await nominated(flow, CA1, 300);
    store.updateCoin(CHAT, CA1, { byName: "" });
    await flow.onOutcome({ kind: "passed", address: CA1, chatId: CHAT, messageId: 300, decisionId: "d-1", notes: [] });
    assert.equal(spoken[0]!.o.mention, undefined);
    assert.equal(spoken[0]!.o.replyTo, 300);
  });
});

// ─── The port subscription ─────────────────────────────────────────────────

describe("the port subscription", () => {
  it("outcomes arrive through the port after start()", async () => {
    const flow = makeFlow();
    flow.start();
    await post(flow, CHAT, `ape ${CA1}`, { id: 300 });
    spoken = [];
    port!.emit({ kind: "bought", address: CA1, chatId: CHAT, messageId: 300, paper: true, decisionId: "d-1", notes: [] });
    await settle();
    assert.deepEqual(intents(), [{ kind: "coin-bought", paper: true, notes: [] }]);
  });

  it("a new port is subscribed on the next post and the old one dropped", async () => {
    const p1 = port!;
    const flow = makeFlow();
    flow.start();
    flow.start();
    assert.equal(p1.subs.size, 1, "start is idempotent");
    await post(flow, CHAT, `ape ${CA1}`, { id: 300 });
    spoken = [];

    const p2 = new FakePort();
    port = p2;
    await post(flow, CHAT, "gm");
    assert.equal(p1.subs.size, 0);
    assert.equal(p2.subs.size, 1);

    const o: CoinOutcome = { kind: "passed", address: CA1, chatId: CHAT, messageId: 300, decisionId: "d-1", notes: [] };
    p1.emit(o);
    await settle();
    assert.equal(spoken.length, 0, "the old port is not heard");
    p2.emit(o);
    await settle();
    assert.equal(spoken.length, 1);
  });

  it("an old port whose unsubscribe failed is still not heard", async () => {
    const p1 = port!;
    p1.onOutcome = (cb) => {
      p1.subs.add(cb);
      return () => {
        throw new Error("cannot unsubscribe");
      };
    };
    const flow = makeFlow();
    flow.start();
    await post(flow, CHAT, `ape ${CA1}`, { id: 300 });
    spoken = [];
    port = new FakePort();
    await post(flow, CHAT, "gm");
    assert.equal(p1.subs.size, 1, "the old callback is still registered");
    assert.match(logs.join("\n"), /unsubscribe failed/);
    p1.emit({ kind: "passed", address: CA1, chatId: CHAT, messageId: 300, decisionId: "d-1", notes: [] });
    await settle();
    assert.equal(spoken.length, 0);
    assert.equal(memoOf(CA1)!.verdict, "candidate");
  });

  it("a new port is also picked up within a minute with no post", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      port = null;
      const flow = makeFlow();
      flow.start();
      const p = new FakePort();
      port = p;
      mock.timers.tick(COIN_FLOW.portCheckMs - 1);
      assert.equal(p.subs.size, 0);
      mock.timers.tick(1);
      assert.equal(p.subs.size, 1);
      port = null;
      mock.timers.tick(COIN_FLOW.portCheckMs);
      assert.equal(p.subs.size, 0, "a port that went away is dropped");
    } finally {
      mock.timers.reset();
    }
  });

  it("stop() unsubscribes and nothing is subscribed before start()", async () => {
    const p = port!;
    const flow = makeFlow();
    await post(flow, CHAT, "gm");
    assert.equal(p.subs.size, 0, "onPost does not subscribe a flow that was never started");
    flow.start();
    assert.equal(p.subs.size, 1);
    flow.stop();
    assert.equal(p.subs.size, 0);
    await post(flow, CHAT, "gm");
    assert.equal(p.subs.size, 0);
  });

  it("a subscribe that throws is logged and retried", async () => {
    const p = port!;
    let fail = true;
    const real = p.onOutcome.bind(p);
    p.onOutcome = (cb) => {
      if (fail) throw new Error("no");
      return real(cb);
    };
    const flow = makeFlow();
    flow.start();
    assert.equal(p.subs.size, 0);
    assert.match(logs.join("\n"), /subscribe failed/);
    fail = false;
    await post(flow, CHAT, "gm");
    assert.equal(p.subs.size, 1);
  });
});

// ─── A faded coin hyped again ──────────────────────────────────────────────

describe("fadedCoinIn", () => {
  function remember(address: string, verdict: TgCoinMemo["verdict"], name: string | undefined, atMs = clock, chatId = CHAT) {
    store.rememberCoin(chatId, { address, byId: ANN, byName: "ann", messageId: 1, atMs, verdict, ...(name ? { name } : {}) });
  }

  it("finds a faded coin said as a whole word, and nothing else", () => {
    const flow = makeFlow();
    remember(ca(1), "passed", "Froggy");
    remember(ca(2), "too-thin", "Moon Cat");
    remember(ca(3), "bought", "Pepe");
    remember(ca(4), "curve", "ok");
    remember(ca(5), "v4-only", undefined);
    remember(ca(6), "wallet", "Walletto");
    assert.equal(flow.fadedCoinIn(CHAT, "FROGGY is sending again")?.address, ca(1));
    assert.equal(flow.fadedCoinIn(CHAT, "moon cat pumping, told you")?.address, ca(2));
    assert.equal(flow.fadedCoinIn(CHAT, "$froggy!!")?.address, ca(1));
    assert.equal(flow.fadedCoinIn(CHAT, "froggyverse is the play"), null, "not a whole word");
    assert.equal(flow.fadedCoinIn(CHAT, "pepe to the moon"), null, "bought is not a fade");
    assert.equal(flow.fadedCoinIn(CHAT, "ok ok"), null, "too short to be a name");
    assert.equal(flow.fadedCoinIn(CHAT, "walletto"), null, "a wallet is not a fade");
    assert.equal(flow.fadedCoinIn(CHAT, ""), null);
  });

  it("the newest faded memo wins, and a copy comes back", () => {
    const flow = makeFlow();
    remember(ca(1), "passed", "Froggy", clock - HOUR);
    remember(ca(2), "too-quiet", "Froggy", clock);
    const got = flow.fadedCoinIn(CHAT, "froggy");
    assert.equal(got?.address, ca(2));
    got!.verdict = "bought";
    assert.equal(memoOf(ca(2))!.verdict, "too-quiet");
  });

  it("names with regex characters are matched literally; other chats and unapproved rooms are not searched", () => {
    const flow = makeFlow();
    remember(ca(1), "passed", "Dog (Wif) Hat+");
    assert.equal(flow.fadedCoinIn(CHAT, "dog (wif) hat+ again")?.address, ca(1));
    assert.equal(flow.fadedCoinIn(CHAT, "dog wif hat"), null);
    approve(OTHER, "Other");
    assert.equal(flow.fadedCoinIn(OTHER, "dog (wif) hat+"), null, "memory never crosses chats");
    store.setStatus(CHAT, "pending");
    assert.equal(flow.fadedCoinIn(CHAT, "dog (wif) hat+"), null);
  });
});

// ─── Never throws ──────────────────────────────────────────────────────────

describe("never throws, logs no content", () => {
  it("speak, react and dmOwner that throw are logged by stage and error class only", async () => {
    const boom = (what: string) => async () => {
      throw new Error(`${what} ${CA1} Frog Pond ann`);
    };
    const flow = makeFlow({ speak: boom("speak"), react: boom("react"), dmOwner: boom("dm") });
    assert.equal((await post(flow, CHAT, `ape ${CA1}`)).r, "handled");
    port!.ready = { kind: "off", ownerReason: "off" };
    assert.equal((await post(flow, CHAT, `ape ${CA2}`)).r, "handled");
    assert.equal((await post(flow, CHAT, MINT)).r, "handled");
    await flow.onOutcome({ kind: "passed", address: CA1, chatId: CHAT, messageId: 100, decisionId: "d-1", notes: [] });
    assert.ok(logs.length >= 4);
    for (const l of logs) {
      assert.match(l, /^\[tg-groups\] coin flow: [a-z ]+ failed \(Error\)$/);
      assert.ok(!l.includes("Frog") && !l.includes("ann") && !l.includes(CA1.slice(2)));
    }
    // A throwing speak did not burn the hour.
    assert.equal(store.room(CHAT)!.lastReadyAskAtMs, undefined);
  });

  it("a port() that throws reads as no port: nothing to look with, so silence", async () => {
    const flow = makeFlow({
      port: () => {
        throw new Error("x");
      },
    });
    assert.equal((await post(flow, CHAT, `ape ${CA1}`)).r, "handled");
    assert.equal(spoken.length + dms.length + reacts.length, 0);
    assert.equal(memoOf(CA1), undefined);
    assert.match(logs.join("\n"), /port failed \(Error\)/);
  });

  it("an ownerId() that throws reads as never linked", async () => {
    port!.ready = { kind: "off", ownerReason: "off" };
    const flow = makeFlow({
      ownerId: () => {
        throw new Error("y");
      },
    });
    assert.equal((await post(flow, CHAT, `ape ${CA1}`)).r, "handled");
    assert.equal(spoken.length + dms.length, 0);
    assert.equal(reacts.length, 1);
    assert.equal(memoOf(CA1)!.verdict, "not-ready");
  });

  it("a readiness() that throws reads as not ready", async () => {
    port!.readiness = () => {
      throw new Error("z");
    };
    const flow = makeFlow();
    await post(flow, CHAT, `ape ${CA1}`);
    assert.deepEqual(intents(), [{ kind: "ready-ask" }]);
    assert.equal(port!.nominations.length, 0);
    assert.match(dms[0]!.text, /check Trencher mode in Settings/, "the DM's reason when readiness could not be read");
  });

  it("a log that throws does not throw through", async () => {
    port!.lookThrows = true;
    const flow = makeFlow({
      log: () => {
        throw new Error("log");
      },
    });
    assert.equal((await post(flow, CHAT, `ape ${CA1}`)).r, "handled");
  });

  it("garbage in is none, not a throw", async () => {
    const flow = makeFlow();
    assert.equal(await flow.onPost(CHAT, null as unknown as TgLine, null as unknown as CoinPostInfo), "none");
    const line: TgLine = { messageId: 1, fromId: ANN, name: "ann", text: "x", atMs: clock };
    assert.equal(await flow.onPost(CHAT, line, { cas: "nope" } as unknown as CoinPostInfo), "none");
    assert.equal(flow.fadedCoinIn(CHAT, 5 as unknown as string), null);
  });
});
