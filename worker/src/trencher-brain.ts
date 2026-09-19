import type { BrainDecision } from "./brain-client";
import { orderFromDecision } from "./brain-live";
import type { ShadowInputs, ShadowOutcome } from "./brain-shadow";
import type { GeckoPool } from "./venues/geckoterminal";
import { fetchGeckoPoolsResult } from "./venues/geckoterminal";
import { CASH, instrumentClassOf } from "../../packages/core/src/index";

export const TRENCH_VOLUME_MIN = 100_000;
export const TRENCH_TAPE_MAX_AGE_MS = 120_000;

/** Six bounded requests per refresh; a failed page cannot erase healthy pages. */
export async function fetchTrenchTape(fetchPage = fetchGeckoPoolsResult): Promise<GeckoPool[]> {
  const results = await Promise.allSettled([1, 2, 3].flatMap(page =>
    (["trending_pools", "pools"] as const).map(feed => fetchPage(feed, { page }))));
  const healthy = results.flatMap(r => r.status === "fulfilled" && !r.value.failed ? [r.value] : []);
  if (!healthy.length) throw new Error("All Trencher discovery pages failed");
  return highVolumePools(healthy.flatMap(r => r.pools), true);
}

/** Volume ranks opportunities; on-chain depth and wallet policy still gate trades. */
export function highVolumePools(pools: readonly GeckoPool[], perPool = false): GeckoPool[] {
  const byToken = new Map<string, GeckoPool>();
  for (const p of pools) {
    // Quote assets are portfolio cash/bridge assets, never speculative entries.
    // instrumentClassOf deliberately classifies unknown addresses as memecoins.
    if ([CASH.USDG, CASH.WETH].some(a => a.toLowerCase() === p.tokenAddress.toLowerCase())) continue;
    if (instrumentClassOf(p.tokenAddress) !== "memecoin") continue;
    if (!Number.isFinite(p.volume24hUsd) || (p.volume24hUsd ?? 0) < TRENCH_VOLUME_MIN ||
        (p.buyers24h ?? 0) < 20 || (p.buys24h ?? 0) <= 0 || (p.sells24h ?? 0) <= 0 ||
        (p.buckets.m5?.volumeUsd ?? 0) <= 0) continue;
    const key = perPool
      ? `${p.tokenAddress.toLowerCase()}:${p.dex}:${p.poolAddress?.toLowerCase() ?? p.poolId}`
      : p.tokenAddress.toLowerCase();
    if ((byToken.get(key)?.volume24hUsd ?? -1) < p.volume24hUsd!) byToken.set(key, p);
  }
  return [...byToken.values()].sort((a, b) => b.volume24hUsd! - a.volume24hUsd!);
}

export type TrenchBrainOrder = { side: "buy" | "sell"; usdgAmount: number; decisionId: string };

export function trenchBrainPersona(symbol: string, held: boolean): string {
  return "Trencher: short-horizon memecoin trading. Evaluate real volume, two-sided flow, liquidity, costs and reversal risk. Maximum new entry is 5 USDG, also bounded by the owner's limits. Hold if evidence or net edge is insufficient. Never invent activity or prices. " +
    (held ? `You hold ${symbol}; evaluate holding or selling the existing position.`
      : `You hold zero ${symbol}. This is an entry review: choose BUY or HOLD. A bearish view means HOLD, not SELL; short selling is not supported.`);
}
type Ready = { decision: BrainDecision; input: ShadowInputs; token: string; context: string; started: number };

/** Model calls cannot hold up a stop-loss tick. Results are one-use, short-lived data. */
export class TrenchBrainReview {
  private pending = false;
  private nextAt = 0;
  private ready: Ready | null = null;
  private context = "";
  private generation = 0;
  private reviewed = new Map<string, number>();
  private reviewSequence = 0;
  constructor(private now = Date.now) {}

  reset(context = "") {
    if (this.context === context) return;
    this.context = context;
    this.generation++;
    this.ready = null;
    this.nextAt = 0;
    this.reviewed.clear();
    this.reviewSequence = 0;
  }

  /** Oldest review first, with incoming volume order breaking ties. */
  candidate<T extends { token: string }>(eligible: readonly T[]): T | undefined {
    const current = new Set(eligible.map(c => c.token.toLowerCase()));
    for (const key of this.reviewed.keys()) if (!current.has(key)) this.reviewed.delete(key);
    return eligible.reduce<T | undefined>((best, c) => !best ||
      (this.reviewed.get(c.token.toLowerCase()) ?? 0) < (this.reviewed.get(best.token.toLowerCase()) ?? 0) ? c : best, undefined);
  }

  launch(context: string, input: ShadowInputs, token: string, run: () => Promise<ShadowOutcome>, note: (s: string) => void) {
    this.reset(context);
    if (this.pending || this.now() < this.nextAt) return;
    this.pending = true;
    this.reviewed.set(token.toLowerCase(), ++this.reviewSequence);
    const started = this.now();
    const generation = this.generation;
    this.nextAt = started + 60_000;
    void run().then(outcome => {
      if (this.context !== context || this.generation !== generation) return;
      if (outcome.ran && outcome.result.ok) {
        if (outcome.result.decision.action === "sell" &&
            !input.positions?.some(p => p.symbol === input.market.symbol && Number(p.qtyRaw) > 0)) {
          this.ready = null;
          note(`Brain SELL ignored for ${input.market.symbol}: no position is held; no order approved`);
          return;
        }
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
    if (verdict.ok && verdict.order.side === "sell" && !held) return null;
    return verdict.ok ? { side: verdict.order.side, usdgAmount: verdict.order.usdgAmount, decisionId: r.decision.decision_id } : null;
  }
}
