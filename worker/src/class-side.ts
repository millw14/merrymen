/**
 * WHICH SIDE OF THE CLASS VAULT A TRADE IS — from its assets, never its target.
 *
 * THE BUG THIS REPLACES. `scoutContextFor` decided "is this a class buy" from
 * `kind === "curve-trade" && target === ponsClassVault`, with no look at which
 * asset was being spent. A class SELL targets the same vault, so it was judged
 * an unpriceable PURCHASE, and policy.ts charged its PROCEEDS against the scout
 * budget on top of the class cost already held. Under the canary preset
 * (budget 15, 5 USDG entries) that refuses any exit whose proceeds exceed
 * `15 - heldCost` — so a single 5 USDG position that more than doubled could
 * never be sold, and the better the trade the more certain the refusal. With
 * three positions held, nothing could exit at all. policy.ts:514 stated the
 * opposite as an invariant; the code had never enforced it.
 *
 * THE RULE, in the words the owner used: a class BUY is when the quote asset is
 * being spent to acquire the class token; a class SELL is when the class token
 * is being spent and the quote asset comes back. Both producers emit exactly
 * those two shapes — entry at index.ts (`assetIn: quote, assetOut: token`),
 * exit at index.ts (`assetIn: token, assetOut: quote`) — and class buys are
 * funded in USDG and nothing else (packages/core/src/wall.ts), so the cash
 * token is the whole test.
 *
 * ITS OWN MODULE, for the reason venues/class-funnel.ts gives: this was three
 * lines inside a closure in index.ts, and a closure has nothing to assert on.
 * `scoutContextFor` now calls `scoutFlagsFor` and the test calls the same
 * function, so what is proven is what runs — not a hand-built flag.
 *
 * FAILS CLOSED. An intent at the vault where both or neither asset is the cash
 * token is a shape neither producer emits. It is budgeted as a buy rather than
 * waved through as a sell: a malformed intent must never be the one that gets
 * a free pass.
 */

import type { TradeIntent } from "./policy";

export type ClassSide = "buy" | "sell";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The side of a vault-targeted curve trade, or null when it is not one.
 *
 * Null covers: not a curve trade at all, no vault sealed in the grant, or a
 * curve trade at some other target — the PonsSelfTrade adapter, say — which
 * is not a class trade and is untouched by this module.
 */
export function classSideOf(
  intent: TradeIntent,
  // `string`, not `0x${string}`: AgentLimits carries the vault as a plain
  // string (limits.ts), and this only ever lowercases and compares it.
  vault: string | undefined,
  cash: `0x${string}`,
): ClassSide | null {
  if (intent.kind !== "curve-trade") return null;
  if (!vault || !same(intent.target, vault)) return null;
  const spendsCash = same(intent.assetIn, cash);
  const returnsCash = same(intent.assetOut, cash);
  if (spendsCash && !returnsCash) return "buy";
  if (returnsCash && !spendsCash) return "sell";
  return "buy"; // both or neither: malformed — fail closed, budget it
}

export interface ScoutFlags {
  /** Null when this is not a class-vault trade. */
  side: ClassSide | null;
  /** A class BUY — the only case where "unpriceable by construction" applies. */
  isClassBuy: boolean;
  /**
   * Is the asset being ACQUIRED unpriceable? This is what policy.ts gates the
   * scout budget on. A class sell acquires cash and is therefore never true,
   * whatever the tape says about the token being sold.
   */
  buyUnpriceable: boolean;
}

/**
 * The flags `scoutContextFor` hands to policy — computed here so they can be
 * tested against the real intents rather than asserted by hand.
 *
 * @param lastUnpriceable tokens the tick could not price this pass, lowercase.
 */
export function scoutFlagsFor(
  intent: TradeIntent,
  deps: { vault: string | undefined; cash: `0x${string}`; lastUnpriceable: ReadonlySet<string> },
): ScoutFlags {
  const side = classSideOf(intent, deps.vault, deps.cash);
  const isClassBuy = side === "buy";

  // A sell acquires the quote asset. It cannot be an unpriceable acquisition
  // by definition, so the tape is not consulted — stated here rather than left
  // to the coincidence that USDG is never on the unpriceable list.
  if (side === "sell") return { side, isClassBuy: false, buyUnpriceable: false };

  const buyToken =
    intent.kind === "swap" ? intent.buyToken : intent.kind === "curve-trade" ? intent.assetOut : null;
  const buyUnpriceable = isClassBuy || (buyToken !== null && deps.lastUnpriceable.has(buyToken.toLowerCase()));
  return { side, isClassBuy, buyUnpriceable };
}
