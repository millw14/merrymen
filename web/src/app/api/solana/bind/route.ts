import { solanaPaperAgentId } from "../../../../../../packages/core/src/solana";
import { authenticateSolana, consumeSolanaBindingProof, issueSolanaBindingChallenge, SolanaWebError } from "@/lib/solana-auth";
import { getSolanaBindingStore, SOLANA_OTHER_SIGN_IN } from "@/lib/solana-binding-store";
import { solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { consumeSolanaRebindProof, issueSolanaRebindChallenge } from "./rebind-proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  return solanaResponse(async () => {
    const principal = await authenticateSolana(req);
    const owner = new URL(req.url).searchParams.get("owner") ?? "";
    solanaPaperAgentId(owner);
    // The tenant's binding has this owner under another identity: what the key signs is a re-bind, and says so (rebind-proof.ts).
    const existing = await getSolanaBindingStore().get(principal.tenant);
    if (existing && existing.owner === owner && existing.did !== principal.did) return issueSolanaRebindChallenge(req, principal, owner, existing.did);
    return issueSolanaBindingChallenge(req, principal, owner);
  });
}
export async function POST(req: Request) {
  return solanaResponse(async () => {
    const principal = await authenticateSolana(req);
    const body = await solanaRequestBody(req, ["owner", "nonce", "signature"]);
    if (typeof body.owner !== "string" || typeof body.nonce !== "string" || body.nonce.length > 1024
      || typeof body.signature !== "string" || body.signature.length > 128) throw new SolanaWebError(400, "Invalid wallet proof.");
    solanaPaperAgentId(body.owner);
    const proof = { owner: body.owner, nonce: body.nonce, signature: body.signature };
    const store = getSolanaBindingStore(), existing = await store.get(principal.tenant);
    // The tenant's verified identity changed since this owner key was bound, and the same owner key just signed a
    // fresh RE-BIND challenge naming both identities (never the ordinary binding message, which says it grants no
    // authority): re-bind (SOLANA OWNER KEY RECOVERY in solana-binding-store.ts). Another owner key stays a conflict.
    if (existing && existing.owner === body.owner && existing.did !== principal.did) {
      await consumeSolanaRebindProof(req, principal, existing.did, proof);
      return { binding: await store.rebind(principal.tenant, principal.did, body.owner, existing.did) };
    }
    await consumeSolanaBindingProof(req, principal, proof);
    // Another wallet, verified by another sign-in: only the original login (or the bound key) recovers it.
    if (existing && existing.did !== principal.did) throw new SolanaWebError(409, SOLANA_OTHER_SIGN_IN);
    return { binding: await store.bind(principal.tenant, principal.did, body.owner) };
  });
}
