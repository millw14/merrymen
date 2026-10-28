/**
 * ONE SLOW LEG MUST NOT DESTROY THE OTHER LEG'S ANSWER.
 *
 * ── THE BEHAVIOUR THIS REPRODUCES ────────────────────────────────────────
 *
 * `readPoolEvidence` joined its candle and trade reads with `Promise.all`, and
 * the caller raced that one combined promise against one 5s timer. `Promise.all`
 * settles only when BOTH legs settle, so candles that arrived in a second were
 * discarded whenever trades were slow, and the caller — holding only a nullable
 * object — could not tell that one leg had succeeded.
 *
 * It was not a rare interleaving. The legs use different cache keys, so they
 * cannot share a fleet pacing slot (3s spacing, one row shared by every
 * tenant): the second leg cannot begin before ~3s, leaving under 2s of the
 * budget for its round trip. Measured on the fleet on 2026-09-20, 29% of
 * Trencher Brain reviews (39 of 135) were handed no evidence at all.
 *
 * ── WHAT THESE PIN ───────────────────────────────────────────────────────
 *
 * That a late leg degrades to a FAILURE while the other leg's data survives,
 * and that a leg which did not land is never reported as a measurement of
 * zero. They say nothing about money; this is evidence quality.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readPoolEvidence, summarizeEvidence, EVIDENCE_BUDGET_MS, type EvidenceRead, type PriceBar, type MarketTrade } from "./pool-evidence";
import { fetchGeckoPoolsResult, resetGeckoFeedsForTest } from "./geckoterminal";
import type { FeedClock } from "./fleet-feed-cache";

const POOL = `0x${"a".repeat(40)}`;
const TOKEN = `0x${"b".repeat(40)}`;

/** A candle set shaped like a real one, aligned to the 300s grid. */
const barsAt = (now: number, n: number): PriceBar[] => {
  const end = Math.floor(now / 1000 / 300) * 300 - 300;
  return Array.from({ length: n }, (_, i) => {
    const time = end - (n - 1 - i) * 300;
    return { time, open: 1, high: 1.2, low: 0.9, close: 1.1 };
  });
};

describe("a leg that misses its budget is a failure, not an empty reading", () => {
  it("keeps candles that arrived when the trade leg never answers", async () => {
    // THE EXACT PRODUCTION SHAPE: fast candles, a trade leg that outlives the
    // budget. Before the per-leg budget this returned nothing at all.
    const now = Date.now();
    const e = await readPoolEvidence(POOL, TOKEN, 120, {
      candles: async () => ({ failed: false, observedAt: now, data: barsAt(now, 6) }) as EvidenceRead<PriceBar>,
      trades: () => new Promise<EvidenceRead<MarketTrade>>(() => {}),
    });
    assert.equal(e.candles.failed, false, "the candle leg landed and must survive");
    assert.equal(e.candles.data.length, 6);
    assert.equal(e.trades.failed, true);
    assert.equal(e.trades.failure, "budget");
  });

  it("keeps trades that arrived when the candle leg never answers", async () => {
    const now = Date.now();
    const e = await readPoolEvidence(POOL, TOKEN, 120, {
      candles: () => new Promise<EvidenceRead<PriceBar>>(() => {}),
      trades: async () => ({ failed: false, observedAt: now, data: [] }) as EvidenceRead<MarketTrade>,
    });
    assert.equal(e.candles.failure, "budget");
    assert.equal(e.trades.failed, false, "the trade leg landed and must survive");
  });

  it("does not invent an observation time for a leg that never answered", async () => {
    // `observedAt` is what freshness is judged on. A budget miss with a
    // timestamp would be indistinguishable from a real reading.
    const e = await readPoolEvidence(POOL, TOKEN, 60, {
      candles: () => new Promise<EvidenceRead<PriceBar>>(() => {}),
      trades: () => new Promise<EvidenceRead<MarketTrade>>(() => {}),
    });
    assert.equal(e.candles.observedAt, undefined);
    assert.equal(e.trades.observedAt, undefined);
  });

  it("returns within its budget rather than waiting for the slow leg", async () => {
    const started = Date.now();
    await readPoolEvidence(POOL, TOKEN, 100, {
      candles: () => new Promise<EvidenceRead<PriceBar>>(() => {}),
      trades: () => new Promise<EvidenceRead<MarketTrade>>(() => {}),
    });
    assert.ok(Date.now() - started < 2000, "a hung pair must not hold the caller open");
  });
});

describe("a leg that did not land is unknown, never zero", () => {
  const summarised = (candles: EvidenceRead<PriceBar>, trades: EvidenceRead<MarketTrade>, now: number) =>
    summarizeEvidence({ poolId: POOL, token: TOKEN, candles, trades }, now);

  it("reports completed bars as NULL when the candle read failed", () => {
    // The bug: `bars.length` is 0 both for a quiet market and for a feed that
    // never answered, and a model reading `completedFiveMinuteBars: 0` is
    // being told this pool printed nothing.
    const now = Date.now();
    const s = summarised({ failed: true, failure: "budget", data: [] }, { failed: true, failure: "budget", data: [] }, now);
    assert.equal(s.completedFiveMinuteBars, null, "a failed read must not read as a measured zero");
    assert.equal(s.contiguous, null, "`false` would assert a gap we never observed");
    assert.equal(s.candleFailure, "budget", "and it must say WHY it is unknown");
  });

  it("still reports a real zero as zero when the read DID land", () => {
    // The other direction, which matters just as much: a feed that answered
    // with no completed bars is a measurement and must not become "unknown".
    const now = Date.now();
    const s = summarised({ failed: false, observedAt: now, data: [] }, { failed: true, failure: "budget", data: [] }, now);
    assert.equal(s.completedFiveMinuteBars, 0, "a landed read of nothing IS zero");
    assert.equal(s.candleFailure, null);
  });

  it("keeps the two legs' freshness independent in the summary", () => {
    const now = Date.now();
    const s = summarised(
      { failed: false, observedAt: now, data: barsAt(now, 4) },
      { failed: true, failure: "budget", data: [] },
      now,
    );
    assert.equal(s.completedFiveMinuteBars, 4, "candles survived");
    assert.equal(s.sampledTrades5m, null, "trades are unknown");
    assert.equal(s.tradeFailure, "budget");
    assert.equal(s.candleFailure, null);
  });

  it("never carries a stale observation forward as fresh", () => {
    // Freshness is judged against the ORIGINAL observation time, so an old
    // reading must go unknown rather than be served as current.
    const now = Date.now();
    const old = now - 10 * 60 * 1000;
    const s = summarised({ failed: false, observedAt: old, data: barsAt(old, 6) }, { failed: true, failure: "budget", data: [] }, now);
    assert.equal(s.completedFiveMinuteBars, null, "a stale read is not a current measurement");
    assert.equal(s.candleObservedAt, old, "but the real observation time is still reported");
  });
});

/**
 * VIRTUAL TIME, REAL CONCURRENCY.
 *
 * Every sleeper waits for its own instant, and time moves only when nothing
 * else can run — straight to the earliest waiter. A clock whose `sleep` just
 * adds to the time cannot be used here: two legs waiting at once would each
 * push time forward, and a leg's budget would start late. Here, as in
 * production, legs that wait together wake together.
 */
function virtualClock(start = 1_000_000) {
  let t = start, seq = 0;
  const waiters: { at: number; seq: number; wake: () => void }[] = [];
  const clock: FeedClock = {
    now: () => t,
    sleep: (ms) => new Promise<void>((wake) => { waiters.push({ at: t + Math.max(0, ms), seq: seq++, wake }); }),
  };
  async function run<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    work.then(() => { settled = true; }, () => { settled = true; });
    for (let spins = 0; !settled; spins++) {
      assert.ok(spins < 10_000, "the work is waiting on something the virtual clock cannot wake");
      await new Promise((resolve) => setImmediate(resolve));
      if (settled || !waiters.length) continue;
      waiters.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = waiters.shift()!;
      t = Math.max(t, next.at);
      next.wake();
    }
    return work;
  }
  return { clock, run, now: () => t, advanceTo: (at: number) => { t = Math.max(t, at); } };
}

/**
 * A LEG ITS REVIEW HAS GIVEN UP ON MUST NOT TAKE A SLOT.
 *
 * Each leg's budget is five seconds, but the lane was asked with its own 30 s
 * deadline, so a leg still queued when its review moved on kept waiting and
 * then claimed a slot anyway: a credit spent on an answer nobody was waiting
 * for, the default row pushed back once more, and every later review queued
 * behind it. At the 3000 ms default, two tenants reviewing different pools
 * at the same moment put four legs on the row at 0, 3, 6 and 9 s. The second
 * tenant missed its budget, still spent two credits, and a third tenant
 * reviewing at 7 s queued behind those (12 s and 15 s) and missed as well.
 * That is the `candles=budget` outcome the evidence row exists to end.
 */
describe("a leg past its budget gives up its place in the lane", () => {
  const KNOBS = ["MERRYMEN_COINGECKO_PRO_API_KEY", "MERRYMEN_FLEET_HOME", "MERRYMEN_COINGECKO_PRO_SPACING_MS", "MERRYMEN_COINGECKO_MONTHLY_CREDITS"] as const;
  const realFetch = globalThis.fetch;
  let saved: Record<string, string | undefined> = {};
  let home = "";
  beforeEach(() => {
    saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
    for (const k of KNOBS) delete process.env[k];
    home = mkdtempSync(path.join(tmpdir(), "evidence-budget-"));
    process.env.MERRYMEN_FLEET_HOME = home;
    process.env.MERRYMEN_COINGECKO_PRO_API_KEY = "evidence-budget-key";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetGeckoFeedsForTest();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    for (const k of KNOBS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });

  it("two tenants at once: the second's legs spend nothing, and a third review is not queued behind them", async () => {
    const vc = virtualClock();
    resetGeckoFeedsForTest(vc.clock);
    const t0 = vc.now();
    const asked: { leg: string; at: number }[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const token = url.searchParams.get("token") ?? "";
      const leg = url.pathname.endsWith("/trades") ? "trades" : url.pathname.includes("/ohlcv/") ? "candles" : "tape";
      asked.push({ leg: `${/\/pools\/(0x[\da-f]{2})/.exec(url.pathname)?.[1] ?? ""}:${leg}`, at: vc.now() - t0 });
      if (leg === "trades") return Response.json({ data: [] });
      if (leg === "candles") return Response.json({ data: { attributes: { ohlcv_list: [] } }, meta: { base: { address: token } } });
      return Response.json({ data: [] });
    }) as typeof globalThis.fetch;
    const pool = (n: string) => `0x${n.repeat(40)}`;
    const token = `0x${"b".repeat(40)}`;

    const [a, b] = await vc.run(Promise.all([readPoolEvidence(pool("1"), token), readPoolEvidence(pool("2"), token)]));
    assert.equal(a.candles.failed, false);
    assert.equal(a.trades.failed, false);
    // B could not get a slot inside its five seconds, so it took none.
    assert.equal(b.candles.failure, "request-budget");
    assert.equal(b.trades.failure, "request-budget");
    assert.equal(b.candles.observedAt, undefined, "a missed leg is unknown, never an empty reading");
    assert.deepEqual(asked, [{ leg: "0x11:candles", at: 0 }, { leg: "0x11:trades", at: 3000 }],
      "only the legs somebody was waiting for were asked");

    // The default row was pushed only by the legs that ran: the tape's 6 s slot is free.
    vc.advanceTo(t0 + 6000);
    await vc.run(fetchGeckoPoolsResult("trending_pools"));
    assert.deepEqual(asked.at(-1), { leg: ":tape", at: 6000 });

    // A third review at 7 s finds the evidence row free, not owed to abandoned legs.
    vc.advanceTo(t0 + 7000);
    const c = await vc.run(readPoolEvidence(pool("3"), token));
    assert.equal(c.candles.failed, false);
    assert.equal(c.trades.failed, false);
    assert.deepEqual(asked.slice(-2), [{ leg: "0x33:candles", at: 7000 }, { leg: "0x33:trades", at: 10_000 }]);
    assert.ok(asked.slice(-2).every((r) => r.at - 7000 < EVIDENCE_BUDGET_MS));
  });
});
