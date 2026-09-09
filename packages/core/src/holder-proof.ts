/**
 * PROVING YOU HOLD $MERRYMEN IN A WALLET THAT IS NOT YOUR LOGIN.
 *
 * THE PROBLEM, raised by a tester: "it can happen that you don't own tokens in
 * your privy based wallet and you have them somewhere else… the app should have
 * the possibility to define the holder address if it's not the 'default' privy
 * wallet address."
 *
 * He is right, and the shape of the answer is forced by why the field could not
 * simply be typed in. `holderAddress` was tenant-settable and shape-validated
 * and nothing more, so anyone could name a whale's wallet and claim their tier;
 * /api/alpha refuses to use it for exactly that reason, in as many words:
 * "fine for a fee discount an owner claims for themselves, never an
 * authorisation input." The orchestrator then began overwriting it with the
 * session-verified wallet, which made the tier earnable and authoritative — and
 * closed the door on his case.
 *
 * A CLAIM BECOMES AN AUTHORISATION WHEN IT IS PROVEN. So the wallet signs. The
 * signature recovers to an address nobody can choose but its holder, which is
 * the same instrument the login itself rests on.
 *
 * ── WHAT THE TEXT HAS TO BIND, AND WHY EACH ONE ──────────────────────────
 *
 *   THE HOLDER, so the reader of the prompt knows which wallet they are
 *   linking. Recovered from the signature rather than trusted from the body.
 *
 *   THE MERRYMEN ACCOUNT. Without it a signature is "I control this wallet"
 *   and nothing more — captured anywhere, it would link that wallet to ANY
 *   account that replayed it. Naming the tenant makes the signature useless
 *   to everyone else, which is the same job the DID does in
 *   `bindingMessage`'s privy arm.
 *
 *   THE ORIGIN AND A NONCE, so a signature gathered on another site or an hour
 *   ago is not a signature here and now. Both are enforced by
 *   `consumeChallengeNonce`; putting them in the text is what makes the
 *   enforcement meaningful rather than a server-side opinion.
 *
 * ── AND WHAT IT DELIBERATELY DOES NOT SAY ────────────────────────────────
 *
 * It grants nothing. This wallet is never a spend key, never an owner, never a
 * signer for the agent: it is read with `balanceOf` and nothing else, exactly
 * as circle.ts already reads one. The text says so, because a person asked to
 * sign something by a trading app is entitled to know it cannot move money.
 *
 * PURE. Returns a string.
 */

export interface HolderProofClaim {
  /** The wallet being linked — the one that signs. */
  holder: string;
  /** The merrymen account it is being linked to: the session-verified tenant. */
  tenant: string;
  /** Where the request came from, bound into the text. */
  origin: string;
  /** A one-time, expiring, origin-bound nonce. */
  nonce: string;
}

/**
 * The exact bytes a holder wallet signs.
 *
 * ADDRESSES LOWER-CASED, deliberately. A wallet may present a checksummed
 * address and a user may paste either form; the signature is over these bytes,
 * so the case has to be decided here rather than by whoever typed it. Recovery
 * is compared the same way.
 */
export function holderProofMessage(args: HolderProofClaim): string {
  return [
    `${args.origin} wants you to link a wallet to your merrymen account.`,
    "",
    "This proves you control the wallet below, so your $MERRYMEN balance can count",
    "toward your tier. It moves no funds, grants no trading permission, and the",
    "wallet is only ever read.",
    "",
    `Holder wallet: ${args.holder.toLowerCase()}`,
    `merrymen account: ${args.tenant.toLowerCase()}`,
    `URI: ${args.origin}`,
    `Nonce: ${args.nonce}`,
  ].join("\n");
}

/** A stored proof. Written only by the route that verified a signature. */
export interface HolderProof {
  /** The wallet whose balance counts, lower-cased. */
  address: string;
  /** When the signature was verified, epoch ms. */
  at: number;
}

/** Shape-check a stored proof before trusting it — a settings blob is data, not a type. */
export function isHolderProof(v: unknown): v is HolderProof {
  if (!v || typeof v !== "object") return false;
  const p = v as Partial<HolderProof>;
  return (
    typeof p.address === "string" &&
    /^0x[0-9a-f]{40}$/.test(p.address) &&
    typeof p.at === "number" &&
    Number.isFinite(p.at)
  );
}
