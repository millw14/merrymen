import { getSolanaAppRuntime } from "../../../../../../worker/src/solana-app-runtime";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { SolanaWebError } from "@/lib/solana-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return solanaResponse(async () => {
    const { binding, scope } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["initialCashRaw"]);
    if (binding.requestedMode !== "paper" || !binding.limits || typeof body.initialCashRaw !== "string") throw new SolanaWebError(400, "Save paper mode and trading limits before creating the book.");
    return { paper: await getSolanaAppRuntime().setupPaper(scope, { initialCashRaw: body.initialCashRaw, limits: binding.limits }) };
  });
}
