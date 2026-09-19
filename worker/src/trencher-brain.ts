import type { BrainDecision } from "./brain-client";
import { orderFromDecision } from "./brain-live";
import type { ShadowInputs, ShadowOutcome } from "./brain-shadow";
import type { GeckoPool } from "./venues/geckoterminal";
import { instrumentClassOf } from "../../packages/core/src/index";

export const TRENCH_VOLUME_MIN = 100_000;
export const TRENCH_TAPE_MAX_AGE_MS = 120_000;

/** Volume ranks opportunities; on-chain depth and wallet policy still gate trades. */
export function highVolumePools(pools: readonly GeckoPool[]): GeckoPool[] {
  const byToken = new Map<string, GeckoPool>();
  for (const p of pools) {
    if (instrumentClassOf(p.tokenAddress) !== "memecoin") continue;
    if (!Number.isFinite(p.volume24hUsd) || (p.volume24hUsd ?? 0) < TRENCH_VOLUME_MIN ||
        (p.buyers24h ?? 0) < 20 || (p.buys24h ?? 0) <= 0 || (p.sells24h ?? 0) <= 0 ||
        (p.buckets.m5?.volumeUsd ?? 0) <= 0) continue;
    const key = p.tokenAddress.toLowerCase();
    if ((byToken.get(key)?.volume24hUsd ?? -1) < p.volume24hUsd!) byToken.set(key, p);
  }
  return [...byToken.values()].sort((a, b) => b.volume24hUsd! - a.volume24hUsd!);
}

export type TrenchBrainOrder = { side: "buy" | "sell"; usdgAmount: number; decisionId: string };
type Ready = { decision: BrainDecision; input: ShadowInputs; token: string; context: string; started: number };

/** Model calls cannot hold up a stop-loss tick. Results are one-use, short-lived data. */
export class TrenchBrainReview {
  private pending = false;
  private nextAt = 0;
  private ready: Ready | null = null;
  private context = "";
  private generation = 0;
  constructor(private now = Date.now) {}

  reset(context = "") {
    if (this.context === context) return;
    this.context = context;
    this.generation++;
    this.ready = null;
    this.nextAt = 0;
  }

  launch(context: string, input: ShadowInputs, token: string, run: () => Promise<ShadowOutcome>, note: (s: string) => void) {
    this.reset(context);
    if (this.pending || this.now() < this.nextAt) return;
    this.pending = true;
    const started = this.now();
    const generation = this.generation;
    this.nextAt = started + 60_000;
    void run().then(outcome => {
      if (this.context !== context || this.generation !== generation) return;
      if (outcome.ran && outcome.result.ok) {
        this.ready = { decision: outcome.result.decision, input, token, context, started };
        note(`Brain reviewed ${input.market.symbol}: ${outcome.result.decision.action}`);
      } else note(outcome.ran ? `Brain unavailable: ${outcome.result.ok ? "" : outcome.result.kind}` : outcome.why);
    }).catch(() => note("Brain review failed; no new entry approved")).finally(() => { this.pending = false; });
  }

  take(symbol: string, token: string, price8: bigint, maxUsdg: number, held = false): TrenchBrainOrder | null {
    const r = this.ready;
    if (!r || r.input.market.symbol !== symbol) return null;
    this.ready = null;
    if (Boolean(r.input.positions?.some(p => p.symbol === symbol && Number(p.qtyRaw) > 0)) !== held) return null;
    if (r.context !== this.context || this.now() - r.started > 60_000 || price8 <= 0n ||
        r.token.toLowerCase() !== token.toLowerCase() ||
        r.decision.instrument_id !== r.input.market.instrumentId || r.decision.symbol !== symbol ||
        typeof r.decision.agent_id !== "string" || typeof r.decision.decision_id !== "string" || !r.decision.decision_id.trim() ||
        r.decision.agent_id.toLowerCase() !== r.input.agentId.toLowerCase()) return null;
    const before = Number(r.input.market.priceUsd);
    const price = Number(price8) / 1e8;
    if (!Number.isFinite(before) || before <= 0 || Math.abs(price / before - 1) > .02) return null;
    const verdict = orderFromDecision(r.decision, { maxUsdg });
    return verdict.ok ? { side: verdict.order.side, usdgAmount: verdict.order.usdgAmount, decisionId: r.decision.decision_id } : null;
  }
}
