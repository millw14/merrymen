import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  FEED_BOOK_LEVELS,
  LIGHTER_FEED_FILE,
  feedBookForPaperFill,
  feedMarketForOpen,
  lighterFeedPath,
  parseLighterFeed,
  readLighterFeed,
  specToJson,
  type LighterFeedFile,
  type LighterFeedFileMarket,
} from "./feed-reader";
import { parseOrderBookDetails } from "./markets";

/**
 * The reader never touches the network and never throws: every case below is
 * either a parsed feed with freshness judged, or null. The spec values come
 * from the live orderBookDetails capture, through the same parser feed.ts
 * uses, so the round trip is the real one.
 */

const DETAILS = parseOrderBookDetails(JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "orderBookDetails.perp.json"), "utf8")))!;
const BTC = DETAILS.markets.get(1)!;
const ETH = DETAILS.markets.get(0)!;

const ROOT = mkdtempSync(path.join(os.tmpdir(), "merrymen-lighter-feed-reader-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const NOW = 1_790_707_956_000;

function market(over: Partial<LighterFeedFileMarket> = {}, view = BTC): LighterFeedFileMarket {
  return {
    observedAt: NOW - 1_000,
    priceSource: "ws",
    mark: view.markPrice.toString(),
    index: view.indexPrice.toString(),
    fundingRatePctPerHour: "0.0012",
    lastFundingRatePctPerHour: "-0.0005",
    lastFundingAt: NOW - 3_000_000,
    status: view.spec.status,
    spec: specToJson(view.spec),
    specObservedAt: NOW - 60_000,
    takerFeePpm: view.takerFeePpm,
    makerFeePpm: view.makerFeePpm,
    bids: [
      ["836485", "3"],
      ["836484", "500"],
    ],
    asks: [
      ["836571", "500"],
      ["836608", "47561"],
    ],
    bookObservedAt: NOW - 1_000,
    bookSource: "ws",
    ...over,
  };
}

function file(markets: Record<string, LighterFeedFileMarket> = { "1": market() }, over: Partial<LighterFeedFile> = {}): LighterFeedFile {
  return { v: 1, observedAt: NOW - 500, markets, ...over };
}

/** A deep copy with one edit, for the refusal table. */
function edit(f: (m: Record<string, unknown>) => void, base: LighterFeedFile = file()): unknown {
  const copy = JSON.parse(JSON.stringify(base)) as { markets: Record<string, Record<string, unknown>> };
  f(copy.markets["1"]!);
  return copy;
}

test("a fresh feed parses to venue integers, the spec round-trips, and both helpers hand it out", () => {
  const r = parseLighterFeed(file({ "1": market(), "0": market({}, ETH) }), NOW);
  assert.ok(r);
  assert.equal(r.observedAt, NOW - 500);
  assert.equal(r.markets.size, 2);
  const m = r.markets.get(1)!;
  assert.equal(m.key, "BTC-PERP");
  assert.equal(m.symbol, "BTC");
  assert.equal(m.mark, BTC.markPrice);
  assert.equal(m.index, BTC.indexPrice);
  assert.deepEqual(m.spec, BTC.spec, "specToJson → parse is the identity");
  assert.equal(m.status, "active");
  assert.equal(m.fundingRatePpm, 12, '"0.0012" percent per hour is 12 ppm');
  assert.deepEqual(m.lastFunding, { ratePpm: -5, atMs: NOW - 3_000_000 });
  assert.deepEqual(m.bids, [
    { price: 836485n, baseAmount: 3n },
    { price: 836484n, baseAmount: 500n },
  ]);
  assert.equal(m.fresh, true);
  assert.equal(m.bookFresh, true);
  assert.equal(r.stale.size, 0);
  assert.equal(r.staleBooks.size, 0);
  assert.equal(feedMarketForOpen(r, 1), m);
  assert.deepEqual(feedBookForPaperFill(r, 1), { bids: m.bids, asks: m.asks, bookObservedAt: m.bookObservedAt, spec: m.spec });
  // A market the feed does not carry is unread, not "no price".
  assert.equal(feedMarketForOpen(r, 3), null);
  assert.equal(feedBookForPaperFill(r, 3), null);
  assert.equal(feedMarketForOpen(null, 1), null);
});

test("prices older than 30 s are unread for opens; a book older than 10 s is not one a paper fill may walk", () => {
  const r = parseLighterFeed(
    file({
      "1": market({ observedAt: NOW - 31_000, bookObservedAt: NOW - 2_000 }),
      "0": market({ observedAt: NOW - 2_000, bookObservedAt: NOW - 11_000 }, ETH),
    }),
    NOW,
  );
  assert.ok(r);
  assert.deepEqual([...r.stale], [1]);
  assert.deepEqual([...r.staleBooks], [0]);
  assert.equal(r.markets.get(1)!.fresh, false, "still listed, for display — but flagged");
  assert.equal(feedMarketForOpen(r, 1), null);
  assert.ok(feedBookForPaperFill(r, 1), "a paper EXIT can still fill against a fresh book while prices are stale for opens");
  assert.ok(feedMarketForOpen(r, 0));
  assert.equal(feedBookForPaperFill(r, 0), null);
  // Exactly at the edge is still fresh.
  const edge = parseLighterFeed(file({ "1": market({ observedAt: NOW - 30_000, bookObservedAt: NOW - 10_000 }) }), NOW)!;
  assert.equal(edge.stale.size + edge.staleBooks.size, 0);
});

test("a spec older than 15 min makes the market unread for opens (it may be missing a status change)", () => {
  const r = parseLighterFeed(file({ "1": market({ specObservedAt: NOW - 901_000 }) }), NOW)!;
  assert.deepEqual([...r.stale], [1]);
});

test("options can only tighten the contract's limits", () => {
  const f = file({ "1": market({ observedAt: NOW - 31_000, bookObservedAt: NOW - 11_000 }) });
  const loose = parseLighterFeed(f, NOW, { maxAgeOpenSec: 600, maxBookAgeSec: 600, maxSpecAgeSec: 1e9 })!;
  assert.deepEqual([...loose.stale], [1], "60 s asked, 30 s applied");
  assert.deepEqual([...loose.staleBooks], [1]);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = parseLighterFeed(f, NOW, { maxAgeOpenSec: bad, maxBookAgeSec: bad })!;
    assert.deepEqual([...r.stale], [1], `maxAgeOpenSec ${bad}`);
  }
  const tight = parseLighterFeed(file({ "1": market({ observedAt: NOW - 6_000, bookObservedAt: NOW - 3_000 }) }), NOW, { maxAgeOpenSec: 5, maxBookAgeSec: 2 })!;
  assert.deepEqual([...tight.stale], [1]);
  assert.deepEqual([...tight.staleBooks], [1]);
});

test("an empty file (writer up, nothing known yet) is a feed with no markets — not null", () => {
  const r = parseLighterFeed(file({}), NOW);
  assert.ok(r);
  assert.equal(r.markets.size, 0);
  assert.equal(feedMarketForOpen(r, 1), null);
});

test("anything wrong with any market makes the whole file null", () => {
  const refusals: Array<[string, (m: Record<string, unknown>) => void]> = [
    ["mark with a leading zero", (m) => (m.mark = "0836485")],
    ["mark as a number", (m) => (m.mark = 836485)],
    ["negative index", (m) => (m.index = "-5")],
    ["zero mark", (m) => (m.mark = "0")],
    ["fractional mark", (m) => (m.mark = "83648.5")],
    ["unknown price source", (m) => (m.priceSource = "cache")],
    ["unknown book source", (m) => (m.bookSource = "")],
    ["observedAt newer than the file", (m) => (m.observedAt = NOW)],
    ["bookObservedAt newer than the file", (m) => (m.bookObservedAt = NOW)],
    ["specObservedAt newer than the file", (m) => (m.specObservedAt = NOW)],
    ["lastFundingAt newer than the file", (m) => (m.lastFundingAt = NOW)],
    ["observedAt not an integer", (m) => (m.observedAt = NOW - 1_000.5)],
    ["status disagreeing with the spec", (m) => (m.status = "inactive")],
    ["unknown status", (m) => ((m.spec as Record<string, unknown>).status = "halted")],
    ["spec for another market", (m) => ((m.spec as Record<string, unknown>).marketId = 0)],
    ["margin fractions out of order", (m) => ((m.spec as Record<string, unknown>).mmfBp = 5_000)],
    ["decimals out of range", (m) => ((m.spec as Record<string, unknown>).priceDecimals = 19)],
    ["minimum base as a number", (m) => ((m.spec as Record<string, unknown>).minBaseAmount = 20)],
    ["negative fee", (m) => (m.takerFeePpm = -1)],
    ["funding with 5 dp", (m) => (m.fundingRatePctPerHour = "0.00012")],
    ["funding as a number", (m) => (m.fundingRatePctPerHour = 0.0012)],
    ["a last funding rate without its time", (m) => delete m.lastFundingAt],
    ["a last funding time without its rate", (m) => delete m.lastFundingRatePctPerHour],
    ["a crossed book", (m) => (m.asks = [["836485", "1"]])],
    ["bids ascending", (m) => (m.bids = [["836484", "1"], ["836485", "1"]])],
    ["a bid level twice", (m) => (m.bids = [["836485", "1"], ["836485", "1"]])],
    ["asks descending", (m) => (m.asks = [["836608", "1"], ["836571", "1"]])],
    ["a zero size", (m) => (m.asks = [["836571", "0"]])],
    ["a level of three", (m) => (m.asks = [["836571", "1", "x"]])],
    ["more levels than the file carries", (m) => (m.bids = Array.from({ length: FEED_BOOK_LEVELS + 1 }, (_, i) => [String(836485 - i), "1"]))],
    ["no book at all", (m) => delete m.bids],
    ["no mark", (m) => delete m.mark],
  ];
  for (const [what, f] of refusals) assert.equal(parseLighterFeed(edit(f), NOW), null, what);
});

test("the envelope: version, key, time and shape are all checked", () => {
  const good = file();
  assert.ok(parseLighterFeed(good, NOW));
  const cases: Array<[string, unknown]> = [
    ["version 2", { ...good, v: 2 }],
    ["no version", { observedAt: good.observedAt, markets: good.markets }],
    ["markets as an array", { ...good, markets: [market()] }],
    ["a file from the future", { ...good, observedAt: NOW + 6_000 }],
    ["observedAt as a string", { ...good, observedAt: String(NOW) }],
    ["a market keyed by symbol", { ...good, markets: { BTC: market() } }],
    ["a market id outside LIGHTER_MARKETS_V1", { ...good, markets: { "999": market() } }],
    ["a key with a leading zero", { ...good, markets: { "01": market() } }],
    ["null", null],
    ["an array", [good]],
    ["a number", 42],
  ];
  for (const [what, raw] of cases) assert.equal(parseLighterFeed(raw, NOW), null, what);
  assert.equal(parseLighterFeed(good, Number.NaN), null, "an unusable clock reads nothing");
  // Within the skew a file a moment "ahead" (rename vs read) is fine.
  assert.ok(parseLighterFeed({ ...good, observedAt: NOW + 4_000 }, NOW));
});

test("readLighterFeed: missing, half-written, garbled, oversized or unreadable files are null, never a throw", () => {
  const dir = mkdtempSync(path.join(ROOT, "read-"));
  const f = path.join(dir, LIGHTER_FEED_FILE);
  assert.equal(readLighterFeed(f, NOW), null, "missing");
  const whole = JSON.stringify(file());
  writeFileSync(f, whole);
  assert.ok(readLighterFeed(f, NOW), "whole");
  writeFileSync(f, whole.slice(0, Math.floor(whole.length / 2)));
  assert.equal(readLighterFeed(f, NOW), null, "half-written");
  writeFileSync(f, "\u0000\u0001garbage");
  assert.equal(readLighterFeed(f, NOW), null, "garbled");
  writeFileSync(f, "");
  assert.equal(readLighterFeed(f, NOW), null, "empty");
  writeFileSync(f, " ".repeat(2_000_001));
  assert.equal(readLighterFeed(f, NOW), null, "oversized");
  assert.equal(readLighterFeed(dir, NOW), null, "a directory");
});

test("the reader makes no network call: with fetch and WebSocket booby-trapped it still reads", () => {
  const dir = mkdtempSync(path.join(ROOT, "net-"));
  const f = path.join(dir, LIGHTER_FEED_FILE);
  writeFileSync(f, JSON.stringify(file()));
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { fetch: g.fetch, WebSocket: g.WebSocket };
  let touched = 0;
  g.fetch = () => {
    touched++;
    throw new Error("network");
  };
  g.WebSocket = function () {
    touched++;
    throw new Error("network");
  };
  try {
    assert.ok(readLighterFeed(f, NOW));
    assert.equal(readLighterFeed(path.join(dir, "absent.json"), NOW), null);
    assert.equal(parseLighterFeed(file({ "1": market({ observedAt: NOW - 60_000 }) }), NOW)?.stale.has(1), true, "stale is stale — no fallback to asking the venue");
  } finally {
    g.fetch = saved.fetch;
    g.WebSocket = saved.WebSocket;
  }
  assert.equal(touched, 0);
});

test("lighterFeedPath: the fleet home when the orchestrator set one, else the process's own", () => {
  const prior = process.env.MERRYMEN_FLEET_HOME;
  try {
    process.env.MERRYMEN_FLEET_HOME = "/srv/fleet";
    assert.equal(lighterFeedPath("/srv/fleet/children/t1"), path.join("/srv/fleet", "lighter-feed.json"));
    process.env.MERRYMEN_FLEET_HOME = "  ";
    assert.equal(lighterFeedPath("/home/me/.merrymen"), path.join("/home/me/.merrymen", "lighter-feed.json"));
    delete process.env.MERRYMEN_FLEET_HOME;
    assert.equal(lighterFeedPath("/home/me/.merrymen"), path.join("/home/me/.merrymen", "lighter-feed.json"));
  } finally {
    if (prior === undefined) delete process.env.MERRYMEN_FLEET_HOME;
    else process.env.MERRYMEN_FLEET_HOME = prior;
  }
});

test("optional funding: absent is unknown (null), never zero", () => {
  const m = market();
  delete m.fundingRatePctPerHour;
  delete m.lastFundingRatePctPerHour;
  delete m.lastFundingAt;
  const r = parseLighterFeed(file({ "1": m }), NOW)!;
  assert.equal(r.markets.get(1)!.fundingRatePpm, null);
  assert.equal(r.markets.get(1)!.lastFunding, null);
});
