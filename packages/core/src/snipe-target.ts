/**
 * "SNIPE PEPE WITH $20" — TURNING WHAT SOMEBODY TYPED INTO ONE TOKEN.
 *
 * An owner names a coin the way they would to a friend: a ticker, a fragment of
 * a name, sometimes the wrong case, sometimes an address. There is no single
 * resolver in this repo — there are six partial ones across two processes, none
 * of which agree on what a "symbol" is — and every one of them assumes the
 * caller already knows which token they mean.
 *
 * A snipe is exactly the case where they do not.
 *
 * SYMBOLS ARE NOT UNIQUE ON THIS CHAIN, and that is the whole reason this file
 * is careful. Anyone may launch a token calling itself anything: the live market
 * list carries five separate coins named NEON, four named HANK, three named
 * STRC and two named haMSTR. `instrumentClassOf` already says the quiet part —
 * "A discovered token may call itself AAPL. The address is the identity." So a
 * resolver that returns the first match is not a convenience, it is a way to
 * spend somebody's money on a different coin than the one they named, and the
 * failure is silent and total.
 *
 * Therefore: ONE match acts, MORE THAN ONE asks, ZERO says so. There is no
 * best-guess arm, no scoring tie-break, no "did you mean". A tie is a question,
 * because the cost of guessing wrong is the entire amount.
 *
 * PURE. Given candidates and a query, returns a verdict. No I/O, no chain, no
 * ledger — the caller assembles the candidate list from whatever it can see, so
 * the same rule serves the web chat and the Telegram bot without either one
 * learning about the other's sources.
 */

/** One thing a query could resolve to. Callers map their own rows into this. */
export interface SnipeCandidate {
  /** The identity. Lower-cased by `resolveSnipeTarget`; compared as such. */
  address: string;
  /** Ticker as the token reports it. Attacker-chosen; never assumed unique. */
  symbol: string;
  /** Long name, when there is one. Also attacker-chosen. */
  name?: string | null;
  /**
   * Whether the signed grant already covers this token.
   *
   * NOT a filter — an uncovered coin still resolves, because "I found it and
   * cannot trade it yet" is a far better answer than "I could not find it",
   * and it is the answer that tells an owner what to do next.
   */
  covered?: boolean;
}

export type SnipeResolution =
  | { kind: "one"; target: SnipeCandidate; matchedOn: "address" | "symbol" | "name" }
  | { kind: "many"; query: string; candidates: SnipeCandidate[] }
  | { kind: "none"; query: string };

/** An 0x-prefixed 20-byte address, in any case. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * How many options are worth listing back before the question stops helping.
 *
 * Five NEONs is a question a person can answer. Forty is a wall of text that
 * makes them give up, and the honest reply there is that the name is too common
 * to act on — which `many` says by carrying the full count separately from what
 * gets rendered.
 */
export const SNIPE_MAX_CHOICES = 6;

/**
 * Resolve a typed query against a candidate set.
 *
 * PRECEDENCE IS EXACTNESS, NOT POPULARITY. An address beats everything, an
 * exact ticker beats a name, and a name fragment is the last resort — because
 * each step down is a step further from something the owner could have verified
 * before typing it. Within a step, ties are never broken: a tie is `many`.
 */
export function resolveSnipeTarget(
  query: string,
  candidates: readonly SnipeCandidate[],
): SnipeResolution {
  const q = norm(query ?? "");
  if (!q) return { kind: "none", query: String(query ?? "") };

  const all = candidates.map((c) => ({ ...c, address: norm(c.address) }));

  // ── AN ADDRESS IS THE IDENTITY, so it cannot be ambiguous and it does not
  // need to be in the candidate list to be meant. It still has to be KNOWN to
  // be actionable, so an unknown one falls through to `none` rather than being
  // fabricated into a target.
  if (ADDRESS.test(q)) {
    const hit = all.find((c) => c.address === q);
    return hit ? { kind: "one", target: hit, matchedOn: "address" } : { kind: "none", query };
  }

  // A leading $ is how people write tickers and is never part of one.
  //
  // AND WHAT IS LEFT MUST NOT BE EMPTY. "$" alone survives the blank check
  // above, strips to "", and then matches EVERY candidate — because
  // `"anything".includes("")` is true. A query that should match nothing
  // matching all of them is precisely the failure this file exists to prevent,
  // and it arrives as `many`, which reads like a real ambiguity.
  const bare = q.replace(/^\$+/, "");
  if (!bare) return { kind: "none", query };

  const bySymbol = all.filter((c) => norm(c.symbol ?? "") === bare);
  if (bySymbol.length === 1) return { kind: "one", target: bySymbol[0]!, matchedOn: "symbol" };
  if (bySymbol.length > 1) return { kind: "many", query, candidates: bySymbol };

  // NAME MATCHING IS SUBSTRING AND DELIBERATELY GENEROUS, because it only ever
  // runs when no ticker matched at all — and it can only ever produce a
  // question or a single answer, never a guess.
  // `bare` is non-empty by the guard above; the length check here is belt to
  // that brace, because an empty needle turns this filter into "select all".
  const byName = all.filter((c) => {
    const n = norm(c.name ?? "");
    return n.length > 0 && bare.length > 0 && (n === bare || n.includes(bare));
  });
  if (byName.length === 1) return { kind: "one", target: byName[0]!, matchedOn: "name" };
  if (byName.length > 1) return { kind: "many", query, candidates: byName };

  return { kind: "none", query };
}

/**
 * A short, stable way to tell two coins with the same ticker apart.
 *
 * The address is the only thing that distinguishes them, and a full one is
 * unreadable in a chat line. Six hex characters is enough for a person to match
 * against an explorer and far too many to collide inside one query's results.
 */
export function shortAddress(address: string): string {
  const a = norm(address);
  return ADDRESS.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
