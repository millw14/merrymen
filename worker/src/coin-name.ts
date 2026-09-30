/**
 * THE WORD A READER RECOGNISES, BESIDE THE ID EVERYTHING SETTLES AGAINST.
 *
 * A discovered coin's `symbol` is address-derived on purpose — `T` plus eleven
 * hex of the contract (trencher-discovery.ts:46) — because a coin's own
 * `symbol()` is text its deployer chose and can change, and one calling itself
 * NVDA must never resolve to a stock's price. That property is worth keeping,
 * and printing `T7631DACC21B` at a reader on its own is still unreadable.
 *
 * So the name rides ALONGSIDE the id, and this is the only place that decides
 * what the name may be. It lived as a closure inside index.ts, where it was
 * safe only because of WHERE it happened to be called — the Brain path, whose
 * symbols are always synthetic. The moment a second caller appeared that rule
 * stopped holding, so it moved here where it can be executed by a test rather
 * than argued about.
 */

/** Only the fields the rule reads — so a test need not build a whole token. */
export interface NameableToken {
  symbol: string;
  name?: string;
  kind?: string;
}

/**
 * DISPLAY ONLY, and absent rather than placeholder.
 *
 * The name came off a third-party pool label, so it is the one string here
 * somebody else wrote: the allowlist is deliberately narrow, an empty result
 * is null, and anything address-shaped is dropped because a post may never
 * carry one.
 */
export function coinDisplayName(token: NameableToken | undefined | null): string | null {
  if (!token) return null;
  // A STOCK IS ALREADY NAMED. "stock" and "etf" are the issuer-backed set with
  // Chainlink feeds, and their tickers are what a reader knows them by —
  // "buy Tesla (TSLA)" is noise, not clarity. Only the address-derived ids
  // need a word attached, and this is the clause that keeps the deterministic
  // strategies (which trade stocks) from rewriting every row in the feed.
  if (token.kind !== "memecoin") return null;
  const raw = (token.name ?? "").trim();
  // A GeckoTerminal pool label is "CASHCAT / WETH 1%" — the coin is the part
  // before the pair separator, and the rest is the venue, not the name.
  const head = raw.split("/")[0]!.trim();
  const clean = head.replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 24);
  if (!clean || clean === token.symbol || /^0x/i.test(clean) || !/[A-Za-z]/.test(clean)) return null;
  return clean;
}
