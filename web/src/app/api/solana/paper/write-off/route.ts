import { CHAINS, canonicalId } from "../../../../../../../packages/core/src/ids";
import { getSolanaAppRuntime } from "../../../../../../../worker/src/solana-app-runtime";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { SolanaWebError } from "@/lib/solana-auth";
import { takeSolanaIntentToken } from "../../intent/throttle";
import { walletNotSupported } from "@/lib/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * POST /api/solana/paper/write-off { mint }: the signed-in owner writes off one
 * dust lot of their hosted paper book (the whole lot, only on the market's
 * zero-output answer). Tenant and owner come from the verified binding, never
 * the body. 200 { paper, writtenOff }; 409 for book refusals (not dust, no
 * position, an unusable or stale answer); 400 for a malformed mint. It asks the
 * quote API once, so it shares the preview pacing bucket and is answered 429
 * before anything runs when paced.
 */
export async function POST(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  return solanaResponse(async () => {
    const { principal, scope } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["mint"]);
    if (typeof body.mint !== "string" || canonicalId(CHAINS.solana, "token", body.mint) !== body.mint) throw new SolanaWebError(400, "Invalid Solana token mint.");
    const wait = takeSolanaIntentToken(principal.tenant, "preview");
    if (wait !== null) throw new SolanaWebError(429, `Too many Solana paper requests. Nothing was changed. Try again in ${wait} second${wait === 1 ? "" : "s"}.`);
    return getSolanaAppRuntime().writeOffPaper(scope, { mint: body.mint });
  });
}
