import { ed25519 } from "@noble/curves/ed25519";
import { base58Decode, base58Encode, CHAINS } from "../../../packages/core/src/ids";
import { solanaPaperAgentId } from "../../../packages/core/src/solana";
import { getIdentityStore } from "../../../worker/src/identity-store";
import { tenantOf, requestOrigin, issueChallengeNonce, consumeChallengeNonce } from "./auth";
import { verifyPrivyToken, privyTokenOf } from "./privy";

export class SolanaWebError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "SolanaWebError"; }
}
export interface SolanaPrincipal { tenant: `0x${string}`; did: string }
export interface SolanaAuthDependencies {
  tenant(req: Request): `0x${string}` | null;
  verifyToken(token: string | null): Promise<{ ok: true; identity: { did: string } } | { ok: false }>;
  tenantForDid(did: string): Promise<`0x${string}` | null>;
}
const defaults: SolanaAuthDependencies = {
  tenant: tenantOf,
  verifyToken: verifyPrivyToken,
  tenantForDid: async (did) => (await getIdentityStore().byDid(did))?.tenant ?? null,
};
/** Both the existing cookie and a current Privy identity must name this tenant. */
export async function authenticateSolana(req: Request, dependencies = defaults): Promise<SolanaPrincipal> {
  const tenant = dependencies.tenant(req);
  if (!tenant) throw new SolanaWebError(401, "Sign in before opening your Solana account.");
  const result = await dependencies.verifyToken(privyTokenOf(req));
  if (!result.ok) throw new SolanaWebError(401, "Your sign-in expired. Sign in again.");
  // This client expectation only narrows a verified identity. It can never
  // substitute for the token or select another tenant during account changes.
  const expectedDid = req.headers.get("x-merrymen-privy-did");
  if (expectedDid && expectedDid !== result.identity.did) throw new SolanaWebError(403, "Your signing account changed. Refresh before continuing.");
  const mapped = await dependencies.tenantForDid(result.identity.did);
  if (mapped !== tenant) throw new SolanaWebError(403, "Your sign-in does not match this account.");
  const origin = req.headers.get("origin");
  if (origin && origin !== requestOrigin(req) && !sameLoopbackOrigin(req, origin)) throw new SolanaWebError(403, "Cross-origin Solana requests are not allowed.");
  return { tenant, did: result.identity.did };
}
const LOOPBACK = /^(localhost|127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}|\[::1\])$/;
/**
 * A page opened at http://127.0.0.1:3000 is same-origin, but Next rewrites
 * loopback hosts in req.url to "localhost", so requestOrigin() disagrees with
 * the browser's Origin and every Solana POST was refused. Middleware handles
 * this by reading the Host header; here that is allowed ONLY for loopback, so
 * a real host never trusts Host. Applies only without MERRYMEN_PUBLIC_ORIGIN
 * (a configured origin is exact), only when req.url itself is loopback, and
 * only when Origin and Host name the same loopback host and port: another
 * local port, or a DNS-rebinding name, is still cross-origin.
 */
function sameLoopbackOrigin(req: Request, origin: string): boolean {
  if (process.env.MERRYMEN_PUBLIC_ORIGIN) return false;
  try {
    const url = new URL(req.url), host = req.headers.get("host"), claimed = new URL(origin);
    if (!host || !LOOPBACK.test(url.hostname) || claimed.origin !== origin || claimed.protocol !== url.protocol) return false;
    const expected = new URL(`${url.protocol}//${host}`);
    return LOOPBACK.test(expected.hostname) && expected.host === host.toLowerCase() && expected.origin === origin;
  } catch { return false; }
}
export function solanaBindingMessage(principal: SolanaPrincipal, owner: string, origin: string, nonce: string): string {
  solanaPaperAgentId(owner);
  if (!/^0x[0-9a-f]{40}$/.test(principal.tenant) || !/^did:privy:[A-Za-z0-9_-]{1,160}$/.test(principal.did)) throw new SolanaWebError(400, "Invalid account identity.");
  return [
    "Merrymen Solana wallet binding v1", "",
    "Bind this Solana wallet to my Merrymen account. This grants no trading or withdrawal authority.", "",
    `Tenant: ${principal.tenant}`, `Identity: ${principal.did}`, `Chain: ${CHAINS.solana}`,
    `Owner: ${owner}`, `URI: ${origin}`, `Nonce: ${nonce}`,
  ].join("\n");
}
export function verifySolanaBindingSignature(principal: SolanaPrincipal, owner: string, origin: string, nonce: string, signature: string): boolean {
  try {
    const publicKey = base58Decode(owner), bytes = base58Decode(signature);
    if (!publicKey || publicKey.length !== 32 || !bytes || bytes.length !== 64 || base58Encode(bytes) !== signature) return false;
    return ed25519.verify(bytes, new TextEncoder().encode(solanaBindingMessage(principal, owner, origin, nonce)), publicKey, { zip215: false });
  } catch { return false; }
}
export function issueSolanaBindingChallenge(req: Request, principal: SolanaPrincipal, owner: string) {
  const origin = requestOrigin(req);
  const nonce = issueChallengeNonce(origin);
  return { nonce, message: solanaBindingMessage(principal, owner, origin, nonce) };
}
export async function consumeSolanaBindingProof(req: Request, principal: SolanaPrincipal, input: { owner: string; nonce: string; signature: string }) {
  const origin = requestOrigin(req);
  if (!verifySolanaBindingSignature(principal, input.owner, origin, input.nonce, input.signature)) throw new SolanaWebError(401, "The Solana wallet signature did not verify.");
  const consumed = await consumeChallengeNonce(input.nonce, origin);
  if (!consumed.ok) throw new SolanaWebError(401, "This wallet challenge expired or was already used. Try again.");
}
