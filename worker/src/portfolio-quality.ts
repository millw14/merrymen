/**
 * HOW MUCH OF THE BOOK IS ACTUALLY KNOWN — AS FIELDS, NOT AS PROSE.
 *
 * The audit used to end in one boolean. That boolean collapsed things that are
 * not the same kind of doubt at all: "the arithmetic does not add up" and "we
 * never got to ask the chain" and "the journal from before this container is
 * gone" all arrived as a single missing tick, and a single missing tick reads
 * as one problem to fix rather than three different questions about what the
 * numbers mean.
 *
 * It ran the other way too, and worse. With no RPC configured the chain checks
 * were SKIPPED and the run printed CHECKED AND SOUND — a clean bill of health
 * whose actual content was "we did not look". That is the specific failure this
 * file exists to make impossible: every field below can say `unknown`, and
 * `unknown` never renders as good news.
 *
 * THREE GUARANTEES, REPORTED SEPARATELY, because they fail independently and
 * because a consumer cares about different ones:
 *
 *   1. PORTFOLIO ARITHMETIC — do the primitives add up to the published figure?
 *      Answerable from the journal alone, offline, and the only one of the
 *      three that Phase 1 sets out to make true.
 *   2. ON-CHAIN VERIFICATION — does every recorded transaction exist on chain,
 *      with the sender and status claimed? Needs an RPC and is therefore
 *      routinely unavailable rather than routinely false.
 *   3. JOURNAL CONTINUITY — is the hash chain unbroken back to row one? A
 *      hosted child whose SQLite was discarded by a redeploy has no chain to
 *      walk, and no amount of care will bring it back. That is a permanent
 *      `unrecoverable`, and saying so is the honest answer.
 *
 * Nothing here decides anything. It is a description of evidence, consumed by
 * the audit CLI's exit code and (later) by the Brain request, both of which are
 * free to refuse on it — which is the point of it being fields.
 */

/** Gas is either charged against P&L, absent from it, or nobody knows which. */
export type GasAccounting = "net" | "gross" | "unknown";

/** Whether the hash chain reaches row one, breaks somewhere, or is simply gone. */
export type JournalContinuity = "verified" | "partial" | "unrecoverable" | "unknown";

/**
 * The machine-readable quality of a book.
 *
 * EVERY FIELD IS ALLOWED TO BE FALSE OR `unknown`, and a consumer that treats
 * an unknown as a pass has made the same mistake the old boolean made.
 */
export interface PortfolioQuality {
  /**
   * Guarantee 1, as a CLOSED UNION for the same reason guarantee 2 is one.
   *
   *   verified  the identity was closed and it held
   *   failed    it was closed and it did not hold
   *   unknown   it could not be closed — a term the identity needs was never
   *             published, so nothing was established either way
   *
   * The third state is not decoration. Marks written before the quarantined-cost
   * term was journalled carry only three of the four components of
   * `composeEquityUsdg`, and summing those against the total finds a discrepancy
   * exactly equal to the quarantined cost — indistinguishable from a book that
   * genuinely does not add up. Reporting that as a failure would accuse an
   * honest ledger; reporting it as a pass would be the original sin. It is
   * neither, and it says so.
   */
  arithmetic: "verified" | "failed" | "unknown";
  /**
   * Is the contribution total supported by evidence?
   *
   * False whenever a restart could not establish durable accounting state — see
   * bootstrap-state.ts. Contributions are the denominator of every performance
   * figure, so a false here makes P&L UNAVAILABLE rather than approximate.
   */
  contributionsKnown: boolean;
  /** Is every open position's cost basis receipt-derived rather than quoted? */
  costBasisComplete: boolean;
  /** Is the equity series free of holes over the period examined? */
  marksComplete: boolean;
  /** Whether P&L is net of gas, gross of it, or unresolved. */
  gasAccounting: GasAccounting;
  /**
   * Guarantee 2, as a CLOSED UNION rather than a boolean.
   *
   * It was a boolean with the unknown-ness pushed into the adjacent detail
   * string, and the renderer recovered it by comparing that string to the
   * literal "not checked". The CLI writes "not checked — no --rpc was given,
   * so nothing was refetched", the comparison missed, and an audit that never
   * opened a socket printed FAILED — announcing that the chain contradicted the
   * ledger when nothing had been asked. That is the same defect as the original
   * "no RPC means clean", pointed the other way, and it happened for the same
   * reason: a two-valued field carrying a three-valued fact, with the third
   * value smuggled through prose. Three states, three names, no parsing.
   */
  onchain: "verified" | "failed" | "unknown";
  /** Why guarantee 2 landed where it did. Always populated. */
  onchainDetail: string;
  /** Guarantee 3. */
  journalContinuity: JournalContinuity;
  /** Why guarantee 3 landed where it did. Always populated. */
  journalDetail: string;
  /** The accounting epoch the figures belong to. Epoch 1 predates the audit trail. */
  epoch: number;
}

/**
 * The safest thing that can be said about a book nothing is known about.
 *
 * Used as the base for every construction so that ADDING a field to
 * `PortfolioQuality` cannot silently default it to "fine" at a call site that
 * was written before the field existed.
 */
export const UNKNOWN_QUALITY: PortfolioQuality = {
  arithmetic: "unknown",
  contributionsKnown: false,
  costBasisComplete: false,
  marksComplete: false,
  gasAccounting: "unknown",
  onchain: "unknown",
  onchainDetail: "not checked",
  journalContinuity: "unknown",
  journalDetail: "not checked",
  epoch: 0,
};

/**
 * Is this book sound enough to publish a performance figure from?
 *
 * DELIBERATELY NARROW. It asks only about the arithmetic and the contributions,
 * because those two are what a P&L number is made of. On-chain verification and
 * journal continuity are about whether the record can be TRUSTED, not about
 * whether it ADDS UP, and conflating the two is how "we could not reach the
 * RPC" turned into "the accounts are wrong".
 */
export function pnlPublishable(q: PortfolioQuality): boolean {
  return q.arithmetic === "verified" && q.contributionsKnown;
}

/**
 * Every reason this book is not fully known, as short phrases.
 *
 * Empty means every guarantee held. Non-empty is what a gate prints before it
 * refuses, so each entry names the missing evidence rather than a severity.
 */
export function qualityGaps(q: PortfolioQuality): string[] {
  const gaps: string[] = [];
  if (q.arithmetic === "failed") gaps.push("portfolio arithmetic does not reconcile");
  if (q.arithmetic === "unknown") {
    gaps.push("portfolio arithmetic could not be closed — the mark is missing a term of the equity identity");
  }
  if (!q.contributionsKnown) gaps.push("contributions unknown — P&L unavailable");
  if (!q.costBasisComplete) gaps.push("cost basis incomplete");
  if (!q.marksComplete) gaps.push("equity series has gaps");
  if (q.gasAccounting !== "net") gaps.push(`gas accounting is ${q.gasAccounting}`);
  if (q.onchain !== "verified") gaps.push(`on-chain verification: ${q.onchainDetail}`);
  if (q.journalContinuity !== "verified") gaps.push(`journal continuity ${q.journalContinuity}: ${q.journalDetail}`);
  return gaps;
}

/**
 * The three guarantees, each on its own line, each with its own verdict.
 *
 * Every verdict is read straight off a field. Nothing here infers a state by
 * inspecting a message, which is how "not checked" once came out as FAILED.
 */
export function guaranteeLines(q: PortfolioQuality): string[] {
  const word = { verified: "HELD", failed: "FAILED", unknown: "UNKNOWN" };
  const onchain = word[q.onchain];
  return [
    `portfolio arithmetic truth        ${word[q.arithmetic]}` +
      (q.contributionsKnown ? "" : "  (contributions unknown — P&L unavailable)"),
    `transaction/on-chain verification ${onchain}  ${q.onchainDetail}`,
    `journal-chain continuity          ${q.journalContinuity.toUpperCase()}  ${q.journalDetail}`,
  ];
}
