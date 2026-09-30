/**
 * WHO DECIDED THIS — recorded at the moment of deciding, never inferred later.
 *
 * ── WHY THIS IS NOT `source` ─────────────────────────────────────────────
 *
 * `decisions.source` is the PUBLICATION key: `thesis-policy.ts` maps it to a
 * trust level and to whether the row may be shown at all. It is fine-grained by
 * design — `strategy:even-keel` and `strategy:dip-hunter` are different sources
 * because they are different publishers.
 *
 * Provenance is a different question with a coarser answer: WHAT KIND OF THING
 * decided. Two rows can share a source and differ here — a `dip-hunter` buy is
 * a deterministic strategy acting on its rule, and a `dip-hunter` stop-floor
 * sell is a hard risk exit that fired whatever the strategy wanted. Reading one
 * off the other means deciding, per reader, which sources "count as" risk
 * exits; and every reader would have to get it right forever.
 *
 * ── AND WHY IT IS A COLUMN RATHER THAN A DERIVATION ──────────────────────
 *
 * Because the alternative is a function that guesses. The class route's exit
 * cause taught this exactly once already: `aged` and `graduating` were computed
 * correctly and then spent on a log line, so from the intent onward a clock
 * exit and a cliff exit were the same bytes and no reader could tell them
 * apart. The fix was to carry the fact, not to reconstruct it.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────
 *
 * NEVER PRETEND ONE SOURCE WAS ANOTHER. A deterministic trade must not claim
 * Brain provenance, and an owner's typed order must not claim autonomy — those
 * are the two directions that matter, because each of them lies about whether
 * anybody chose. `brain-shadow.ts` already refuses the mirror image of this
 * ("filing this as chat would put the owner's name on a decision they did not
 * make"), and this is that rule given a column to live in.
 *
 * PURE. No database, no environment: a string in, a string out, so the whole
 * mapping is testable as a table.
 */

/**
 * The five kinds, closed.
 *
 *   brain                   — a BrainDecision. The model chose, within policy.
 *   deterministic-strategy  — a rule chose: steady-basket, even-keel, the class
 *                             route's scoring. No model was consulted.
 *   owner-command           — a person typed it. Autonomy claimed here would be
 *                             a lie about who is trading.
 *   peer-triggered-research — research an agent started because a peer it wires
 *                             in said something. The trade that follows is
 *                             still the agent's own, and the wall still vets it;
 *                             this records that the LOOK began elsewhere.
 *   hard-risk-exit          — a stop-floor, a take-profit, a graduation cliff.
 *                             The machine cut it, and the distinguishing fact is
 *                             that it fires whatever the strategy wanted.
 */
export const PROVENANCE_KINDS = [
  "brain",
  "deterministic-strategy",
  "owner-command",
  "peer-triggered-research",
  "hard-risk-exit",
] as const;
export type Provenance = (typeof PROVENANCE_KINDS)[number];

export function isProvenance(v: unknown): v is Provenance {
  return typeof v === "string" && (PROVENANCE_KINDS as readonly string[]).includes(v);
}

/**
 * The `Why` codes that are a RISK EXIT rather than a strategy acting.
 *
 * Listed rather than pattern-matched: "contains the word stop" is the kind of
 * rule that silently reclassifies the next code somebody adds. A code absent
 * from this set is an ordinary deterministic decision, which is the safe
 * default — it claims less.
 */
const RISK_EXIT_CODES: ReadonlySet<string> = new Set([
  "stop-floor",
  "take-profit",
  "trench-exit",
  // The class route's two exits: a clock running out and a contract about to
  // stop accepting sells. Both fire regardless of what the entry scoring wanted.
  "class-exit",
]);

/**
 * What kind of thing decided, from the publication source and (when there is
 * one) the typed reason the producer emitted.
 *
 * `whyCode` is the discriminator that `source` cannot carry: a deterministic
 * strategy publishes its ordinary buys and its stop-loss sells under the same
 * source, and only the `Why` knows which is which.
 *
 * DEFAULTS TO THE SMALLEST CLAIM. An unrecognised source is
 * `deterministic-strategy`, not `brain`: a row that cannot prove a model chose
 * it must not say one did.
 */
export function provenanceOf(source: string, whyCode?: string | null): Provenance {
  if (whyCode && RISK_EXIT_CODES.has(whyCode)) return "hard-risk-exit";
  // `brain-shadow` is Brain too: the reasoner is the same one, and the fact
  // that execution was not connected is carried by the source, not by this.
  if (source === "brain" || source === "brain-shadow") return "brain";
  if (source === "chat") return "owner-command";
  return "deterministic-strategy";
}
