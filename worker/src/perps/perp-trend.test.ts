import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { leverageFromImfBp, type PerpKey } from "../../../packages/core/src/perps";
import type { Why } from "../strategies/reasons";
import type { PerpsView } from "../strategies/types";
import { parseMarkCandles } from "./markets";
import {
  PERP_TREND_DEFAULTS,
  TREND_SCALE,
  atrScaled,
  emaScaled,
  entrySignal,
  perpTrendTick,
  trendExit,
  trendRead,
  trendStopBps,
} from "./perp-trend";
import {
  BASE,
  H4,
  NOW_SEC,
  T_LAST,
  breakout,
  candles,
  ctx,
  funding,
  marketView,
  policyVerdict,
  position,
  scaleRange,
  settings,
  u,
  view,
  type Candle,
} from "./testkit-perps";

/**
 * perp-trend as a truth table: every entry condition alone blocks the entry,
 * every exit condition alone fires, exits come before entries, the candle in
 * progress is never read, and the same inputs always give the same output.
 * Each built open is then put through the REAL checkPolicy, so "perp-trend
 * proposes it" and "the wall accepts it" are the same statement.
 */

const idle = (r: ReturnType<typeof perpTrendTick>): Why | null => r.idle;
const withMarket = (v: PerpsView, key: PerpKey, over: Parameters<typeof marketView>[1]) => {
  const markets = new Map(v.markets);
  markets.set(key, marketView(key, over));
  return { ...v, markets };
};
/** BTC breaking out alone: ETH flat. */
const btcOnly = (over: Partial<PerpsView> = {}) => withMarket(view(over), "ETH-PERP", { closed4h: breakout("ETH-PERP", 0n) });

describe("perp-trend enters on a closed-candle breakout, and the wall accepts what it builds", () => {
  it("long: close above the 12-bar high and the EMA → one open with its stop, sized under every cap", () => {
    const v = btcOnly();
    const r = perpTrendTick(v, settings(), ctx());
    assert.equal(r.exits.length, 0);
    assert.ok(r.entry, JSON.stringify(r.idle));
    const e = r.entry;
    assert.equal(e.market, "BTC-PERP");
    assert.equal(e.side, "long");
    assert.equal(e.effect, "open");
    assert.equal(e.reduceOnly, false);
    assert.equal(e.takeTrigger, undefined, "perp-trend never carries a take-profit");
    assert.ok(e.worstPrice > e.markPrice, "a long's IOC pays at most mark + slippage");
    assert.ok(e.stopTrigger < e.markPrice && e.stopPrice <= e.stopTrigger);
    assert.ok(e.notionalUsdg <= u(25), "min(perpsPerTradeUsdg 25, sealed 100, headroom…)");
    assert.equal(e.imfBp, v.markets.get("BTC-PERP")!.imfBp, "leverage is the market's target, never chosen here");
    assert.equal(r.entryCandleT, T_LAST);
    assert.deepEqual(r.why, [{ code: "perp-open", market: "BTC-PERP", side: "long", leverage: leverageFromImfBp(e.imfBp), stopPct: 1.5 }]);
    assert.deepEqual(policyVerdict(e, v), { ok: true });
  });

  it("short: the mirror, and the wall accepts it too", () => {
    const v = withMarket(btcOnly(), "BTC-PERP", { closed4h: breakout("BTC-PERP", -5_000n) });
    const r = perpTrendTick(v, settings(), ctx());
    assert.ok(r.entry);
    assert.equal(r.entry.side, "short");
    assert.ok(r.entry.worstPrice < r.entry.markPrice);
    assert.ok(r.entry.stopTrigger > r.entry.markPrice);
    assert.ok(r.entry.notionalUsdg <= u(25), "a short is sized at the mark, the higher of its two prices");
    assert.deepEqual(policyVerdict(r.entry, v), { ok: true });
  });

  it("the stop is max(1.5%, 3 × ATR / close), rounded up, never tighter", () => {
    const calm = trendRead(breakout("BTC-PERP", 5_000n))!;
    assert.equal(trendStopBps(calm), 150);
    const wild = trendRead(breakout("BTC-PERP", 20_000n, 6_000n))!; // ±600 USD bars: 3 ATR ≈ 4.5%
    const s = trendStopBps(wild);
    assert.ok(s > 150);
    const exact = (3n * wild.atrS * 10_000n) / (wild.close * TREND_SCALE);
    assert.ok(BigInt(s) >= exact && BigInt(s) <= exact + 1n);
  });

  it("chooses the strongest break in ATRs when two markets signal, one open per tick", () => {
    const v = withMarket(view(), "ETH-PERP", { closed4h: breakout("ETH-PERP", scaleRange("ETH-PERP", 9_000n)) });
    const r = perpTrendTick(v, settings(), ctx());
    assert.equal(r.entry?.market, "ETH-PERP");
    // And the other way round: a stronger BTC break wins.
    const b = withMarket(view(), "BTC-PERP", { closed4h: breakout("BTC-PERP", 12_000n) });
    assert.equal(perpTrendTick(b, settings(), ctx()).entry?.market, "BTC-PERP");
  });
});

describe("perp-trend: each entry condition ALONE blocks the entry", () => {
  const base = btcOnly;
  const cases: Array<[string, () => { v: PerpsView; s?: ReturnType<typeof settings>; c?: ReturnType<typeof ctx> }, Why | null]> = [
    ["no break of the 12-bar high", () => ({ v: withMarket(base(), "BTC-PERP", { closed4h: breakout("BTC-PERP", 150n) }) }), { code: "perp-no-signal", markets: 2 }],
    [
      "a break of the channel below a falling EMA",
      () => {
        // 100 bars at 90,000 then 19 at 80,000: the EMA still sits near 81,900.
        const closes = [...Array(100).fill(900_000n), ...Array(19).fill(800_000n), 805_000n] as bigint[];
        return { v: withMarket(base(), "BTC-PERP", { closed4h: candles(closes, 200n) }) };
      },
      { code: "perp-no-signal", markets: 2 },
    ],
    ["the market reduce-only", () => ({ v: withMarket(base(), "BTC-PERP", { status: "reduce-only" }) }), { code: "perp-no-signal", markets: 2 }],
    ["a position already there", () => ({ v: base({ positions: new Map([["BTC-PERP", position("BTC-PERP", "long", { openedAtSec: NOW_SEC - 60 })]]) }) }), { code: "perp-no-signal", markets: 2 }],
    ["an unresolved order there", () => ({ v: base({ unresolved: new Set(["BTC-PERP"]) }) }), { code: "perp-order-unresolved", market: "BTC-PERP" }],
    [
      "8 h after a strategy exit",
      () => ({ v: base({ lastExit: new Map([["BTC-PERP", { atSec: NOW_SEC - 8 * 3600 + 60, cause: "strategy" }]]) }) }),
      { code: "perp-cooldown", market: "BTC-PERP", hours: 8, after: "strategy" },
    ],
    [
      "24 h after a stop",
      () => ({ v: base({ lastExit: new Map([["BTC-PERP", { atSec: NOW_SEC - 23 * 3600, cause: "stop" }]]) }) }),
      { code: "perp-cooldown", market: "BTC-PERP", hours: 24, after: "stop" },
    ],
    [
      "24 h after a forced fill",
      () => ({ v: base({ lastExit: new Map([["BTC-PERP", { atSec: NOW_SEC - 3600, cause: "forced" }]]) }) }),
      { code: "perp-cooldown", market: "BTC-PERP", hours: 24, after: "forced" },
    ],
    [
      "24 h after an exit of unknown cause",
      () => ({ v: base({ lastExit: new Map([["BTC-PERP", { atSec: NOW_SEC - 3600, cause: "unknown" }]]) }) }),
      { code: "perp-cooldown", market: "BTC-PERP", hours: 24, after: "strategy" },
    ],
    ["the candle already entered on (policy refusals included)", () => ({ v: base({ lastEntryCandleT: new Map([["BTC-PERP", T_LAST]]) }) }), { code: "perp-no-signal", markets: 2 }],
    [
      "two positions held",
      () => ({
        v: base({
          positions: new Map([
            ["ETH-PERP", position("ETH-PERP", "long")],
            ["TSLA-PERP", position("TSLA-PERP", "short")],
          ]),
        }),
      }),
      { code: "perp-max-positions", max: 2 },
    ],
    ["the breaker tripped", () => ({ v: base(), c: ctx({ breakerIdle: false, breakerLimitBps: 1_500 }) }), { code: "breaker-tripped", limitBps: 1_500 }],
    ["today's energy spent", () => ({ v: base(), c: ctx({ energyEntriesLeft: false }) }), null],
    ["the day's operations spent", () => ({ v: base(), c: ctx({ opsHeadroom: false }) }), { code: "ops-spent" }],
    ["the grant good for less than 168 h", () => ({ v: base({ grantExpiresAtSec: NOW_SEC + 167 * 3600 }) }), { code: "perp-grant-expiring", withinHours: 168 }],
    ["a live book with no known grant expiry", () => ({ v: base({ mode: "live", grantExpiresAtSec: null }) }), { code: "perp-grant-expiring", withinHours: 168 }],
    [
      "funding against the long above 0.005%/h on average",
      () => ({ v: withMarket(base(), "BTC-PERP", { funding8h: funding(51) }) }),
      { code: "perp-funding-against", market: "BTC-PERP", side: "long" },
    ],
    ["funding unread", () => ({ v: withMarket(base(), "BTC-PERP", { funding8h: null }) }), { code: "perp-signal-unread", market: "BTC-PERP" }],
    ["candles unread", () => ({ v: withMarket(base(), "BTC-PERP", { closed4h: null }) }), { code: "perp-signal-unread", market: "BTC-PERP" }],
    ["a mark older than 30 s", () => ({ v: withMarket(base(), "BTC-PERP", { observedAtSec: NOW_SEC - 31 }) }), { code: "perp-signal-unread", market: "BTC-PERP" }],
    [
      "a stop the market needs wider than perpsStopLossPct",
      () => ({ v: withMarket(base(), "BTC-PERP", { closed4h: breakout("BTC-PERP", 20_000n, 6_000n) }), s: settings({ perpsStopLossPct: 3 }) }),
      null,
    ],
    ["caps under the venue minimum", () => ({ v: base(), c: ctx({ perTradeSealedMicro: u(10) }) }), null],
    ["perps opens blocked at the view", () => ({ v: base({ opensBlocked: "perps-venue-unreachable" }) }), { code: "perp-signal-unread", market: null }],
    ["no opens left today", () => ({ v: base({ headroom: { perTradeNotionalMicro: u(25), openNotionalLeftMicro: u(50), collateralLeftMicro: u(30), opensLeftToday: 0 } }) }), null],
    ["equity unknown", () => ({ v: base(), c: ctx({ equityMicro: null }) }), { code: "perp-signal-unread", market: null }],
    ["no covered market allowed", () => ({ v: base(), s: settings({ perpsMarkets: ["TSLA-PERP"] }) }), { code: "perp-market-not-covered", market: "TSLA-PERP" }],
    ["the market not allowed", () => ({ v: base(), s: settings({ perpsMarkets: ["ETH-PERP"] }) }), { code: "perp-no-signal", markets: 1 }],
  ];

  it("the unblocked baseline enters", () => {
    assert.ok(perpTrendTick(base(), settings(), ctx()).entry);
  });
  for (const [what, make, want] of cases) {
    it(what, () => {
      const { v, s, c } = make();
      const r = perpTrendTick(v, s ?? settings(), c ?? ctx());
      assert.equal(r.entry, null, `${what}: no entry`);
      if (want !== null) assert.deepEqual(idle(r), want, what);
    });
  }

  it("too volatile says so, with the owner's ceiling, rather than widening the stop", () => {
    const v = withMarket(btcOnly(), "BTC-PERP", { closed4h: breakout("BTC-PERP", 20_000n, 6_000n) });
    const r = perpTrendTick(v, settings({ perpsStopLossPct: 3 }), ctx());
    assert.equal(r.idle?.code, "perp-too-volatile");
    const w = r.idle as Extract<Why, { code: "perp-too-volatile" }>;
    assert.equal(w.maxStopPct, 3);
    assert.ok(w.stopPct > 3);
  });

  it("below the minimum says what the venue needs and what the caps allow — nothing is raised to reach it", () => {
    const r = perpTrendTick(btcOnly(), settings(), ctx({ perTradeSealedMicro: u(10) }));
    const w = r.idle as Extract<Why, { code: "perp-below-min" }>;
    assert.equal(w.code, "perp-below-min");
    assert.equal(w.capRaw, u(10));
    assert.ok(w.minRaw > u(10));
  });

  it("cooldowns end: 8 h after a strategy exit, 24 h after a stop", () => {
    const at = (h: number, cause: "strategy" | "stop") => btcOnly({ lastExit: new Map([["BTC-PERP", { atSec: NOW_SEC - h * 3600, cause }]]) });
    assert.ok(perpTrendTick(at(8, "strategy"), settings(), ctx()).entry);
    assert.equal(perpTrendTick(at(7.9, "strategy"), settings(), ctx()).entry, null);
    assert.ok(perpTrendTick(at(24, "stop"), settings(), ctx()).entry);
    assert.equal(perpTrendTick(at(23.9, "stop"), settings(), ctx()).entry, null);
  });

  it("the size is the smallest of the caps and the two risk budgets", () => {
    // 1% of 500 USDG over a 1.5% stop is 333 — not binding; 0.95 × 2 × 10 collateral = 19 is.
    const v = btcOnly({ headroom: { perTradeNotionalMicro: u(25), openNotionalLeftMicro: u(50), collateralLeftMicro: u(10), opensLeftToday: 4 } });
    const r = perpTrendTick(v, settings(), ctx({ equityMicro: u(500) }));
    assert.ok(r.entry);
    assert.ok(r.entry.notionalUsdg <= u(19) && r.entry.notionalUsdg > u(18), String(r.entry.notionalUsdg));
    // 1% of 20 USDG over a 1.5% stop is 13.33: under BTC's ~16 minimum → below-min, not a bigger order.
    const small = perpTrendTick(btcOnly(), settings(), ctx({ equityMicro: u(20) }));
    assert.equal(small.entry, null);
    assert.equal(small.idle?.code, "perp-below-min");
  });
});

describe("perp-trend: each exit ALONE fires, and exits come first", () => {
  const holding = (key: PerpKey, side: "long" | "short", closes: bigint[], opened = NOW_SEC - 3_600) =>
    withMarket(view({ positions: new Map([[key, position(key, side, { openedAtSec: opened })]]) }), key, { closed4h: candles(closes, 200n) });
  const flat = (n: number, p: bigint) => Array.from({ length: n }, () => p);

  it("a long whose close falls under the 6-bar low → trend exit, whole position, reduce-only", () => {
    // Rising slowly (EMA below), then a close under the last six lows but above the EMA.
    const closes = [...Array.from({ length: 113 }, (_, i) => 700_000n + BigInt(i) * 1_000n), ...flat(6, 812_600n), 811_000n];
    const v = holding("BTC-PERP", "long", closes);
    const r = trendRead(candles(closes, 200n))!;
    assert.ok(r.close < r.ll6 && r.close * TREND_SCALE > r.emaS, "the channel alone");
    const t = perpTrendTick(v, settings(), ctx());
    assert.equal(t.exits.length, 1);
    const x = t.exits[0]!;
    assert.equal(x.effect, "close");
    assert.equal(x.reduceOnly, true);
    assert.equal(x.side, "long", "the side HELD");
    assert.equal(x.baseAmount, v.positions.get("BTC-PERP")!.baseAmount);
    assert.ok(x.worstPrice < x.markPrice, "closing a long sells, bounded below the mark");
    assert.deepEqual(t.why[0], { code: "perp-exit", market: "BTC-PERP", side: "long", cause: "trend" });
    assert.deepEqual(policyVerdict(x, v), { ok: true });
  });

  it("a long whose close falls under the EMA but not the 6-bar low → trend exit", () => {
    const closes = [...flat(100, 820_000n), ...flat(19, 800_000n), 800_100n];
    const r = trendRead(candles(closes, 200n))!;
    assert.ok(r.close >= r.ll6 && r.close * TREND_SCALE < r.emaS, "the EMA alone");
    const t = perpTrendTick(holding("BTC-PERP", "long", closes), settings(), ctx());
    assert.equal(t.exits.length, 1);
    assert.equal((t.why[0] as { cause: string }).cause, "trend");
  });

  it("a short: the mirror (a close over the 6-bar high)", () => {
    const closes = [...Array.from({ length: 113 }, (_, i) => 900_000n - BigInt(i) * 1_000n), ...flat(6, 787_400n), 789_000n];
    const r = trendRead(candles(closes, 200n))!;
    assert.ok(r.close > r.hh6 && r.close * TREND_SCALE < r.emaS);
    const t = perpTrendTick(holding("BTC-PERP", "short", closes), settings(), ctx());
    assert.equal(t.exits.length, 1);
    assert.equal(t.exits[0]!.side, "short");
    assert.ok(t.exits[0]!.worstPrice > t.exits[0]!.markPrice, "closing a short buys");
  });

  it("held 168 h with the trend intact → aged exit", () => {
    const up = [...Array.from({ length: 119 }, (_, i) => 780_000n + BigInt(i) * 200n), 804_000n];
    const young = perpTrendTick(holding("BTC-PERP", "long", up, NOW_SEC - 167 * 3600), settings(), ctx());
    assert.equal(young.exits.length, 0, "the trend holds and it is not yet aged");
    const old = perpTrendTick(holding("BTC-PERP", "long", up, NOW_SEC - 168 * 3600), settings(), ctx());
    assert.equal(old.exits.length, 1);
    assert.deepEqual(old.why[0], { code: "perp-exit", market: "BTC-PERP", side: "long", cause: "aged" });
  });

  it("exits read no brake: breaker, energy, ops, caps, grant — the close still goes", () => {
    const closes = [...flat(100, 820_000n), ...flat(19, 800_000n), 800_100n];
    const v = { ...holding("BTC-PERP", "long", closes), opensBlocked: "breaker-tripped" as const, grantExpiresAtSec: NOW_SEC + 60 };
    const t = perpTrendTick(v, settings({ perpsMarkets: ["ETH-PERP"] }), ctx({ breakerIdle: false, energyEntriesLeft: false, opsHeadroom: false, equityMicro: null, perTradeSealedMicro: 0n }));
    assert.equal(t.exits.length, 1, "even for a market no longer allowed");
  });

  it("exits come before the entry, and the why list pairs with both", () => {
    const closes = [...flat(100, 820_000n), ...flat(19, 800_000n), 800_100n];
    const v = withMarket(
      view({ positions: new Map([["BTC-PERP", position("BTC-PERP", "long")]]) }),
      "BTC-PERP",
      { closed4h: candles(closes, 200n) },
    );
    const eth = withMarket(v, "ETH-PERP", { closed4h: breakout("ETH-PERP", scaleRange("ETH-PERP", 5_000n)) });
    const t = perpTrendTick(eth, settings(), ctx());
    assert.equal(t.exits.length, 1);
    assert.equal(t.entry?.market, "ETH-PERP");
    assert.deepEqual(
      t.why.map((w) => w.code),
      ["perp-exit", "perp-open"],
    );
  });

  it("no exit is built for an unresolved market (a close is in flight), an unread market, or a market outside the universe", () => {
    const closes = [...flat(100, 820_000n), ...flat(19, 800_000n), 800_100n];
    const v = holding("BTC-PERP", "long", closes);
    assert.equal(perpTrendTick({ ...v, unresolved: new Set<PerpKey>(["BTC-PERP"]) }, settings(), ctx()).exits.length, 0);
    const noMarket = new Map(v.markets);
    noMarket.delete("BTC-PERP");
    assert.equal(perpTrendTick({ ...v, markets: noMarket }, settings(), ctx()).exits.length, 0);
    const tsla = view({ positions: new Map([["TSLA-PERP", position("TSLA-PERP", "long", { openedAtSec: NOW_SEC - 999 * 3600 })]]) }, ["BTC-PERP", "TSLA-PERP"]);
    assert.equal(perpTrendTick(tsla, settings(), ctx()).exits.length, 0, "the owner's TSLA perp is not this strategy's to close");
  });

  it("Lighter unread: nothing at all, not even an exit", () => {
    for (const v of [null, undefined]) {
      const t = perpTrendTick(v, settings(), ctx());
      assert.deepEqual(t, { exits: [], entry: null, why: [], idle: { code: "perp-signal-unread", market: null }, blocked: [], entryCandleT: null });
    }
  });
});

describe("perp-trend reads only CLOSED candles", () => {
  it("a huge in-progress candle is ignored until it closes", () => {
    const series = breakout("BTC-PERP", 0n); // flat, no signal
    const inProgress: Candle = { t: T_LAST + H4, o: 800_000n, h: 900_000n, l: 800_000n, c: 900_000n };
    const v = withMarket(btcOnly(), "BTC-PERP", { closed4h: [...series, inProgress], markPrice: 900_000n });
    assert.equal(perpTrendTick(v, settings(), ctx()).entry, null, "NOW is one hour into that candle");
    const closedNow = (T_LAST + 2 * H4) / 1000 + 60;
    const later = perpTrendTick({ ...v, markets: new Map([...v.markets].map(([k, m]) => [k, { ...m, observedAtSec: closedNow - 1, funding8h: funding(10, closedNow) }])) }, settings(), ctx({ nowSec: closedNow }));
    assert.equal(later.entry?.market, "BTC-PERP");
    assert.equal(later.entryCandleT, T_LAST + H4);
  });

  it("fewer than 100 contiguous closed candles, or a stale history, is unread", () => {
    const short = breakout("BTC-PERP", 5_000n).slice(-99);
    const r = perpTrendTick(withMarket(btcOnly(), "BTC-PERP", { closed4h: short }), settings(), ctx());
    assert.deepEqual(r.idle, { code: "perp-signal-unread", market: "BTC-PERP" });
    const stale = perpTrendTick(btcOnly(), settings(), ctx({ nowSec: (T_LAST + 2 * H4 + 16 * 60_000) / 1000 }));
    assert.equal(stale.entry, null);
  });
});

describe("perp-trend is deterministic", () => {
  it("the same view gives the same answer, byte for byte", () => {
    const a = perpTrendTick(view(), settings(), ctx());
    const b = perpTrendTick(view(), settings(), ctx());
    const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
    assert.equal(j(a), j(b));
  });

  it("EMA and Wilder ATR match an independent float computation on the live BTC capture", () => {
    const raw = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "markPriceCandles.1.4h.json"), "utf8")) as { c: Array<{ t: number; o: number; h: number; l: number; c: number }> };
    const parsed = parseMarkCandles(raw, 1)!;
    const now = 1_790_718_587_000;
    const closed = parsed.candles.filter((c) => c.tMs + H4 <= now).map((c) => ({ t: c.tMs, o: c.open, h: c.high, l: c.low, c: c.close }));
    assert.equal(closed.length, 149);
    // Float reference, the same definitions: SMA seeds, then the recurrences.
    const cs = raw.c.slice(0, 149);
    let e = cs.slice(0, 24).reduce((s, x) => s + x.c, 0) / 24;
    for (let i = 24; i < cs.length; i++) e = (2 * cs[i]!.c + 23 * e) / 25;
    const tr = (i: number) => Math.max(cs[i]!.h - cs[i]!.l, Math.abs(cs[i]!.h - cs[i - 1]!.c), Math.abs(cs[i]!.l - cs[i - 1]!.c));
    let a = 0;
    for (let i = 1; i <= 14; i++) a += tr(i);
    a /= 14;
    for (let i = 15; i < cs.length; i++) a = (13 * a + tr(i)) / 14;
    const ema = Number(emaScaled(closed, 24)!) / Number(TREND_SCALE) / 10;
    const atr = Number(atrScaled(closed, 14)!) / Number(TREND_SCALE) / 10;
    assert.ok(Math.abs(ema - e) / e < 1e-9, `${ema} vs ${e}`);
    assert.ok(Math.abs(atr - a) / a < 1e-9, `${atr} vs ${a}`);
    const r = trendRead(closed)!;
    assert.equal(r.lastT, 1_790_697_600_000);
    // Whatever the capture says, it says it the same way twice.
    assert.deepEqual(entrySignal(r), entrySignal(trendRead(closed)!));
    assert.equal(trendExit(r, "long"), trendExit(trendRead(closed)!, "long"));
  });

  it("the frozen defaults are the documented rule", () => {
    assert.ok(Object.isFrozen(PERP_TREND_DEFAULTS));
    assert.equal(PERP_TREND_DEFAULTS.maxPositions, 2);
    assert.equal(PERP_TREND_DEFAULTS.maxHoldHours, 168);
    assert.equal(PERP_TREND_DEFAULTS.minStopBps, 150);
    assert.equal(PERP_TREND_DEFAULTS.maxFundingAgainstPpmPerHour, 50, "0.005 %/h");
    assert.equal(PERP_TREND_DEFAULTS.cooldownAfterStrategyHours, 8);
    assert.equal(PERP_TREND_DEFAULTS.cooldownAfterRiskHours, 24);
    assert.equal(BASE["BTC-PERP"], 800_000n);
  });
});


describe("first-class trend profiles", () => {
  it("scalping requires its own closed five-minute evidence, never four-hour fallback", () => {
    const base = btcOnly();
    const selected = { ...settings(), perpsStyle: "scalp-breakout" as const };
    assert.equal(perpTrendTick(base, selected, ctx()).entry, null);
    const last = Math.floor(NOW_SEC * 1000 / 300_000) * 300_000 - 300_000;
    const series = breakout("BTC-PERP", 5_000n).map((b, i, all) => ({ ...b, t: last - (all.length - 1 - i) * 300_000 }));
    const v = withMarket(base, "BTC-PERP", { closedByTimeframe: { "5m": series } });
    const out = perpTrendTick(v, selected, ctx());
    assert.ok(out.entry);
    assert.equal(out.entryCandleT, last);
    assert.equal(out.entry.notionalUsdg, perpTrendTick(base, settings(), ctx()).entry!.notionalUsdg);
    const gap = series.slice(); gap.splice(50, 1);
    assert.equal(perpTrendTick(withMarket(base, "BTC-PERP", { closedByTimeframe: { "5m": gap } }), selected, ctx()).entry, null);
  });
  it("a saved scalp entry retains its thirty-minute deadline after switching to swing", () => {
    const held = position("BTC-PERP", "long", { openedAtSec: NOW_SEC - 1800, entryStyle: "scalp-breakout" });
    const r = perpTrendTick(btcOnly({ positions: new Map([["BTC-PERP", held]]) }), settings(), ctx());
    assert.equal(r.exits.length, 1);
    assert.deepEqual(r.why[0], { code: "perp-exit", market: "BTC-PERP", side: "long", cause: "aged" });
  });
  it("different channel lengths produce different measured signals", () => {
    const rows = breakout("BTC-PERP", 5_000n);
    rows[rows.length - 20] = { ...rows[rows.length - 20]!, h: rows.at(-1)!.c + 10_000n };
    assert.equal(entrySignal(trendRead(rows, 12)!), "long");
    assert.equal(entrySignal(trendRead(rows, 24)!), null);
  });
});
