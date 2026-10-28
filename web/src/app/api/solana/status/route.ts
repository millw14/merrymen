import { getSolanaAppRuntime } from "../../../../../../worker/src/solana-app-runtime";
import { authenticateSolana, SolanaWebError } from "@/lib/solana-auth";
import { getSolanaBindingStore, SOLANA_OTHER_SIGN_IN } from "@/lib/solana-binding-store";
import { solanaResponse } from "@/lib/solana-api";
import { takeSolanaStatusToken } from "./throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  return solanaResponse(async () => {
    const principal = await authenticateSolana(req);
    const wait = takeSolanaStatusToken(principal.tenant);
    if (wait !== null) throw new SolanaWebError(429, `Your Solana account was refreshed too often. Try again in ${wait} second${wait === 1 ? "" : "s"}.`);
    const binding = await getSolanaBindingStore().get(principal.tenant);
    if (!binding) return { binding: null, runtime: null };
    if (binding.did !== principal.did) throw new SolanaWebError(403, SOLANA_OTHER_SIGN_IN);
    return { binding, runtime: await getSolanaAppRuntime().status({ tenant: principal.tenant, owner: binding.owner }) };
  });
}
