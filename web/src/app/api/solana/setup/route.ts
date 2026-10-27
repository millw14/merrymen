import { getSolanaAppRuntime } from "../../../../../../worker/src/solana-app-runtime";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { SolanaWebError } from "@/lib/solana-auth";
import { solanaOwnerPacedMessage, takeSolanaOwnerToken, type SolanaOwnerBucket } from "../owner/throttle";
import { walletNotSupported } from "@/lib/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  return solanaResponse(async () => {
    const { binding, scope } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["stage", "sessionPublicKey", "signedTransactionBase64", "signature", "sessionSecretKey"]);
    if (binding.requestedMode !== "live" || !binding.limits) throw new SolanaWebError(409, "Review and save live mode and its limits before registering a trading permission.");
    const app = getSolanaAppRuntime(), limits = binding.limits;
    // Validated, then paced with the owner route's buckets (one owner, one saved owner transaction), then run.
    let bucket: SolanaOwnerBucket, run: () => Promise<unknown>;
    if (body.stage === "prepare" && typeof body.sessionPublicKey === "string") {
      const sessionPublicKey = body.sessionPublicKey;
      bucket = "prepare"; run = async () => ({ setup: await app.prepareLive(scope, { limits, sessionPublicKey }) });
    } else if (body.stage === "submit" && typeof body.signedTransactionBase64 === "string") {
      const signedTransactionBase64 = body.signedTransactionBase64;
      bucket = "submit"; run = async () => ({ registration: await app.submitSetup(scope, { signedTransactionBase64 }) });
    } else if (body.stage === "activate" && typeof body.signature === "string" && typeof body.sessionSecretKey === "string") {
      const signature = body.signature, sessionSecretKey = body.sessionSecretKey;
      bucket = "submit"; run = async () => ({ live: await app.activateLive(scope, { signature, sessionSecretKey }) });
    } else throw new SolanaWebError(400, "Invalid Solana permission registration request.");
    const wait = takeSolanaOwnerToken(scope.tenant, bucket);
    if (wait !== null) throw new SolanaWebError(429, solanaOwnerPacedMessage(bucket, wait));
    return run();
  });
}
