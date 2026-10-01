import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runPerpsReplay, type PerpsReplayProducer } from "./backtest";
import { buildPerpsBrainRequest, perpsBrainEstimatedCostBps, PERPS_BRAIN_STRATEGY_VERSION, type PerpsBrainRequest, type PerpsBrainResponse } from "./brain";
import { mergeBrainSourceFrames, recordedBrainProducer, verifiedBrainRunIds, type RecordedPerpsBrainDecision } from "./replay-brain";
import { captureFeedSample, framesFromRecording, parseFeedRecording, recordPublicFeed, replayFrameHash } from "./replay-recorder";
import { evaluatePerpsWalkForward, type ReplayEvaluationPlan } from "./replay-evaluation";
import { scoreRecordedPerpsForecasts } from "./replay-forecast";
import { replayTestFrame, REPLAY_TEST_START as start } from "./testkit-replay";
import { breakout } from "./testkit-perps";
import { buildExitDraft } from "./drafts";
import { FEED_CANDLE_MS, type LighterFeedFile } from "./feed-reader";

const version = PERPS_BRAIN_STRATEGY_VERSION;
const config = { initialCashUsdg: 100, settings: { perpsMarkets: ["BTC-PERP" as const] } };
function frame(atMs = start, mark = 805000n) {
  const f = replayTestFrame(atMs, mark);
  // Thirty three-bar, non-overlapping analogs require a full 100-bar
  // feature warmup plus ninety outcome bars.
  (f.feed as LighterFeedFile).markets["1"]!.closed4h = breakout("BTC-PERP", 5000n, 200n, 190)
    .map(c => ({ t: c.t, o: String(c.o), h: String(c.h), l: String(c.l), c: String(c.c) }));
  return f;
}
function decision(atMs = start): RecordedPerpsBrainDecision {
  let request: PerpsBrainRequest | null = null;
  const context = "recorded-context";
  runPerpsReplay(config, [frame(atMs)], { id: "capture", tick({ frame, feed, view, trend }) {
    assert.ok(view && trend.entry && trend.entryCandleT !== null);
    request = buildPerpsBrainRequest({ agentId: "0x1111111111111111111111111111111111111111", runId: "recorded-run", nowMs: frame.atMs,
      context, view, candidate: trend.entry, candleT: trend.entryCandleT, feed });
    return { ...trend, entry: null, entryCandleT: null };
  } });
  assert.ok(request);
  const r = request as PerpsBrainRequest;
  const response: PerpsBrainResponse = {
    schema_version: r.schema_version, run_id: r.run_id, agent_id: r.agent_id, snapshot_id: r.snapshot_id,
    market: r.market, as_of_ms: r.as_of_ms, expires_at_ms: r.expires_at_ms, strategy_version: version,
    candidate_bar_t: r.candidate.bar_t, candidate_side: r.candidate.side, action: r.candidate.side,
    reason_codes: ["fixture-approval"], features: {},
    forecast: { method: "causal-regime-analogs-v1", horizon_bars: 3, target: "signed-mark-return-after-estimated-costs",
      samples: 30, win_probability: 0.8, lower_95: 0.6269430358685175, upper_95: 0.9049489282271013,
      mean_net_bps: 20, mean_lower_95_bps: 5, cost_bps: perpsBrainEstimatedCostBps(r), calibrated: false },
    committee: ["bull", "bear", "risk"].map(lens => ({ lens, verdict: "accept", reason: "Synthetic acceptance for boundary tests" })),
  };
  return { sourceFrameSha256: replayFrameHash(frame(atMs)), context, request: r, response, completedAtMs: atMs + 5_000 };
}

test("recorded approval waits for a later frame after completion and uses that frame's price", () => {
  const d = decision();
  const r = runPerpsReplay(config, [frame(), frame(start + 2_000), frame(start + 6_000, 804900n)], recordedBrainProducer([d], version));
  const opens = r.events.filter(e => e.kind === "open");
  assert.equal(opens.length, 1);
  assert.equal(opens[0]!.atMs, start + 6_000);
  assert.equal(r.tailPositions[0]!.entryPrice, 804901n);
  assert.equal(r.metrics.completedTrades, 0);
  assert.equal(r.metrics.winRate, null);
  assert.ok(r.metrics.openBookedNetMicro < 0n);
});

test("source, run, market, candle, response version and completion expiry are binding", () => {
  const mutations: ((d: RecordedPerpsBrainDecision) => void)[] = [
    d => { d.sourceFrameSha256 = "0".repeat(64); },
    d => { d.context = "different-context"; },
    d => { d.request.snapshot_id = "0".repeat(64); },
    d => { d.response!.run_id = "another-run"; },
    d => { d.response!.market = "ETH-PERP"; },
    d => { d.response!.candidate_bar_t -= FEED_CANDLE_MS; },
    d => { d.response!.strategy_version = "foreign-version"; },
    d => { d.completedAtMs = d.request.expires_at_ms; },
  ];
  for (const mutate of mutations) {
    const d = decision(); mutate(d);
    const r = runPerpsReplay(config, [frame(), frame(start + 6_000), frame(start + 121_000)], recordedBrainProducer([d], version));
    assert.equal(r.events.filter(e => e.kind === "open").length, 0);
  }
  assert.throws(() => recordedBrainProducer([decision(), decision()], version), /duplicate/);
  const duplicateTime = decision(); duplicateTime.request.run_id = "other-run";
  assert.throws(() => recordedBrainProducer([decision(), duplicateTime], version), /request clocks/);
});

test("HOLD, missing approval and changed market never fall back to an ungated entry", () => {
  const d = decision(); d.response!.action = "hold";
  assert.equal(runPerpsReplay(config, [frame(), frame(start + 6_000)], recordedBrainProducer([d], version)).tailPositions.length, 0);
  assert.equal(runPerpsReplay(config, [frame(), frame(start + 6_000)], recordedBrainProducer([], version)).tailPositions.length, 0);
  assert.equal(runPerpsReplay(config, [frame(), frame(start + 6_000, 810000n)], recordedBrainProducer([decision()], version)).tailPositions.length, 0);
});

test("an impossible overlapping review cannot resurrect an old approval after a newer HOLD", () => {
  const old = decision(), newer = decision(start + 1_000);
  old.completedAtMs = start + 8_000;
  newer.request.run_id = newer.response!.run_id = "newer-hold";
  newer.response!.action = "hold";
  newer.completedAtMs = start + 3_000;
  assert.throws(() => recordedBrainProducer([old, newer], version), /cannot overlap/);
  const sequential = decision(start + 8_000);
  sequential.request.run_id = sequential.response!.run_id = "sequential-hold";
  sequential.response!.action = "hold";
  assert.doesNotThrow(() => recordedBrainProducer([old, sequential], version));
});

test("exact journal source frames join polling captures without overwriting different observations", () => {
  const d = decision(); d.sourceFrame = frame();
  const frames = mergeBrainSourceFrames([frame(start + 6_000)], [d]);
  assert.deepEqual(frames.map(f => f.atMs), [start, start + 6_000]);
  assert.equal(runPerpsReplay(config, frames, recordedBrainProducer([d], version)).tailPositions.length, 1);
  assert.throws(() => mergeBrainSourceFrames([frame(start, 804990n)], [d]), /conflicting/);
  assert.throws(() => mergeBrainSourceFrames([frame(start + 1), frame()], []), /increase/);
  d.sourceFrame = frame(start + 1);
  assert.throws(() => mergeBrainSourceFrames([], [d]), /mismatch/);
});

test("higher aggregate costs or insufficient liquidity withhold an in-flight approval", () => {
  for (const mutate of [
    (m: LighterFeedFile["markets"][string]) => { m.takerFeePpm += 1; },
    (m: LighterFeedFile["markets"][string]) => { m.fundingRatePctPerHour = "0.0011"; },
    (m: LighterFeedFile["markets"][string]) => { m.asks[0]![1] = "1"; },
  ]) {
    const later = frame(start + 6_000); mutate((later.feed as LighterFeedFile).markets["1"]!);
    const result = runPerpsReplay(config, [frame(), later], recordedBrainProducer([decision()], version));
    assert.equal(result.tailPositions.length, 0);
  }
});

test("appending future responses cannot change the earlier replay and stops remain independent", () => {
  const d = decision();
  const prefix = [frame(), frame(start + 6_000)];
  const a = runPerpsReplay(config, prefix, recordedBrainProducer([d], version));
  const stop = a.tailPositions[0]!.stop!;
  const b = runPerpsReplay(config, [...prefix, frame(start + 3_600_000, stop.trigger - 1n)], recordedBrainProducer([d], version));
  assert.deepEqual(a.curve, b.curve.slice(0, a.curve.length));
  assert.equal(b.metrics.completedTrades, 1);
  assert.equal(b.metrics.losses, 1);
  assert.equal(b.completedTrades[0]!.netMicro, b.realizedMicro + b.fundingMicro - b.feesMicro);
  assert.equal(b.metrics.feesMicro, b.feesMicro);
  assert.equal(b.metrics.fundingMicro, b.fundingMicro);
  assert.equal(b.tailPositions.length, 0);
});

test("partial exits form one net trade and a gross winner losing after fees is a loss", () => {
  let ticks = 0;
  const producer: PerpsReplayProducer = { id: "accounting-test", tick({ trend, view, settings }) {
    ticks++;
    if (ticks === 1) return trend;
    const p = view!.positions.get("BTC-PERP")!, m = view!.markets.get("BTC-PERP")!;
    const exit = buildExitDraft({ market: m, position: p, effect: ticks === 2 ? "reduce" : "close",
      baseAmount: p.baseAmount / 2n, maxSlippageBps: settings.perpsMaxSlippageBps });
    assert.ok(exit);
    return { ...trend, entry: null, entryCandleT: null, exits: [exit] };
  } };
  const r = runPerpsReplay(config, [frame(), frame(start + 1_000, 805003n), frame(start + 2_000, 805003n)], producer);
  assert.equal(r.completedTrades.length, 1);
  assert.equal(r.completedTrades[0]!.fills, 3);
  assert.ok(r.realizedMicro > 0n);
  assert.ok(r.completedTrades[0]!.netMicro < 0n);
  assert.equal(r.metrics.wins, 0);
  assert.equal(r.metrics.losses, 1);
  assert.equal(r.metrics.expectancyMicro, r.finalEquityMicro! - r.initialCashMicro);
});

test("recording preserves raw/spec timestamps and a gap stops replay rather than disappearing", () => {
  const raw = JSON.stringify(frame().feed, null, 2);
  const first = captureFeedSample(raw, start, null);
  const gap = captureFeedSample(null, start + 1000, start);
  const third = captureFeedSample(JSON.stringify(frame(start + 2000).feed), start + 2000, start + 1000);
  assert.equal(first.rawFeed, raw);
  assert.equal(first.observedAtMs, start);
  assert.equal(gap.elapsedMs, 1000);
  const frames = framesFromRecording([first, gap, third]);
  const r = runPerpsReplay(config, frames);
  assert.equal(r.complete, false);
  assert.equal(r.failure?.atMs, start + 1000);
  assert.throws(() => framesFromRecording([{ ...first, rawFeed: `${raw} ` }, gap]), /hash/);
  assert.throws(() => framesFromRecording([first, { ...gap, previousReceivedAtMs: start - 1 }]), /chain/);
  const future = frame(start + 5000).feed;
  assert.equal(captureFeedSample(JSON.stringify(future), start, null).kind, "gap");
  assert.equal(runPerpsReplay(config, [{ atMs: start, feed: future }]).complete, false);
});

test("finite recorder uses only a local feed and refuses to overwrite its output", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "perps-recorder-"));
  const inputPath = path.join(dir, "feed.json"), outputPath = path.join(dir, "capture.jsonl");
  try {
    writeFileSync(inputPath, JSON.stringify(frame(Date.now()).feed));
    const result = await recordPublicFeed({ inputPath, outputPath, durationMs: 1 });
    assert.equal(result.samples, 1);
    const recording = parseFeedRecording(readFileSync(outputPath, "utf8"));
    assert.equal(recording.frames.length, 1);
    await assert.rejects(recordPublicFeed({ inputPath, outputPath, durationMs: 1 }), /EEXIST/);
    assert.ok(readFileSync(inputPath, "utf8").startsWith('{"v":1'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const plan = (): ReplayEvaluationPlan => ({ strategyVersion: version, frozenAtMs: start - 100_000,
  provenance: "synthetic", minimumCompletedTrades: 1, purgeMs: 43_200_000,
  folds: [{ trainEndMs: start - 43_200_000, testStartMs: start, testEndMs: start + 7_000 }] });
test("walk-forward requires chronological purged frozen folds and reports insufficient evidence", () => {
  const args = { config, frames: [frame(), frame(start + 6_000)], plan: plan(), producer: () => recordedBrainProducer([decision()], version) };
  const report = evaluatePerpsWalkForward(args);
  assert.equal(report.status, "insufficient-evidence");
  assert.equal(report.promotionAuthorized, false);
  assert.equal(report.folds[0]!.candidate!.metrics.openTrades, 1);
  assert.ok(report.reasons.includes("no-forward-capture-evidence"));
  assert.equal(report.pooledCompleted.candidate.maxDrawdownBps, null);
  assert.throws(() => evaluatePerpsWalkForward({ ...args, plan: { ...plan(), frozenAtMs: start + 1 } }), /frozen/);
  assert.throws(() => evaluatePerpsWalkForward({ ...args, plan: { ...plan(), purgeMs: 1 } }), /purge/);
  assert.throws(() => evaluatePerpsWalkForward({ ...args, plan: { ...plan(), folds: [...plan().folds, ...plan().folds] } }), /overlapping/);
  assert.throws(() => evaluatePerpsWalkForward({ ...args, producer: () => ({ id: "other", tick: i => i.trend }) }), /version/);
});

test("comparison includes the baseline's open gains instead of rewarding an earlier, smaller realized gain", () => {
  let ticks = 0;
  const report = evaluatePerpsWalkForward({ config, frames: [frame(), frame(start + 1_000, 806000n), frame(start + 2_000, 808000n)],
    plan: plan(), producer: () => ({ id: version, tick({ trend, view, settings }) {
      if (++ticks === 1) return trend;
      const position = view!.positions.get("BTC-PERP");
      const exit = position ? buildExitDraft({ market: view!.markets.get("BTC-PERP")!, position,
        effect: "close", maxSlippageBps: settings.perpsMaxSlippageBps }) : null;
      return { ...trend, entry: null, entryCandleT: null, exits: exit ? [exit] : [] };
    } }) });
  const fold = report.folds[0]!;
  assert.equal(fold.baseline!.metrics.completedTrades, 0);
  assert.equal(fold.baseline!.metrics.openTrades, 1);
  assert.equal(fold.candidate!.metrics.completedTrades, 1);
  assert.equal(fold.candidate!.metrics.wins, 1);
  assert.ok(report.pooledCompleted.candidate.netCompletedMicro > report.pooledCompleted.baseline.netCompletedMicro);
  assert.ok(report.pooledMarkedNetMicro.candidate! < report.pooledMarkedNetMicro.baseline!);
  assert.ok(report.reasons.includes("candidate-did-not-improve-marked-net-pnl"));
  for (const side of ["baseline", "candidate"] as const) {
    const replay = fold[side]!;
    assert.equal(report.pooledMarkedNetMicro[side], replay.realizedMicro + replay.fundingMicro - replay.feesMicro + replay.curve.at(-1)!.unrealizedMicro);
  }
});

test("incomplete or empty folds cannot supply partial marked returns to a comparison", () => {
  for (const frames of [[], [frame(), { atMs: start + 1_000, feed: null }]]) {
    const report = evaluatePerpsWalkForward({ config, frames, plan: plan(), producer: () => recordedBrainProducer([], version) });
    assert.equal(report.status, "insufficient-evidence");
    assert.deepEqual(report.pooledMarkedNetMicro, { baseline: null, candidate: null });
    assert.equal(report.promotionAuthorized, false);
  }
});

test("approval timing matrix never spends a future, expired or already consumed response", () => {
  for (const delay of [0, 1, 2_000, 5_000, 119_999, 120_000, 121_000]) {
    for (const sampleOffset of [1, 2_000, 6_000, 119_999, 120_000, 121_000]) {
      const d = decision();
      d.completedAtMs = start + delay;
      const frames = [frame(), frame(start + sampleOffset), frame(start + sampleOffset + 1)];
      const result = runPerpsReplay(config, frames, recordedBrainProducer([d], version));
      const opens = result.events.filter(e => e.kind === "open");
      const expected = frames.slice(1).find(f => f.atMs >= d.completedAtMs && f.atMs < d.request.expires_at_ms);
      assert.equal(opens.length, expected ? 1 : 0, `delay=${delay} sample=${sampleOffset}`);
      if (expected) assert.equal(opens[0]!.atMs, expected.atMs);
    }
  }
});

test("proxy forecasts need a later closed target and remain separate from realized wins", () => {
  const d = decision();
  const initialFrames = [frame(), frame(start + 6_000)];
  const replay = runPerpsReplay(config, initialFrames, recordedBrainProducer([d], version));
  const verified = verifiedBrainRunIds(replay.producerDiagnostics);
  assert.equal(scoreRecordedPerpsForecasts([d], initialFrames, verified).samples, 0);
  const targetT = d.request.candidate.bar_t + 3 * FEED_CANDLE_MS;
  const future = frame(targetT + FEED_CANDLE_MS + 1_000, 820000n);
  const m = (future.feed as LighterFeedFile).markets["1"]!;
  const candles = m.closed4h!;
  for (let i = 1; i <= 3; i++) candles.push({ t: d.request.candidate.bar_t + i * FEED_CANDLE_MS, o: "805000", h: "820000", l: "805000", c: "820000" });
  const scored = scoreRecordedPerpsForecasts([d], [...initialFrames, future], verified);
  assert.equal(scored.samples, 1);
  assert.equal(scored.outcomes[0]!.positive, true);
  assert.ok(Math.abs(scored.brierScore! - 0.04) < 1e-12);
  assert.equal(scored.calibrated, false);
  assert.equal(replay.metrics.completedTrades, 0);
  assert.equal(scoreRecordedPerpsForecasts([d], [...initialFrames, future], new Set()).samples, 0);
  const smallGain = structuredClone(future);
  (smallGain.feed as LighterFeedFile).markets["1"]!.closed4h!.at(-1)!.c = "805100";
  const costly = scoreRecordedPerpsForecasts([d], [...initialFrames, smallGain], verified);
  assert.equal(costly.outcomes[0]!.positive, false, "the frozen proxy cost can turn a rising price into a negative target");
});

function forecastTarget(d: RecordedPerpsBrainDecision, close: bigint, observedOffset = 1_000) {
  const targetT = d.request.candidate.bar_t + 3 * FEED_CANDLE_MS;
  const future = frame(targetT + FEED_CANDLE_MS + observedOffset, close);
  const candles = (future.feed as LighterFeedFile).markets["1"]!.closed4h!;
  const high = close > 805000n ? close : 805000n, low = close < 805000n ? close : 805000n;
  for (let i = 1; i <= 3; i++) candles.push({ t: d.request.candidate.bar_t + i * FEED_CANDLE_MS,
    o: "805000", h: String(high), l: String(low), c: String(close) });
  return future;
}

test("forecast scoring keeps the first observed target even when a later candle revision reverses the outcome", () => {
  const d = decision(), verified = new Set([d.request.run_id]);
  const first = forecastTarget(d, 803000n), revised = forecastTarget(d, 820000n, 2_000);
  const scored = scoreRecordedPerpsForecasts([d], [frame(), first, revised], verified);
  assert.equal(scored.samples, 1);
  assert.equal(scored.outcomes[0]!.positive, false);
  assert.equal(scored.outcomes[0]!.observedAtMs, first.atMs);
  assert.deepEqual(scored, scoreRecordedPerpsForecasts([d], [frame(), first], verified));
});

test("future-stamped target data is ignored and a missing target is never forward-filled", () => {
  const d = decision(), verified = new Set([d.request.run_id]);
  const honest = forecastTarget(d, 803000n, 2_000), future = forecastTarget(d, 820000n);
  (future.feed as LighterFeedFile).observedAt = future.atMs + 1;
  const scored = scoreRecordedPerpsForecasts([d], [frame(), future, honest], verified);
  assert.equal(scored.samples, 1);
  assert.equal(scored.outcomes[0]!.positive, false);
  assert.equal(scored.outcomes[0]!.observedAtMs, honest.atMs);
  const missing = forecastTarget(d, 820000n);
  (missing.feed as LighterFeedFile).markets["1"]!.closed4h!.pop();
  assert.equal(scoreRecordedPerpsForecasts([d], [frame(), missing], verified).samples, 0);
});

test("HOLD forecasts remain measurable, but fabricated confidence or omitted costs cannot improve calibration", () => {
  const d = decision(); d.response!.action = "hold";
  const future = forecastTarget(d, 820000n), frames = [frame(), future], verified = new Set([d.request.run_id]);
  assert.equal(scoreRecordedPerpsForecasts([d], frames, verified).samples, 1);
  const mutations: ((f: PerpsBrainResponse["forecast"]) => void)[] = [
    f => { f.samples = 0; },
    f => { f.samples = 100; },
    f => { f.lower_95 = null; },
    f => { f.lower_95 = 0.99; },
    f => { f.win_probability = 0.98765; },
    f => { f.mean_net_bps = null; },
    f => { f.mean_lower_95_bps = f.mean_net_bps! + 1; },
    f => { f.cost_bps = 0; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(d); mutate(changed.response!.forecast);
    const score = scoreRecordedPerpsForecasts([changed], frames, verified);
    assert.equal(score.samples, 0);
    assert.equal(score.brierScore, null);
  }
});

test("offline CLI loads a hash-verified recording and exits 2 for insufficient evaluation evidence", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "perps-eval-cli-"));
  try {
    const samples = [captureFeedSample(JSON.stringify(frame().feed), start, null),
      captureFeedSample(JSON.stringify(frame(start + 6_000).feed), start + 6_000, start)];
    writeFileSync(path.join(dir, "capture.jsonl"), [
      JSON.stringify({ v: 1, kind: "header", source: "existing-public-lighter-feed", startedAtMs: start, intervalMs: 6_000 }),
      ...samples.map(s => JSON.stringify(s)), "",
    ].join("\n"));
    const inputPath = path.join(dir, "evaluation.json");
    writeFileSync(inputPath, JSON.stringify({ config, recording: "capture.jsonl", brainDecisions: [decision()], plan: plan() }));
    const cli = path.join(import.meta.dirname, "backtest-cli.ts");
    const evaluated = spawnSync(process.execPath, ["--import", "tsx", cli, "evaluate", inputPath], { encoding: "utf8" });
    assert.equal(evaluated.status, 2, evaluated.stderr);
    const result = JSON.parse(evaluated.stdout);
    assert.equal(result.promotionAuthorized, false);
    assert.equal(result.status, "insufficient-evidence");
    assert.equal(result.forecasts[0].samples, 0);
    writeFileSync(inputPath, JSON.stringify({ config, recording: "capture.jsonl" }));
    const replayed = spawnSync(process.execPath, ["--import", "tsx", cli, inputPath], { encoding: "utf8" });
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.equal(JSON.parse(replayed.stdout).strategy, "perp-trend");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
