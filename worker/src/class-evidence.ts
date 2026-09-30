/**
 * THE FACT LAYER — what was measurably true when a class trade was decided.
 *
 * ── WHY THERE ARE TWO LAYERS AT ALL ──────────────────────────────────────
 *
 * A feed of "15m activity 32, real depth 410.22 USDG, graduation 41.3%" is an
 * observability dashboard wearing a feed's clothes. Nobody talks like that, and
 * an agent that does is not an agent anybody wants to read. But the figures are
 * the only thing that makes a post TRUE, and throwing them away to get a
 * readable sentence is how a trading feed becomes a creative-writing exercise.
 *
 * So they are kept apart. THIS is the fact layer: structured, deterministic,
 * auditable, and the only thing a social writer is ever allowed to draw on. The
 * post in the agent's own voice is written from this and nothing else, and a
 * reader who wants the numbers can open them.
 *
 * ── THE ONE PROPERTY THIS MODULE EXISTS TO ENFORCE ───────────────────────
 *
 * A writer that is handed a number will eventually print a number, and the
 * first time it prints one we did not measure, every post this product has ever
 * made becomes worth re-checking. The defence is not a prompt instruction; it is
 * that `qualify()` below CONVERTS EVERY MEASUREMENT INTO A WORD. The social
 * writer is handed the words and never the figures, so there is nothing
 * numerical in its context to fabricate from — and the validator downstream can
 * therefore be a total predicate over a closed vocabulary rather than a
 * fact-checker that has to be right every time.
 *
 * The figures stay here, in the row, for the drill-down. They are not lost;
 * they are merely not in the writer's hands.
 *
 * ── AND THE NULLS SURVIVE ────────────────────────────────────────────────
 *
 * `trades: null` means the tape could not be read. It is NOT a quiet curve, and
 * `qualify` refuses to turn it into one — an unknown gets no word at all, so a
 * writer with no activity evidence cannot say anything about buyers. That is
 * this repo's oldest rule and the one most easily undone by a `?? 0` written in
 * a hurry.
 */
import type { Why } from "./strategies/reasons";

/**
 * A measurement rendered as one of a FIXED set of words.
 *
 * Closed on purpose. Every value here is written in this file, which is what
 * lets `admitPost` treat the vocabulary as total: a word the writer used that
 * is not in the set it was given did not come from evidence.
 */
export type Band = string;

/** The qualitative evidence a post may be written from. */
export interface ClassEvidence {
  /** "enter" or "exit" — what the agent actually did. */
  act: "enter" | "exit";
  /** The token's symbol, as the discovery pass recorded it. */
  symbol: string;
  /**
   * THE NAME A HUMAN WOULD RECOGNISE, when one is known and safe to print.
   *
   * `symbol` for an autonomous Trencher token is ADDRESS-DERIVED — `T` plus the
   * last eleven hex of the contract — because a coin's own `symbol()` is text
   * its deployer chose and can change, and one calling itself NVDA must never
   * resolve to a stock's price. That property is worth keeping and it makes for
   * an unreadable feed: "just bought TE21291018B4" tells a reader nothing.
   *
   * So the real name rides ALONGSIDE the stable id rather than replacing it.
   * It is display only: nothing prices, routes, matches or settles against it.
   * ABSENT when the tape carried no name, because a made-up one is worse than
   * the id — and sanitised at the point it is read, since it is the one field
   * here a stranger wrote.
   */
  displayName?: string;
  /**
   * WHAT DECIDED THIS TRADE, for provenance that cannot be faked downstream.
   *
   * "rule" means a deterministic producer chose it — the class route's own
   * scoring and its two exit triggers. "brain" would mean a BrainDecision did.
   * Nothing writes "brain" here today, because Brain provably cannot reach a
   * class-vault position: its orders resolve symbols against watchTokens (a
   * launch is not in it), target the Pons adapter rather than the vault, and
   * size from the smart account's balance, which holds none of the class book.
   *
   * The field exists anyway, and is recorded rather than assumed, because the
   * whole point is that a reader can tell a deterministic trade from a model's
   * opinion. A product that labels the first as the second has lied about the
   * only thing that makes the second interesting.
   */
  decidedBy: "rule" | "brain";
  /**
   * The qualitative evidence, already banded. Keys are stable; a key is ABSENT
   * when the underlying measurement was unavailable — never present-and-zero.
   */
  bands: Record<string, Band>;
  /**
   * The raw figures, for the drill-down and for nothing else.
   *
   * Never handed to a writer. Kept as strings for bigints, because JSON has no
   * integer type that can hold a raw 18-decimal token amount without silently
   * losing the low end of it.
   */
  raw: Record<string, string | number | null>;
}

/** USDG, raw 6dp, as a number of whole units. */
const usdgNum = (raw: bigint): number => Number(raw) / 1e6;

/**
 * BANDS, AND WHY THE EDGES ARE WHERE THEY ARE.
 *
 * Each of these is a claim about the market, so each is anchored to a number
 * this codebase already acts on rather than to a round figure that reads well.
 * A band nobody can defend is a number the writer will repeat as if we could.
 */

/**
 * Depth. `CLASS_MIN_REAL_DEPTH_USDG` is the floor the route refuses below, so
 * "thin" is defined as "only just cleared our own bar" rather than as an
 * opinion about small numbers.
 */
export function depthBand(realDepthUsdg: number, floorUsdg: number): Band {
  if (realDepthUsdg < floorUsdg * 2) return "liquidity thin";
  if (realDepthUsdg < floorUsdg * 6) return "liquidity adequate";
  return "liquidity deep";
}

/**
 * Round-trip cost — what it costs to be wrong. Anchored on
 * CLASS_MAX_ROUND_TRIP_BPS (600), the worst the route will accept.
 */
export function costBand(costBps: number, ceilingBps: number): Band {
  if (costBps > ceilingBps * 0.75) return "round trip expensive";
  if (costBps > ceilingBps * 0.4) return "round trip fair";
  return "round trip cheap";
}

/**
 * How far along the curve is. The cliff at `classExitAtGraduationPct` is the
 * point the vault can no longer sell, so the bands are measured against the
 * owner's own exit setting rather than against 100%.
 */
export function curveBand(graduationBps: number, exitAtBps: number): Band {
  if (graduationBps >= exitAtBps) return "curve at the exit line";
  if (graduationBps >= exitAtBps * 0.6) return "curve well along";
  if (graduationBps >= exitAtBps * 0.25) return "curve building";
  return "curve early";
}

/**
 * Activity. `ACTIVITY_GATE.minTrades` is 25 over the window, and the route
 * refuses below it — so every entry has cleared it and the interesting question
 * is by how much.
 */
export function activityBand(trades: number, floorTrades: number): Band {
  if (trades >= floorTrades * 4) return "activity heavy";
  if (trades >= floorTrades * 2) return "activity picking up";
  return "activity steady";
}

/**
 * BREADTH IS THE ONE THAT MATTERS MOST AND IS EASIEST TO GET WRONG.
 *
 * Trades and traders are different facts: forty trades from two addresses is a
 * pair of bots passing it back and forth, and forty from thirty addresses is
 * interest. Expressed as a ratio so the word is about the SHAPE of the tape.
 *
 * Refuses on trades <= 0 rather than dividing — a measured-zero tape supports
 * no statement about who is in it.
 */
export function breadthBand(traders: number, trades: number): Band | null {
  if (trades <= 0) return null;
  const per = traders / trades;
  if (traders <= 2) return "the same few hands";
  if (per >= 0.5) return "buyers mostly new";
  if (per >= 0.25) return "buyers spread out";
  return "a handful of hands";
}

/** Price impact of our own buy, against the owner's configured ceiling. */
export function impactBand(impactBps: number, ceilingBps: number): Band {
  if (ceilingBps <= 0) return "our size barely moves it";
  if (impactBps > ceilingBps * 0.75) return "our size moves it";
  if (impactBps > ceilingBps * 0.35) return "our size nudges it";
  return "our size barely moves it";
}

/** How long a position was held, relative to the owner's own maximum. */
export function heldBand(heldSec: number, maxHoldSec: number): Band {
  if (maxHoldSec <= 0) return "held its full window";
  if (heldSec >= maxHoldSec) return "held its full window";
  if (heldSec >= maxHoldSec * 0.5) return "held most of its window";
  return "held briefly";
}

/** The thresholds a band is measured against — passed in, never guessed. */
export interface BandBounds {
  depthFloorUsdg: number;
  roundTripCeilingBps: number;
  exitAtBps: number;
  activityFloorTrades: number;
  impactCeilingBps: number;
  maxHoldSec: number;
}

/**
 * Turn one `Why` from the class route into the fact layer.
 *
 * Returns null for any other `Why`, so a caller that passes the wrong thing
 * gets no evidence rather than evidence about something else.
 */
export function classEvidenceOf(w: Why | null | undefined, b: BandBounds): ClassEvidence | null {
  if (!w) return null;

  if (w.code === "class-enter") {
    const bands: Record<string, Band> = {
      depth: depthBand(usdgNum(w.depthRaw), b.depthFloorUsdg),
      curve: curveBand(w.graduationBps, b.exitAtBps),
      impact: impactBand(w.impactBps, b.impactCeilingBps),
    };
    // ABSENT, NOT ZERO. A null tape contributes no key at all, so a writer
    // handed these bands has nothing to say about buyers and cannot invent it.
    if (w.trades !== null) bands.activity = activityBand(w.trades, b.activityFloorTrades);
    if (w.traders !== null && w.trades !== null) {
      const breadth = breadthBand(w.traders, w.trades);
      if (breadth) bands.breadth = breadth;
    }
    if (w.costBps !== null) bands.cost = costBand(w.costBps, b.roundTripCeilingBps);
    if (w.field > 1) bands.field = "picked over others";
    return {
      act: "enter",
      symbol: w.symbol,
      decidedBy: "rule",
      bands,
      raw: {
        usdg: usdgNum(w.usdgRaw),
        trades: w.trades,
        traders: w.traders,
        depthUsdg: usdgNum(w.depthRaw),
        impactBps: w.impactBps,
        costBps: w.costBps,
        graduationBps: w.graduationBps,
        field: w.field,
      },
    };
  }

  if (w.code === "class-exit") {
    const bands: Record<string, Band> = {
      held: heldBand(w.heldSec, b.maxHoldSec),
    };
    /**
     * THE CAUSE IS A BAND ONLY WHEN IT ADDS SOMETHING.
     *
     * The clock fires at `heldSec >= maxHold`, so `heldBand` has ALREADY
     * returned "held its full window" — every clock exit would carry that
     * sentence twice, which the first run of the harness printed back as
     * "held its full window · held its full window · curve building". Two slots
     * of a small evidence budget spent saying one thing, and a writer handed a
     * doubled phrase reasonably concludes it is being emphasised.
     *
     * The cliff is different and needs its own words: a position can be sold
     * having been held five minutes, and the reason is a contract that is about
     * to stop accepting sells rather than anything about the clock.
     */
    /**
     * WHY IT LEFT, IN WORDS THAT LEAVE NO ROOM FOR A BETTER STORY.
     *
     * The first run of this produced "I sensed the upside was capped" for a
     * clock exit and "before the rally could finish" for a cliff one. Neither is
     * a fabricated MEASUREMENT — the gate is right to admit them — and both are
     * fabricated REASONS, which is just as bad in public: the clock is a rule
     * the owner set and has nothing to do with upside, and the cliff is a
     * contract that stops accepting sells and has nothing to do with a rally.
     *
     * A writer handed only "held its full window" will reach for a market
     * narrative, because that is what a sentence about selling normally has in
     * it. So it is given the actual reason instead of being left to infer one.
     * This is the cheaper half of the no-invention rule: the expensive half
     * refuses bad output, this half removes the reason to produce it.
     */
    bands.why =
      w.cause === "cliff"
        ? "sold because the vault cannot sell it once it graduates, not because of the price"
        : "sold on my own time limit, not on anything the market did";
    if (w.graduationBps !== null) bands.curve = curveBand(w.graduationBps, b.exitAtBps);
    return {
      act: "exit",
      symbol: w.symbol,
      decidedBy: "rule",
      bands,
      raw: {
        heldSec: w.heldSec,
        graduationBps: w.graduationBps,
        proceedsUsdg: usdgNum(w.proceedsRaw),
        cause: w.cause,
      },
    };
  }

  return null;
}

/**
 * Every band word this module can produce, for any bounds.
 *
 * THE WHOLE ANTI-FABRICATION ARGUMENT RESTS ON THIS BEING COMPLETE, so it is
 * derived by running the band functions across their ranges rather than by
 * being typed out beside them — a hand-kept copy drifts the moment somebody
 * adds a band, and it drifts in the direction that ADMITS an unvouched word.
 * `class-evidence.test.ts` asserts the derivation covers every branch.
 */
export function everyBand(): ReadonlySet<Band> {
  const out = new Set<Band>();
  const bounds: BandBounds = {
    depthFloorUsdg: 100,
    roundTripCeilingBps: 600,
    exitAtBps: 8500,
    activityFloorTrades: 25,
    impactCeilingBps: 300,
    maxHoldSec: 21600,
  };
  /**
   * SWEPT FINELY, NOT SAMPLED AT ROUND NUMBERS.
   *
   * The first version of this walked [0, 0.5, 1, 1.5, 3, 7, 12] and stepped
   * clean over `curve well along`, whose band is 0.6x-1.0x of the exit line. The
   * consequence is worth stating because it is the opposite of what a missing
   * entry sounds like: the vocabulary is what the validator downstream ADMITS,
   * so a band missing from here does not go unchecked — it causes a perfectly
   * truthful post to be thrown away, silently, for as long as nobody notices the
   * feed is thinner than the trade log.
   *
   * A fine sweep costs microseconds and removes the whole class of near-miss.
   * The test beside this sweeps finer still and asserts the two agree in BOTH
   * directions, so a band that exists only here is caught as well.
   */
  for (let i = 0; i <= 200; i++) {
    const m = i / 20;
    out.add(depthBand(bounds.depthFloorUsdg * m, bounds.depthFloorUsdg));
    out.add(costBand(bounds.roundTripCeilingBps * m, bounds.roundTripCeilingBps));
    out.add(curveBand(Math.round(bounds.exitAtBps * m), bounds.exitAtBps));
    out.add(activityBand(Math.round(bounds.activityFloorTrades * m), bounds.activityFloorTrades));
    out.add(impactBand(Math.round(bounds.impactCeilingBps * m), bounds.impactCeilingBps));
    out.add(heldBand(Math.round(bounds.maxHoldSec * m), bounds.maxHoldSec));
  }
  for (let traders = 0; traders <= 50; traders++) {
    for (const trades of [1, 2, 4, 10, 25, 60, 200]) {
      const bandValue = breadthBand(traders, trades);
      if (bandValue) out.add(bandValue);
    }
  }
  out.add("picked over others");
  out.add("sold because the vault cannot sell it once it graduates, not because of the price");
  out.add("sold on my own time limit, not on anything the market did");
  return out;
}
