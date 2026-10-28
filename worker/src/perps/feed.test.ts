import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { parseDecimalToScaled } from "../../../packages/core/src/index";
import { clearLighterCooldown, publishLighterCooldown, type LighterResult } from "./api";
import { LIGHTER_FEED_DEFAULTS, startLighterFeed, type FeedSocket, type FeedSocketCtor, type FeedTimers, type LighterFeedApi, type LighterFeedOptions } from "./feed";
import { parseLighterFeed, readLighterFeed } from "./feed-reader";
import { parseDepth, parseOrderBookDetails, type DepthRead, type OrderBookDetailsRead, type PerpDecimals } from "./markets";

/**
 * The feed under a fake clock, a fake socket and a fake REST client. No
 * network, ever: the socket is an object the test plays the venue through,
 * and the venue's frames are either the verbatim live capture
 * (fixtures/ws.stream.0.jsonl) or synthetic frames in exactly its shape.
 */

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const fixture = (f: string) => readFileSync(path.join(FIXTURES, f), "utf8");
const DETAILS = parseOrderBookDetails(JSON.parse(fixture("orderBookDetails.perp.json")))!;
const DEPTH_1 = JSON.parse(fixture("orderBookOrders.1.json")) as unknown;
const WS_FRAMES = fixture("ws.stream.0.jsonl").trim().split("\n");
const WS_STATS_SNAPSHOT = JSON.parse(WS_FRAMES.find((s) => s.includes('"type":"subscribed/market_stats"'))!) as {
  market_stats: Record<string, Record<string, unknown>>;
};

const ROOT = mkdtempSync(path.join(os.tmpdir(), "merrymen-lighter-feed-"));
const FLEET = path.join(ROOT, "fleet");
const priorFleet = process.env.MERRYMEN_FLEET_HOME;
process.env.MERRYMEN_FLEET_HOME = FLEET;
after(() => {
  if (priorFleet === undefined) delete process.env.MERRYMEN_FLEET_HOME;
  else process.env.MERRYMEN_FLEET_HOME = priorFleet;
  rmSync(ROOT, { recursive: true, force: true });
});

let T0 = 1_790_700_000_000;
let OUT = "";
beforeEach(() => {
  clearLighterCooldown(FLEET);
  T0 += 86_400_000;
  OUT = path.join(ROOT, `run-${T0}`, "fleet", "lighter-feed.json");
});

// ── fakes ───────────────────────────────────────────────────────────────────

const flush = () => new Promise<void>((r) => setImmediate(r));

class Clock {
  t: number;
  private seq = 0;
  private q: Array<{ at: number; id: number; fn: () => void }> = [];
  constructor(t: number) {
    this.t = t;
  }
  now = () => this.t;
  timers: FeedTimers = {
    setTimeout: (fn, ms) => {
      const id = ++this.seq;
      this.q.push({ at: this.t + Math.max(0, ms), id, fn });
      return id;
    },
    clearTimeout: (h) => {
      this.q = this.q.filter((x) => x.id !== h);
    },
  };
  /** Run every timer due up to now + ms, in order, letting promises settle after each. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.q[0];
      if (next === undefined || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
      await flush();
    }
    this.t = end;
  }
}

interface Sent {
  at: number;
  socket: number;
  msg: { type: string; channel?: string };
}

function socketFactory(clock: Clock, behaviour: "manual" | "refuse" = "manual") {
  const all: FakeSocket[] = [];
  const sent: Sent[] = [];
  class FakeSocket implements FeedSocket {
    readyState = 0;
    readonly n: number;
    readonly createdAt: number;
    onopen: FeedSocket["onopen"] = null;
    onmessage: FeedSocket["onmessage"] = null;
    onclose: FeedSocket["onclose"] = null;
    onerror: FeedSocket["onerror"] = null;
    constructor(readonly url: string) {
      this.n = all.length;
      this.createdAt = clock.t;
      all.push(this);
      // The venue refusing the connection: an error, then a close, after the handlers are attached.
      if (behaviour === "refuse")
        queueMicrotask(() => {
          this.readyState = 3;
          this.onerror?.({});
          this.onclose?.({ code: 1006 });
        });
    }
    send(data: string) {
      if (this.readyState !== 1) throw new Error("not open");
      sent.push({ at: clock.t, socket: this.n, msg: JSON.parse(data) as Sent["msg"] });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code: 1000 }));
    }
    /** The venue accepts and says `connected`. */
    accept() {
      this.readyState = 1;
      this.onopen?.({});
      this.frame({ session_id: "test", type: "connected" });
    }
    frame(x: unknown) {
      this.onmessage?.({ data: typeof x === "string" ? x : JSON.stringify(x) });
    }
    /** The venue drops the connection. */
    kill(code = 1006) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
  }
  return { Ctor: FakeSocket as unknown as FeedSocketCtor, all, sent };
}
type FakeSocket = ReturnType<typeof socketFactory>["all"][number];

const ok = <T>(value: T): LighterResult<T> => ({ ok: true, value, serverDateMs: null });

function fakeApi(over: Partial<{ details: () => Promise<LighterResult<OrderBookDetailsRead>>; depth: (m: number, limit: number, d: PerpDecimals) => Promise<LighterResult<DepthRead>> }> = {}) {
  const calls = { details: [] as number[], depth: [] as Array<{ m: number; limit: number }> };
  let clock: Clock | null = null;
  const api: LighterFeedApi = {
    budgetKey: "public",
    orderBookDetails: () => {
      calls.details.push(clock?.t ?? 0);
      return over.details ? over.details() : Promise.resolve(ok(DETAILS));
    },
    orderBookOrders: (m, limit, d) => {
      calls.depth.push({ m, limit });
      if (over.depth) return over.depth(m, limit, d);
      const read = parseDepth(DEPTH_1, m, d, limit);
      return Promise.resolve(read === null ? { ok: false, error: { kind: "malformed", status: 200, retryable: true, detail: "x" }, serverDateMs: null } : ok(read));
    },
  };
  return { api, calls, bind: (c: Clock) => (clock = c) };
}

function start(ids: number[] | (() => number[]), over: Partial<LighterFeedOptions> = {}, behaviour: "manual" | "refuse" = "manual", apiOver: Parameters<typeof fakeApi>[0] = {}) {
  const clock = new Clock(T0);
  const socks = socketFactory(clock, behaviour);
  const fa = fakeApi(apiOver);
  fa.bind(clock);
  const logs: string[] = [];
  const feed = startLighterFeed({
    marketIds: typeof ids === "function" ? ids : () => ids,
    outPath: OUT,
    home: FLEET,
    api: fa.api,
    WebSocketImpl: socks.Ctor,
    now: clock.now,
    timers: clock.timers,
    random: () => 0,
    logger: (l) => logs.push(l),
    ...over,
  });
  return { feed, clock, socks, api: fa, logs };
}

/** Start, let orderBookDetails land, accept the socket and let the paced subscribes go out. */
async function boot(ids: number[] | (() => number[]), over: Partial<LighterFeedOptions> = {}) {
  const f = start(ids, over);
  await f.clock.advance(1_100); // past the first connect's jitter
  const sock = f.socks.all[0]!;
  sock.accept();
  await f.clock.advance(3_000);
  return { ...f, sock };
}

const subs = (sent: Sent[], socket?: number) => sent.filter((s) => (s.msg.type === "subscribe" || s.msg.type === "unsubscribe") && (socket === undefined || s.socket === socket));

// ── synthetic frames in the live shape ──────────────────────────────────────

type Lv = [price: string, size: string];
const lv = (xs: Lv[]) => xs.map(([price, size]) => ({ price, size }));
let offset = 5_000_000;
function bookFrame(id: number, kind: "subscribed" | "update", o: { asks?: Lv[]; bids?: Lv[]; nonce: number; begin?: number }) {
  offset++;
  return {
    channel: `order_book:${id}`,
    last_updated_at: 1_790_707_955_817_934,
    offset,
    order_book: { code: 0, asks: lv(o.asks ?? []), bids: lv(o.bids ?? []), offset, nonce: o.nonce, last_updated_at: 1_790_707_955_817_934, begin_nonce: o.begin ?? 0 },
    timestamp: 1_790_707_955_852,
    type: `${kind}/order_book`,
  };
}
function statsFrame(kind: "subscribed" | "update", over: Record<string, Record<string, unknown>> = {}, ids?: number[]) {
  const all = WS_STATS_SNAPSHOT.market_stats;
  const pick = ids === undefined ? Object.keys(all) : ids.map(String);
  const market_stats: Record<string, unknown> = {};
  for (const k of pick) market_stats[k] = { ...all[k], ...(over[k] ?? {}) };
  return { channel: "market_stats:all", market_stats, timestamp: 1_790_707_956_000, type: `${kind}/market_stats` };
}

const BTC_ASKS: Lv[] = [
  ["83657.1", "0.00500"],
  ["83660.8", "0.47561"],
  ["83660.9", "0.03865"],
];
const BTC_BIDS: Lv[] = [
  ["83648.5", "0.00003"],
  ["83648.4", "0.00500"],
  ["83647.3", "0.63826"],
];

// ── the live capture ────────────────────────────────────────────────────────

test("replays the live capture: snapshot + 30 deltas chain without a gap, served best-first, matching an independent replay", async () => {
  const f = start([0]);
  await f.clock.advance(1);
  const sock = f.socks.all[0]!;
  sock.frame(WS_FRAMES[0]!); // the venue's own `connected`
  sock.readyState = 1;
  await f.clock.advance(3_000);
  assert.deepEqual(
    subs(f.socks.sent).map((s) => s.msg),
    [
      { type: "subscribe", channel: "market_stats/all" },
      { type: "subscribe", channel: "order_book/0" },
    ],
  );
  for (const frame of WS_FRAMES.slice(1)) sock.frame(frame);
  assert.equal(f.feed.health().gaps, 0, f.logs.join("\n"));
  assert.equal(f.feed.health().syncedBooks, 1);

  // An independent replay: price-string maps, a zero size deletes.
  const ref = { bids: new Map<string, string>(), asks: new Map<string, string>() };
  for (const s of WS_FRAMES) {
    const m = JSON.parse(s) as { type?: string; order_book?: { asks: Array<{ price: string; size: string }>; bids: Array<{ price: string; size: string }> } };
    if (m.type === "subscribed/order_book") {
      ref.bids = new Map(m.order_book!.bids.map((x) => [x.price, x.size]));
      ref.asks = new Map(m.order_book!.asks.map((x) => [x.price, x.size]));
    } else if (m.type === "update/order_book") {
      for (const side of ["bids", "asks"] as const) {
        for (const x of m.order_book![side]) {
          if (Number(x.size) === 0) ref[side].delete(x.price);
          else ref[side].set(x.price, x.size);
        }
      }
    }
  }
  const top = (side: Map<string, string>, desc: boolean) =>
    [...side.entries()]
      .sort((a, b) => (desc ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0])))
      .slice(0, 10)
      .map(([p, s]) => [parseDecimalToScaled(p, 2)!.toString(), parseDecimalToScaled(s, 4)!.toString()]);

  const snap = f.feed.snapshot();
  const eth = snap.markets["0"]!;
  assert.ok(eth, "ETH is in the file");
  assert.deepEqual(eth.bids, top(ref.bids, true));
  assert.deepEqual(eth.asks, top(ref.asks, false));
  assert.equal(eth.bids.length, 10);
  assert.ok(BigInt(eth.bids[0]![0]) < BigInt(eth.asks[0]![0]), "uncrossed");
  assert.equal(eth.bookSource, "ws");
  assert.equal(eth.priceSource, "ws");
  assert.equal(eth.spec.priceDecimals, 2);
  // The mark is the LAST market_stats entry for ETH in the capture, scaled to price decimals.
  let lastMark = "";
  for (const s of WS_FRAMES) {
    const m = JSON.parse(s) as { market_stats?: Record<string, { mark_price: string }> };
    const e = m.market_stats?.["0"];
    if (e) lastMark = e.mark_price;
  }
  assert.equal(eth.mark, parseDecimalToScaled(lastMark, 2)!.toString());
  assert.match(eth.fundingRatePctPerHour ?? "", /^-?\d+\.\d{4}$/);
  // The unsubscribed / pong / error-30005 frames at the end change nothing and throw nothing.
  assert.equal(f.feed.health().wsUp, true);
  // And the reader accepts exactly what the writer produced.
  const read = parseLighterFeed(JSON.parse(JSON.stringify(snap)), f.clock.t);
  assert.ok(read);
  assert.equal(read.markets.get(0)?.fresh, true);
  assert.equal(read.markets.get(0)?.bookFresh, true);
  f.feed.stop();
});

// ── gaps ────────────────────────────────────────────────────────────────────

test("a nonce gap drops the book, re-snapshots, ignores in-flight deltas, and the market returns only with a fresh snapshot", async () => {
  const f = await boot([1]);
  f.sock.frame(statsFrame("subscribed"));
  f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce: 100 }));
  f.sock.frame(bookFrame(1, "update", { asks: [["83657.1", "0.00000"]], bids: [["83649.0", "0.10000"]], begin: 100, nonce: 105 }));
  let m = f.feed.snapshot().markets["1"];
  assert.ok(m);
  assert.deepEqual(m.asks[0], ["836608", "47561"], "the deleted best ask is gone");
  assert.deepEqual(m.bids[0], ["836490", "10000"], "the new best bid is in");

  const before = subs(f.socks.sent).length;
  f.sock.frame(bookFrame(1, "update", { bids: [["83650.0", "1.00000"]], begin: 107, nonce: 110 })); // 105 → 107: a gap
  assert.equal(f.feed.snapshot().markets["1"], undefined, "a gapped book is never served");
  assert.equal(f.feed.health().gaps, 1);
  await f.clock.advance(1_000);
  assert.equal(f.feed.snapshot().markets["1"], undefined);
  // The file written meanwhile does not carry it either.
  assert.equal(readLighterFeed(OUT, f.clock.t)?.markets.has(1), false);
  // A delta still in flight from the old subscription changes nothing.
  f.sock.frame(bookFrame(1, "update", { bids: [["83651.0", "1.00000"]], begin: 110, nonce: 111 }));
  assert.equal(f.feed.snapshot().markets["1"], undefined);
  await f.clock.advance(2_000);
  assert.deepEqual(
    subs(f.socks.sent).slice(before).map((s) => s.msg),
    [
      { type: "unsubscribe", channel: "order_book/1" },
      { type: "subscribe", channel: "order_book/1" },
    ],
  );
  f.sock.frame({ type: "unsubscribed", channel: "order_book:1" });
  f.sock.frame(bookFrame(1, "subscribed", { asks: [["83700.0", "0.20000"]], bids: [["83690.0", "0.30000"]], nonce: 500 }));
  m = f.feed.snapshot().markets["1"];
  assert.ok(m, "back with the fresh snapshot");
  assert.deepEqual(m.bids, [["836900", "30000"]]);
  assert.deepEqual(m.asks, [["837000", "20000"]]);
  // And the chain continues from the NEW nonce.
  f.sock.frame(bookFrame(1, "update", { asks: [["83699.0", "0.10000"]], begin: 500, nonce: 501 }));
  assert.deepEqual(f.feed.snapshot().markets["1"]!.asks[0], ["836990", "10000"]);
  assert.equal(f.feed.health().gaps, 1);
  f.feed.stop();
});

test("a crossed book, an over-precise level, or a snapshot listing a price twice is never served", async () => {
  const f = await boot([1]);
  f.sock.frame(statsFrame("subscribed"));
  // Crossed: best bid above best ask.
  f.sock.frame(bookFrame(1, "subscribed", { asks: [["83600.0", "1.00000"]], bids: [["83610.0", "1.00000"]], nonce: 1 }));
  assert.equal(f.feed.snapshot().markets["1"], undefined);
  assert.equal(f.feed.health().gaps, 1);
  await f.clock.advance(2_000);
  f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce: 10 }));
  assert.ok(f.feed.snapshot().markets["1"]);
  // BTC sizes carry 5 dp; a sixth is not a size this market has.
  f.sock.frame(bookFrame(1, "update", { asks: [["83657.1", "0.000001"]], begin: 10, nonce: 11 }));
  assert.equal(f.feed.snapshot().markets["1"], undefined);
  assert.equal(f.feed.health().gaps, 2);
  await f.clock.advance(2_000);
  // A snapshot with a duplicated price is refused and retried later, not served.
  f.sock.frame(bookFrame(1, "subscribed", { asks: [BTC_ASKS[0]!, BTC_ASKS[0]!], bids: BTC_BIDS, nonce: 20 }));
  assert.equal(f.feed.snapshot().markets["1"], undefined);
  f.feed.stop();
});

test("repeated gaps back off instead of spinning", async () => {
  const f = await boot([1]);
  f.sock.frame(statsFrame("subscribed"));
  let nonce = 1_000;
  for (let i = 0; i < 3; i++) {
    f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce }));
    f.sock.frame(bookFrame(1, "update", { begin: nonce + 7, nonce: nonce + 8 })); // gap
    nonce += 100;
    await f.clock.advance(2_000);
  }
  const at = f.clock.t - 2_000; // the third gap
  const n = subs(f.socks.sent).length;
  await f.clock.advance(LIGHTER_FEED_DEFAULTS.subscribePendingMs - 7_000);
  assert.equal(subs(f.socks.sent).length, n, "the third gap in a minute waits");
  await f.clock.advance(10_000);
  const later = subs(f.socks.sent).slice(n);
  assert.deepEqual(
    later.map((s) => s.msg),
    [
      { type: "unsubscribe", channel: "order_book/1" },
      { type: "subscribe", channel: "order_book/1" },
    ],
  );
  assert.ok(later[0]!.at - at >= LIGHTER_FEED_DEFAULTS.subscribePendingMs);
  f.feed.stop();
});

// ── the socket's life ───────────────────────────────────────────────────────

test("reconnects back off exponentially with jitter up to 60 s, and reset after a healthy connection", async () => {
  const f = start([1], { random: () => 0.5 }, "refuse");
  await f.clock.advance(250_000);
  const at = f.socks.all.map((s) => s.createdAt - T0);
  // First connect: jitter 0.5 × 1 s. Then d/2 + 0.5 × d/2 for d = 2, 4, 8, 16, 32, 60 (capped), 60 s — to the 200 ms heartbeat.
  const want = [1_500, 3_000, 6_000, 12_000, 24_000, 45_000, 45_000];
  const gapsSeen = at.slice(1).map((x, i) => x - at[i]!);
  assert.equal(at[0]! >= 500 && at[0]! <= 700, true, `first connect at ${at[0]}`);
  for (let i = 0; i < want.length; i++) {
    assert.ok(Math.abs(gapsSeen[i]! - want[i]!) <= 200, `backoff ${i}: ${gapsSeen[i]} vs ${want[i]}`);
  }
  f.feed.stop();

  // A connection that stayed up a minute resets the backoff.
  const g = await boot([1], { random: () => 0.5 });
  for (let i = 0; i < 70; i++) {
    g.sock.frame(statsFrame("update", {}, [1]));
    await g.clock.advance(1_000);
  }
  g.sock.kill();
  const t = g.clock.t;
  await g.clock.advance(3_000);
  assert.equal(g.socks.all.length, 2);
  assert.ok(Math.abs(g.socks.all[1]!.createdAt - t - 1_500) <= 200, `reconnect after ${g.socks.all[1]!.createdAt - t} ms`);
  g.feed.stop();
});

test("pings at least every 20 s; a socket silent for 45 s is replaced", async () => {
  const f = await boot([1]);
  f.sock.frame({ type: "pong" }); // the last frame the venue sends
  const t = f.clock.t;
  await f.clock.advance(44_000);
  const pings = f.socks.sent.filter((s) => s.msg.type === "ping");
  assert.equal(pings.length, 2, "one every 20 s");
  assert.ok(pings[1]!.at - pings[0]!.at <= 20_200);
  assert.equal(f.socks.all.length, 1, "still the first socket");
  await f.clock.advance(4_000); // past 45 s of silence, plus the first reconnect delay
  assert.ok(f.socks.all.length >= 2, "the silent socket was replaced");
  assert.equal(f.socks.all[0]!.readyState, 3);
  f.feed.stop();
});

test("answers the venue's ping with a pong", async () => {
  const f = await boot([1]);
  f.sock.frame({ type: "ping" });
  assert.deepEqual(f.socks.sent.at(-1)?.msg, { type: "pong" });
  f.feed.stop();
});

test("subscribe messages are paced ≥ 600 ms apart — ≤ 100 in any minute — and the pacing survives reconnects", async () => {
  const all = Array.from({ length: 57 }, (_, i) => i);
  const f = await boot(all);
  await f.clock.advance(20_000);
  f.sock.kill(); // mid-way through subscribing
  await f.clock.advance(3_000);
  const s2 = f.socks.all[1]!;
  s2.accept();
  await f.clock.advance(90_000);
  const msgs = subs(f.socks.sent);
  assert.ok(msgs.length > 58, `${msgs.length} subscribe messages`);
  for (let i = 1; i < msgs.length; i++) assert.ok(msgs[i]!.at - msgs[i - 1]!.at >= 600, `spacing at ${i}`);
  for (const m of msgs) {
    const inMinute = msgs.filter((x) => x.at >= m.at && x.at < m.at + 60_000).length;
    assert.ok(inMinute <= 100, `${inMinute} in the minute from ${m.at - T0}`);
  }
  // Every market in use got its subscription on the new socket.
  const onS2 = new Set(subs(f.socks.sent, 1).map((s) => s.msg.channel));
  for (const id of all) assert.ok(onS2.has(`order_book/${id}`), `order_book/${id}`);
  assert.ok(onS2.has("market_stats/all"));
  f.feed.stop();
});

test("a change in the markets in use subscribes the new market and unsubscribes the dropped one", async () => {
  let ids = [1];
  const f = await boot(() => ids);
  f.sock.frame(statsFrame("subscribed"));
  f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce: 1 }));
  assert.ok(f.feed.snapshot().markets["1"]);
  const n = subs(f.socks.sent).length;
  ids = [0, 42]; // ETH, and an id that is in the table
  await f.clock.advance(5_000);
  const later = subs(f.socks.sent).slice(n).map((s) => s.msg);
  assert.deepEqual(new Set(later.map((m) => `${m.type} ${m.channel}`)), new Set(["unsubscribe order_book/1", "subscribe order_book/0", "subscribe order_book/42"]));
  assert.equal(f.feed.snapshot().markets["1"], undefined, "a market no longer in use leaves the file");
  // Ids outside the frozen table are ignored, never subscribed.
  ids = [0, 999, -1, 1.5 as number];
  await f.clock.advance(5_000);
  assert.ok(!subs(f.socks.sent).some((s) => s.msg.channel === "order_book/999"));
  f.feed.stop();
});

test("no order_book subscription until orderBookDetails has given the market's decimals", async () => {
  let release: (v: LighterResult<OrderBookDetailsRead>) => void = () => {};
  const f = start([1], {}, "manual", { details: () => new Promise((r) => (release = r)) });
  await f.clock.advance(1);
  f.socks.all[0]!.accept();
  await f.clock.advance(5_000);
  assert.deepEqual(
    subs(f.socks.sent).map((s) => s.msg.channel),
    ["market_stats/all"],
  );
  assert.deepEqual(f.feed.snapshot().markets, {}, "no spec, no market");
  release(ok(DETAILS));
  await f.clock.advance(2_000);
  assert.deepEqual(
    subs(f.socks.sent).map((s) => s.msg.channel),
    ["market_stats/all", "order_book/1"],
  );
  f.feed.stop();
});

test("a market_stats entry whose symbol is not the table's is refused; the orderBookDetails price stands in, stamped as old", async () => {
  const f = await boot([1]);
  f.sock.frame(statsFrame("subscribed", { "1": { symbol: "ETH" } }));
  f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce: 1 }));
  const m = f.feed.snapshot().markets["1"]!;
  assert.equal(m.priceSource, "rest");
  assert.equal(m.mark, DETAILS.markets.get(1)!.markPrice.toString());
  assert.equal(m.observedAt, m.specObservedAt);
  assert.equal(m.fundingRatePctPerHour, undefined, "REST prices carry no funding");
  f.feed.stop();
});

test("no news is news for a bounded time: a quiet book re-snapshots after 2 min and is served frozen meanwhile", async () => {
  const f = await boot([1]);
  f.sock.frame(statsFrame("subscribed"));
  f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce: 1 }));
  const n = subs(f.socks.sent).length;
  // The socket stays busy (stats), the book says nothing.
  for (let i = 0; i < 125; i++) {
    f.sock.frame(statsFrame("update", {}, [1]));
    await f.clock.advance(1_000);
    const m = f.feed.snapshot().markets["1"]!;
    if (i < 100) assert.ok(f.clock.t - m.bookObservedAt <= 1_000, "a synced book on a live socket is current");
  }
  const later = subs(f.socks.sent).slice(n).map((s) => s.msg);
  assert.deepEqual(later, [
    { type: "unsubscribe", channel: "order_book/1" },
    { type: "subscribe", channel: "order_book/1" },
  ]);
  const frozen = f.feed.snapshot().markets["1"]!;
  assert.ok(f.clock.t - frozen.bookObservedAt >= 4_000, "frozen while the re-snapshot is in flight");
  assert.ok(f.clock.t - frozen.observedAt <= 1_000, "prices keep flowing");
  f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce: 900 }));
  assert.equal(f.feed.snapshot().markets["1"]!.bookObservedAt, f.clock.t);
  f.feed.stop();
});

test("a dropped socket's books are held at the moment they were last known current, then age out", async () => {
  const f = await boot([1]);
  f.sock.frame(statsFrame("subscribed"));
  f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce: 1 }));
  const lastFrame = f.clock.t;
  await f.clock.advance(3_000);
  f.sock.kill();
  const m = f.feed.snapshot().markets["1"]!;
  assert.equal(m.bookSource, "ws");
  assert.ok(m.bookObservedAt <= lastFrame + 3_000 && m.bookObservedAt >= lastFrame);
  const read = parseLighterFeed(f.feed.snapshot(), f.clock.t + 20_000);
  assert.equal(read?.staleBooks.has(1), true, "the reader ages it out");
  f.feed.stop();
});

// ── REST ────────────────────────────────────────────────────────────────────

test("orderBookDetails: once at start, then at most once per 5 min; a failure retries after 60 s", async () => {
  const f = await boot([1]);
  await f.clock.advance(11 * 60_000);
  const at = f.api.calls.details.map((t) => t - T0);
  assert.equal(at.length, 3, `calls at ${at.join(", ")}`);
  for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! >= 300_000);
  f.feed.stop();

  let fail = true;
  const g = start([1], {}, "manual", {
    details: () => Promise.resolve(fail ? { ok: false, error: { kind: "unavailable", status: 503, retryable: true, detail: "HTTP 503" }, serverDateMs: null } : ok(DETAILS)),
  });
  await g.clock.advance(59_000);
  assert.equal(g.api.calls.details.length, 1);
  fail = false;
  await g.clock.advance(2_000);
  assert.equal(g.api.calls.details.length, 2, "retried after 60 s");
  g.feed.stop();
});

test("REST depth only while the socket is down: ≤ 20 a minute, levels aggregated from orders, stamped with the ask time", async () => {
  const f = start([1], {}, "refuse");
  await f.clock.advance(4_000);
  assert.equal(f.api.calls.depth.length, 0, "not before the socket has been down 5 s");
  await f.clock.advance(62_000);
  const n = f.api.calls.depth.length;
  assert.ok(n >= 18 && n <= 21, `${n} depth reads in ~62 s`);
  const perMinute = Math.max(...f.api.calls.depth.map((_, i) => f.api.calls.depth.slice(i).length));
  assert.ok(perMinute <= 21);
  const m = f.feed.snapshot().markets["1"]!;
  assert.equal(m.bookSource, "rest");
  assert.equal(m.priceSource, "rest");
  // orderBookOrders.1.json: 20 asks at 19 distinct prices, 20 bids at 18 — aggregated into levels, best first.
  const depth = parseDepth(DEPTH_1, 1, { sizeDecimals: 5, priceDecimals: 1 }, 100)!;
  const agg = (side: DepthRead["bids"]) => {
    const out = new Map<bigint, bigint>();
    for (const o of side) out.set(o.price, (out.get(o.price) ?? 0n) + o.baseAmount);
    return [...out.entries()].slice(0, 10).map(([p, s]) => [p.toString(), s.toString()]);
  };
  assert.deepEqual(m.bids, agg(depth.bids));
  assert.deepEqual(m.asks, agg(depth.asks));
  assert.ok(f.feed.snapshot().markets["1"]!.bookObservedAt <= f.clock.t);
  f.feed.stop();
});

test("a full REST page drops its deepest level, which may continue past the page", async () => {
  const f = start([1], { tuning: { depthOrders: 20 } }, "refuse");
  await f.clock.advance(10_000);
  const m = f.feed.snapshot().markets["1"]!;
  const depth = parseDepth(DEPTH_1, 1, { sizeDecimals: 5, priceDecimals: 1 }, 20)!;
  const distinct = (side: DepthRead["bids"]) => new Set(side.map((o) => o.price)).size;
  assert.equal(m.bids.length, Math.min(10, distinct(depth.bids) - 1));
  f.feed.stop();
});

test("no REST depth while the socket is up", async () => {
  const f = await boot([1]);
  f.sock.frame(statsFrame("subscribed"));
  f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce: 1 }));
  for (let i = 0; i < 30; i++) {
    f.sock.frame(statsFrame("update", {}, [1]));
    await f.clock.advance(1_000);
  }
  assert.equal(f.api.calls.depth.length, 0);
  f.feed.stop();
});

test("the fleet cooldown: no REST at all while it stands (the socket carries on); REST resumes after", async () => {
  publishLighterCooldown(FLEET, T0 + 60_000, "test");
  const f = start([1], {}, "refuse");
  await f.clock.advance(59_000);
  assert.equal(f.api.calls.details.length, 0);
  assert.equal(f.api.calls.depth.length, 0);
  assert.ok(f.socks.all.length >= 1, "WebSocket connects are not REST");
  assert.equal(f.feed.health().cooldownUntil, T0 + 60_000);
  await f.clock.advance(10_000);
  assert.equal(f.api.calls.details.length, 1);
  assert.ok(f.api.calls.depth.length >= 1);
  f.feed.stop();
});

test("a rate-limited answer brakes this feed's REST for as long as the venue said, even with no cooldown file", async () => {
  const f = start([1], {}, "manual", {
    details: () =>
      Promise.resolve({ ok: false, error: { kind: "rate-limited", source: "budget", status: null, retryAfterMs: 90_000, retryable: true, detail: "budget" }, serverDateMs: null }),
  });
  await f.clock.advance(100_000);
  const at = f.api.calls.details.map((t) => t - T0);
  // The 60 s retry would fall inside the 90 s brake; it waits for the brake instead.
  assert.equal(at.length, 2, `calls at ${at.join(", ")}`);
  assert.ok(at[1]! >= 90_000);
  f.feed.stop();
});

// ── the file ────────────────────────────────────────────────────────────────

test("the file is written atomically every 2 s: whole, 0600, no tmp left behind, and the reader takes it", async () => {
  const f = await boot([1]);
  f.sock.frame(statsFrame("subscribed"));
  f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce: 1 }));
  const seen: number[] = [];
  for (let i = 0; i < 10; i++) {
    await f.clock.advance(1_000);
    f.sock.frame(statsFrame("update", {}, [1]));
    const raw = JSON.parse(readFileSync(OUT, "utf8")) as { observedAt: number };
    seen.push(raw.observedAt);
  }
  const distinct = [...new Set(seen)];
  for (let i = 1; i < distinct.length; i++) assert.ok(distinct[i]! - distinct[i - 1]! <= 5_000);
  assert.ok(distinct.length >= 4);
  assert.equal(statSync(OUT).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(path.dirname(OUT)).filter((x) => x.endsWith(".tmp")),
    [],
  );
  const read = readLighterFeed(OUT, f.clock.t);
  assert.ok(read);
  const m = read.markets.get(1)!;
  assert.equal(m.key, "BTC-PERP");
  assert.equal(m.mark, parseDecimalToScaled(String(WS_STATS_SNAPSHOT.market_stats["1"]!.mark_price), 1));
  assert.equal(m.fresh, true);
  assert.equal(m.bookFresh, true);
  assert.deepEqual(m.bids[0], { price: 836485n, baseAmount: 3n });
  // Bigints are strings in the file.
  const file = readFileSync(OUT, "utf8");
  assert.match(file, /"mark":"\d+"/);
  f.feed.stop();
  // After stop nothing more is written.
  const last = statSync(OUT).mtimeMs;
  const content = readFileSync(OUT, "utf8");
  await f.clock.advance(10_000);
  assert.equal(readFileSync(OUT, "utf8"), content);
  assert.equal(statSync(OUT).mtimeMs, last);
});

test("the file exists (empty) before anything is known, so a reader can tell 'nothing yet' from 'no writer'", async () => {
  const f = start([1], {}, "refuse", { details: () => new Promise(() => {}) });
  await f.clock.advance(1);
  assert.ok(existsSync(OUT));
  const read = readLighterFeed(OUT, f.clock.t);
  assert.ok(read);
  assert.equal(read.markets.size, 0);
  f.feed.stop();
});

test("one market the reader would refuse costs that market only: the writer leaves it out and the file stays readable", async () => {
  const f = await boot([0, 1]);
  // A 30-digit BTC mark passes the frame parser; at BTC's 1 dp it is a 31-digit integer the reader refuses.
  f.sock.frame(statsFrame("subscribed", { "1": { mark_price: "999999999999999999999999999999" } }));
  f.sock.frame(bookFrame(0, "subscribed", { asks: [["2695.08", "1.3157"]], bids: [["2694.59", "0.5000"]], nonce: 1 }));
  f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce: 1 }));
  const snap = f.feed.snapshot();
  assert.equal(snap.markets["1"], undefined);
  assert.ok(snap.markets["0"]);
  await f.clock.advance(2_000);
  const read = readLighterFeed(OUT, f.clock.t);
  assert.ok(read, "the file is still readable");
  assert.deepEqual([...read.markets.keys()], [0]);
  f.feed.stop();
});

test("with no market in use the feed contacts Lighter not at all; a market coming into use starts it", async () => {
  let ids: number[] = [];
  const f = start(() => ids);
  await f.clock.advance(30_000);
  assert.equal(f.socks.all.length, 0, "no socket");
  assert.equal(f.api.calls.details.length, 0, "no REST");
  assert.deepEqual(readLighterFeed(OUT, f.clock.t)?.markets.size, 0, "the (empty) file is still written");
  ids = [1];
  await f.clock.advance(3_000);
  assert.equal(f.socks.all.length, 1);
  assert.equal(f.api.calls.details.length, 1);
  f.socks.all[0]!.accept();
  await f.clock.advance(2_000);
  // Back to nothing in use: a brief empty set keeps the socket, a minute of it closes the socket.
  ids = [];
  await f.clock.advance(30_000);
  assert.notEqual(f.socks.all[0]!.readyState, 3);
  await f.clock.advance(35_000);
  assert.equal(f.socks.all[0]!.readyState, 3);
  await f.clock.advance(60_000);
  assert.equal(f.socks.all.length, 1, "and it does not come back while nothing is in use");
  f.feed.stop();
});

// ── configuration ───────────────────────────────────────────────────────────

test("refuses an address-keyed client, a plaintext socket, and tuning looser than the contract", () => {
  const base = () => {
    const clock = new Clock(T0);
    return { marketIds: () => [1], outPath: OUT, home: FLEET, api: fakeApi().api, WebSocketImpl: socketFactory(clock).Ctor, now: clock.now, timers: clock.timers };
  };
  assert.throws(() => startLighterFeed({ ...base(), api: { ...fakeApi().api, budgetKey: "0x8e93b78ef08d5e36da2e2473cd9027f8c286c176" } }), /public/);
  assert.throws(() => startLighterFeed({ ...base(), wsUrl: "ws://api.rh.lighter.xyz/stream" }), /wss/);
  assert.throws(() => startLighterFeed({ ...base(), tuning: { writeIntervalMs: 6_000 } }), /5000/);
  assert.throws(() => startLighterFeed({ ...base(), tuning: { pingIntervalMs: 90_000 } }), /60000/);
  assert.throws(() => startLighterFeed({ ...base(), tuning: { subscribeSpacingMs: 100 } }), /600/);
  assert.throws(() => startLighterFeed({ ...base(), tuning: { detailsIntervalMs: 60_000 } }), /300000/);
  assert.throws(() => startLighterFeed({ ...base(), tuning: { depthSpacingMs: 1_000 } }), /3000/);
});

test("the default socket URL is Lighter's Robinhood stream in read-only mode", async () => {
  const f = start([1]);
  await f.clock.advance(1);
  assert.equal(f.socks.all[0]!.url, "wss://api.rh.lighter.xyz/stream?readonly=true");
  f.feed.stop();
});

test("a marketIds() that throws keeps the previous set, and a throwing logger does not stop the feed", async () => {
  let boom = false;
  const f = await boot(() => {
    if (boom) throw new Error("settings unreadable");
    return [1];
  }, { logger: () => {
    throw new Error("logger down");
  } });
  f.sock.frame(statsFrame("subscribed"));
  f.sock.frame(bookFrame(1, "subscribed", { asks: BTC_ASKS, bids: BTC_BIDS, nonce: 1 }));
  boom = true;
  await f.clock.advance(10_000);
  f.sock.frame(statsFrame("update", {}, [1]));
  assert.ok(f.feed.snapshot().markets["1"], "still following market 1");
  f.feed.stop();
});
