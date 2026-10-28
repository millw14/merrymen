/**
 * The re-bind challenge (SOLANA OWNER KEY RECOVERY in web/src/lib/solana-binding-store.ts).
 *
 * A re-bind hands the tenant's existing Solana binding (its live mode and limits,
 * the trading permission registered on Solana, the autonomous strategy and the
 * owner actions) from the sign-in that verified it to the signed-in one. The
 * ordinary binding message says it "grants no trading or withdrawal authority",
 * which is true of a first bind and not of this, so the owner key signs text that
 * says what a re-bind does and names both identities. The bind route issues this
 * challenge whenever the tenant's binding has the requested owner under another
 * identity, and accepts only this one for a re-bind: a signed ordinary binding
 * message never moves a binding. Its nonce is the same single-use, origin-bound
 * challenge nonce the binding message uses.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { base58Decode, base58Encode, CHAINS } from "../../../../../../packages/core/src/ids";
import { solanaPaperAgentId } from "../../../../../../packages/core/src/solana";
import { consumeChallengeNonce, issueChallengeNonce, requestOrigin } from "../../../../lib/auth";
import { SolanaWebError, type SolanaPrincipal } from "@/lib/solana-auth";

const DID = /^did:privy:[A-Za-z0-9_-]{1,160}$/;
/** The text the bound owner key signs to move its binding from `previousDid` to the signed-in identity. */
export function solanaRebindMessage(principal: SolanaPrincipal, owner: string, previousDid: string, origin: string, nonce: string): string {
  solanaPaperAgentId(owner);
  if (!/^0x[0-9a-f]{40}$/.test(principal.tenant) || !DID.test(principal.did) || !DID.test(previousDid) || previousDid === principal.did) {
    throw new SolanaWebError(400, "Invalid account identity.");
  }
  return [
    "Merrymen Solana wallet re-bind v1", "",
    "Move this Solana account's controls to my current Merrymen sign-in. The previous sign-in below verified this wallet; after this it no longer controls the account, and my current sign-in does: its live mode and trading limits, the trading permission registered on Solana, the autonomous strategy (turned off until I turn it on again), and owner actions such as revoking and withdrawing.", "",
    `Tenant: ${principal.tenant}`, `Previous identity: ${previousDid}`, `Identity: ${principal.did}`, `Chain: ${CHAINS.solana}`,
    `Owner: ${owner}`, `URI: ${origin}`, `Nonce: ${nonce}`,
  ].join("\n");
}
export function verifySolanaRebindSignature(principal: SolanaPrincipal, owner: string, previousDid: string, origin: string, nonce: string, signature: string): boolean {
  try {
    const publicKey = base58Decode(owner), bytes = base58Decode(signature);
    if (!publicKey || publicKey.length !== 32 || !bytes || bytes.length !== 64 || base58Encode(bytes) !== signature) return false;
    return ed25519.verify(bytes, new TextEncoder().encode(solanaRebindMessage(principal, owner, previousDid, origin, nonce)), publicKey, { zip215: false });
  } catch { return false; }
}
/** A fresh re-bind challenge for the binding `previousDid` verified. `rebind: true` tells the page what it is signing. */
export function issueSolanaRebindChallenge(req: Request, principal: SolanaPrincipal, owner: string, previousDid: string) {
  const origin = requestOrigin(req);
  const nonce = issueChallengeNonce(origin);
  return { nonce, message: solanaRebindMessage(principal, owner, previousDid, origin, nonce), rebind: true as const };
}
/** Verifies the re-bind proof against the binding's identity as it is now, then spends its nonce. */
export async function consumeSolanaRebindProof(req: Request, principal: SolanaPrincipal, previousDid: string, input: { owner: string; nonce: string; signature: string }) {
  const origin = requestOrigin(req);
  if (!verifySolanaRebindSignature(principal, input.owner, previousDid, origin, input.nonce, input.signature)) {
    throw new SolanaWebError(401, "The Solana wallet signature did not verify. A wallet already verified by another sign-in moves only with a signed re-bind message; request a new challenge and sign it.");
  }
  const consumed = await consumeChallengeNonce(input.nonce, origin);
  if (!consumed.ok) throw new SolanaWebError(401, "This wallet challenge expired or was already used. Try again.");
}
