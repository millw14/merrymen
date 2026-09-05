/**
 * THE SHADOW PATH: a Merryman thinks, and nothing happens.
 *
 * worker state → buildPortfolioSnapshot() → trigger → Brain → persist.
 *
 * EXECUTION IS DISCONNECTED BY ABSENCE, not by a flag. This module does not
 * import proposalsToIntents, checkPolicy, simulate or the executor, and nothing
 * it returns is shaped like an intent. A future version that connects execution
 * has to ADD an import, which is a reviewable act; a flag would be one edit by
 * someone who did not read this comment.
 *
 * THE SNAPSHOT IS BUILT BY CORE. `buildPortfolioSnapshot` is the only place
 * equity and P&L are computed, and this file passes it inputs rather than
 * arithmetic. Every figure Brain sees can be traced to one snapshot id.
 *
 * TRIGGER STATE IS DURABLE, and that is deliberate rather than tidy. The
 * accounting work spent weeks on a bug whose whole shape was "a redeploy makes
 * the child forget, so it books the same thing again" — and an AI budget has
 * exactly the same failure available to it. A child that forgot its cooldowns
 * would re-fire every reason on every deploy.
 */
import {
  buildPortfolioSnapshot,
  type PortfolioQuality,
  type PortfolioSnapshot,
  type SnapshotPosition,
} from "../../packages/core/src/index";
import { decide, type BrainConfig, type BrainDecision, type BrainResult } from "./brain-client";
import {
  afterFiring,
  DEFAULT_TRIGGERS,
  EMPTY_TRIGGER_STATE,
  shouldWake,
  type TriggerInputs,
  type TriggerState,
  type TriggerVerdict,
} from "./brain-trigger";
import { addDecision, addEvent, loadTriggerState, newDecisionId, saveTriggerState } from "./store";

/**
 * How long after a COLD start the first run may happen.
 *
 * A child's sqlite is wiped by every redeploy, so a cold start is common and
 * says nothing about whether Brain ran recently. Two choices were available and
 * both are wrong on their own: treat cold as "never ran" and every deploy fires
 * every reason for every agent; treat it as "just ran" and a fresh agent waits
 * four hours to think for the first time.
 *
 * So a cold start seeds the cooldowns as though Brain ran
 * `scheduledIntervalSec - COLD_START_DELAY_SEC` ago: the first run comes a
 * couple of minutes in, and a redeploy costs AT MOST one run per enabled agent
 * rather than one per reason per agent.
 */
const COLD_START_DELAY_SEC = 120;

export interface ShadowInputs {
  agentId: string;
  now: number;
  epoch: number;
  /** Micro-USDG, straight off the tick. */
  cashUsdg: number;
  vaultUsdg: number;
  quarantinedUsdg: number;
  positions: SnapshotPosition[];
  netContributionsUsdg: number | null;
  grossContributionsUsdg: number | null;
  grossWithdrawalsUsdg: number | null;
  gasUsdg: number | null;
  quality: PortfolioQuality;
  /** The instrument this run is about, and what the lenses can see. */
  market: {
    instrumentId: string;
    symbol: string;
    instrumentClass: "equity-token" | "crypto-native" | "memecoin" | "stablecoin";
    priceUsd: string | null;
    signals: Record<string, string>;
  };
  persona?: string;
  memory?: string[];
  /** Set when a person asked. Bypasses the movement thresholds, not the budget. */
  userRequested?: boolean;
  /** A stable identity for the newest material news item, or null. */
  newsKey?: string | null;
}

export type ShadowOutcome =
  | { ran: false; why: string; trigger: TriggerVerdict }
  | { ran: true; trigger: TriggerVerdict; snapshot: PortfolioSnapshot; result: BrainResult };

/**
 * A snapshot id that IS the state it describes.
 *
 * Content-addressed rather than random, so two runs over identical inputs carry
 * the same id and a decision can be traced to exactly what Brain saw — a random
 * id would only say WHEN, which is the question nobody asks afterwards.
 */
export function snapshotId(agentId: string, asOf: number, parts: (string | number | null)[]): string {
  let h = 0x811c9dc5;
  for (const ch of `${agentId}|${asOf}|${parts.join("|")}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `snap_${asOf}_${h.toString(16).padStart(8, "0")}`;
}

/** Assemble the canonical snapshot. NOTHING is computed here — core does it. */
export function buildShadowSnapshot(i: ShadowInputs): PortfolioSnapshot {
  return buildPortfolioSnapshot({
    snapshotId: snapshotId(i.agentId, i.now, [
      i.cashUsdg,
      i.vaultUsdg,
      i.quarantinedUsdg,
      i.netContributionsUsdg,
      i.epoch,
      i.positions.map((p) => `${p.symbol}:${p.valueUsdg}`).join(","),
    ]),
    agentId: i.agentId,
    asOf: i.now,
    epoch: i.epoch,
    cashUsdg: i.cashUsdg,
    vaultUsdg: i.vaultUsdg,
    quarantinedUsdg: i.quarantinedUsdg,
    netContributionsUsdg: i.netContributionsUsdg,
    grossContributionsUsdg: i.grossContributionsUsdg,
    grossWithdrawalsUsdg: i.grossWithdrawalsUsdg,
    gasUsdg: i.gasUsdg,
    positions: i.positions,
    quality: i.quality,
  });
}

/**
 * Run one shadow decision, if anything is worth thinking about.
 *
 * Returns without calling Brain when the trigger says nothing changed — which
 * is the common case and the whole reason the trigger exists.
 */
export async function runShadow(
  cfg: BrainConfig | null,
  i: ShadowInputs,
  log: (m: string) => void,
): Promise<ShadowOutcome> {
  const idle: TriggerVerdict = { fire: false, reason: null, detail: "brain not configured", candidates: [] };
  if (!cfg || !cfg.url || !cfg.token) {
    // ABSENT MEANS ABSENT. Not "fall back to the local strategist" — a feed that
    // attributed a thesis to Brain when a different reasoner wrote it would be
    // lying about provenance, and provenance is the product.
    return { ran: false, why: "brainUrl/brainToken not configured", trigger: idle };
  }

  const snapshot = buildShadowSnapshot(i);

  // The stored blob is validated rather than cast: a row written by an older
  // build, or a half-written one, must degrade to a cold start rather than
  // producing a TriggerState with undefined baselines that compare as "no move".
  const stored = readTriggerState(await loadTriggerState(i.agentId));
  const state: TriggerState = stored ?? coldStart(i.now);
  if (!stored) {
    log(
      `[brain] cold start — cooldowns seeded so the first run lands in ~${COLD_START_DELAY_SEC}s ` +
        `and a redeploy costs at most one run`,
    );
  }

  const triggerInput: TriggerInputs = {
    now: i.now,
    priceUsd: i.market.priceUsd === null ? null : Number(i.market.priceUsd),
    equityUsdg: snapshot.equityUsdg,
    newsKey: i.newsKey ?? null,
    userRequested: i.userRequested ?? false,
  };

  const trigger = shouldWake(state, triggerInput);
  if (!trigger.fire) {
    // Persist anyway when this is the first sighting, so a cold start's seeded
    // cooldowns survive the next restart rather than being re-seeded forever.
    if (!stored) await saveTriggerState(i.agentId, state);
    return { ran: false, why: trigger.detail, trigger };
  }

  // THE STATE IS SAVED BEFORE THE CALL, not after.
  //
  // A crash between the call and the save would otherwise leave the cooldown
  // unset, and the next tick would ask again — paying twice for one situation.
  // Saving first means a crash costs one wasted run at most, and the failure
  // direction is "thought once and lost it" rather than "thinks forever".
  await saveTriggerState(i.agentId, afterFiring(state, trigger.reason!, triggerInput));

  const runId = `brain_${i.agentId.slice(2, 10)}_${i.now}`;
  const triggerId = `${trigger.reason}_${i.now}`;
  log(
    `[brain] waking — ${trigger.detail} · snapshot ${snapshot.snapshotId} · ` +
      `quality epoch=${snapshot.quality.epoch} contributionsKnown=${snapshot.quality.contributionsKnown} ` +
      `pnlPublishable=${snapshot.pnl.publishable}`,
  );

  const result = await decide(cfg, {
    runId,
    agentId: i.agentId,
    triggerId,
    snapshot,
    market: {
      snapshot_id: snapshot.snapshotId,
      as_of: i.now,
      instrument_id: i.market.instrumentId,
      symbol: i.market.symbol,
      instrument_class: i.market.instrumentClass,
      price_usd: i.market.priceUsd,
      signals: i.market.signals,
    },
    persona: i.persona,
    memory: i.memory,
    tier: "research",
  });

  await persist(i.agentId, runId, triggerId, trigger, snapshot, result, log);
  return { ran: true, trigger, snapshot, result };
}

/** Parse a stored blob, or say it is unusable. A partial state is not a state. */
function readTriggerState(raw: Record<string, unknown> | null): TriggerState | null {
  if (!raw || typeof raw !== "object") return null;
  const fired = raw.lastFiredAt;
  if (!fired || typeof fired !== "object") return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    lastFiredAt: fired as TriggerState["lastFiredAt"],
    lastPriceUsd: num(raw.lastPriceUsd),
    lastEquityUsdg: num(raw.lastEquityUsdg),
    lastNewsKey: typeof raw.lastNewsKey === "string" ? raw.lastNewsKey : null,
  };
}

function coldStart(now: number): TriggerState {
  const seeded = now - DEFAULT_TRIGGERS.scheduledIntervalSec + COLD_START_DELAY_SEC;
  return {
    ...EMPTY_TRIGGER_STATE,
    lastFiredAt: {
      "scheduled-review": seeded,
      "price-move": seeded,
      "portfolio-change": seeded,
      "news-event": seeded,
      "user-request": seeded,
    },
  };
}

/**
 * Write the decision into the SAME substrate every other decision uses.
 *
 * Not a shadow table. When execution is eventually connected, a trade links to
 * this row by `decision_id` exactly as a strategist trade already does — and the
 * social thesis is read from it rather than generated separately. One decision,
 * two readings; that is the product invariant.
 */
async function persist(
  agentId: string,
  runId: string,
  triggerId: string,
  trigger: TriggerVerdict,
  snapshot: PortfolioSnapshot,
  result: BrainResult,
  log: (m: string) => void,
): Promise<void> {
  if (!result.ok) {
    // A REFUSAL IS A RESULT, and it is recorded. The runs that produced nothing
    // are exactly the ones an unmeasured system loses track of, and they are
    // where the interesting failures live.
    const detail = result.kind === "refused" ? `${result.reason}: ${result.detail}` : result.detail;
    log(`[brain] no decision — ${result.kind} · ${detail}`);
    await addEvent(agentId, result.kind === "refused" ? "warn" : "err", `brain ${result.kind}: ${detail}`).catch(
      () => {},
    );
    await addDecision({
      id: newDecisionId(),
      agent_id: agentId,
      source: "brain-shadow",
      strategy: "brain",
      // undefined, not null: DecisionRow leaves these out entirely for a run
      // that produced no decision, which is a different row shape from one that
      // decided and happened to have no size.
      reason: `no decision (${result.kind}): ${detail}`,
      dropped_rule: `brain-${result.kind}`,
      signals_json: JSON.stringify({
        brain_run_id: runId,
        snapshot_id: snapshot.snapshotId,
        trigger_id: triggerId,
        trigger_reason: trigger.reason,
        quality: snapshot.quality,
        cost: result.kind === "refused" ? result.cost : null,
      }),
    }).catch(() => {});
    return;
  }

  const d: BrainDecision = result.decision;
  log(
    `[brain] ${d.action.toUpperCase()} ${d.symbol} conf=${d.confidence.toFixed(2)} ` +
      `delta=${d.suggested_delta_usdg} · depth=${d.depth_used}` +
      (d.escalation_reasons.length ? ` (escalated: ${d.escalation_reasons.join(", ")})` : "") +
      ` · ${d.cost.model_calls} calls ${d.cost.tokens_in + d.cost.tokens_out} tok ` +
      `$${d.cost.usd.toFixed(4)} ${result.seconds.toFixed(1)}s · decision ${d.decision_id}`,
  );

  await addDecision({
    id: d.decision_id,
    agent_id: agentId,
    // SHADOW IS NAMED IN THE SOURCE, so nothing downstream can mistake a
    // thought for an instruction. When execution connects, this becomes
    // "brain" and the change is visible in one place.
    source: "brain-shadow",
    strategy: "brain",
    provider: d.models[0]?.provider,
    model: d.models[0]?.model,
    symbol: d.symbol,
    action: d.action,
    size_usdg: d.suggested_delta_usdg / 1e6,
    // The model's own words — the thesis, which the feed publishes verbatim.
    reason: d.thesis,
    // NOT DROPPED. A shadow decision was not rejected by anything — it simply
    // has nowhere to go yet, and marking it dropped would make the tape read as
    // though policy had refused it.
    dropped_rule: undefined,
    signals_json: JSON.stringify({
      brain_run_id: runId,
      decision_id: d.decision_id,
      snapshot_id: snapshot.snapshotId,
      trigger_id: triggerId,
      trigger_reason: trigger.reason,
      trigger_detail: trigger.detail,
      instrument_id: d.instrument_id,
      confidence: d.confidence,
      suggested_delta_usdg: d.suggested_delta_usdg,
      target_position_usdg: d.target_position_usdg,
      evidence: d.evidence,
      risks: d.risks,
      invalidation: d.invalidation,
      bull_case: d.bull_case,
      bear_case: d.bear_case,
      time_horizon: d.time_horizon,
      tier: d.tier,
      depth_used: d.depth_used,
      escalation_reasons: d.escalation_reasons,
      candidate_action: d.candidate_action,
      cost: d.cost,
      models: d.models,
      latency_seconds: result.seconds,
      quality: snapshot.quality,
      pnl_publishable: snapshot.pnl.publishable,
      // EXPLICIT, so a reader of the tape never has to infer it. Until
      // execution is connected this is always zero, and a future non-zero is a
      // change someone made on purpose.
      executor_calls: 0,
      execution_connected: false,
    }),
  }).catch((e) => log(`[brain] decision write failed: ${e instanceof Error ? e.message : String(e)}`));
}
