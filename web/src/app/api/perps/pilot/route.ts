import { readWalletParam } from "@/lib/wallet-param";
import { walletUnknown } from "@/lib/route-guard";
import { pilotActor, pilotReply, pilotStatus, pilotUnavailable, pilotWalletRefusal } from "@/lib/perps-pilot-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("Nothing was read.");
  if (wallet !== "perps") return pilotWalletRefusal();
  const tenant = pilotActor(req);
  if (typeof tenant !== "string") return tenant;
  try { return pilotReply(await pilotStatus(tenant)); }
  catch { return pilotUnavailable(); }
}
