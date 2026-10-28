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
import { onchainIdIn, onchainIdsIn, type PortfolioSnapshot } from "../../packages/core/src/index";
import { strategyTermsWire, type StrategyTerms } from "./strategy-terms";

/**
 * Whether the caller's desk policy reached Brain. "withheld" when the caller
 * supplied one and it did not go — this Brain does not advertise the
 * capability yet, or the policy failed the wire bounds. Absent when the caller
 * supplied none. Recorded with the decision, so "did the terms change what the
 * desk decided?" is answerable from the ledger rather than from a deploy date.
 */
export type StrategyTermsDelivery = "sent" | "withheld";

/** What Brain answered, as a closed union. An exception is not an answer. */
export type BrainResult =
  | { ok: true; decision: BrainDecision; seconds: number; strategyTerms?: StrategyTermsDelivery }
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
  /**
   * Micro-USDG the manager expected this trade to MAKE. Model-written, and
   * treated as such: nothing sizes from it, and it exists so the economics can
   * be checked against what actually happened rather than argued about.
   */
  expected_edge_usdg?: number;
  /**
   * Would this trade have paid for itself? Advisory — nothing enforces it while
   * shadow mode is still observing. "unknown" whenever either side of the
   * comparison was missing, and unknown is never read as permission.
   */
  economics?: "viable" | "marginal" | "uneconomic" | "unknown";
  /** The marginal gas that verdict was reached against, micro-USDG. */
  expected_trade_gas_usdg?: number | null;
  /**
   * Where each lens landed, on every run rather than only escalated ones.
   *
   * Structure only — no `note`, no prose. The service drops the model's words
   * before sending, so nothing here needs the address backstop that `thesis`
   * needs, and nothing here grows with what a news source decided to write.
   * Optional because an older Brain build does not send it, and a decision that
   * arrives without the measurement is still a decision.
   */
  analyst_views?: {
    lens: string;
    direction: "buy" | "sell" | "hold" | "no-data";
    confidence: number;
    evidence_strength: number;
  }[];
  /**
   * WHAT THE PORTFOLIO GATE DECIDED — carried from the Brain, never re-derived.
   *
   * The gate lives in `services/brain/brain/gate.py` and that is where it stays:
   * a second implementation here is exactly what the canonical snapshot exists
   * to prevent, and it would be a second opinion on whether a book may be sized.
   * So the worker READS this and does not compute it.
   *
   * Optional because an older Brain build does not send it — and absent is
   * carried as absent rather than defaulted, because "the service did not say"
   * and "the gate was open" are different facts.
   */
  gate_verdict?: "proceed" | "downgrade-to-hold" | "refuse" | null;
  gate_why?: string | null;
  gate_caveat_count?: number | null;
  /**
   * WHY A HOLD WAS A HOLD. Null when the action was not a hold.
   *
   * `graph.py` applies a shut gate by overwriting `action, delta = "hold", 0`
   * after parsing, so without this a gate-forced hold and a model's own hold
   * are byte-identical. One agent held six times running and production could
   * not say which kind any of them were.
   */
  hold_kind?: "MODEL_HOLD" | "GATE_FORCED_HOLD" | null;
  /**
   * WHAT THE MODEL ASKED FOR, before the gate overwrote it.
   *
   * `hold_kind` says a hold was forced; it cannot say what was forced OUT —
   * and "the model wanted to buy and was not allowed to size it" is the one
   * fact the decision funnel most needs and could not see. Carried, never
   * acted on: `action` and `suggested_delta_usdg` remain the decision, and
   * nothing sizes from these. Optional and nullable because a Brain build
   * that predates them sends neither; absent stays absent and is never read
   * as "the model agreed".
   */
  proposed_action?: "buy" | "sell" | "hold" | null;
  /** Micro-USDG the model proposed before the gate, signed like `suggested_delta_usdg`. */
  proposed_delta_usdg?: number | null;
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
 *
 * SOLANA IDS TOO. A base58 key or signature, or a Solana explorer link, by the
 * shared detector (packages/core/src/ids.ts onchainIdsIn), which Brain mirrors
 * in services/brain/brain/onchain_ids.py. A second pass after the 0x patterns,
 * so a decision they refuse is refused in the same words as before. The glued
 * scan, as Brain's `_reject_executable` reads it: "CA<mint>" or "<mint>is" is
 * an id too (audit regressions F3).
 */
const ADDRESS = /0x[0-9a-fA-F]{40}/;
const HEXBLOB = /0x[0-9a-fA-F]{16,}/;
const GLUED = { glued: true } as const;
const SOLANA_SHAPE = {
  address: "a Solana address",
  hash: "a Solana signature or secret key",
  link: "a Solana explorer link",
} as const;

function solanaIdIn(v: string): string | null {
  const hit = onchainIdsIn(v, GLUED).find((h) => h.family === "solana");
  return hit ? SOLANA_SHAPE[hit.shape] : null;
}

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
  for (const [name, v] of fields) {
    if (typeof v !== "string") continue;
    const solana = solanaIdIn(v);
    if (solana) return `${name} carries ${solana}`;
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
    /** Marginal cost of the next trade, micro-USDG. Null = could not price it. */
    expected_trade_gas_usdg: number | null;
  };
  persona?: string;
  memory?: string[];
  tier?: "pulse" | "research" | "deep";
  /**
   * THE DESK'S OWN TERMS, rendered by strategy-terms.ts from repo code and
   * never from owner or market text — the type is branded so a string cannot
   * be passed here, and it is re-validated below because a brand can be
   * forged. Brain renders it as trusted DESK POLICY; `persona` stays the
   * fenced, untrusted brief. Omitted, the request is byte-for-byte today's.
   */
  strategyTerms?: StrategyTerms | null;
}

// ─── What this Brain build accepts ─────────────────────────────────────────

/** The /health capability that says `strategy_terms` and `horizon` are accepted. */
export const STRATEGY_TERMS_CAPABILITY = "strategy-terms";

/**
 * WHICH OPTIONAL DECIDE FIELDS THIS BRAIN ACCEPTS, read from GET /health
 * (`capabilities`). Brain's DecideRequest forbids unknown keys, so sending
 * `strategy_terms` to an older build is a 422 — and a 422 here arrives as
 * "unreachable" and costs the whole review, not just the terms.
 *
 * The same shape as fomo-child.ts's BrainLensProbe, for the same reasons:
 * false until known, at most one read an hour per URL, never on the review's
 * own clock (a review asks, gets the cached answer and, when due, starts a
 * read in the background), and a decide that 422s while carrying the fields
 * turns them off at once, because /health and /v1/decide can be served by
 * different builds during a rollback.
 *
 * A FAILED READ IS NOT AN ANSWER. Only a 2xx whose body parses as a JSON
 * object replaces what is cached, and then it is believed either way: an
 * older build's /health that lists no capabilities is a real "no". A network
 * error, a timeout, a non-2xx or an unparseable body keeps the last answer and
 * asks again after `retryMs` instead of the full hour. A read that lands in a
 * restart window, as one will on the deploy this channel needs, would
 * otherwise withhold every review's terms for an hour and fill the ledger with
 * "withheld" for a Brain that supports them. Real skew does not depend on this
 * path: it shows up as a 422 on decide, and that calls `invalidate`.
 *
 * FREE. /health is Brain's own unauthenticated status endpoint on the private
 * network: no model call, no vendor, nothing metered.
 *
 * THE SAME READ ANSWERS FOR A LENS KEY with `list: "lens_keys"`: Brain's
 * MarketState refuses a signals key it does not know, with the same 422 and
 * the same lost review (index.ts asks it before sending `onchain-flow`).
 */
export class BrainCapabilityProbe {
  private url = "";
  private checkedAt = Number.NEGATIVE_INFINITY;
  private value: ReadonlySet<string> = new Set();
  private inflight: Promise<void> | null = null;
  /** Bumped by `invalidate`: a read that started before it cannot restore the old answer. */
  private generation = 0;

  constructor(
    private readonly fetchImpl?: typeof fetch,
    private readonly now: () => number = Date.now,
    private readonly everyMs: number = 60 * 60_000,
    private readonly timeoutMs: number = 3_000,
    /** How soon a read that got no answer is retried. Still never on a review's clock. */
    private readonly retryMs: number = 60_000,
    /** Which /health list is read: decide fields (`capabilities`) or signals keys (`lens_keys`). */
    private readonly list: "capabilities" | "lens_keys" = "capabilities",
  ) {}

  advertises(brainUrl: string | null | undefined, capability: string): boolean {
    const u = typeof brainUrl === "string" ? brainUrl.trim().replace(/\/+$/, "") : "";
    if (!/^https?:\/\/\S+$/.test(u)) return false;
    if (u !== this.url) {
      this.url = u;
      this.checkedAt = Number.NEGATIVE_INFINITY;
      this.value = new Set();
    }
    const t = this.now();
    if (!this.inflight && t - this.checkedAt >= this.everyMs) {
      this.checkedAt = t;
      this.inflight = this.probe(u).finally(() => {
        this.inflight = null;
      });
    }
    return this.value.has(capability);
  }

  /**
   * A decide carrying the fields came back 422. Off NOW, for at least
   * `recheckAfterMs`, and back only when a /health read made after this moment
   * says so again.
   */
  invalidate(recheckAfterMs: number = 5 * 60_000): void {
    this.generation++;
    this.value = new Set();
    this.checkedAt = this.now() - this.everyMs + Math.max(0, recheckAfterMs);
  }

  /** Resolves when no read is in flight (tests, shutdown). */
  settled(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  private async probe(u: string): Promise<void> {
    const generation = this.generation;
    // NULL IS "NO ANSWER", which is not the same as an empty advert: see the
    // class header. Only a parsed object below sets it.
    let caps: ReadonlySet<string> | null = null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      const res = await (this.fetchImpl ?? fetch)(`${u}/health`, {
        method: "GET",
        signal: ctl.signal,
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const text = await res.text();
        if (text.length <= 64_000) {
          const j = JSON.parse(text) as unknown;
          if (j !== null && typeof j === "object" && !Array.isArray(j)) {
            const listed = (j as Record<string, unknown>)[this.list];
            caps = new Set(
              Array.isArray(listed) ? listed.filter((c): c is string => typeof c === "string" && c.length <= 64) : [],
            );
          }
        }
      } else {
        void res.body?.cancel().catch(() => {});
      }
    } catch {
      caps = null;
    } finally {
      clearTimeout(timer);
    }
    if (this.url !== u || this.generation !== generation) return;
    if (caps) {
      this.value = caps;
      return;
    }
    // KEEP THE LAST ANSWER, ASK AGAIN SOON. Never later than the hourly read
    // already due, so a short `everyMs` is not stretched by the retry.
    this.checkedAt = Math.min(this.checkedAt, this.now() - this.everyMs + Math.max(0, this.retryMs));
  }
}

/** The process's probe. One worker child talks to one Brain URL. */
export const brainCapabilities = new BrainCapabilityProbe();

export interface DecideDeps {
  /** Injected in tests; the process-wide probe otherwise. */
  capabilities?: Pick<BrainCapabilityProbe, "advertises" | "invalidate">;
}

/**
 * Ask Brain to think. One call, no retry, bounded read.
 *
 * The snapshot goes over the wire AS CORE BUILT IT — not re-derived, not
 * re-summed, not converted to floats on the way. Brain carries those figures;
 * the moment this function starts reshaping them there are two NAV
 * implementations again.
 */
export async function decide(cfg: BrainConfig, args: DecideArgs, deps: DecideDeps = {}): Promise<BrainResult> {
  if (!cfg.url || !cfg.token) {
    // FAIL CLOSED. An unconfigured Brain is not a Brain that says hold; it is a
    // Brain that was never asked, and the caller must be able to tell.
    return { ok: false, kind: "unreachable", detail: "brainUrl or brainToken is not configured" };
  }

  // THE DESK POLICY GOES ONLY WHERE IT IS UNDERSTOOD, and only when it passes
  // Brain's own bounds. Either failure WITHHOLDS it and sends today's request —
  // never a 422 that would cost the review. The probe is consulted only when a
  // caller supplied terms, so a request without them reads nothing new.
  const probe = deps.capabilities ?? brainCapabilities;
  const wire = args.strategyTerms ? strategyTermsWire(args.strategyTerms) : null;
  // Brain's bounds now refuse a Solana id in either field too, glued ones
  // included (schemas.py `_reject_executable`), and strategyTermsWire checks
  // only the 0x shapes.
  const terms = wire && !onchainIdIn(wire.strategy_terms, GLUED) && !onchainIdIn(wire.horizon, GLUED) ? wire : null;
  const sendTerms = terms !== null && probe.advertises(cfg.url, STRATEGY_TERMS_CAPABILITY);
  const delivery: StrategyTermsDelivery | undefined = args.strategyTerms ? (sendTerms ? "sent" : "withheld") : undefined;

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
    ...(sendTerms && terms ? terms : {}),
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
    clearTimeout(timer);
    return { ok: false, kind: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }

  if (!res.ok && res.status !== 200) {
    clearTimeout(timer);
    void res.body?.cancel().catch(() => {});
    // A 422 WHILE CARRYING THE TERMS is the build skew the probe exists for —
    // /health said yes and /v1/decide is an older build. Off at once; this
    // review is lost (no retry: see the header), the next one is not.
    if (sendTerms && res.status === 422) probe.invalidate();
    return { ok: false, kind: "unreachable", detail: `brain returned HTTP ${res.status}` };
  }

  let payload: Record<string, unknown>;
  try {
    const text = await readBounded(res, MAX_BYTES);
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, kind: "malformed", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    // Headers are not a completed decision. Keep the deadline armed while a
    // response body streams, otherwise a stalled provider can stop every tick.
    clearTimeout(timer);
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

  return {
    ok: true,
    decision,
    seconds: Number(payload.seconds ?? 0),
    ...(delivery ? { strategyTerms: delivery } : {}),
  };
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
      // The auditability VERDICT, carried the way `pnl_publishable` is. Brain
      // consumes it and keeps no second implementation to disagree with.
      current_accounting_history_auditable: s.quality.currentAccountingHistoryAuditable,
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
