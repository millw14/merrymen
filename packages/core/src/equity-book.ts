/**
 * ONE SERIES, ONE BOOK.
 *
 * An agent has two books and both write to `equity`. The paper one opens at
 * `paperStartUsdg` — 1,000 by default — and the funded one holds whatever the
 * owner actually sent. Nothing in the row said which, so an agent that
 * practised and then went live had a series that stepped from 1,000 to its real
 * equity in the space of one tick, and every surface reading it treated the step
 * as performance. A production owner was shown "−$950.17 today" for a book that
 * was down 2.7 cents.
 *
 * The two high-water marks were already kept apart — the paper book carries its
 * own, which is why the drawdown breaker was never fooled by this. It was only
 * ever the curve, and everything computed from the curve: the daily change, the
 * chart, and any return measured across its ends.
 *
 * WHAT THIS DOES NOT DO. It does not join a live run to an older live run across
 * a paper interlude — it does, and deliberately. The funded book kept existing
 * while the owner practised; nobody was marking it. That is a GAP IN
 * OBSERVATION of one book, which a series may legitimately span, and it is a
 * different thing from two books' marks interleaved.
 *
 * A NULL MODE PREDATES THE QUESTION and is not evidence of either book. Rows
 * written before the column existed keep their old behaviour exactly — the whole
 * series, unfiltered — because the alternative is to assert `live` about 900
 * rows an owner can see, and this file exists because of an assertion like that.
 * Once the newest row carries a mode, the series is that book's and the
 * unattributable prefix drops away.
 *
 * PURE. Given rows, returns rows.
 */

/** The only field this rule reads. Callers pass their own richer rows through. */
export interface EquityMarked {
  /** "paper", "live", or null/undefined for a row written before the column. */
  mode?: string | null;
}

/**
 * Keep only the marks belonging to the same book as the most recent one.
 *
 * `rows` must be in time order, oldest first — the order every caller already
 * selects in. The newest row decides, because it is the book the agent is
 * running now and the one every headline figure is about.
 */
export function sameBookAsLatest<T extends EquityMarked>(rows: readonly T[]): T[] {
  if (rows.length === 0) return [];
  const latest = rows[rows.length - 1]!.mode ?? null;
  // Nothing is attributable yet: return the series untouched rather than
  // emptying every chart in the product on the day the column ships.
  if (latest === null) return [...rows];
  return rows.filter((r) => (r.mode ?? null) === latest);
}

/**
 * Does this series span more than one book?
 *
 * For the surfaces that would rather say "this is the funded book since you
 * stopped practising" than silently show a shorter line. Null modes do not count
 * as a book — they are rows that never said.
 */
export function spansTwoBooks(rows: readonly EquityMarked[]): boolean {
  const seen = new Set<string>();
  for (const r of rows) if (r.mode === "paper" || r.mode === "live") seen.add(r.mode);
  return seen.size > 1;
}
