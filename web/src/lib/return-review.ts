/**
 * RETURNS AN OPERATOR HAS PUT UNDER REVIEW, from the web's
 * `MERRYMEN_RETURN_REVIEW`: smart-account addresses, separated by commas or
 * whitespace.
 *
 * WHY A LIST AND NOT A RULE. A book whose gas is not all on record is withheld
 * as gas-pending (book-performance.ts). Filling that gas in from receipts makes
 * it complete — and makes its return publishable and rankable at once, whether
 * or not the return is right. Some of those books have growth steps no trade
 * explains (a token sweep out reads as a trading loss until it is booked as a
 * withdrawal), and only a person reading the chain can say which. So the
 * accounts waiting on that review are named here BEFORE any gas is applied, and
 * until they come off the list their return is not published anywhere: no
 * percentage, no P&L, no growth line, no rank. The current value stays — it is
 * the recorded equity, not a claim about performance.
 *
 * FAILS CLOSED. One entry that is not an address puts EVERY book under review.
 * A typo that silently dropped an address would publish exactly the return the
 * list exists to hold back, and nothing on the page would say so; every row
 * reading "Return under review" is a failure the operator sees at once, which
 * is what the runbook's check of this list looks for.
 *
 * AND SAYS SO IN THE LOG. To someone checking only the rows they listed,
 * "every row is under review" and "the rows I listed are under review" look
 * the same — and an agent's NAME in place of its address is the likely way in.
 * So a malformed list is logged, once per process, with how many entries
 * failed and never what they were.
 *
 * Read on every call, never at import: what the list says is the process's
 * environment now, and a test can set it without reloading a module.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type ReturnReview = { all: true } | { all: false; accounts: ReadonlySet<string> };

/** Unset or blank is nobody. Any malformed entry is everybody — see above. */
export function parseReturnReview(raw: string | undefined): ReturnReview {
  const entries = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  if (entries.some((entry) => !ADDRESS.test(entry))) return { all: true };
  return { all: false, accounts: new Set(entries.map((entry) => entry.toLowerCase())) };
}

/**
 * The malformed list last logged. Every row of every page asks, so the log
 * says it once for the list the process runs with, not once per row.
 */
let warnedFor: string | null = null;

function warnMalformed(raw: string): void {
  if (raw === warnedFor) return;
  warnedFor = raw;
  const entries = raw.split(/[\s,]+/).filter(Boolean);
  const bad = entries.filter((entry) => !ADDRESS.test(entry)).length;
  console.warn(`[return-review] MERRYMEN_RETURN_REVIEW has ${bad} of ${entries.length} entries that are not 0x smart-account addresses; every return is withheld as under review until it is corrected`);
}

/** Whether this account's return is withheld for review. Address casing never decides. */
export function underReturnReview(account: string, raw = process.env.MERRYMEN_RETURN_REVIEW): boolean {
  const review = parseReturnReview(raw);
  if (review.all) warnMalformed(raw ?? "");
  return review.all || review.accounts.has(account.toLowerCase());
}
