/**
 * WHAT A PERSON ACTUALLY PASTES, turned into an address.
 *
 * A user with 1010 USDG followed every step correctly, pasted his exchange
 * address into the withdrawal form, and found the button disabled with nothing
 * said. His address was bare 40-hex with no `0x` — which plenty of wallets and
 * explorers copy that way. A 40-character hex string is unambiguously an address
 * missing its prefix; there is nothing else it could be, so refusing it is
 * pedantry with somebody's money on the other side.
 *
 * THE RULE IS NARROW ON PURPOSE: normalise only what cannot be anything else,
 * and leave everything else invalid so the person is TOLD rather than guessed
 * at. A normaliser that got clever here would send funds somewhere nobody typed,
 * and that is not a mistake anyone can undo.
 *
 * Its own module, not a helper inside the panel, because it is a pure string
 * rule that decides where money goes — so it should be testable without a
 * browser, and it is used by more than one call site.
 */

/** Trim, drop an `ethereum:` URI wrapper, and supply a missing `0x`. */
export function normalizeAddr(v: string): string {
  const t = v
    .trim()
    .replace(/^ethereum:/i, "")
    .split("?")[0]!
    .trim();
  if (/^[0-9a-fA-F]{40}$/.test(t)) return `0x${t}`;
  return t;
}

/** Is this something we can pay, once normalised? */
export function isAddr(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(normalizeAddr(v));
}
