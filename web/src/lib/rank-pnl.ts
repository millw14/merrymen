/**
 * MAY THIS AGENT'S RETURN BE PUBLISHED, AND IF NOT, WHY NOT.
 *
 * Its own module, with NO IMPORTS, for the same reason the publication gate is:
 * it is the rule the public leaderboard exists to get right, and a rule buried
 * in the middle of a database read is a rule nobody can test. Keeping it
 * dependency-free is what lets a test call it directly instead of standing up a
 * ledger.
 *
 * Three things must all hold:
 *
 *   - capital on record, or there is no denominator;
 *   - an equity reading, or there is no numerator;
 *   - AT LEAST ONE LANDED TRADE.
 *
 * That third one is not obvious and it is the one that matters. `agents.mode`
 * is only the LAST HEARTBEAT's value, and the `equity` table carries no
 * per-row mode — so an agent that wrote its equity rows while simulating and is
 * labelled live now hands this a PRETEND balance to divide by a REAL deposit.
 *
 * Production published +2643.3% exactly that way, at the top of the board: a
 * flat 1000.0000 equity curve — the paper book's opening balance — over about
 * 36 USDG of contributions, from an agent with zero landed trades and 1,225
 * refusals. Every figure was real; the arithmetic was measuring the wrong two
 * things against each other.
 *
 * The fix is a refusal rather than a smarter formula. An agent that has never
 * filled a trade has not produced a return, and the board already has a word
 * for that.
 */

export type UnrankedWhy =
  | "no-deposit"
  | "never-filled"
  /**
   * Capital IS on record and it is not evidence.
   *
   * The worker publishes `agents.contributions_known` from the accounting anchor:
   * true only when every flow this epoch is a chain-log receipt or a
   * reconciling epoch-carry. False means the denominator rests on inference —
   * a balance change nobody can point at — and the phantom opening balances a
   * redeploy used to manufacture are exactly that shape. A percentage over an
   * unevidenced denominator is a confident wrong number, which is worse than a
   * dash.
   */
  | "contributions-unevidenced"
  /**
   * Nobody has assessed this book yet — the column is NULL, not false.
   *
   * An agent that has not armed since quality shipped has made no claim, and
   * picking an answer on its behalf is the mistake that runs in both directions.
   */
  | "quality-unknown";

export interface RankInputs {
  /** Capital in, less capital out. Null when nothing is on record. */
  contributed: number | null;
  /** The newest equity reading. Null when there is no history. */
  latest: number | null;
  /** Gas charged against the return, in USDG. */
  gasUsdg: number;
  /** Trades that actually filled. Zero means there is no return to measure. */
  landed: number;
  /**
   * What the worker says about the DENOMINATOR: true, false, or null for never
   * assessed.
   *
   * THREE STATES, because the two ways this can fail are different questions.
   * `false` means the contribution total rests on inference — a balance change
   * nobody can point at, which is exactly the shape a redeploy's phantom opening
   * balance had. `null` means nobody has looked yet. A boolean would have to
   * pick one of those to stand for both.
   *
   * Optional so a caller written before quality existed still compiles, but
   * `undefined` is treated as null, never as permission. Absent evidence is not
   * evidence.
   */
  contributionsKnown?: boolean | null;
}

export interface Rank {
  pnlBps: number | null;
  unrankedWhy: UnrankedWhy | null;
}

/**
 * The words a reader sees when there is no rank. ONE definition.
 *
 * The leaderboard and the agent page each had their own if/else chain over
 * `unrankedWhy`, both ending in a fall-through — so adding an arm to the union
 * did not break either of them, it just silently relabelled the new refusal as
 * "no deposit". A reader would have been told the account was unfunded when the
 * truth was that its funding could not be evidenced, which is a different and
 * more alarming fact.
 *
 * Exhaustive by construction: the `never` return makes a new arm a compile
 * error at this one site instead of a wrong word at two.
 */
export function unrankedLabel(why: UnrankedWhy): string {
  switch (why) {
    case "no-deposit":
      return "no deposit on record";
    case "never-filled":
      return "nothing has filled yet";
    case "contributions-unevidenced":
      return "capital on record is not evidenced";
    case "quality-unknown":
      return "not yet assessed";
    default: {
      const exhaustive: never = why;
      return exhaustive;
    }
  }
}

/** The same reasons, short enough for a leaderboard cell. */
export function unrankedShort(why: UnrankedWhy): string {
  switch (why) {
    case "no-deposit":
      return "no deposit";
    case "never-filled":
      return "never filled";
    case "contributions-unevidenced":
      return "unevidenced";
    case "quality-unknown":
      return "unassessed";
    default: {
      const exhaustive: never = why;
      return exhaustive;
    }
  }
}

/**
 * Exactly one of `pnlBps` and `unrankedWhy` is ever set — they are the two arms
 * of one answer, and both being set would let a page render a rank alongside an
 * excuse for not having one.
 */
export function rankPnl(a: RankInputs): Rank {
  // Checked before the fill count, because "no deposit" is the more fundamental
  // fact: an agent with neither should be told to fund, not to wait.
  if (a.contributed === null || a.contributed <= 0) {
    return { pnlBps: null, unrankedWhy: "no-deposit" };
  }
  if (a.landed <= 0) return { pnlBps: null, unrankedWhy: "never-filled" };
  if (a.latest === null) return { pnlBps: null, unrankedWhy: "never-filled" };
  // AND THE DENOMINATOR HAS TO BE EVIDENCE.
  //
  // Checked last because it is the subtlest of the four: the other three are
  // about a number being missing, this one is about a number being present and
  // unsupportable. Dividing by a contribution total assembled from inference
  // produces a confident percentage with nothing behind it, which is worse than
  // the dash it replaces — the phantom opening balances a redeploy manufactured
  // were exactly that, and every surface published returns over them.
  if (a.contributionsKnown === false) {
    return { pnlBps: null, unrankedWhy: "contributions-unevidenced" };
  }
  if (a.contributionsKnown === null || a.contributionsKnown === undefined) {
    return { pnlBps: null, unrankedWhy: "quality-unknown" };
  }
  return {
    pnlBps: Math.round(((a.latest - a.contributed - a.gasUsdg) / a.contributed) * 10_000),
    unrankedWhy: null,
  };
}
