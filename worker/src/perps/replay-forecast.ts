/** Score the declared three-bar proxy target separately from realized trade P&L. */
import { perpMarketByKey, type PerpKey } from "../../../packages/core/src/perps";
import type { PerpsReplayFrame } from "./backtest";
import { validatePerpsBrainResponse } from "./brain";
import { FEED_CANDLE_MS, parseLighterFeed } from "./feed-reader";
import type { RecordedPerpsBrainDecision } from "./replay-brain";
import { replayFrameHash } from "./replay-recorder";

export function scoreRecordedPerpsForecasts(records: readonly RecordedPerpsBrainDecision[], frames: readonly PerpsReplayFrame[], sourceVerifiedRunIds: ReadonlySet<string>) {
  let previous = -1;
  for (const frame of frames) {
    if (!Number.isSafeInteger(frame.atMs) || frame.atMs <= previous) throw new Error("forecast frames must strictly increase");
    previous = frame.atMs;
  }
  const byTime = new Map(frames.map(f => [f.atMs, f]));
  const parsed = frames.map(f => {
    const future = f.feed && typeof f.feed === "object" && "observedAt" in f.feed && typeof f.feed.observedAt === "number" && f.feed.observedAt > f.atMs;
    return { atMs: f.atMs, feed: future ? null : parseLighterFeed(f.feed, f.atMs) };
  });
  const outcomes: { runId: string; probability: number; netTargetBps: number; positive: boolean; observedAtMs: number; action: string }[] = [];
  const unscored: { runId: string; reason: string }[] = [];
  const ids = new Set<string>();
  for (const record of records) {
    const r = record.request;
    if (ids.has(r.run_id)) throw new Error("duplicate forecast run");
    ids.add(r.run_id);
    if (!sourceVerifiedRunIds.has(r.run_id)) { unscored.push({ runId: r.run_id, reason: "source-not-replayed" }); continue; }
    const response = validatePerpsBrainResponse(record.response, r, record.completedAtMs);
    const source = byTime.get(r.as_of_ms);
    const last = r.candles.at(-1);
    const id = perpMarketByKey(r.market as PerpKey)?.marketId;
    if (!response || !source || replayFrameHash(source) !== record.sourceFrameSha256 || !last || id === undefined) {
      unscored.push({ runId: r.run_id, reason: "unbound-or-invalid-response" }); continue;
    }
    const probability = response.forecast.win_probability;
    if (probability === null) { unscored.push({ runId: r.run_id, reason: "no-probability" }); continue; }
    const targetT = last.t + response.forecast.horizon_bars * FEED_CANDLE_MS;
    // Use the first observed, fully closed target candle. A later revision is
    // not substituted because it would change what was measurable at the time.
    let target: { close: bigint; observedAtMs: number } | null = null;
    for (const frame of parsed) {
      if (frame.atMs < targetT + FEED_CANDLE_MS || frame.atMs < record.completedAtMs) continue;
      const bar = frame.feed?.markets.get(id)?.closed4h?.find(c => c.t === targetT);
      if (bar) { target = { close: bar.c, observedAtMs: frame.atMs }; break; }
    }
    if (!target) { unscored.push({ runId: r.run_id, reason: "target-not-observed" }); continue; }
    const initial = BigInt(last.c);
    if (initial <= 0n) { unscored.push({ runId: r.run_id, reason: "invalid-reference-price" }); continue; }
    const direction = r.candidate.side === "long" ? 1n : -1n;
    const netTargetBps = Number(direction * (target.close - initial) * 1_000_000n / initial) / 100 - response.forecast.cost_bps;
    outcomes.push({ runId: r.run_id, probability, netTargetBps, positive: netTargetBps > 0, observedAtMs: target.observedAtMs, action: response.action });
  }
  const bins = Array.from({ length: 10 }, (_, i) => {
    const rows = outcomes.filter(o => Math.min(9, Math.floor(o.probability * 10)) === i);
    return { from: i / 10, to: (i + 1) / 10, samples: rows.length,
      meanProbability: rows.length ? rows.reduce((n, o) => n + o.probability, 0) / rows.length : null,
      observedPositiveRate: rows.length ? rows.filter(o => o.positive).length / rows.length : null };
  });
  return {
    target: "signed-mark-return-after-estimated-costs", horizonBars: 3,
    status: outcomes.length < 100 ? "insufficient-data" : "measured-proxy-only",
    calibrated: false, samples: outcomes.length, unscored, outcomes, reliabilityBins: bins,
    brierScore: outcomes.length ? outcomes.reduce((n, o) => n + (o.probability - Number(o.positive)) ** 2, 0) / outcomes.length : null,
    equalProbabilityBrierScore: outcomes.length ? 0.25 : null,
    caveat: "This proxy uses future candle closes and the forecast's frozen estimated costs. It is not a completed-trade win rate, net realized return, or proof of calibration; overlapping labels are correlated.",
  };
}
