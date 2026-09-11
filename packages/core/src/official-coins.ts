/**
 * OFFICIAL COINS — the platform's own curated non-equity listings.
 *
 * WHY THIS EXISTS. `steady-basket` skips every leg whose Chainlink feed is
 * stale, all 24 equity feeds go stale at a weekend, and the remedy the worker
 * already ships for that — the curve fallback, "the always-on side of the chain,
 * for when the always-off side is shut" — reaches only tokens the owner added in
 * /settings AND put in their basket AND re-signed for. An owner holding the
 * default equity basket therefore had a fallback that could never fire, and the
 * sentence they were shown said "Memecoins trade around the clock and are
 * unaffected" while nothing on the platform could reach one.
 *
 * An official coin is the platform doing for a coin what it already does for
 * AAPL: publishing a verified address so no owner has to find, type or vouch for
 * one. It is CURATED, not discovered — that is the whole difference from the
 * trencher feed, which deliberately cannot drive entries in live mode.
 *
 * ── WHAT IS PINNED HERE AND WHY EACH FIELD ──────────────────────────────────
 *
 * The curve travels WITH the token, and that is the load-bearing decision.
 * The worker normally learns a curve from `curveFor()`, which reads
 * `discovered_pools` — a table `pruneDiscovered()` trims to the 5,000 newest
 * rows against a launchpad measured at ~475 launches an hour. A coin listed here
 * would age out of its own provenance in hours and then be unpriceable and
 * unsellable, which is the no-exit trap in its purest form: a position the
 * platform put you in and then forgot how to value. Pinning the curve makes an
 * official listing independent of the discovery window, the prune, and whether
 * the worker happened to be running when the coin launched.
 *
 * `graduationThresholdRaw` is not decoration either. Pons opens every curve with
 * a VIRTUAL reserve of 40% of it, so without the threshold a reported reserve
 * cannot be turned into how much money is really there — see
 * `worker/src/venues/pons-price.ts:realQuoteRaw`. A wrong threshold does not
 * produce a slightly wrong depth; it produces a depth that is confidently wrong
 * in the direction of "deeper than it is".
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────
 *
 * It does NOT add anything to `STOCK_TOKENS`, and it must never be made to.
 * Three separate things would break:
 *
 *   1. `snapshot.ts` calls `tokenPaused()` across `STOCK_TOKENS`. A Pons coin is
 *      a plain ERC-20 with no such function (verified: the call reverts), so its
 *      entry would fail every tick and be pushed into `unread` — reporting "we
 *      could not read this" about a token that simply has nothing to read. That
 *      is the empty-vs-unavailable rule broken in the one place the whole
 *      codebase is most careful about it.
 *   2. `builtinGrantTargets()` derives its address set from `STOCK_TOKENS`
 *      filtered by `TRADEABLE_SYMBOLS` AT RUNTIME, while the on-chain wall was
 *      sealed at SIGNING time. A coin added there would join `sellableAssets`
 *      for every already-signed grant, so the worker would believe it could sell
 *      something the signature does not cover — a hole in the wall, and the same
 *      shape of hole this repo has already had to close once.
 *   3. The web UI renders registry entries as stocks.
 *
 * So an official coin enters through the same door an owner-added token uses —
 * `kind: "memecoin"`, `chainlinkFeed: null` — which is exactly what routes it to
 * curve pricing (`index.ts`'s `feedless` filter demands both), keeps it out of
 * `withFeed` and therefore out of `staleFeeds` forever, and keeps it away from
 * every ERC-8056 multiplier and pause read.
 *
 * ── A LISTING IS NOT A RECOMMENDATION ───────────────────────────────────────
 *
 * Everything downstream still binds: the per-trade cap, the daily cap, the scout
 * budget for unpriceable money, the depth floor, the impact ceiling, the
 * round-trip check, the stop-loss and take-profit floors, and the wall itself.
 * A coin listed here is reachable, not endorsed, and an owner can decline the
 * whole category with `officialCoinsEnabled: false`.
 *
 * AND IT STILL NEEDS A SIGNATURE. Listing a coin cannot widen a grant that is
 * already signed — that is the point of the wall. An owner whose grant predates
 * a listing must re-sign before their key can touch it, and no code here, or
 * anywhere, may route around that.
 */
import { CASH } from "./tokens";
import type { CustomToken } from "./tokens";

/** A platform-curated coin, with everything needed to price and trade it pinned. */
export interface OfficialCoin {
  /** Ticker as the CONTRACT reports it, uppercased for symbol-keyed lookups. */
  symbol: string;
  /** Human name, read from the contract at listing time. */
  name: string;
  /** The ERC-20, lowercased. */
  address: `0x${string}`;
  /** Real ERC-20 decimals. Never guessed — the asset model divides by 10^this. */
  decimals: number;
  /** Its Pons bonding curve, lowercased. Pinned; see the header. */
  curve: `0x${string}`;
  /** What the curve is priced in. USDG only — see `officialCoinsFor`. */
  quoteToken: `0x${string}`;
  /** Raw quote units at which the curve graduates. Decoded from the launch log. */
  graduationThresholdRaw: bigint;
  /** When this listing was verified against the chain, for the audit trail. */
  listedOn: string;
}

/**
 * THE USDG-ONLY RULE, and it is a reachability fact rather than a preference.
 *
 * `PonsSelfTrade` is non-payable, so the wall keeps `valueLimit: 0n` and the
 * adapter cannot touch a native-ETH-quoted curve — 57.6% of the launchpad,
 * measured over 18,084 launches in a 25-hour window. Stock-token-quoted curves
 * are reachable in principle but would spend an equity position to buy a
 * memecoin, which is not a trade any owner asked for. That leaves USDG, which is
 * also the one asset every funded agent actually holds.
 */
function isUsdgQuoted(c: OfficialCoin): boolean {
  return c.quoteToken.toLowerCase() === (CASH.USDG as string).toLowerCase();
}

/**
 * Listings per chain.
 *
 * An empty list is the honest state for a chain with no verified listing, and is
 * a different fact from "official coins are turned off" — which is a setting.
 */
export const OFFICIAL_COINS: Readonly<Record<number, readonly OfficialCoin[]>> = Object.freeze({
  /**
   * Robinhood Chain mainnet — EMPTY, and the measurement that emptied it is the
   * most useful thing in this file.
   *
   * ROBINHOOD (0xcd69e6…77dd6) was listed here on 2026-09-11, picked by
   * measurement rather than taste: of 1,509 USDG-quoted Pons launches in a
   * 25-hour window it carried by far the deepest real book — $3,007.70 excluding
   * the virtual seed, 37.2% of the way to graduation, against a median in the
   * low tens of dollars. It read clean on every other axis too: 18 decimals, 1e9
   * supply, no `tokenPaused()`, and a $5 round trip returning 97.87%.
   *
   * THREE AND A HALF HOURS LATER ITS CURVE HELD $0.26. Nearly the whole supply
   * had been sold back into it. Production caught this correctly and refused to
   * value it ("only $0 has really been raised into this curve, under the $250
   * floor"), so nothing could be bought — but the listing was by then a dead
   * token pinned inside a platform constant.
   *
   * IT WAS NOT A BAD PICK; IT WAS THE WRONG CONTAINER. Re-measuring the 14
   * deepest USDG curves over the same interval: two went to zero, five lost
   * ~79%, six were flat or up — SEVEN OF FOURTEEN fell under the $250 curve
   * floor in one afternoon. A launchpad coin's depth has a half-life measured in
   * hours. A listing here has to outlive a 14-day grant cycle, because the wall
   * seals token addresses at SIGNING time and every owner must re-sign to reach
   * a new entry. Those two timescales are three orders of magnitude apart, and
   * no amount of care choosing the coin closes that gap.
   *
   * SO WHAT BELONGS HERE is an asset whose depth is durable on the scale of a
   * grant: a graduated token with a real pool, or a major non-equity. The
   * ephemeral-launchpad problem is a DIFFERENT problem, and this repo already
   * has the right architecture for it — the class route, which grants
   * permissions on a per-account vault rather than on token addresses, and can
   * therefore reach a coin that did not exist when the grant was signed. See
   * MerrymenSettings.classSnipeEnabled and docs/owner-runbook-class.md.
   *
   * An empty list is the honest state, and it is a different fact from "official
   * coins are turned off", which is a setting.
   */
  4663: [],
  /** Robinhood Chain testnet — the launchpad is not meaningfully populated. */
  46630: [],
});

/**
 * Listings for a chain, filtered to the ones that are actually reachable.
 *
 * The filter runs HERE rather than at each call site so that a listing which
 * cannot be traded also cannot be watched, priced, put in a basket or sealed
 * into a wall. A coin the agent can see and can never act on is the failure this
 * whole file exists to end, and reproducing it one layer down would be worse
 * than not listing at all.
 */
export function officialCoinsFor(chainId: number): readonly OfficialCoin[] {
  return (OFFICIAL_COINS[chainId] ?? []).filter(isUsdgQuoted);
}

/** One listing by address, or null. Lowercase-insensitive. */
export function officialCoinByAddress(chainId: number, address: string): OfficialCoin | null {
  const key = address.toLowerCase();
  return officialCoinsFor(chainId).find((c) => c.address.toLowerCase() === key) ?? null;
}

/** One listing by symbol, or null. Case-insensitive. */
export function officialCoinBySymbol(chainId: number, symbol: string): OfficialCoin | null {
  const key = symbol.toUpperCase();
  return officialCoinsFor(chainId).find((c) => c.symbol.toUpperCase() === key) ?? null;
}

/** Every official symbol on a chain, for basket resolution. */
export function officialCoinSymbols(chainId: number): string[] {
  return officialCoinsFor(chainId).map((c) => c.symbol);
}

/**
 * Listings in the shape the SIGNERS take, so a re-sign seals them.
 *
 * `usableExtraTokens` drops anything already in `builtinGrantTargets()` and
 * anything malformed, so passing these alongside the owner's own custom tokens
 * is safe against both duplication and a listing that collides with a built-in.
 */
export function officialCoinTokens(chainId: number): CustomToken[] {
  return officialCoinsFor(chainId).map((c) => ({
    symbol: c.symbol,
    address: c.address,
    decimals: c.decimals,
  }));
}

/**
 * The curve record for an official coin, in the shape `curveFor()` returns.
 *
 * Returned as ONE object or not at all, matching the store's own discipline: a
 * curve without a threshold, or a threshold without a curve, cannot be read as
 * money.
 */
export function officialCoinCurve(
  chainId: number,
  address: string,
): { curve: `0x${string}`; quoteToken: `0x${string}`; graduationThresholdRaw: bigint } | null {
  const c = officialCoinByAddress(chainId, address);
  if (!c) return null;
  return { curve: c.curve, quoteToken: c.quoteToken, graduationThresholdRaw: c.graduationThresholdRaw };
}
