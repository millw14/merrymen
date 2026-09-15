/**
 * WHICH DISCOVERED TOKEN, IF ANY, IS WORTH BUYING — and the sentence explaining
 * every one that is not.
 *
 * THE DEFAULT ANSWER IS NO. An autonomous trader that finds a reason to buy
 * every time it looks is not selecting, it is just buying; the brief's own words
 * are "always searching, sometimes holding, autonomously trading when
 * qualified," and nothing here exists to manufacture a qualification. Most
 * passes should return no pick, and a pass that returns no pick is working.
 *
 * THREE STYLES, NOT THIRTY SETTINGS. An owner should be able to say how much
 * risk they want in one word. The styles move thresholds together in the
 * direction that word implies, and the numbers below are the whole product
 * surface — everything else stays a derived consequence.
 *
 * WHAT A STYLE MAY NEVER DO is loosen a signed limit. Per-trade cap, daily cap,
 * drawdown and the allowed venue set live in the grant and in policy, and the
 * most aggressive style here still runs entirely inside them. A style chooses
 * among candidates the wall would already permit; it never asks for a candidate
 * the wall would not.
 */
import type { VenueLeg, VenueQuote } from "./venue";

export type RiskStyle = "conservative" | "balanced" | "aggressive";

export const RISK_STYLES: readonly RiskStyle[] = ["conservative", "balanced", "aggressive"] as const;

export function isRiskStyle(v: unknown): v is RiskStyle {
  return typeof v === "string" && (RISK_STYLES as readonly string[]).includes(v);
}

export interface StyleThresholds {
  /** Minimum REAL quote depth, 6dp. Never the reported reserve. */
  minRealDepthRaw: bigint;
  /** Ceiling on the measured round-trip cost of the entry. */
  maxCostBps: number;
  /** A market younger than this has not yet shown anything. 0 disables. */
  minAgeSec: number;
  /**
   * THE TRAP CEILING, and the least obvious number here.
   *
   * A Pons class position is sold through the vault, and the vault refuses a
   * GRADUATED curve by name — so a token that graduates while held stops being
   * sellable on this route and needs the owner's own sweep. Graduation is the
   * SUCCESS case, which means the better the trade goes the sooner the exit
   * closes.
   *
   * The exit already fires at `classExitAtGraduationPct` (85% by default). Entry
   * must therefore stop well BELOW that, or a buy is made with almost no room
   * between it and the cliff: enter at 8,000 bps against an 8,500 bps exit and
   * the position has 5% of a curve to live in. These ceilings leave real room,
   * and `styleFitsExit` below refuses to run a combination that does not.
   */
  maxGraduationBps: number;
  /** Trades seen in the venue's recent window. 0 disables the check. */
  minRecentTrades: number;
}

/**
 * The numbers behind each word.
 *
 * Conservative wants a market that already exists: real depth, a cheap round
 * trip, some history, and a long way from the cliff. Aggressive will take a
 * newer, thinner market and pay more to get in — but still refuses a market it
 * cannot measure, and still leaves room before graduation, because those two are
 * safety rather than taste.
 */
const THRESHOLDS: Readonly<Record<RiskStyle, StyleThresholds>> = Object.freeze({
  conservative: {
    minRealDepthRaw: 2_000_000_000n, // 2,000 USDG
    maxCostBps: 300,
    minAgeSec: 3600,
    maxGraduationBps: 5_000,
    minRecentTrades: 10,
  },
  balanced: {
    minRealDepthRaw: 500_000_000n, // 500 USDG
    maxCostBps: 600,
    minAgeSec: 600,
    maxGraduationBps: 6_000,
    minRecentTrades: 3,
  },
  aggressive: {
    minRealDepthRaw: 250_000_000n, // 250 USDG — the existing classMinDepthUsdg floor
    maxCostBps: 900,
    minAgeSec: 0,
    maxGraduationBps: 7_000,
    minRecentTrades: 0,
  },
});

export function thresholdsFor(style: RiskStyle): StyleThresholds {
  return THRESHOLDS[style];
}

/**
 * A style name OR the numbers themselves.
 *
 * The entry path already has thresholds an owner chose and a wall SIGNED —
 * `classMinDepthUsdg`, `maxImpactBps`, and a graduation ceiling derived from
 * their exit setting. Making it pick a style word and then look those numbers
 * up again would mean two sources for one limit, and the one that wins would be
 * whichever was consulted last.
 *
 * So the styles are a way for an OWNER to choose numbers, and this is how the
 * numbers get used. When the three-way style control ships in the UI it writes
 * the same fields; nothing downstream has to learn a new concept.
 */
export type Thresholds = RiskStyle | StyleThresholds;

function resolve(t: Thresholds): StyleThresholds {
  return typeof t === "string" ? THRESHOLDS[t] : t;
}

/** What to call the limits in a refusal an owner reads. */
function nameOf(t: Thresholds): string {
  return typeof t === "string" ? t : "your settings";
}

/**
 * Does this style leave room between entry and the exit cliff?
 *
 * Checked rather than assumed, because the exit threshold is an owner setting
 * and the entry ceiling is ours: an owner who lowers the exit to 60% would
 * otherwise have Conservative buying at 50% and selling at 60%, with the whole
 * position's life inside a tenth of a curve.
 */
export function styleFitsExit(style: RiskStyle, exitAtGraduationBps: number): boolean {
  return exitAtGraduationBps - thresholdsFor(style).maxGraduationBps >= 1_000;
}

/**
 * WHY a candidate was passed over, as one groupable word.
 *
 * The sentence beside it names a symbol and a figure, so no two refusals are
 * ever the same string and counting them by text would report every rejection
 * as unique. The funnel needs to say "eleven of them were too thin", which
 * needs a category — and deriving one later by matching phrases is the exact
 * coupling `why.ts` already pays for, where rewording a sentence silently
 * reclassifies it. So the producer says what it means.
 */
export type RefusalKind =
  | "depth"
  | "impact"
  | "graduation"
  | "age"
  | "activity"
  | "unpriceable"
  | "venue";

export interface Verdict {
  /** True only when every threshold was MEASURED and met. */
  ok: boolean;
  /** Null when it passed. */
  kind: RefusalKind | null;
  /**
   * Higher is better, among candidates that passed. Never compared across
   * styles, and never a reason to buy on its own — it orders a shortlist, it
   * does not create one.
   */
  score: number;
  /** The owner's sentence when `ok` is false. Null when it passed. */
  reason: string | null;
}

const usdg = (raw: bigint): string => `${(Number(raw) / 1e6).toFixed(2)} USDG`;

/**
 * Judge one verified leg at one style.
 *
 * A NULL SIGNAL IS A REFUSAL, NOT A PASS. Every measurement this consults can
 * come back null when the chain would not answer, and treating that as
 * satisfied is how an agent buys the one token it could not read. "Unknown" and
 * "fine" are different words and this function keeps them apart.
 */
export function scoreLeg(leg: VenueLeg, style: Thresholds, entry: VenueQuote | null): Verdict {
  const t = resolve(style);
  const who = nameOf(style);

  if (leg.realDepthRaw < t.minRealDepthRaw) {
    return {
      ok: false,
      kind: "depth",
      score: 0,
      reason: `only ${usdg(leg.realDepthRaw)} of real liquidity — ${who} wants at least ${usdg(t.minRealDepthRaw)}`,
    };
  }

  if (entry === null) {
    return { ok: false, kind: "unpriceable", score: 0, reason: `could not price an entry into ${leg.symbol} this pass` };
  }
  if (entry.costBps === null) {
    return {
      ok: false,
      kind: "unpriceable",
      score: 0,
      reason: `could not measure what a round trip in ${leg.symbol} would cost, so it is not known to be affordable`,
    };
  }
  if (entry.costBps > t.maxCostBps) {
    return {
      ok: false,
      kind: "impact",
      score: 0,
      reason: `expected price impact is ${(entry.costBps / 100).toFixed(2)}% — above the ${(t.maxCostBps / 100).toFixed(2)}% ${who} allows`,
    };
  }

  if (leg.graduationBps === null) {
    return {
      ok: false,
      kind: "graduation",
      score: 0,
      reason: `cannot tell how close ${leg.symbol} is to graduating, and a position that graduates cannot be sold from the vault`,
    };
  }
  if (leg.graduationBps > t.maxGraduationBps) {
    return {
      ok: false,
      kind: "graduation",
      score: 0,
      reason:
        `${leg.symbol} is ${(leg.graduationBps / 100).toFixed(1)}% of the way to graduating — too close to the point ` +
        `where it can no longer be sold from the vault`,
    };
  }

  if (t.minAgeSec > 0) {
    if (leg.ageSec === null) {
      return { ok: false, kind: "age", score: 0, reason: `do not know how old ${leg.symbol} is, and ${who} will not buy an unknown age` };
    }
    if (leg.ageSec < t.minAgeSec) {
      return {
        ok: false,
        kind: "age",
        score: 0,
        reason: `${leg.symbol} is ${Math.floor(leg.ageSec / 60)} minutes old — ${who} waits ${Math.floor(t.minAgeSec / 60)}`,
      };
    }
  }

  if (t.minRecentTrades > 0) {
    if (leg.recentTrades === null) {
      return { ok: false, kind: "activity", score: 0, reason: `no recent trading data for ${leg.symbol}` };
    }
    if (leg.recentTrades < t.minRecentTrades) {
      return {
        ok: false,
        kind: "activity",
        score: 0,
        reason: `${leg.symbol} has had ${leg.recentTrades} trades recently — ${who} wants ${t.minRecentTrades}`,
      };
    }
  }

  /**
   * THE ORDERING, and it is only an ordering.
   *
   * Depth dominates because it is the one signal that is money rather than
   * inference, and cheapness comes next. Distance from graduation is a positive
   * term for the reason the ceiling exists: room to live in is worth more than
   * momentum toward a cliff the position cannot cross.
   */
  const depthScore = Math.log10(Math.max(1, Number(leg.realDepthRaw) / 1e6)) * 40;
  const costScore = (t.maxCostBps - entry.costBps) / 10;
  const roomScore = (t.maxGraduationBps - leg.graduationBps) / 100;
  return { ok: true, kind: null, score: Math.round(depthScore + costScore + roomScore), reason: null };
}

/**
 * The best of a verified set at this style, plus a sentence for every reject.
 *
 * Returns `pick: null` when nothing qualifies, which is the ordinary outcome and
 * is not an error. The refusals travel with it because the funnel needs them:
 * "nothing qualified" is not an explanation, and "nothing had more than 250 USDG
 * of real depth" is.
 */
export function chooseEntry(
  legs: readonly { leg: VenueLeg; entry: VenueQuote | null }[],
  style: Thresholds,
): {
  pick: VenueLeg | null;
  score: number;
  refused: { symbol: string; reason: string; kind: RefusalKind }[];
} {
  let pick: VenueLeg | null = null;
  let best = -Infinity;
  const refused: { symbol: string; reason: string; kind: RefusalKind }[] = [];

  for (const { leg, entry } of legs) {
    const v = scoreLeg(leg, style, entry);
    if (!v.ok) {
      refused.push({
        symbol: leg.symbol,
        reason: v.reason ?? "did not qualify",
        kind: v.kind ?? "venue",
      });
      continue;
    }
    if (v.score > best) {
      best = v.score;
      pick = leg;
    }
  }
  return { pick, score: pick ? best : 0, refused };
}
