import { MAX_DECISION_INTERVAL_SEC, reviewLookaheadSec } from "./decision-cadence";

export interface ReviewQuote {
  symbol: string;
  priceUsd: number;
  stale: boolean;
  at: number;
}

export interface MarketReview {
  action: "hold";
  symbol: string;
  reason: string;
  evidence_json: string;
  /**
   * WHETHER THIS REVIEW SAYS ANYTHING THE LAST ONE DID NOT.
   *
   * The review is written every five minutes for every quiet agent, from one
   * shared oracle series, and nothing in it is the agent's own. Published every
   * time, it put the same paragraph on the feed under five names every five
   * minutes. So it is always WRITTEN — the owner's record keeps it — and only
   * PUBLISHED when the bias flipped or the breakout it named confirmed.
   */
  publish: boolean;
}

export interface ReviewPoint { at: number; priceUsd: number }

type Direction = "upward" | "downward" | "range-bound";
type Event = "flip" | "breakout-up" | "breakout-down" | null;

/** What a recorded review concluded, kept as the baseline for the next one. */
export interface ReviewStance {
  symbol: string;
  direction: Direction;
  high: number;
  low: number;
  observationEnd: number;
}

/** Filed when the review changed: classified in SOURCE_POLICY, so it may publish. */
export const REVIEW_SOURCE = "market-review";
/**
 * Filed when it did not. DELIBERATELY UNCLASSIFIED: SOURCE_POLICY has no key
 * for it, so the publication gate drops it by construction rather than by a
 * check somebody has to keep — the same fail-closed default every unknown
 * source gets.
 */
export const PRIVATE_REVIEW_SOURCE = "market-review-private";

export function reviewSource(review: Pick<MarketReview, "publish">): string {
  return review.publish ? REVIEW_SOURCE : PRIVATE_REVIEW_SOURCE;
}

/** Filed when there was no review to write: private, and never a mark. */
export const RESEARCH_UNAVAILABLE_SOURCE = "research-unavailable";

/**
 * THE DECISION ROW A QUIET REVIEW IS WRITTEN AS — built here, where a test can
 * run it, and written by the tick's quietReview.
 *
 * ALWAYS WRITTEN, PUBLISHED ONLY WHEN IT CHANGED: an unchanged review is one
 * shared oracle series restated, so it is filed under the private source (see
 * reviewSource). With no review — no fresh quote, or no informative series —
 * the row says so and is filed where nothing publishes it.
 *
 * THE MARK IS THE QUOTE THE REVIEW WAS WRITTEN AT, so a published one can say
 * "+x% since posted". Only with a review: one exists only for a fresh, unstale
 * quote, and "research unavailable" saw no market to mark.
 */
export function quietReviewRow(args: {
  id: string;
  agentId: string;
  review: MarketReview | null;
  quote: ReviewQuote | null;
  /** The name chooseFocus picked, for the row that could not review it. */
  focusSymbol?: string;
  historyRead: boolean;
}): {
  id: string;
  agent_id: string;
  source: string;
  provenance: "deterministic-strategy";
  mark_usd: number | null;
  action: "hold";
  symbol: string | undefined;
  reason: string;
  evidence_json: string;
} {
  const { review, quote } = args;
  const base = {
    id: args.id,
    agent_id: args.agentId,
    provenance: "deterministic-strategy" as const,
    action: "hold" as const,
  };
  if (review) {
    return {
      ...base,
      source: reviewSource(review),
      mark_usd: quote ? quote.priceUsd : null,
      symbol: review.symbol,
      reason: review.reason,
      evidence_json: review.evidence_json,
    };
  }
  return {
    ...base,
    source: RESEARCH_UNAVAILABLE_SOURCE,
    mark_usd: null,
    symbol: args.focusSymbol,
    reason: "Research does not establish a fresh, informative price series; hold and retry next review.",
    evidence_json: JSON.stringify({ kind: "research-unavailable", quote, historyRead: args.historyRead }),
  };
}

const DIRECTIONS = new Set<string>(["upward", "downward", "range-bound"]);

/** Read a baseline back out of a review's own evidence, or refuse to. */
function stanceOf(review: MarketReview): ReviewStance | null {
  try {
    const e = JSON.parse(review.evidence_json) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const high = n(e.high), low = n(e.low), end = n(e.observationEnd);
    if (high === null || low === null || end === null || !DIRECTIONS.has(String(e.direction))) return null;
    return { symbol: review.symbol, direction: e.direction as Direction, high, low, observationEnd: end };
  } catch {
    return null;
  }
}

/**
 * A technical observation from recorded oracle history; a spot quote alone is
 * not research.
 *
 * ONE THIRD-PERSON LINE — "TSLA +1.1% over 20h, above its mean." It used to be
 * a first-person paragraph ("My technical bias is upward… I hold while testing
 * this range…") built from nothing but the symbol and the shared Chainlink
 * history, so every agent watching TSLA said it word for word as its own
 * conviction, and at ~500 characters it was cut mid-word on every surface.
 * The duration is whole hours so an unchanged review does not become a new
 * sentence each tick merely because the clock moved.
 *
 * `prior` is the last RECORDED review of this same name, or nothing. Only a
 * change against it is news: a flip in bias, or the two-round breakout the
 * range named. Everything else is written privately — see `publish`.
 */
export function marketReview(quote: ReviewQuote, prior?: ReviewStance | null, history: readonly ReviewPoint[] = []): MarketReview | null {
  const { symbol, priceUsd, at } = quote;
  if (!/^[A-Z0-9._-]{1,20}$/.test(symbol) || !Number.isFinite(priceUsd) || priceUsd <= 0 || quote.stale || !Number.isFinite(at)) return null;
  const points = [...new Map(history.filter(p => Number.isFinite(p.at) && Number.isFinite(p.priceUsd) &&
    p.priceUsd > 0 && p.at <= at && p.at >= at - 86400).map(p => [p.at, p])).values()].sort((a,b) => a.at-b.at);
  const first = points[0], last = points.at(-1);
  if (points.length < 3 || !first || !last || last.at-first.at < 900 || at-last.at > 3600) return null;
  const low = Math.min(...points.map(p => p.priceUsd)), high = Math.max(...points.map(p => p.priceUsd));
  if (high === low) return null;
  const mean = points.reduce((sum,p) => sum+p.priceUsd,0)/points.length;
  const changePct = (priceUsd/first.priceUsd-1)*100;
  if (!Number.isFinite(mean) || !Number.isFinite(changePct)) return null;
  const money = (n: number) => '$' + (n >= 1 ? n.toFixed(2) : n.toPrecision(3));
  const direction: Direction = priceUsd > mean ? 'upward' : priceUsd < mean ? 'downward' : 'range-bound';

  // THE BASELINE IS THIS NAME'S, OR THERE IS NONE. A review of NVDA is not
  // something a TSLA review can have flipped against.
  const base = prior && prior.symbol === symbol ? prior : null;
  // Rounds that arrived AFTER the last recorded review. The confirmation the
  // range named is the last two of those, both past the same side of it.
  const fresh = base ? points.filter(p => p.at > base.observationEnd).slice(-2) : [];
  const event: Event =
    base && fresh.length === 2 && fresh.every(p => p.priceUsd > base.high) ? 'breakout-up'
    : base && fresh.length === 2 && fresh.every(p => p.priceUsd < base.low) ? 'breakout-down'
    // A move into or out of the middle is not a reversal; up against down is.
    : base && base.direction !== direction && base.direction !== 'range-bound' && direction !== 'range-bound' ? 'flip'
    : null;

  const span = at - first.at;
  const over = span >= 3600 ? `${Math.round(span / 3600)}h` : `${Math.round(span / 60)}m`;
  const where = direction === 'upward' ? 'above its mean' : direction === 'downward' ? 'below its mean' : 'at its mean';
  const why =
    event === 'breakout-up' ? ` — two fresh oracle rounds above the ${money(base!.high)} high`
    : event === 'breakout-down' ? ` — two fresh oracle rounds below the ${money(base!.low)} low`
    : event === 'flip' ? ` — it was ${base!.direction === 'upward' ? 'above' : 'below'} it at the last review`
    : '';
  const reason = `${symbol} ${changePct >= 0 ? '+' : '-'}${Math.abs(changePct).toFixed(1)}% over ${over}, ${where}${why}.`;
  return { action: 'hold', symbol, reason, publish: event !== null, evidence_json: JSON.stringify({
    kind: 'technical-review', quote, points, previous: base,
    observationStart: first.at, observationEnd: last.at, low, high, mean, changePct, direction, event,
    horizonSec: 3600, confirmationRounds: 2,
  }) };
}

/** State is advanced only after the caller successfully records a review. */
export class MarketReviewClock {
  private lastDecisionAt = -Infinity;
  /** The last RECORDED review of each name — the only thing a change is measured against. */
  private stances = new Map<string, ReviewStance>();

  get nextAt(): number | null {
    return Number.isFinite(this.lastDecisionAt) ? this.lastDecisionAt + MAX_DECISION_INTERVAL_SEC : null;
  }

  noteDecision(at: number): void {
    this.lastDecisionAt = at;
  }

  due(at: number, preparationMs = 0): boolean {
    return at + reviewLookaheadSec(preparationMs) - this.lastDecisionAt >= MAX_DECISION_INTERVAL_SEC;
  }

  prepare(quote: ReviewQuote, preparationMs = 0, history: readonly ReviewPoint[] = [], decisionAt = quote.at): MarketReview | null {
    if (!this.due(decisionAt, preparationMs)) return null;
    return marketReview(quote, this.stances.get(quote.symbol) ?? null, history);
  }

  /**
   * Called only once the row is verified written. A review the owner's record
   * never received is not a baseline: the next flip is measured against what
   * was actually said.
   */
  recorded(quote: ReviewQuote, review?: MarketReview | null): void {
    const stance = review ? stanceOf(review) : null;
    if (stance) this.stances.set(stance.symbol, stance);
    this.noteDecision(quote.at);
  }
}
