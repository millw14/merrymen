import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { clearLighterCooldown, publishLighterCooldown, type LighterResult } from "./api";
import { startLighterFeed, type FeedSocket, type FeedSocketCtor, type FeedTimers, type LighterFeedApi } from "./feed";
import {
  FEED_CANDLE_GRACE_MS,
  FEED_CANDLE_MS,
  parseLighterFeed,
  readLighterFeed,
  specToJson,
  usableClosedCandles,
  usableFunding8h,
  type FeedCandleJson,
  type LighterFeedFile,
  type LighterFeedFileMarket,
} from "./feed-reader";
import { parseFundings, parseMarkCandles, parseOrderBookDetails, type FundingRow, type MarkCandle } from "./markets";

/**
 * The route's history — closed 4 h mark candles and hourly fundings — through
 * the feed file. The venue is the live capture in fixtures/: the 4 h candles
 * were read with ONE GET on 2026-09-29 21:49:47 UTC (1790718587 s), and its last
 * row is the candle then in progress, which is the case everything here turns
 * on. No network, ever.
 */

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const fixture = (f: string) => readFileSync(path.join(FIXTURES, f), "utf8");
const DETAILS = parseOrderBookDetails(JSON.parse(fixture("orderBookDetails.perp.json")))!;
const BTC = DETAILS.markets.get(1)!;
const CANDLES_RAW = JSON.parse(fixture("markPriceCandles.1.4h.json")) as unknown;
const CANDLES = parseMarkCandles(CANDLES_RAW, BTC.spec.priceDecimals)!;
const FUNDINGS_2 = parseFundings(JSON.parse(fixture("fundings.2.json")))!;
/** The capture moment, ms. */
const CAPTURED = 1_790_718_587_000;

const ROOT = mkdtempSync(path.join(os.tmpdir(), "merrymen-feed-history-"));
const FLEET = path.join(ROOT, "fleet");
const priorFleet = process.env.MERRYMEN_FLEET_HOME;
process.env.MERRYMEN_FLEET_HOME = FLEET;
after(() => {
  if (priorFleet === undefined) delete process.env.MERRYMEN_FLEET_HOME;
  else process.env.MERRYMEN_FLEET_HOME = priorFleet;
  rmSync(ROOT, { recursive: true, force: true });
});
let RUN = 0;
let OUT = "";
beforeEach(() => {
  clearLighterCooldown(FLEET);
  OUT = path.join(ROOT, `run-${++RUN}`, "lighter-feed.json");
});

const candleJson = (c: MarkCandle): FeedCandleJson => ({ t: c.tMs, o: c.open.toString(), h: c.high.toString(), l: c.low.toString(), c: c.close.toString() });
const closedAt = (at: number) => CANDLES.candles.filter((c) => c.tMs + FEED_CANDLE_MS <= at);

function market(over: Partial<LighterFeedFileMarket> = {}, now = CAPTURED): LighterFeedFileMarket {
  return {
    observedAt: now - 1_000,
    priceSource: "ws",
    mark: BTC.markPrice.toString(),
    index: BTC.indexPrice.toString(),
    status: BTC.spec.status,
    spec: specToJson(BTC.spec),
    specObservedAt: now - 60_000,
    takerFeePpm: BTC.takerFeePpm,
    makerFeePpm: BTC.makerFeePpm,
    bids: [["836485", "3"]],
    asks: [["836571", "500"]],
    bookObservedAt: now - 1_000,
    bookSource: "ws",
    ...over,
  };
}
function file(m: LighterFeedFileMarket, now = CAPTURED): LighterFeedFile {
  return { v: 1, observedAt: now - 500, markets: { "1": m } };
}

// ── the capture itself ──────────────────────────────────────────────────────

test("the live 4h capture: 150 candles on the grid, the LAST one still in progress when it was read", () => {
  assert.equal(CANDLES.resolution, "4h");
  assert.equal(CANDLES.candles.length, 150);
  const last = CANDLES.candles[149]!;
  assert.equal(last.tMs, 1_790_712_000_000);
  assert.ok(last.tMs + FEED_CANDLE_MS > CAPTURED, "the venue returns the candle in progress last");
  for (let i = 1; i < 150; i++) assert.equal(CANDLES.candles[i]!.tMs - CANDLES.candles[i - 1]!.tMs, FEED_CANDLE_MS);
  // Extra field `sc` (sample count) is ignored by the parser, not refused.
  assert.match(fixture("markPriceCandles.1.4h.json"), /"sc":/);
});

// ── the reader ──────────────────────────────────────────────────────────────

test("reader: closed candles from the file become venue integers — 149 contiguous, the last CLOSED one last", () => {
  const rows = closedAt(CAPTURED).map(candleJson);
  const r = parseLighterFeed(file(market({ closed4h: rows, candlesObservedAt: CAPTURED - 5_000 })), CAPTURED);
  assert.ok(r);
  const c = r.markets.get(1)!.closed4h;
  assert.ok(c);
  assert.equal(c.length, 149);
  assert.equal(c[c.length - 1]!.t, 1_790_697_600_000);
  assert.equal(c[0]!.c, BigInt(rows[0]!.c));
  assert.equal(typeof c[0]!.o, "bigint");
});

test("reader: no history in the file is null — unread, not an empty market", () => {
  const r = parseLighterFeed(file(market()), CAPTURED)!;
  assert.equal(r.markets.get(1)!.closed4h, null);
  assert.equal(r.markets.get(1)!.funding8h, null);
});

test("reader: fewer than 100 contiguous closed candles is null; a gap cuts the run to what follows it", () => {
  const all = closedAt(CAPTURED).map(candleJson);
  const short = all.slice(-99);
  assert.equal(parseLighterFeed(file(market({ closed4h: short, candlesObservedAt: CAPTURED - 5_000 })), CAPTURED)!.markets.get(1)!.closed4h, null);

  // A gap 120 candles from the end: the run after it is 120 long, and only that is handed out.
  const gapped = [...all.slice(0, all.length - 121), ...all.slice(all.length - 120)];
  const r1 = parseLighterFeed(file(market({ closed4h: gapped, candlesObservedAt: CAPTURED - 5_000 })), CAPTURED)!;
  assert.equal(r1.markets.get(1)!.closed4h!.length, 120);

  // A gap 60 from the end leaves 60: null, however long the history before it.
  const gapped2 = [...all.slice(0, all.length - 61), ...all.slice(all.length - 60)];
  assert.equal(parseLighterFeed(file(market({ closed4h: gapped2, candlesObservedAt: CAPTURED - 5_000 })), CAPTURED)!.markets.get(1)!.closed4h, null);
});

test("reader: a history the writer stopped refreshing goes null once the NEXT candle has closed past the grace", () => {
  const rows = closedAt(CAPTURED).map(candleJson);
  const last = rows[rows.length - 1]!.t;
  const limit = last + 2 * FEED_CANDLE_MS + FEED_CANDLE_GRACE_MS;
  const f = file(market({ closed4h: rows, candlesObservedAt: CAPTURED - 5_000 }, limit - 1), limit - 1);
  assert.ok(parseLighterFeed(f, limit - 1)!.markets.get(1)!.closed4h, "still current a moment before the limit");
  const g = file(market({ closed4h: rows, candlesObservedAt: CAPTURED - 5_000 }, limit), limit);
  assert.equal(parseLighterFeed(g, limit)!.markets.get(1)!.closed4h, null);
});

test("usableClosedCandles drops the candle in progress at ITS clock, whatever it is handed", () => {
  const all = CANDLES.candles.map((c) => ({ t: c.tMs }));
  const r = usableClosedCandles(all, CAPTURED)!;
  assert.equal(r.length, 149);
  assert.ok(r.every((c) => c.t + FEED_CANDLE_MS <= CAPTURED));
  // One ms after the in-progress candle closes, it counts.
  assert.equal(usableClosedCandles(all, 1_790_712_000_000 + FEED_CANDLE_MS)!.length, 150);
  assert.equal(usableClosedCandles(null, CAPTURED), null);
  assert.equal(usableClosedCandles([], CAPTURED), null);
});

test("reader: present-and-wrong history refuses the whole file, like any other field", () => {
  const rows = closedAt(CAPTURED).map(candleJson);
  const cases: Array<[string, Partial<LighterFeedFileMarket>]> = [
    ["rows without a time", { closed4h: rows }],
    ["a time without rows", { candlesObservedAt: CAPTURED - 5_000 }],
    ["off the 4h grid", { closed4h: [...rows.slice(0, -1), { ...rows[rows.length - 1]!, t: rows[rows.length - 1]!.t + 1 }], candlesObservedAt: CAPTURED - 5_000 }],
    ["out of order", { closed4h: [rows[1]!, rows[0]!, ...rows.slice(2)], candlesObservedAt: CAPTURED - 5_000 }],
    ["a candle that had not closed when read", { closed4h: rows, candlesObservedAt: rows[rows.length - 1]!.t + FEED_CANDLE_MS - 1 }],
    ["high under close", { closed4h: [{ ...rows[0]!, h: "1" }, ...rows.slice(1)], candlesObservedAt: CAPTURED - 5_000 }],
    ["a float", { closed4h: [{ ...rows[0]!, c: "79544.5" }, ...rows.slice(1)], candlesObservedAt: CAPTURED - 5_000 }],
    ["newer than the file", { closed4h: rows, candlesObservedAt: CAPTURED }],
    ["a funding with no time", { fundings1h: [{ t: 1_790_697_600, rate: "0.0012", direction: "long" }] }],
    ["a funding off the hour", { fundings1h: [{ t: 1_790_697_601, rate: "0.0012", direction: "long" }], fundingsObservedAt: CAPTURED - 5_000 }],
    ["a funding with no direction", { fundings1h: [{ t: 1_790_697_600, rate: "0.0012", direction: "up" as "long" }], fundingsObservedAt: CAPTURED - 5_000 }],
  ];
  for (const [what, over] of cases) {
    assert.equal(parseLighterFeed(file(market(over)), CAPTURED), null, what);
  }
});

test("reader: the last eight hourly fundings, signed so that positive means longs pay", () => {
  const rows = FUNDINGS_2.fundings;
  const lastAt = rows[rows.length - 1]!.timestampSec;
  const now = (lastAt + 600) * 1000;
  const json = rows.map((f) => ({ t: f.timestampSec, rate: pct4(f.ratePpm), direction: f.direction }));
  const r = parseLighterFeed(file(market({ fundings1h: json, fundingsObservedAt: now - 5_000 }, now), now), now)!;
  const f = r.markets.get(1)!.funding8h!;
  assert.equal(f.length, 8);
  assert.equal(f[7]!.atSec, lastAt);
  const want = rows.slice(-8).map((x) => (x.direction === "long" ? x.ratePpm : -x.ratePpm));
  assert.deepEqual(
    f.map((x) => x.ppmPerHour),
    want,
  );
});

test("usableFunding8h: fewer than eight, a skipped hour, a stale latest, or a NEGATIVE venue rate is unread", () => {
  const row = (atSec: number, ratePpm: number, direction: "long" | "short" = "long") => ({ atSec, ratePpm, direction });
  const H = 1_790_697_600;
  const eight = Array.from({ length: 8 }, (_, i) => row(H - (7 - i) * 3600, 10));
  const now = (H + 600) * 1000;
  assert.deepEqual(usableFunding8h(eight, now)!.map((x) => x.ppmPerHour), Array(8).fill(10));
  assert.equal(usableFunding8h(eight.slice(1), now), null, "seven");
  const gap = [...eight.slice(0, 7), row(H + 3600, 10)];
  assert.equal(usableFunding8h(gap, (H + 3600 + 60) * 1000), null, "a skipped hour");
  assert.equal(usableFunding8h(eight, (H + 2 * 3600 + 15 * 60) * 1000), null, "stale");
  assert.ok(usableFunding8h(eight, (H + 2 * 3600 + 15 * 60 - 1) * 1000), "just current");
  const neg = [...eight.slice(0, 7), row(H, -5)];
  assert.equal(usableFunding8h(neg, now), null, "a negative rate's sign is unobserved");
  const short = [...eight.slice(0, 7), row(H, 30, "short")];
  assert.equal(usableFunding8h(short, now)![7]!.ppmPerHour, -30, "shorts pay → negative");
});

function pct4(ppm: number): string {
  const a = Math.abs(ppm);
  return `${ppm < 0 ? "-" : ""}${Math.floor(a / 10_000)}.${String(a % 10_000).padStart(4, "0")}`;
}

// ── the writer ──────────────────────────────────────────────────────────────

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

/** A socket that opens and says `connected`, and lets the test play the venue. */
function sockets() {
  const all: Array<FeedSocket & { frame(x: unknown): void; accept(): void }> = [];
  class S implements FeedSocket {
    readyState = 0;
    onopen: FeedSocket["onopen"] = null;
    onmessage: FeedSocket["onmessage"] = null;
    onclose: FeedSocket["onclose"] = null;
    onerror: FeedSocket["onerror"] = null;
    constructor(readonly url: string) {
      all.push(this);
    }
    send() {}
    close() {
      this.readyState = 3;
    }
    accept() {
      this.readyState = 1;
      this.frame({ type: "connected" });
    }
    frame(x: unknown) {
      this.onmessage?.({ data: JSON.stringify(x) });
    }
  }
  return { Ctor: S as unknown as FeedSocketCtor, all };
}

const WS_FRAMES = fixture("ws.stream.0.jsonl").trim().split("\n");
const WS_STATS = JSON.parse(WS_FRAMES.find((s) => s.includes('"type":"subscribed/market_stats"'))!) as { market_stats: Record<string, unknown> };

type CandleArgs = Parameters<NonNullable<LighterFeedApi["markPriceCandles"]>>[0];
type FundingArgs = Parameters<NonNullable<LighterFeedApi["fundings"]>>[0];

function api(opts: { candles?: (a: CandleArgs, at: number) => LighterResult<{ resolution: string; candles: MarkCandle[] }>; history?: boolean } = {}) {
  const calls = { candles: [] as Array<{ at: number; args: CandleArgs }>, fundings: [] as Array<{ at: number; args: FundingArgs }>, depth: 0 };
  let clock: Clock | null = null;
  const ok = <T,>(value: T): LighterResult<T> => ({ ok: true, value, serverDateMs: null });
  const a: LighterFeedApi = {
    budgetKey: "public",
    orderBookDetails: () => Promise.resolve(ok(DETAILS)),
    orderBookOrders: () => {
      calls.depth++;
      return Promise.resolve({ ok: false, error: { kind: "unavailable", status: null, retryable: true, detail: "test" }, serverDateMs: null });
    },
  };
  if (opts.history !== false) {
    a.markPriceCandles = (args) => {
      const at = clock!.t;
      calls.candles.push({ at, args });
      if (opts.candles) return Promise.resolve(opts.candles(args, at));
      // The venue: every candle up to and INCLUDING the one in progress at `at`.
      return Promise.resolve(ok({ resolution: "4h", candles: CANDLES.candles.filter((c) => c.tMs <= at) }));
    };
    a.fundings = (args) => {
      const at = clock!.t;
      calls.fundings.push({ at, args });
      // The captured hours, moved so the latest is the hour that just began at `at`.
      const src = FUNDINGS_2.fundings;
      const shift = Math.floor(at / 3_600_000) * 3600 - src[src.length - 1]!.timestampSec;
      const rows: FundingRow[] = src.map((x) => ({ ...x, timestampSec: x.timestampSec + shift }));
      return Promise.resolve(ok({ resolution: "1h", fundings: rows }));
    };
  }
  return { api: a, calls, bind: (c: Clock) => (clock = c) };
}

async function boot(ids: number[], at: number, apiOpts: Parameters<typeof api>[0] = {}) {
  const clock = new Clock(at);
  const socks = sockets();
  const fa = api(apiOpts);
  fa.bind(clock);
  const logs: string[] = [];
  const feed = startLighterFeed({
    marketIds: () => ids,
    outPath: OUT,
    home: FLEET,
    api: fa.api,
    WebSocketImpl: socks.Ctor,
    now: clock.now,
    timers: clock.timers,
    random: () => 0,
    logger: (l) => logs.push(l),
  });
  await clock.advance(1_100);
  const sock = socks.all[0]!;
  sock.accept();
  await clock.advance(2_000);
  sock.frame({ ...WS_STATS, type: "subscribed/market_stats", channel: "market_stats:all" });
  for (const id of ids) {
    sock.frame({
      channel: `order_book:${id}`,
      order_book: { code: 0, asks: [{ price: "83657.1", size: "0.00500" }], bids: [{ price: "83648.5", size: "0.00003" }], nonce: 1, begin_nonce: 0 },
      type: "subscribed/order_book",
    });
  }
  await clock.advance(3_000);
  return { feed, clock, calls: fa.calls, logs, sock };
}

test("writer: the capture moment — the candle in progress is dropped, 149 closed candles go into the file, stamped with the ask", async () => {
  const f = await boot([1], CAPTURED);
  assert.equal(f.calls.candles.length, 1);
  const { args, at } = f.calls.candles[0]!;
  assert.equal(args.resolution, "4h");
  assert.equal(args.countBack, 150);
  assert.equal(args.marketId, 1);
  assert.equal(args.endSec, Math.floor(at / 1000));
  assert.equal(args.startSec, args.endSec - 150 * 14_400, "start/end in SECONDS, both sent");
  assert.equal(args.priceDecimals, BTC.spec.priceDecimals);

  const snap = f.feed.snapshot();
  const m = snap.markets["1"]!;
  assert.ok(m.closed4h, "history written");
  assert.equal(m.closed4h.length, 149);
  assert.equal(m.candlesObservedAt, at);
  assert.ok(m.closed4h.every((c) => c.t + FEED_CANDLE_MS <= at));
  assert.equal(m.closed4h[m.closed4h.length - 1]!.t, 1_790_697_600_000);
  assert.deepEqual(m.closed4h[0], candleJson(CANDLES.candles[0]!));

  // And the reader takes exactly what the writer wrote, from disk.
  await f.clock.advance(2_000);
  const r = readLighterFeed(OUT, f.clock.t)!;
  assert.equal(r.markets.get(1)!.closed4h!.length, 149);
  assert.equal(r.markets.get(1)!.funding8h!.length, 8);
  f.feed.stop();
});

test("writer: at most one candle read per 4h close, at the close + 60 s — never between", async () => {
  const f = await boot([1], CAPTURED);
  const first = f.calls.candles.length;
  const nextClose = (Math.floor(CAPTURED / FEED_CANDLE_MS) + 1) * FEED_CANDLE_MS;
  await f.clock.advance(nextClose + 59_000 - f.clock.t);
  assert.equal(f.calls.candles.length, first, "nothing before close + 60 s");
  // The read takes the next REST pacing slot (depthSpacingMs, shared with the
  // depth fallback this socketless test runs), so it lands within 3 s of due.
  await f.clock.advance(5_000);
  assert.equal(f.calls.candles.length, first + 1, "one read just after close + 60 s (within the REST pacing slot)");
  const snap = f.feed.snapshot().markets["1"]!;
  assert.equal(snap.closed4h![snap.closed4h!.length - 1]!.t, nextClose - FEED_CANDLE_MS, "the candle that just closed is now the last");
  f.feed.stop();
});

test("writer: only the route's universe markets in use get history, and a client without the reads gets none", async () => {
  const f = await boot([16, 1], CAPTURED); // TSLA-PERP and BTC-PERP
  assert.deepEqual(new Set(f.calls.candles.map((c) => c.args.marketId)), new Set([1]));
  assert.ok(f.feed.snapshot().markets["1"]!.closed4h);
  f.feed.stop();

  const g = await boot([1], CAPTURED, { history: false });
  assert.equal(g.feed.snapshot().markets["1"]!.closed4h, undefined);
  g.feed.stop();
});

test("writer: while the fleet cooldown stands, no history is asked for", async () => {
  publishLighterCooldown(FLEET, CAPTURED + 120_000, "test");
  const f = await boot([1], CAPTURED);
  assert.equal(f.calls.candles.length, 0);
  assert.equal(f.calls.fundings.length, 0);
  await f.clock.advance(120_000);
  assert.equal(f.calls.candles.length, 1, "asked once the cooldown lifts");
  f.feed.stop();
});

test("writer: an answer missing the candle that just closed is asked again each minute for 15 min, then left until the next close", async () => {
  // The venue lags: it serves everything up to (not including) the candle that just closed.
  const lagging = (_a: CandleArgs, at: number) => {
    const periodStart = Math.floor(at / FEED_CANDLE_MS) * FEED_CANDLE_MS;
    return { ok: true as const, value: { resolution: "4h", candles: CANDLES.candles.filter((c) => c.tMs < periodStart - FEED_CANDLE_MS) }, serverDateMs: null };
  };
  const periodStart = Math.floor(CAPTURED / FEED_CANDLE_MS) * FEED_CANDLE_MS;
  const f = await boot([1], periodStart + 120_000, { candles: lagging });
  assert.equal(f.calls.candles.length, 1);
  await f.clock.advance(61_000);
  assert.equal(f.calls.candles.length, 2, "re-asked after a minute");
  await f.clock.advance(periodStart + 16 * 60_000 - f.clock.t);
  const settled = f.calls.candles.length;
  assert.ok(settled <= 16, `about one a minute inside the window, got ${settled}`);
  await f.clock.advance(60 * 60_000);
  assert.equal(f.calls.candles.length, settled, "past the lag window it waits for the next close");
  f.feed.stop();
});

test("writer: a failed read retries no sooner than a minute, and the market keeps its prices and book meanwhile", async () => {
  const failing = (): LighterResult<{ resolution: string; candles: MarkCandle[] }> => ({
    ok: false,
    error: { kind: "unavailable", status: 503, retryable: true, detail: "test" },
    serverDateMs: null,
  });
  const f = await boot([1], CAPTURED, { candles: failing });
  assert.equal(f.calls.candles.length, 1);
  assert.ok(f.feed.snapshot().markets["1"], "the market is still in the file");
  assert.equal(f.feed.snapshot().markets["1"]!.closed4h, undefined);
  const firstAt = f.calls.candles[0]!.at;
  await f.clock.advance(firstAt + 59_000 - f.clock.t);
  assert.equal(f.calls.candles.length, 1);
  await f.clock.advance(3_000);
  assert.equal(f.calls.candles.length, 2);
  f.feed.stop();
});

test("writer: fundings are read once an hour, after the hour", async () => {
  const f = await boot([1], CAPTURED);
  assert.equal(f.calls.fundings.length, 1);
  const a = f.calls.fundings[0]!.args;
  assert.equal(a.resolution, "1h");
  assert.equal(a.endSec - a.startSec, 12 * 3600);
  const nextHour = (Math.floor(CAPTURED / 3_600_000) + 1) * 3_600_000;
  await f.clock.advance(nextHour + 85_000 - f.clock.t);
  assert.equal(f.calls.fundings.length, 1);
  await f.clock.advance(10_000);
  assert.equal(f.calls.fundings.length, 2);
  const m = f.feed.snapshot().markets["1"]!;
  assert.ok(m.fundings1h && m.fundings1h.length > 0);
  assert.match(m.fundings1h[0]!.rate, /^-?\d+\.\d{4}$/);
  f.feed.stop();
});
