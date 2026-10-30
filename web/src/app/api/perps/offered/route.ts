import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { perpsCreationAllowed } from "@/lib/perps-enabled";
import { NO_STORE_HEADERS, walletUnknown } from "@/lib/route-guard";
import { readWalletParam } from "@/lib/wallet-param";
import { perpsPaperAdmissionRefusal } from "@/lib/perps-paper-admission";

export const dynamic = "force-dynamic";

/** Renewal checks this before stopping an existing permission or asking for a signature. */
export async function GET(req: Request) {
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("Nothing was read.");
  if (wallet !== "perps") {
    return NextResponse.json({ error: "Name the Perps wallet explicitly." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!perpsCreationAllowed()) return NextResponse.json({ error: "Paper Perps is not offered here." }, { status: 404, headers: NO_STORE_HEADERS });
  return perpsPaperAdmissionRefusal(req, isHostedMode()) ?? NextResponse.json({ offered: true, mode: "paper" }, { headers: NO_STORE_HEADERS });
}
