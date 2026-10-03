import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atr, ema, levels, pivots, rsi, technicals, vwap, type Bar } from "./ta";

const H = 3600;
/** A bar series from closes: open is the previous close, wicks 1% out, volume flat unless given. */
function series(closes: number[], volume: (i: number) => number | null = () => 1000): Bar[] {
  return closes.map((c, i) => {
    const open = i ? closes[i - 1]! : c;
    return { time: 1_700_000_000 + i * H, open, high: Math.max(open, c) * 1.01, low: Math.min(open, c) * 0.99, close: c, volume: volume(i) };
  });
}

describe("desk indicators", () => {
  it("EMA seeds with the simple mean and is null before it has enough values", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    assert.deepEqual(out.slice(0, 2), [null, null]);
    assert.equal(out[2], 2);
    assert.equal(out[3], 3);
    assert.equal(out[4], 4);
    assert.deepEqual(ema([1, 2], 3), [null, null]);
  });

  it("RSI is 100 for a series that only rises, 0 for one that only falls, null when short", () => {
    assert.equal(rsi(Array.from({ length: 20 }, (_, i) => i + 1)), 100);
    assert.equal(rsi(Array.from({ length: 20 }, (_, i) => 20 - i)), 0);
    assert.equal(rsi([1, 2, 3]), null);
    const flat = rsi(Array.from({ length: 20 }, () => 5));
    assert.equal(flat, 50);
  });

  it("RSI matches a hand-checked Wilder value", () => {
    // Alternating +2 / -1: average gain 2/2, average loss 1/2 → RS 2 → RSI 66.67.
    const closes = [10];
    for (let i = 0; i < 40; i++) closes.push(closes.at(-1)! + (i % 2 === 0 ? 2 : -1));
    const v = rsi(closes)!;
    assert.ok(Math.abs(v - 66.67) < 1.5, `rsi ${v}`);
  });

  it("ATR and VWAP use the bars they are given, and VWAP ignores bars with no volume", () => {
    const bars = series(Array.from({ length: 30 }, () => 100));
    const a = atr(bars)!;
    assert.ok(a > 1.9 && a < 2.1, `atr ${a}`);
    assert.equal(atr(bars.slice(0, 5)), null);
    const v = vwap([
      { time: 0, open: 1, high: 3, low: 1, close: 2, volume: 1 },
      { time: H, open: 1, high: 6, low: 4, close: 5, volume: 3 },
      { time: 2 * H, open: 1, high: 99, low: 99, close: 99, volume: null },
    ])!;
    assert.equal(v, (2 * 1 + 5 * 3) / 4);
    assert.equal(vwap([{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: null }]), null);
  });

  it("finds swing highs and lows and leaves the unconfirmed tail alone", () => {
    const closes = [10, 11, 12, 15, 12, 11, 10, 8, 10, 11, 12, 11, 10];
    const ps = pivots(series(closes));
    assert.ok(ps.some((p) => p.kind === "high" && Math.abs(p.price - 15 * 1.01) < 1e-9));
    assert.ok(ps.some((p) => p.kind === "low" && Math.abs(p.price - 8 * 0.99) < 1e-9));
    assert.ok(ps.every((p) => p.time <= series(closes).at(-4)!.time));
  });

  it("clusters repeated swings into one level with its touch count, on the right side of price", () => {
    // A range: three tops near 120, three bottoms near 100, price now 110.
    const closes: number[] = [];
    for (let k = 0; k < 3; k++) closes.push(105, 110, 115, 120, 115, 110, 105, 100);
    closes.push(105, 110);
    const bars = series(closes);
    const { supports, resistances } = levels(bars, 110, atr(bars));
    assert.ok(supports.length >= 1 && resistances.length >= 1);
    assert.ok(supports.every((l) => l.price < 110) && resistances.every((l) => l.price > 110));
    assert.ok(resistances[0]!.touches >= 2, JSON.stringify(resistances));
    assert.ok(supports[0]!.touches >= 2, JSON.stringify(supports));
  });

  it("reads an uptrend: price above a rising EMA20 above EMA50, higher swings, volume picking up", () => {
    const closes = Array.from({ length: 168 }, (_, i) => 100 * Math.exp(i * 0.004) * (1 + 0.03 * Math.sin(i / 3)));
    const t = technicals(series(closes, (i) => (i >= 162 ? 3000 : 1000)))!;
    assert.equal(t.trend, "uptrend");
    assert.ok(t.ema20! > t.ema50!);
    assert.ok(t.rsi14! > 50);
    assert.equal(t.volume6hVsPrior, 3);
    assert.equal(t.hours, 168);
    assert.ok(t.rangePositionPct! > 70);
    assert.equal(t.lastBarsPct.length, 3);
  });

  it("reads a downtrend and calls nothing above price support", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 * Math.exp(-i * 0.006) * (1 + 0.03 * Math.sin(i / 3)));
    const t = technicals(series(closes))!;
    assert.equal(t.trend, "downtrend");
    assert.ok(t.supports.every((l) => l.price < t.last));
    assert.ok(t.resistances.every((l) => l.price > t.last));
    assert.ok(t.rsi14! < 50);
  });

  it("says null rather than inventing long indicators for a young coin", () => {
    const t = technicals(series([1, 1.1, 1.2, 1.15, 1.3, 1.25, 1.4, 1.35]))!;
    assert.equal(t.ema50, null);
    assert.equal(t.rsi14, null);
    assert.equal(t.volume24hVsPrior, null);
    assert.equal(technicals(series([1, 2])), null);
  });

  it("drops malformed bars instead of letting a zero become a level", () => {
    const bars = series(Array.from({ length: 30 }, (_, i) => 10 + i));
    bars.push({ time: bars.at(-1)!.time + H, open: 0, high: 0, low: 0, close: 0, volume: 1 });
    const t = technicals(bars)!;
    assert.equal(t.bars, 30);
    assert.ok(t.rangeLow > 0);
  });
});
