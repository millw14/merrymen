/**
 * HOW FAR THIS PARTICULAR POSITION IS ALLOWED TO FALL.
 *
 * One number swept across a whole book is the wrong shape for the book this
 * fleet holds. A 12% floor under a tokenised equity with four analysts agreeing
 * is a real risk control; the same 12% under a launchpad memecoin is a machine
 * that pays the spread to be stopped out by noise — p99 movement among active
 * curves is 1,546bps over four minutes, so a tight floor there fires on the
 * venue rather than on the trade. And the reverse: a 35% floor under a
 * well-evidenced equity is not caution, it is 35% of the owner's money.
 *
 * So the level is graded per position, once, at entry.
 *
 * WHAT IT GRADES FROM, AND WHAT IT REFUSES TO.
 *
 * `confidence` is not an input to this function and cannot be added to it
 * without editing this comment. Both confidences Brain produces — the manager's
 * own `confidence` and each analyst's — are a model's self-report about its own
 * output. Scaling risk by one means a confidently wrong model earns a wider
 * floor, which is exactly backwards: the times you most need the floor are the
 * times the reasoning was most sure and most wrong. `evidence_strength` is the
 * sound half of the same idea, and Brain's own schema draws the line: "how much
 * the lens had to work with, as distinct from how sure it is. A confident read
 * of thin evidence and a confident read of thick evidence are different things."
 *
 * The best input here is not a model output at all. `overhangBps` is exact
 * arithmetic on a curve's reserves — how far the price falls if every prior
 * buyer leaves — and on a bonding curve that is the whole risk. It outranks
 * everything a model said.
 *
 * THE OWNER STILL DECIDES WHETHER, AND WHERE THE MIDDLE IS. The rungs are
 * multiples of the owner's own `stopLossBps`, not constants: at the 2,500bps
 * this was specified against they are 1,200 / 2,500 / 3,500, and an owner who
 * moves their dial moves all three with it. A grade may never arm a floor the
 * owner has not armed — `ownerBps <= 0` returns 0 and nothing sells.
 *
 * PURE. Given a grade, returns a level and the sentence for it.
 */

/** What the grader may look at. Deliberately does NOT include any confidence. */
export interface FloorInputs {
  /** Merrymen's own classification, never the model's. */
  instrumentClass: "equity-token" | "crypto-native" | "memecoin" | "stablecoin";
  /**
   * How far the price would fall if every prior buyer sold, bps — exact, from
   * the curve's reserves. NULL means "not on a curve" for an equity, and "the
   * curve could not be read" for a memecoin. Those are different facts and this
   * module treats them differently; see `unknownVenue` below.
   */
  overhangBps: number | null;
  /**
   * One entry per lens that ANSWERED, with how much material it had. A lens
   * that returned no-data or failed to parse is absent — it is not a zero, it
   * is not a reading at all, and counting it as weak evidence would let four
   * broken analysts look like a considered view.
   */
  evidence: readonly { lens: string; evidenceStrength: number }[];
  /** Brain's deterministic economics verdict, or null when Brain did not run. */
  economics: "viable" | "marginal" | "uneconomic" | "unknown" | null;
  /** The owner's armed floor, bps. Zero or less means no floor at all. */
  ownerBps: number;
}

export interface FloorGrade {
  /** The level for THIS position, bps. Zero means no floor is armed. */
  bps: number;
  /** Which rung, for the log and the test. */
  rung: "off" | "tight" | "default" | "wide";
  /** Why, in the owner's words. Empty when the floor is off. */
  why: string;
}

/**
 * The rungs, as multiples of the owner's dial.
 *
 * 0.48 and 1.4 are 1,200 and 3,500 against the 2,500bps this was specified at.
 * They are ratios rather than constants so the dial keeps meaning: an owner who
 * halves their floor halves the whole band rather than finding their setting
 * quietly ignored on two thirds of their book.
 */
export const TIGHT_RATIO = 0.48;
export const WIDE_RATIO = 1.4;

/** Two lenses that answered, at this mean strength, is what "well-evidenced" means. */
export const MIN_LENSES = 2;
export const MIN_MEAN_STRENGTH = 0.6;

/**
 * Past this much overhang, a floor at the wide rung is already inside routine
 * curve movement, so tightening below it buys nothing and costs a fill.
 *
 * Read off the curve's own arithmetic rather than chosen: 5% of threshold is
 * 2,099bps of floor drawdown, 10% is 3,600, 25% is 6,213. So a curve past about
 * a tenth of the way to graduation can fall a third of the way to its seed
 * doing nothing unusual at all.
 */
export const OVERHANG_WIDE_BPS = 3_500;

/** Below this, a curve is shallow enough that a tight floor is a real signal. */
export const OVERHANG_TIGHT_BPS = 2_000;

export function gradeFloor(i: FloorInputs): FloorGrade {
  // THE OWNER DECIDES WHETHER. A grade is a level, never a permission: an agent
  // whose owner has armed no floor must not acquire one because a lens was
  // thin. Checked first so nothing below can reach past it.
  if (!Number.isFinite(i.ownerBps) || i.ownerBps <= 0) {
    return { bps: 0, rung: "off", why: "" };
  }
  const owner = Math.round(i.ownerBps);
  const tight = Math.round(owner * TIGHT_RATIO);
  const wide = Math.round(owner * WIDE_RATIO);

  const answered = i.evidence.filter((e) => Number.isFinite(e.evidenceStrength));
  const meanStrength =
    answered.length === 0 ? 0 : answered.reduce((s, e) => s + e.evidenceStrength, 0) / answered.length;
  // A MEMECOIN WHOSE VENUE COULD NOT BE READ. Not the same as an equity with no
  // curve: there the absence of overhang is a fact about the instrument, here it
  // is a gap in what we know about the one risk that matters most.
  const unknownVenue = i.instrumentClass === "memecoin" && i.overhangBps === null;

  // ── WIDEN FIRST, because a floor that fires on the venue is worse than none.
  // Each of these says the same thing in a different way: at this position, a
  // tighter level would be measuring noise.
  const wideBecause: string[] = [];
  if (i.overhangBps !== null && i.overhangBps >= OVERHANG_WIDE_BPS) {
    wideBecause.push(
      `if everyone ahead of me sold, this would fall ${(i.overhangBps / 100).toFixed(0)}% on its own — ` +
        `a tighter floor here fires on the curve, not on the trade`,
    );
  }
  if (unknownVenue) {
    wideBecause.push("I could not read this coin's curve, so I cannot say how much of its price is other people's exit");
  }
  if (i.instrumentClass === "memecoin" && answered.length < MIN_LENSES) {
    wideBecause.push(
      `only ${answered.length} of my analysts had anything to work with on a launchpad coin`,
    );
  }
  if (wideBecause.length) {
    return {
      bps: wide,
      rung: "wide",
      why: `${(wide / 100).toFixed(0)}% — ${wideBecause[0]!}.`,
    };
  }

  // ── THEN TIGHTEN, and only when every condition holds. Any one of them
  // missing leaves the owner's own number in place, which is the right default
  // for a position nothing in particular is known about.
  const wellEvidenced = answered.length >= MIN_LENSES && meanStrength >= MIN_MEAN_STRENGTH;
  const shallowVenue = i.overhangBps === null ? i.instrumentClass !== "memecoin" : i.overhangBps <= OVERHANG_TIGHT_BPS;
  // Economics is a bar to tightening, not a reason for it. A trade whose edge
  // does not clear its own gas is not one to take a smaller loss on with
  // confidence — it is one that should not have been sized.
  const economicsOk = i.economics === null || i.economics === "viable" || i.economics === "unknown";
  if (wellEvidenced && shallowVenue && economicsOk) {
    return {
      bps: tight,
      rung: "tight",
      why:
        `${(tight / 100).toFixed(0)}% — ${answered.length} analysts had real material on this ` +
        `(${Math.round(meanStrength * 100)}% of what they wanted)` +
        (i.overhangBps === null ? " and it is not on a bonding curve" : ", and its curve is shallow") +
        `, so a close floor is measuring the trade rather than the noise.`,
    };
  }

  return {
    bps: owner,
    rung: "default",
    why:
      `${(owner / 100).toFixed(0)}% — your own floor. ` +
      (answered.length === 0
        ? "No analyst had material on this one, so there is nothing to grade it up or down from."
        : `Nothing here argues for closer or wider: ${answered.length} analyst(s) answered at ` +
          `${Math.round(meanStrength * 100)}% strength.`),
  };
}
