/**
 * $MERRYMEN IS ENERGY, NOT A COIN TO TRADE — SAID ONE WAY, EVERYWHERE THE WEB
 * WOULD OTHERWISE SAY "RE-SIGN TO COVER IT".
 *
 * Every signer drops the energy reserve from the sealed extras
 * (core wall.ts usableExtraTokens) and the worker never watches it, so the
 * usual answer to "why can't my agent trade X" — add it and re-sign — is false
 * for this one token, however many times it is followed. The agent buys it only
 * through get-energy, in the Merrymen app chat, where the owner confirms the
 * amount; its key can never sell or send it.
 *
 * The sites that used to give the false advice (the snipe resolver, the
 * proposals list, the MCP trade proposal and eligibility check) take their
 * words from here, so a copy change is made once. No price or returns
 * language, ever (core token.ts STANCE).
 */
import { MERRYMEN_TOKEN, isEnergyReserveToken, shortAddress } from "@merrymen/core";

/** For an assistant or a checklist: what it is, how it is bought, and that no signature is involved. */
export const ENERGY_RESERVE_WHY =
  "It is $MERRYMEN, this agent's energy — not a token it trades. The agent buys it only when the owner asks it " +
  "to get its $MERRYMEN in the Merrymen app chat and confirms the amount there, and its key never sells or sends " +
  "it, so no signature needs to cover it.";

/**
 * The owner's custom tokens as a SIGNER reads them: the energy reserve left out.
 *
 * WHY AT THE READ, NOT ONLY IN THE SIGNER. Current signers drop the reserve
 * themselves (core wall.ts usableExtraTokens), but a signer is code the server
 * does not ship on its own schedule: an iOS build whose bundled engine predates
 * energy, or a tab loaded before the deploy, seals whatever this list says —
 * $MERRYMEN included, with an uncapped approve — and the server's canonical
 * rebuild (which drops it) then refuses the grant, so that owner could not
 * re-sign or renew. Every signer (the web tabs, iOS GrantScreen, Android, the
 * RN app) reads GET /api/settings, so leaving the reserve out HERE makes an old
 * signer seal the same wall the new rebuild expects. canonical-wall.ts refuses,
 * by name, whatever still gets through.
 *
 * READ-SIDE ONLY: the stored settings are not rewritten. The worker never
 * watches the reserve whatever the list says (watchTokensFor), so a stored
 * entry is inert, and the next save from a form built on this view simply
 * does not carry it. Anything that is not a reserve entry — including an entry
 * too malformed to have an address — passes through untouched.
 */
export function withoutEnergyReserve<T>(list: T[] | undefined): T[] | undefined {
  if (!Array.isArray(list)) return list;
  return list.filter((t) => {
    const address = (t as { address?: unknown } | null)?.address;
    return !(typeof address === "string" && isEnergyReserveToken(address));
  });
}

/**
 * THE BASKET AS A CLIENT READS AND SAVES IT: a symbol only a reserve entry
 * ever supplied goes with that entry.
 *
 * withoutEnergyReserve leaves the reserve out of the custom tokens a client is
 * served, but an owner who listed $MERRYMEN before energy also has MERRYMEN
 * in `basketSymbols` — Settings' add-token and the Proposals approve both put
 * the symbol in the basket too. Serving the basket unchanged made every client
 * that saves both fields (web Settings, Proposals, iOS, Android) send a basket
 * naming a coin its own token list no longer carried, and the PUT refused it
 * ("basketSymbols: unknown symbols MERRYMEN"). After a tokens-only save had
 * dropped the stored entry, EVERY later basket save was refused, about a coin
 * the owner could no longer see or deselect.
 *
 * So a basket symbol is dropped when nothing selectable supplies it (not in
 * `selectable`: the registry's stocks plus the custom tokens that stay) AND
 * it is the reserve's — the symbol of a reserve entry in `tokens`, or the
 * reserve's own name once no entry supplies it at all. Anything else passes
 * untouched, including a lookalike at another address that merely calls itself
 * MERRYMEN (it is in `selectable`), and a symbol validation should still refuse.
 */
export function withoutReserveBasket<T>(
  basket: T[] | undefined,
  tokens: unknown,
  selectable: ReadonlySet<string>,
): T[] | undefined {
  if (!Array.isArray(basket)) return basket;
  const reserveSymbols = new Set<string>();
  for (const t of Array.isArray(tokens) ? tokens : []) {
    const { symbol, address } = (t ?? {}) as { symbol?: unknown; address?: unknown };
    if (typeof symbol === "string" && typeof address === "string" && isEnergyReserveToken(address)) reserveSymbols.add(symbol);
  }
  const reserveName = MERRYMEN_TOKEN.symbol.toUpperCase();
  return basket.filter((s) => {
    if (typeof s !== "string" || selectable.has(s)) return true;
    return !(reserveSymbols.has(s) || s.trim().replace(/^\$/, "").toUpperCase() === reserveName);
  });
}

/**
 * What a snipe resolved to the energy reserve answers instead of placing an
 * order or asking for a signature. Not an error: the owner named a real coin,
 * and the answer tells them the one way it is bought.
 */
export function snipeEnergyAnswer(target: { symbol: string; address: string }): {
  outcome: "energy";
  target: { symbol: string; address: string; short: string };
  say: string;
} | null {
  if (!isEnergyReserveToken(target.address)) return null;
  const short = shortAddress(target.address);
  return {
    outcome: "energy",
    target: { symbol: target.symbol, address: target.address, short },
    say:
      `That's $MERRYMEN at ${short} — my energy, not a coin I trade, so I won't snipe it. ` +
      `Ask me to get my $MERRYMEN instead: I size it to cover what I'm short of, with a small margin, and you confirm the amount first.`,
  };
}
