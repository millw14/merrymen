/** MerrymenBrain reviews a deterministic, risk-sized candidate. It can only veto.
 * No model call blocks the trading/protection loop; no approval survives restart.
 */
import { createHash, randomUUID } from "node:crypto";
import type { BrainConfig } from "../brain-client";
import type { PerpsView } from "../strategies/types";
import type { PerpOpenDraft } from "./drafts";
import type { LighterFeedRead, LighterFeedFile } from "./feed-reader";

export const PERPS_BRAIN_STRATEGY_VERSION = "merrymenbrain-perps-analogs-v1";
export const PERPS_BRAIN_TTL_MS = 120_000;
export const PERPS_BRAIN_INTERVAL_MS = 5 * 60_000;
export const PERPS_BRAIN_MAX_DRIFT_BPS = 25;
export interface PerpsBrainRequest {
  schema_version: "perps-1";
  run_id: string; agent_id: string; snapshot_id: string;
  market: string; as_of_ms: number; expires_at_ms: number;
  candidate: { side: "long" | "short"; bar_t: number; stop_bps: number };
  candles: { t: number; o: string; h: string; l: string; c: string }[];
  mark_price: string; index_price: string;
  spread_bps: number; taker_fee_bps: number; slippage_bps: number;
  funding_ppm_per_hour: number; depth_ratio: number;
}
export interface PerpsBrainResponse {
  schema_version: "perps-1"; run_id: string; agent_id: string; snapshot_id: string;
  market: string; as_of_ms: number; expires_at_ms: number;
  strategy_version: string; candidate_bar_t: number; candidate_side: "long" | "short";
  action: "long" | "short" | "hold"; reason_codes: string[];
  features: Record<string, unknown>;
  forecast: {
    method: "causal-regime-analogs-v1"; horizon_bars: 3;
    target: "signed-mark-return-after-estimated-costs"; samples: number;
    win_probability: number | null; lower_95: number | null; upper_95: number | null;
    mean_net_bps: number | null; mean_lower_95_bps: number | null;
    cost_bps: number; calibrated: false;
  };
  committee?: { lens: string; verdict: "accept" | "veto"; reason: string }[];
}
export type PerpsBrainBuildArgs = {
  agentId: string; runId?: string; nowMs: number; context: string;
  view: PerpsView; candidate: PerpOpenDraft; candleT: number;
  feed: LighterFeedRead | null;
};
/** Canonical key ordering so recording/replay does not depend on JSON insertion order. */
export function brainFingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(canonical) :
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function buildPerpsBrainRequest(a: PerpsBrainBuildArgs): PerpsBrainRequest | null {
  const { candidate: c, nowMs, view } = a;
  const m = view.markets.get(c.market), tape = a.feed?.markets.get(c.marketId);
  if (!m || !tape?.fresh || !tape.bookFresh || !m.closed4h || m.closed4h.length < 100 ||
      m.markPrice <= 0n || m.indexPrice === null || m.indexPrice <= 0n || m.fundingPpmPerHour === null ||
      m.bestBid === null || m.bestAsk === null || m.bestBid <= 0n || m.bestAsk < m.bestBid ||
      nowMs < m.observedAtSec * 1000 || nowMs - m.observedAtSec * 1000 > 30_000 ||
      c.notionalUsdg <= 0n || m.closed4h.at(-1)?.t !== a.candleT) return null;
  const levels = c.side === "long" ? tape.asks : tape.bids;
  // Only depth within the candidate's executable price bound counts.
  const depth = levels.filter(l => c.side === "long" ? l.price <= c.worstPrice : l.price >= c.worstPrice)
    .reduce((sum, l) => sum + l.price * l.baseAmount, 0n);
  const quoteScale = 10n ** BigInt(m.spec.priceDecimals + m.spec.sizeDecimals);
  const depthMicro = depth * 1_000_000n / quoteScale;
  // Forecast current observable impact, not the owner's maximum loss-of-price
  // allowance. Both sides must fill this base size within that unchanged bound.
  // Future exit liquidity is unknown; this is an estimate, never a guarantee.
  const limitGap = c.worstPrice > m.markPrice ? c.worstPrice - m.markPrice : m.markPrice - c.worstPrice;
  const impact = (side: "buy" | "sell") => {
    const book = side === "buy" ? tape.asks : tape.bids;
    const best = book[0]?.price;
    if (!best || best <= 0n || c.baseAmount <= 0n) return null;
    const executable = book.filter(level => side === "buy" ? level.price <= m.markPrice + limitGap : level.price >= m.markPrice - limitGap);
    const availableMicro = executable.reduce((sum, level) => sum + level.price * level.baseAmount, 0n) * 1_000_000n / quoteScale;
    if (availableMicro * 4n < c.notionalUsdg * 5n) return null;
    let left = c.baseAmount, quote = 0n;
    for (const level of executable) {
      if (side === "buy" ? level.price > m.markPrice + limitGap : level.price < m.markPrice - limitGap) break;
      const fill = left < level.baseAmount ? left : level.baseAmount;
      quote += fill * level.price; left -= fill;
      if (left === 0n) break;
    }
    if (left > 0n) return null;
    // Forecast outcomes are MARK returns. A shifted book can have a tiny
    // spread yet charge a large premium versus mark; include that basis.
    const baseline = m.markPrice * c.baseAmount;
    const rawMoved = side === "buy" ? quote - baseline : baseline - quote;
    const moved = rawMoved > 0n ? rawMoved : 0n;
    // Round the measured cost UP to 0.0001 bp.
    return Number((moved * 100_000_000n + baseline - 1n) / baseline) / 10_000;
  };
  const buyImpact = impact("buy"), sellImpact = impact("sell");
  if (buyImpact === null || sellImpact === null) return null;
  const stopGap = c.side === "long" ? m.markPrice - c.stopTrigger : c.stopTrigger - m.markPrice;
  if (stopGap <= 0n) return null;
  const body = {
    schema_version: "perps-1" as const, agent_id: a.agentId, market: c.market,
    as_of_ms: nowMs, expires_at_ms: nowMs + PERPS_BRAIN_TTL_MS,
    candidate: { side: c.side, bar_t: a.candleT, stop_bps: Number(stopGap * 1_000_000n / m.markPrice) / 100 },
    candles: m.closed4h.slice(-500).map(b => ({ t: b.t, o: String(b.o), h: String(b.h), l: String(b.l), c: String(b.c) })),
    mark_price: String(m.markPrice), index_price: String(m.indexPrice),
    spread_bps: Number((m.bestAsk - m.bestBid) * 1_000_000n / m.markPrice) / 100,
    taker_fee_bps: tape.takerFeePpm / 100,
    slippage_bps: Math.max(buyImpact, sellImpact),
    funding_ppm_per_hour: m.fundingPpmPerHour,
    depth_ratio: Number(depthMicro * 1_000_000n / c.notionalUsdg) / 1_000_000,
  };
  if (Object.values(body).some(v => typeof v === "number" && !Number.isFinite(v))) return null;
  return { ...body, run_id: a.runId ?? randomUUID(), snapshot_id: brainFingerprint({ context: a.context, candidate: c, evidence: body }) };
}
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const boundedProbability = (x: unknown) => x === null || (finite(x) && x >= 0 && x <= 1);
/** Same conservative numeric cost convention as the exported engine. No favorable funding credit. */
export function perpsBrainEstimatedCostBps(r: PerpsBrainRequest): number {
  const side = r.candidate.side === "long" ? 1 : -1;
  const drift = (Number(r.mark_price) / Number(r.candles.at(-1)!.c) - 1) * 10_000;
  return 2 * (r.taker_fee_bps + r.slippage_bps + r.spread_bps) +
    Math.max(0, side * r.funding_ppm_per_hour) / 100 * 12 + Math.max(0, side * drift);
}
/** Strict executable boundary: malformed economics or mismatched identity is never approval. */
export function validatePerpsBrainResponse(raw: unknown, req: PerpsBrainRequest, nowMs: number): PerpsBrainResponse | null {
  if (!record(raw) || nowMs < req.as_of_ms || nowMs >= req.expires_at_ms) return null;
  for (const key of ["schema_version", "run_id", "agent_id", "snapshot_id", "market", "as_of_ms", "expires_at_ms"] as const)
    if (raw[key] !== req[key]) return null;
  if (raw.candidate_bar_t !== req.candidate.bar_t || raw.candidate_side !== req.candidate.side ||
      (raw.action !== "hold" && raw.action !== req.candidate.side) ||
      raw.strategy_version !== PERPS_BRAIN_STRATEGY_VERSION ||
      !Array.isArray(raw.reason_codes) || raw.reason_codes.length > 32 || raw.reason_codes.some(x => typeof x !== "string" || !/^[a-z0-9_-]{1,100}$/.test(x)) ||
      !record(raw.features) || !record(raw.forecast)) return null;
  const f = raw.forecast;
  if (f.method !== "causal-regime-analogs-v1" || f.horizon_bars !== 3 || f.target !== "signed-mark-return-after-estimated-costs" || f.calibrated !== false ||
      !Number.isSafeInteger(f.samples) || Number(f.samples) < 0 || Number(f.samples) > 500 ||
      ![f.win_probability, f.lower_95, f.upper_95].every(boundedProbability) ||
      ![f.mean_net_bps, f.mean_lower_95_bps].every(x => x === null || finite(x)) || !finite(f.cost_bps) || f.cost_bps < 0) return null;
  if (raw.action !== "hold" && (f.win_probability === null || f.lower_95 === null || f.upper_95 === null ||
      !finite(f.mean_net_bps) || !finite(f.mean_lower_95_bps) || f.mean_lower_95_bps <= 0 || f.mean_lower_95_bps > f.mean_net_bps ||
      f.cost_bps + 1e-9 < perpsBrainEstimatedCostBps(req) || f.cost_bps > req.candidate.stop_bps * .15 || Number(f.samples) < 20 || Number(f.lower_95) <= 0.5 ||
      Number(f.lower_95) > Number(f.win_probability) || Number(f.win_probability) > Number(f.upper_95))) return null;
  if (raw.committee !== undefined && (!Array.isArray(raw.committee) || raw.committee.length > 3 || raw.committee.some(x => !record(x) ||
      !["bull", "bear", "risk"].includes(String(x.lens)) || !["accept", "veto"].includes(String(x.verdict)) || typeof x.reason !== "string" || x.reason.length > 500))) return null;
  if (raw.action !== "hold" && (!Array.isArray(raw.committee) || raw.committee.length !== 3 ||
      new Set(raw.committee.map(x => x.lens)).size !== 3 || raw.committee.some(x => x.verdict !== "accept"))) return null;
  return raw as unknown as PerpsBrainResponse;
}
/** Bounded private-network call, no retry and no raw provider/credential diagnostics. */
export async function requestPerpsBrain(cfg: BrainConfig, request: PerpsBrainRequest): Promise<PerpsBrainResponse | null> {
  if (!cfg.url || !cfg.token) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(cfg.timeoutMs ?? 30_000, 30_000));
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, "")}/v1/perps/decide`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` }, body: JSON.stringify(request), signal: ac.signal });
    if (!res.ok || !res.body) { void res.body?.cancel(); return null; }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 128 * 1024) { await reader.cancel(); return null; } chunks.push(next.value); }
    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return raw?.ok === true ? validatePerpsBrainResponse(raw.decision, request, Date.now()) : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
export interface PerpsBrainRecording {
  context: string;
  sourceFrame: { atMs: number; feed: LighterFeedFile };
  sourceFrameSha256: string;
  request: PerpsBrainRequest;
  response: PerpsBrainResponse | null;
  candidateNotionalMicro: string;
  completedAtMs: number;
}
/** A review cannot cover worse costs/liquidity or a widened stop after it completed. */
export function brainMarketStillQualified(reviewed: PerpsBrainRequest, current: PerpsBrainRequest, response?: PerpsBrainResponse): boolean {
  const driftBps = (r: PerpsBrainRequest) => (Number(r.mark_price) / Number(r.candles.at(-1)!.c) - 1) * 10_000;
  const basisBps = (r: PerpsBrainRequest) => Math.abs(Number(r.mark_price) / Number(r.index_price) - 1) * 10_000;
  const cost = perpsBrainEstimatedCostBps;
  const atr = typeof response?.features.atr_bps === "number" && Number.isFinite(response.features.atr_bps) ? response.features.atr_bps : 0;
  const currentCost = cost(current);
  return reviewed.market === current.market && reviewed.candidate.side === current.candidate.side && reviewed.candidate.bar_t === current.candidate.bar_t &&
    brainFingerprint(reviewed.candles) === brainFingerprint(current.candles) &&
    current.candidate.stop_bps <= reviewed.candidate.stop_bps && currentCost <= .15 * current.candidate.stop_bps &&
    currentCost <= cost(reviewed) + 1e-9 && current.depth_ratio >= 1.25 &&
    basisBps(current) <= Math.max(50, atr) && Math.abs(driftBps(current)) <= Math.max(25, .2 * atr);
}
export type PerpsBrainApproval = { request: PerpsBrainRequest; response: PerpsBrainResponse; context: string; candidate: PerpOpenDraft };
/** Single-flight, bounded cadence and one-use results. The caller never awaits a model. */
export class PerpsBrainReview {
  private context = ""; private generation = 0; private pending = false; private nextAt = 0;
  private ready: PerpsBrainApproval | null = null;
  constructor(private now = Date.now) {}
  reset(context: string) { if (context !== this.context) { this.context = context; this.generation++; this.ready = null; this.nextAt = 0; } }
  launch(context: string, request: PerpsBrainRequest, candidate: PerpOpenDraft, run: () => Promise<PerpsBrainResponse | null>, note: (s: string) => void) {
    this.reset(context);
    if (this.pending || this.now() < this.nextAt) return;
    this.pending = true; this.nextAt = this.now() + PERPS_BRAIN_INTERVAL_MS;
    const generation = this.generation;
    void run().then(raw => {
      if (generation !== this.generation) return;
      const response = validatePerpsBrainResponse(raw, request, this.now());
      this.ready = response?.action === request.candidate.side ? { request, response, context, candidate } : null;
      note(response ? `Brain ${response.action === "hold" ? "held" : "approved"} ${request.market}: ${response.reason_codes.join(", ") || "review complete"}` : "Brain review unavailable or expired; no new entry approved.");
    }).catch(() => { if (generation === this.generation) note("Brain review failed; no new entry approved."); }).finally(() => { this.pending = false; });
  }
  take(context: string, candidate: PerpOpenDraft, candleT: number, markPrice: bigint, current?: PerpsBrainRequest): PerpsBrainApproval | null {
    this.reset(context);
    const ready = this.ready; if (!ready) return null;
    this.ready = null;
    const r = ready.request;
    if (current && !brainMarketStillQualified(r, current, ready.response)) return null;
    if (candidate.notionalUsdg > ready.candidate.notionalUsdg || candidate.imfBp < ready.candidate.imfBp) return null;
    if (!validatePerpsBrainResponse(ready.response, r, this.now()) || r.market !== candidate.market || r.candidate.side !== candidate.side || r.candidate.bar_t !== candleT || markPrice <= 0n) return null;
    const old = BigInt(r.mark_price), drift = markPrice > old ? markPrice - old : old - markPrice;
    if (drift * 10_000n > old * BigInt(PERPS_BRAIN_MAX_DRIFT_BPS)) return null;
    return ready;
  }
}
