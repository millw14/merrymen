import { readWalletParam } from "@/lib/wallet-param";
import { walletUnknown } from "@/lib/route-guard";
import { perpsReadGate, readPerpsAccountResponse } from "../read-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("Nothing was read.");
  const refusal = perpsReadGate(req, wallet);
  if (refusal) return refusal;
  return readPerpsAccountResponse(req);
}
