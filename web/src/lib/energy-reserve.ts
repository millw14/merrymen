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
import { isEnergyReserveToken, shortAddress } from "@merrymen/core";

/** For an assistant or a checklist: what it is, how it is bought, and that no signature is involved. */
export const ENERGY_RESERVE_WHY =
  "It is $MERRYMEN, this agent's energy — not a token it trades. The agent buys it only when the owner asks it " +
  "to get its $MERRYMEN in the Merrymen app chat and confirms the amount there, and its key never sells or sends " +
  "it, so no signature needs to cover it.";

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
