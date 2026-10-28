import { getSolanaAppRuntime } from "../../../../../../worker/src/solana-app-runtime";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { SolanaWebError } from "@/lib/solana-auth";
import { takeSolanaIntentToken } from "./throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return solanaResponse(async () => {
    const { principal, binding, scope } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["mode", "intent", "action"]);
    if ((body.mode !== "paper" && body.mode !== "live") || body.mode !== binding.requestedMode
      || (body.action !== "preview" && body.action !== "trade")) throw new SolanaWebError(409, "Refresh and confirm the current Solana trading mode before placing this request.");
    const action = body.action;
    const wait = takeSolanaIntentToken(principal.tenant, action);
    if (wait !== null) {
      const seconds = `${wait} second${wait === 1 ? "" : "s"}`;
      // Pacing comes before the runtime's recorded-request check, and the page
      // retries a trade with the same request id to learn its outcome. So a
      // paced trade speaks only for this request: an earlier attempt with that
      // id may already have been signed and sent.
      throw new SolanaWebError(429, action === "preview" ? `Too many Solana previews. Try again in ${seconds}.`
        : `Too many Solana trade requests. This request was not processed; a trade you already placed is unaffected. Refresh to check it, then try again in ${seconds}.`);
    }
    const app = getSolanaAppRuntime();
    const input: { mode: "paper" | "live"; intent: unknown } = { mode: body.mode, intent: body.intent };
    return action === "preview" ? { preview: await app.preview(scope, input) } : { receipt: await app.trade(scope, input) };
  });
}
