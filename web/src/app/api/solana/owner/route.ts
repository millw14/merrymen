import { getSolanaAppRuntime } from "../../../../../../worker/src/solana-app-runtime";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { SolanaWebError } from "@/lib/solana-auth";
import { solanaOwnerPacedMessage, takeSolanaOwnerToken, type SolanaOwnerBucket } from "./throttle";
import { walletNotSupported } from "@/lib/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  return solanaResponse(async () => {
    const { scope } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["stage", "action", "mint", "amountRaw", "signedTransactionBase64", "signatures"]);
    const app = getSolanaAppRuntime();
    // The request is validated first, then paced, then run: a malformed one costs
    // nothing, and a paced one reaches no runtime (owner/throttle.ts).
    let bucket: SolanaOwnerBucket, run: () => Promise<unknown>;
    // Owner recovery is available even after live consent is disabled or its
    // session expires. The owner must still sign the exact prepared transaction.
    if (body.stage === "prepare" && (body.action === "revoke" || body.action === "resume-buys") && body.mint === undefined && body.amountRaw === undefined) {
      const action = body.action;
      bucket = action === "revoke" ? "revoke" : "prepare"; run = async () => ({ prepared: await app.prepareOwnerAction(scope, { action }) });
    } else if (body.stage === "prepare" && body.action === "withdraw" && typeof body.mint === "string" && typeof body.amountRaw === "string") {
      const mint = body.mint, amountRaw = body.amountRaw;
      bucket = "prepare"; run = async () => ({ prepared: await app.prepareOwnerAction(scope, { action: "withdraw", mint, amountRaw }) });
    } else if (body.stage === "prepare" && body.action === "withdraw-sol" && body.mint === undefined && typeof body.amountRaw === "string") {
      // Native SOL held by the vault account itself (above its rent reserve), in lamports.
      const amountRaw = body.amountRaw;
      bucket = "prepare"; run = async () => ({ prepared: await app.prepareOwnerAction(scope, { action: "withdraw-sol", amountRaw }) });
    } else if (body.stage === "submit" && typeof body.signedTransactionBase64 === "string") {
      const signedTransactionBase64 = body.signedTransactionBase64;
      bucket = "submit"; run = async () => ({ result: await app.submitOwnerAction(scope, { signedTransactionBase64 }) });
    } else if (body.stage === "record" && body.action === "external-withdrawals" && Array.isArray(body.signatures) && body.mint === undefined && body.amountRaw === undefined) {
      // Withdrawals the owner made outside Merrymen, by their signatures: read on both providers, nothing signed or sent.
      const signatures: unknown[] = body.signatures;
      bucket = "prepare"; run = async () => ({ recorded: await app.recordExternalWithdrawals(scope, { signatures }) });
    } else throw new SolanaWebError(400, "Invalid Solana owner action.");
    const wait = takeSolanaOwnerToken(scope.tenant, bucket);
    if (wait !== null) throw new SolanaWebError(429, solanaOwnerPacedMessage(bucket, wait));
    return run();
  });
}
