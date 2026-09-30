/** Synthetic causal replay frames; never evidence of historical returns. */
import type { PerpsReplayFrame } from "./backtest";
import { specToJson, type LighterFeedFile } from "./feed-reader";
import { marketView, NOW_SEC, breakout } from "./testkit-perps";
export const REPLAY_TEST_START = (NOW_SEC + 120) * 1000;
export function replayTestFrame(atMs = REPLAY_TEST_START, mark = 805000n): PerpsReplayFrame {
  const spec = marketView("BTC-PERP").spec;
  const endHour = Math.floor(atMs / 3600000) * 3600;
  const feed: LighterFeedFile = { v: 1, observedAt: atMs, markets: { "1": {
    observedAt: atMs, priceSource: "ws", mark: String(mark), index: String(mark), fundingRatePctPerHour: "0.0010",
    status: "active", spec: specToJson(spec), specObservedAt: atMs, takerFeePpm: 200, makerFeePpm: 0,
    bids: [[String(mark - 1n), "100000"]], asks: [[String(mark + 1n), "100000"]], bookSource: "ws", bookObservedAt: atMs,
    closed4h: breakout("BTC-PERP", 5000n).map(c => ({ t: c.t, o: String(c.o), h: String(c.h), l: String(c.l), c: String(c.c) })),
    candlesObservedAt: atMs,
    fundings1h: Array.from({ length: 12 }, (_, i) => ({ t: endHour - (11 - i) * 3600, rate: "0.0010", direction: "long" as const })),
    fundingsObservedAt: atMs,
  } } };
  return { atMs, feed };
}
