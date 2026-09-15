/**
 * THE CLASS SCAN'S STAGES, AS ARITHMETIC THAT CAN BE TESTED.
 *
 * This was eleven lines inside a closure in `index.ts`, which is why it was
 * wrong for as long as it was: there was no way to assert on it, so the one
 * property that matters — every candidate that entered a stage leaves it either
 * as a survivor or as a named refusal — was never checked, and a whole stage
 * went missing without a single test going red.
 *
 * WHAT WENT WRONG, precisely. `scoreLeg` refuses in the order depth → impact →
 * graduation → age → activity, and the line named the first three and stopped.
 * A candidate turned back for a quiet tape therefore printed as
 * `1 passed graduation safety → 0 qualified`: a drop with no stage under it.
 * Nothing else logs `choice.refused`, so the reason existed nowhere at all, and
 * the only way to recover it was to know the scorer's ordering by heart and do
 * the subtraction in your head. An operator reading the line honestly got no
 * answer, which is the exact failure this funnel exists to prevent.
 *
 * SO THE RESIDUE IS REPORTED. Cumulative subtraction by kind silently loses any
 * kind nobody thought to subtract — that is the mechanism, not the mistake. The
 * fix is not "remember to add the next kind too": it is to carry what is left
 * over and print it, so the next unnamed kind shows up as a number instead of
 * disappearing between two stages.
 */
import type { RefusalKind } from "./candidate-score";

export interface ClassScanCounts {
  /** Rows the candidate table returned. */
  discovered: number;
  /** Of those, the ones carrying a curve — ANY quote token. */
  withCurve: number;
  /** Of those, the ones quoted in USDG and readable — `readClassLegs` output. */
  tradable: number;
  /** Every refusal the scorer produced, with its kind. */
  refused: readonly { kind: RefusalKind }[];
  /** Did the scorer pick one? */
  picked: boolean;
  /** Are the execution gates open, or is this a scan-only pass? */
  buying: boolean;
}

export interface ClassFunnelStages {
  passedDepth: number;
  passedImpact: number;
  passedGraduation: number;
  passedActivity: number;
  qualified: number;
  /**
   * Survivors of every NAMED stage that still did not qualify.
   *
   * Non-zero means the scorer refused on a kind this module does not account
   * for. It is the tripwire for the next `activity`: a number an operator can
   * see, rather than a candidate that vanishes between two stages.
   */
  unaccounted: number;
}

/**
 * The stages, cumulative.
 *
 * Sound because `scoreLeg` SHORT-CIRCUITS in this order, so each stage narrows
 * what survived the one before it and a candidate contributes exactly one
 * refusal. `unpriceable` joins impact because that is where an unreadable quote
 * stops the trade, and `age` joins activity because both are tape signals and
 * the age floor is currently zero — grouping them keeps the printed line short
 * without letting either go unreported.
 */
export function classFunnelStages(c: ClassScanCounts): ClassFunnelStages {
  const by = (k: RefusalKind) => c.refused.filter((r) => r.kind === k).length;
  const passedDepth = c.tradable - by("depth");
  const passedImpact = passedDepth - (by("impact") + by("unpriceable"));
  const passedGraduation = passedImpact - by("graduation");
  const passedActivity = passedGraduation - (by("activity") + by("age"));
  const qualified = c.picked ? 1 : 0;
  return {
    passedDepth,
    passedImpact,
    passedGraduation,
    passedActivity,
    qualified,
    unaccounted: passedActivity - qualified,
  };
}

/**
 * What changes between ticks.
 *
 * The producer runs every tick and the answer is usually the same one, so the
 * caller prints only when this moves. Every stage is in the key: a pass that
 * turned a candidate back at a different stage is a different answer even when
 * the ends match.
 */
export function classFunnelKey(c: ClassScanCounts, s: ClassFunnelStages): string {
  return (
    `${c.discovered}/${c.withCurve}/${c.tradable}/${s.passedDepth}/${s.passedImpact}/` +
    `${s.passedGraduation}/${s.passedActivity}/${s.qualified}/${c.buying ? 1 : 0}`
  );
}

/**
 * The operator's line.
 *
 * `with a curve` and `tradable in USDG`, NOT `usdg pairs` then `tradable`. The
 * old labels put the quote filter one stage too early: the first number is
 * every row carrying a curve whatever it is quoted in, and the USDG filter runs
 * inside `readClassLegs`, which produces the SECOND. So the line read
 * `9 usdg pairs → 1 tradable` about a set holding exactly one USDG pair, while
 * the census printed beside it said `usdg 1`. Two true numbers that flatly
 * contradict each other are worse than either alone.
 */
export function classFunnelLine(c: ClassScanCounts, s: ClassFunnelStages): string {
  return (
    `[class funnel] scanned ${c.discovered} → ${c.withCurve} with a curve → ${c.tradable} tradable in USDG → ` +
    `${s.passedDepth} passed depth → ${s.passedImpact} passed impact → ` +
    `${s.passedGraduation} passed graduation safety → ${s.passedActivity} passed activity → ` +
    `${s.qualified} qualified` +
    (s.unaccounted > 0 ? ` · ${s.unaccounted} refused for a reason no stage above names` : "") +
    (c.buying ? "" : " · BUYING OFF (scan only)")
  );
}
