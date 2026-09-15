/**
 * WHAT THE AGENT ACTUALLY TRADES, AND THE TWO WAYS TO GET IT WRONG.
 *
 * Extracted from `Proposals.tsx`, which had it right, because `Settings.tsx`
 * had the same read-modify-write and did not. One copy, so the next screen that
 * edits a basket inherits the reasoning rather than rediscovering it.
 */

/**
 * THE BASKET AS IT STANDS, WHICH IS NOT THE SAME AS THE BASKET THEY TYPED.
 *
 * `values.basketSymbols` is only set once an owner has EDITED their basket. For
 * everyone else it is undefined and the agent trades `defaults` implicitly.
 * Reading `values.basketSymbols ?? []` therefore does not read "no basket", it
 * reads "the default basket" as empty — and a read-modify-write on top of that
 * PUTs an explicit basket containing only whatever was just added. Adding one
 * memecoin would silently narrow the agent's whole universe to that memecoin,
 * for every owner who had never opened the basket editor, which is most of them
 * because the default is the point.
 *
 * The same "absent is not empty" rule the rest of this repo is built on. An
 * unset basket is a question nobody answered, and the answer is the default.
 */
export const basketNow = (s: {
  values?: { basketSymbols?: unknown[] };
  defaults?: { basketSymbols?: unknown[] };
}): string[] => (s.values?.basketSymbols ?? s.defaults?.basketSymbols ?? []) as string[];

/**
 * Add a symbol to a basket without disturbing what is already in it.
 *
 * ADDING A TOKEN AND TRADING IT ARE TWO DIFFERENT WRITES, and for a long time
 * only the first of them happened on the Settings screen. `customTokens` said
 * "know about this"; `basketSymbols` says "trade it" — a distinction
 * `strategies/registry.ts` states deliberately ("a token added to be tracked
 * must not start being bought on its own") and which nothing on that screen
 * made visible. An owner pasted a contract address, saved, re-signed, and asked
 * the group why his agent still only traded stocks. He had done nothing wrong;
 * the second write was never offered to him.
 *
 * `Proposals.tsx` already did both in one click, because approving a proposal
 * IS the owner saying both about one named coin. Typing an address and pressing
 * "add token" is the same deliberate act, so the same pair of writes applies —
 * with the choice left visible and reversible rather than assumed.
 */
export const withSymbol = (basket: readonly string[], symbol: string): string[] =>
  basket.includes(symbol) ? [...basket] : [...basket, symbol];

/**
 * The basket after an owner adds a token, given whether they asked to trade it.
 *
 * A FUNCTION RATHER THAN THREE LINES INSIDE `addToken`, and the reason is that
 * the first test written for this passed against a deliberately broken
 * implementation. It asserted `setSymbols(` appeared in the handler's source —
 * which is still true when the call sits inside `if (false)`. A source regex
 * cannot tell a decision from the text of one.
 *
 * So the decision moved somewhere it can be executed. The handler keeps the
 * React wiring; this keeps the rule, and the rule is what the tests are about.
 *
 * `saved` is the basket as it stands — session edit first, then the stored
 * value, then the DEFAULT, never `[]`. See `basketNow` above for why that last
 * step matters more than it looks.
 */
export function basketAfterAdd(opts: {
  saved: readonly string[];
  symbol: string;
  trade: boolean;
}): string[] {
  return opts.trade ? withSymbol(opts.saved, opts.symbol) : [...opts.saved];
}
