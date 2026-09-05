/**
 * TALKING TO BRAIN, over the private network, with no way to be talked back into
 * anything dangerous.
 *
 * Mirrors research.ts and the browser client point for point, because those
 * exist for the identical reason and their shape is already load-bearing here:
 * a typed `{ok: …}` union rather than exceptions crossing the wire, an
 * AbortController set ABOVE the server's own timeout, a bounded read, and NO
 * RETRIES.
 *
 * The no-retry rule is the one worth restating. A Brain run costs real tokens
 * and takes tens of seconds; a client that retries a timeout has not recovered
 * anything, it has bought the same decision twice and doubled the bill. If Brain
 * did not answer, the trigger that woke it will fire again on its own schedule.
 *
 * WHAT THIS CLIENT WILL NOT DO, and the service could not make it:
 *   - resolve a symbol to an address (that is the trusted TS adapter's job, and
 *     it is deliberately not called from here);
 *   - construct calldata or a target;
 *   - hand Brain a session key, an owner key, a bundler key or DATABASE_URL.
 *
 * The decision that comes back is DATA. It is persisted and it may be published
 * as a thesis. It does not reach proposalsToIntents, checkPolicy or the executor
 * — there is no code path from here to any of them, and that absence is the
 * shadow-mode guarantee rather than a flag someone could flip.
 */
import type { PortfolioSnapshot } from "../../packages/core/src/index";

/** What Brain answered, as a closed union. An exception is not an answer. */
export type BrainResult =
  | { ok: true; decision: BrainDecision; seconds: number }
  | { ok: false; kind: "refused"; reason: string; detail: string; cost: BrainCost }
  | { ok: false; kind: "unreachable"; detail: string }
  | { ok: false; kind: "malformed"; detail: string };

export interface BrainCost {
  model_calls: number;
  tokens_in: number;
  tokens_out: number;
  usd: number;
}

export interface BrainDecision {
  schema_version: string;
  decision_id: string;
  agent_id: string;
  created_at: number;
  trigger_id: string | null;
  action: "buy" | "sell" | "hold";
  instrument_id: string;
  symbol: string;
  confidence: number;
  suggested_delta_usdg: number;
  target_position_usdg: number | null;
  thesis: string;
  evidence: { source: string; ref: string; claim: string }[];
  bull_case: string;
  bear_case: string;
  risks: string[];
  invalidation: string[];
  time_horizon: string;
  tier: string;
  depth_used: string;
  escalation_reasons: string[];
  candidate_action: string | null;
  cost: BrainCost;
  models: { node: string; provider: string; model: string }[];
}

export interface BrainConfig {
  url: string;
  token: string;
  /** Above the server's own ceiling, so the server's timeout wins and reports. */
  timeoutMs?: number;
}

/** Bytes we will read from Brain. A decision is a few KB; anything larger is a bug. */
const MAX_BYTES = 256 * 1024;

/**
 * ADDRESS-SHAPED ANYTHING IS REJECTED AT THE CLIENT TOO.
 *
 * Brain's schema already refuses it, and this checks again — not from distrust
 * of that validator but because the two failures are different: the schema stops
 * Brain EMITTING one, and this stops the worker ACCEPTING one from a service
 * that might one day be a different build than we think. A defence that lives
 * only on the far side of a network boundary is a defence you cannot audit from
 * here.
 */
const ADDRESS = /0x[0-9a-fA-F]{40}/;
const HEXBLOB = /0x[0-9a-fA-F]{16,}/;

function carriesExecutable(d: BrainDecision): string | null {
  const fields: [string, string][] = [
    ["instrument_id", d.instrument_id],
    ["symbol", d.symbol],
    ["thesis", d.thesis],
    ["bull_case", d.bull_case],
    ["bear_case", d.bear_case],
    ["time_horizon", d.time_horizon],
    ...d.risks.map((r, i) => [`risks[${i}]`, r] as [string, string]),
    ...d.invalidation.map((r, i) => [`invalidation[${i}]`, r] as [string, string]),
    ...d.evidence.flatMap((e, i) => [
      [`evidence[${i}].source`, e.source],
      [`evidence[${i}].ref`, e.ref],
      [`evidence[${i}].claim`, e.claim],
    ] as [string, string][]),
  ];
  for (const [name, v] of fields) {
    if (typeof v !== "string") continue;
    if (ADDRESS.test(v)) return `${name} carries an address`;
    if (HEXBLOB.test(v)) return `${name} carries a hex blob`;
  }
  return null;
}

export interface DecideArgs {
  runId: string;
  agentId: string;
  triggerId: string;
  snapshot: PortfolioSnapshot;
  market: {
    snapshot_id: string;
    as_of: number;
    instrument_id: string;
    symbol: string;
    instrument_class: "equity-token" | "crypto-native" | "memecoin" | "stablecoin";
    price_usd: string | null;
    signals: Record<string, string>;
  };
  persona?: string;
  memory?: string[];
  tier?: "pulse" | "research" | "deep";
}

/**
 * Ask Brain to think. One call, no retry, bounded read.
 *
 * The snapshot goes over the wire AS CORE BUILT IT — not re-derived, not
 * re-summed, not converted to floats on the way. Brain carries those figures;
 * the moment this function starts reshaping them there are two NAV
 * implementations again.
 */
export async function decide(cfg: BrainConfig, args: DecideArgs): Promise<BrainResult> {
  if (!cfg.url || !cfg.token) {
    // FAIL CLOSED. An unconfigured Brain is not a Brain that says hold; it is a
    // Brain that was never asked, and the caller must be able to tell.
    return { ok: false, kind: "unreachable", detail: "brainUrl or brainToken is not configured" };
  }

  const body = {
    schema_version: "1.0.0",
    run_id: args.runId,
    agent_id: args.agentId,
    trigger_id: args.triggerId,
    portfolio: snapshotToRequest(args.snapshot),
    market: args.market,
    persona: args.persona ?? "",
    memory: args.memory ?? [],
    tier: args.tier ?? "research",
    // ADAPTIVE IS THE DEFAULT, on measured evidence: on 36 scenarios it scored
    // 28/36 against the full committee's 27/36, for 58% of the cost.
    stages: "adaptive",
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs ?? 90_000);
  let res: Response;
  try {
    res = await fetch(`${cfg.url.replace(/\/$/, "")}/v1/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    return { ok: false, kind: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok && res.status !== 200) {
    return { ok: false, kind: "unreachable", detail: `brain returned HTTP ${res.status}` };
  }

  let payload: Record<string, unknown>;
  try {
    const text = await readBounded(res, MAX_BYTES);
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, kind: "malformed", detail: e instanceof Error ? e.message : String(e) };
  }

  if (payload.ok === false && payload.refusal) {
    const r = payload.refusal as { reason?: string; detail?: string; cost?: BrainCost };
    return {
      ok: false,
      kind: "refused",
      reason: String(r.reason ?? "unknown"),
      detail: String(r.detail ?? ""),
      cost: r.cost ?? { model_calls: 0, tokens_in: 0, tokens_out: 0, usd: 0 },
    };
  }

  const decision = payload.decision as BrainDecision | undefined;
  if (!decision || typeof decision.action !== "string" || typeof decision.thesis !== "string") {
    return { ok: false, kind: "malformed", detail: "response carried no usable decision" };
  }

  const bad = carriesExecutable(decision);
  if (bad) {
    // REFUSE THE WHOLE DECISION, not just the offending field. A decision that
    // tried to smuggle an address is not one to salvage — thesis-policy.ts makes
    // the same call for the same reason, dropping a whole post rather than
    // redacting it.
    return { ok: false, kind: "malformed", detail: `refusing a decision that ${bad}` };
  }

  return { ok: true, decision, seconds: Number(payload.seconds ?? 0) };
}

/** The canonical snapshot, renamed for Brain's request shape. NOTHING is recomputed. */
function snapshotToRequest(s: PortfolioSnapshot) {
  return {
    snapshot_id: s.snapshotId,
    as_of: s.asOf,
    cash_usdg: s.cashUsdg,
    equity_usdg: s.equityUsdg,
    net_contributions_usdg: s.netContributionsUsdg,
    positions: s.positions.map((p) => ({
      instrument_id: p.instrumentId,
      symbol: p.symbol,
      qty: p.qtyRaw,
      value_usdg: p.valueUsdg,
      cost_basis_usdg: p.costBasisUsdg,
    })),
    quality: {
      audit_passed: s.quality.auditPassed,
      epoch: s.quality.epoch,
      contributions_known: s.quality.contributionsKnown,
      equity_complete: s.quality.equityComplete,
      gas_basis: s.quality.gasBasis,
      position_history_available: s.quality.positionHistoryAvailable,
      quarantined_assets_present: s.quality.quarantinedAssetsPresent,
    },
    // CORE'S VERDICT, carried. Brain defers to this rather than re-deciding.
    pnl_publishable: s.pnl.publishable,
    pnl_unavailable: s.pnl.unavailable,
  };
}

async function readBounded(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error(`brain response exceeded ${max} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(
    chunks.reduce((acc, c) => {
      const out = new Uint8Array(acc.length + c.length);
      out.set(acc);
      out.set(c, acc.length);
      return out;
    }, new Uint8Array()),
  );
}
