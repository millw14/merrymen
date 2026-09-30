/** Predeclared chronological comparisons; never trains or promotes a strategy. */
import { PERP_TREND_MAX_HOLD_HOURS } from "../../../packages/core/src/perps";
import { runPerpsReplay, type PerpsReplayConfig, type PerpsReplayFrame, type PerpsReplayProducer } from "./backtest";
import { canonicalJson, sha256 } from "./replay-recorder";
import { replayTradeMetrics } from "./replay-metrics";

export interface ReplayEvaluationPlan {
  strategyVersion: string;
  /** Time the candidate/rules were frozen, before the first evaluated interval. */
  frozenAtMs: number;
  provenance: "forward-capture" | "historical-reconstruction" | "synthetic";
  /** Maximum outcome/trade horizon used for fitting. Defaults to the 168 h trade maximum. */
  purgeMs?: number;
  minimumCompletedTrades?: number;
  folds: readonly { trainEndMs: number; testStartMs: number; testEndMs: number }[];
}

export const EVALUATION_LIMITS = [
  "A supplied freeze timestamp is metadata, not independent proof that a strategy was fixed in advance.",
  "Each test interval starts flat with identical capital and risk limits. No position is force-closed at its end.",
  "Completed-trade wins include entry/exit fees and booked funding. Open tails are never counted as wins.",
  "Sampled replay cannot establish live profitability; latency, impact and intrabar crossings remain unmodelled.",
  "Historical LLM tests may leak outcomes through pretrained knowledge. Newly captured forward evidence is required.",
  "Sample sufficiency is not statistical significance or a deployment/promotion decision.",
] as const;

export function evaluatePerpsWalkForward(args: {
  config: PerpsReplayConfig;
  frames: readonly PerpsReplayFrame[];
  plan: ReplayEvaluationPlan;
  producer: (testFrames: readonly PerpsReplayFrame[]) => PerpsReplayProducer;
}) {
  const { plan } = args;
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const purgeMs = plan.purgeMs ?? PERP_TREND_MAX_HOLD_HOURS * 3_600_000;
  const minimumCompletedTrades = plan.minimumCompletedTrades ?? 100;
  // The new forecast's labels extend three closed 4 h bars into the future.
  if (!plan.strategyVersion?.trim() || !integer(plan.frozenAtMs) || !integer(purgeMs) || purgeMs < 43_200_000 ||
      !integer(minimumCompletedTrades) || minimumCompletedTrades < 1 || !plan.folds.length ||
      !["forward-capture", "historical-reconstruction", "synthetic"].includes(plan.provenance))
    throw new Error("invalid evaluation plan or purge shorter than the forecast horizon");
  let previousEnd = -1;
  for (const fold of plan.folds) {
    if (![fold.trainEndMs, fold.testStartMs, fold.testEndMs].every(integer) ||
        fold.testStartMs - fold.trainEndMs < purgeMs || fold.testEndMs <= fold.testStartMs ||
        fold.testStartMs < previousEnd || plan.frozenAtMs > fold.testStartMs)
      throw new Error("folds must be chronological, non-overlapping, purged and frozen before evaluation");
    previousEnd = fold.testEndMs;
  }
  let previousFrame = -1;
  for (const frame of args.frames) {
    if (!integer(frame.atMs) || frame.atMs <= previousFrame) throw new Error("frames must strictly increase");
    previousFrame = frame.atMs;
  }
  const folds = plan.folds.map(bounds => {
    const frames = args.frames.filter(f => f.atMs >= bounds.testStartMs && f.atMs < bounds.testEndMs);
    if (!frames.length) return { ...bounds, status: "insufficient-data" as const, snapshots: 0, baseline: null, candidate: null };
    const baseline = runPerpsReplay(args.config, frames);
    const producer = args.producer(frames);
    if (producer.id !== plan.strategyVersion) throw new Error("producer version differs from the frozen evaluation plan");
    const candidate = runPerpsReplay(args.config, frames, producer);
    const status = !baseline.complete || !candidate.complete ? "incomplete" as const :
      baseline.metrics.completedTrades < minimumCompletedTrades || candidate.metrics.completedTrades < minimumCompletedTrades ?
        "insufficient-data" as const : "measured" as const;
    return { ...bounds, status, snapshots: frames.length, baseline, candidate };
  });
  const completed = (side: "baseline" | "candidate") => folds.flatMap(f => f[side]?.completedTrades ?? []);
  const pooled = (side: "baseline" | "candidate") => replayTradeMetrics({ completed: completed(side), open: folds.flatMap(f => f[side]?.openTrades ?? []),
    initialCashMicro: 0n, curve: [], complete: folds.every(f => f[side]?.complete) });
  const baseline = pooled("baseline"), candidate = pooled("candidate");
  const reasons: string[] = [];
  if (plan.provenance !== "forward-capture") reasons.push("no-forward-capture-evidence");
  if (folds.some(f => f.status === "incomplete")) reasons.push("incomplete-replay");
  if (folds.some(f => f.status === "insufficient-data")) reasons.push("insufficient-completed-trades-per-fold");
  if (folds.length < 3) reasons.push("fewer-than-three-independent-test-intervals");
  if (candidate.netCompletedMicro <= 0n) reasons.push("candidate-net-expectancy-not-positive");
  if (candidate.netCompletedMicro <= baseline.netCompletedMicro) reasons.push("candidate-did-not-improve-net-completed-pnl");
  return {
    status: reasons.length ? "insufficient-evidence" : "requires-forward-risk-review",
    /** This report is never automatic authority to enable or promote live trading. */
    promotionAuthorized: false,
    reasons, strategyVersion: plan.strategyVersion, plan: { ...plan, purgeMs, minimumCompletedTrades },
    datasetSha256: sha256(canonicalJson(args.frames)), assumptions: EVALUATION_LIMITS, folds,
    pooledCompleted: {
      baseline: { ...baseline, maxDrawdownBps: null }, candidate: { ...candidate, maxDrawdownBps: null },
      drawdown: "reported per fold; independent resets cannot form one continuous equity curve",
    },
  };
}
