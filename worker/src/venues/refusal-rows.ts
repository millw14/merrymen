/**
 * WHICH VENUE'S ANSWER SURVIVES, WHEN SEVERAL LOOKED AT THE SAME TOKEN.
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────
 *
 * The pricing pass tries three venues in order — a Uniswap v3 route, then v4,
 * then the bonding curve — and each may refuse. One list of rows carries the
 * outcome, and `poolRefusals` is rebuilt from it wholesale, so whatever is in
 * that list at the end is the only thing the owner is ever told.
 *
 * Two bugs lived in the ten inline lines that maintained it, and both were
 * invisible because they produce a plausible sentence rather than an error:
 *
 *   The v4 pass wrote its reason STRAIGHT INTO `poolRefusals` and never into
 *   the row list, so the rebuild below it discarded the write every time. A
 *   pool that was found, measured and turned down for an 86% fee was reported
 *   as "no Uniswap v3 pool against USDG or WETH — nothing to price it from".
 *
 *   The curve pass then replaced whatever row was present, though its own
 *   comment says it replaces the pool's "no-pool" — so even a surviving v4
 *   verdict would have become "I know this token but not where it trades",
 *   which is the opposite of what v4 had just measured.
 *
 * Both are the same mistake: a LATER pass overwriting a MEASUREMENT with an
 * absence. So the precedence rule lives here, as one pure function with a name,
 * instead of as an assignment inside a loop inside a 200-line closure that no
 * test can reach.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────
 *
 * A venue that looked and refused outranks a venue that found nothing to look
 * at. `no-pool` means "this pricer had nothing to measure", so anything may
 * replace it; everything else is a measurement and is kept.
 */

/** A refusal row as the pricing pass carries it. `kind` is the stable key. */
export interface RefusalRow {
  symbol: string;
  kind: string;
  reason: string;
}

/**
 * The kinds that mean "there was nothing here to measure".
 *
 * NAMED EXPLICITLY, not inferred from a prefix. `curve-no-curve` is the one
 * that makes the difference: it is emitted by the curve pass, so a rule like
 * "a later venue loses" or "anything not `no-pool` is a measurement" would let
 * it overwrite the v4 fee measurement recorded moments earlier — which is the
 * precise bug this file exists to stop, arriving from the other side.
 *
 * Everything else — a fee ceiling, a depth floor, a divergence band, a stale
 * read, a graduated curve — is something a venue looked at and judged.
 */
const ABSENCE_KINDS: ReadonlySet<string> = new Set([
  // No Uniswap v3 route against USDG or WETH.
  "no-pool",
  // No curve, or a curve that did not answer. Both spellings come from
  // curve-prices.ts under the single kind `no-curve`.
  "curve-no-curve",
]);

/** Did this row come from a venue that actually measured something? */
export function isMeasured(kind: string): boolean {
  return !ABSENCE_KINDS.has(kind);
}

/**
 * Add or replace one token's refusal, keeping the more informative answer.
 *
 * Mutates `rows` in place, because the caller owns a list it is still building
 * and copying it per token would be a different function pretending to be this
 * one. Returns whether the row was taken, which is what a test asserts on.
 */
export function upsertRefusal(rows: RefusalRow[], row: RefusalRow): boolean {
  const at = rows.findIndex((x) => x.symbol === row.symbol);
  if (at < 0) {
    rows.push(row);
    return true;
  }
  // A measurement is never overwritten by an absence. Same-venue updates still
  // land: a second v4 read replacing the first is two measurements, and the
  // later one is the current one.
  if (isMeasured(rows[at]!.kind) && !isMeasured(row.kind)) return false;
  rows[at] = row;
  return true;
}
