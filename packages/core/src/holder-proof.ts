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

/** Which account holds the claim on a wallet (lower-cased), or nothing when nobody does. */
export type HolderClaimOf = (wallet: string) => string | null | undefined;

/** The wallet whose $MERRYMEN counts for an account, and how it earned that. */
export interface EffectiveHolder {
  address: `0x${string}`;
  source: "linked" | "login";
}

const WALLET = /^0x[0-9a-f]{40}$/;

/**
 * ONE $MERRYMEN WALLET POWERS ONE AGENT.
 *
 * THE HOLE. A proof binds a wallet to an account, and nothing bound it the
 * other way: one 100,000-token wallet could be linked by any number of
 * accounts, each with its own agent, and every one of them read the same bag
 * as its own. And the login wallet was a second road to the same place — a
 * wallet can be account W's login AND account B's linked wallet, counted by
 * both. With energy riding on the balance, one bag would power a fleet.
 *
 * THE RULE, in the order it is applied:
 *
 *   THE LINKED PROOF COUNTS ONLY IF THE CLAIM NAMES THIS ACCOUNT. The claim is
 *   the cross-account record (`holder_claims`), made by /api/holder before the
 *   proof is stored, and only on a fresh signature BY the wallet over text
 *   naming this account. The first claim is not final: a wallet nobody holds
 *   is claimed by that signature, and one another account holds MOVES to the
 *   signer's account (settings-store takeHolder) — at most one move per wallet
 *   in any rolling 24 hours, counted from the last move and not reset by an
 *   unlink, except that the wallet's own sign-in account (and the account it
 *   was last moved from) may always take it back, so a phished signature
 *   cannot lock the real holder out. (Proofs linked before claims existed
 *   were claimed once, earliest proof first, by the orchestrator's backfill —
 *   worker/src/holder-claims.ts.) A proof whose claim belongs to someone
 *   else — or to nobody yet — is a signature, not a holding.
 *
 *   OTHERWISE THE LOGIN WALLET, ONLY IF NO OTHER ACCOUNT CLAIMS IT. Linking
 *   your login wallet to a second account moves it there; it cannot count in
 *   both places.
 *
 *   OTHERWISE NOTHING. No wallet counts for this account — its agent's own
 *   account is still read beside this (energy D1), so "nothing" here is not
 *   "holds nothing". Never `settings.holderAddress`: typed in, so a claim
 *   about anybody's balance.
 *
 * The web (/api/tier, /api/circle, /api/alpha via holderWalletFor) and the
 * orchestrator (the child's settings.json) both call this, with the same
 * claims, so a person cannot be told one thing on screen while their agent is
 * throttled on another.
 *
 * PURE. `claimOf` is the claims table as a lookup; the caller reads it.
 */
export function effectiveHolder(
  tenant: string,
  proof: unknown,
  claimOf: HolderClaimOf,
): EffectiveHolder | null {
  const me = tenant.toLowerCase();
  // An account is a verified address or it is nothing this rule can speak for.
  if (!WALLET.test(me)) return null;
  const holderOf = (wallet: string): string | null => {
    const held = claimOf(wallet.toLowerCase());
    return typeof held === "string" && held ? held.toLowerCase() : null;
  };
  if (isHolderProof(proof) && holderOf(proof.address) === me) {
    return { address: proof.address as `0x${string}`, source: "linked" };
  }
  const loginHolder = holderOf(me);
  if (loginHolder === null || loginHolder === me) return { address: me as `0x${string}`, source: "login" };
  return null;
}
