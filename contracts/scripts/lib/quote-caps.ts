/**
 * The translation from "the owner will risk $X in this quote asset" into the
 * raw integer a PonsClassVaultV2 compares against.
 *
 * ITS OWN MODULE, IMPORTING NOTHING, because this is the only number in the
 * system that is sealed on chain and then never re-derived. The vault reads no
 * price and no ERC-8056 share multiplier at execution time — that is the rule
 * that keeps a hostile curve from choosing its own ceiling — so this arithmetic
 * runs exactly once, off chain, before signing. An error here is not a bad
 * trade; it is a ceiling that does not mean what the owner was told it means.
 *
 * The deploy script cannot be imported by a test (it calls `main()` at module
 * scope and would try to deploy), so the formula lives here and both sides
 * import it. See contracts/test/quote-caps.test.ts.
 */

/** ERC-8056 multipliers are 18-decimal fixed point; 1e18 means "no split". */
export const UI_ONE = 10n ** 18n;

/**
 * usd6 × 10^dec × 1e8 × 1e18 / (price8 × uiMultiplier × 1e6), evaluated as one
 * integer expression so precision is lost exactly once, at the end.
 *
 * WHY THE MULTIPLIER IS IN THE DENOMINATOR. A Stock Token's displayed balance
 * is `raw × uiMultiplier / 1e18`, and Chainlink prices the DISPLAYED share. So
 * one raw unit is worth `price × uiMultiplier / 1e18` dollars, and a fixed
 * dollar budget buys FEWER raw units as the multiplier grows. Inverting this is
 * the mistake that looks right in review: a 10:1 split would silently seal a
 * ceiling a hundred times the allowance.
 *
 * ROUNDS DOWN, by integer division. A cap that rounded up would be a ceiling
 * larger than the allowance the owner approved, which is the one direction that
 * is not merely inconvenient.
 *
 * @param usd           the owner's allowance in dollars (e.g. 25 for $25)
 * @param decimals      the quote token's own `decimals()`
 * @param price8        Chainlink's answer, 8dp, per displayed share
 * @param uiMultiplier  ERC-8056 share scaling, 18dp (`UI_ONE` for a stable)
 */
export function rawCapFor(usd: number, decimals: number, price8: bigint, uiMultiplier: bigint): bigint {
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`allowance ${usd} is not a positive dollar figure`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`decimals ${decimals} is implausible`);
  if (price8 <= 0n) throw new Error(`price ${price8} is not positive`);
  if (uiMultiplier <= 0n) throw new Error(`uiMultiplier ${uiMultiplier} is not positive`);
  const usd6 = BigInt(Math.round(usd * 1e6));
  return (usd6 * 10n ** BigInt(decimals) * 100n * UI_ONE) / (price8 * uiMultiplier);
}

/** The vault packs a cap into a uint96. A cap that does not fit is refused, never truncated. */
export const MAX_CAP = 2n ** 96n - 1n;
