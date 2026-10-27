/**
 * THE MOST ONE CHAT ORDER MAY SPEND — the figure POST /api/orders enforces.
 *
 * Read by the chat so its amount chips clamp to the ceiling the route will
 * actually apply, rather than to the default the settings screen shows. Same
 * resolution as POST (lib/order-ceiling.ts): hosted, the tenant's own value,
 * else the house's; self-hosted, the house's file and env. A number, never a
 * guess: when this cannot be read the chat offers no amount at all.
 *
 * SPOT ONLY, ON PURPOSE (route-guard.ts walletNotSupported). The Perps wallet
 * takes only the owner's exits from the app, and an exit has no amount to
 * offer chips for: it closes what is held (worker perps/owner-order.ts). POST
 * still applies the Perps wallet's own ceiling to every Perps order, where a
 * zero-sized exit never meets it.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { ceilingFor } from "@/lib/order-ceiling";
import { walletNotSupported } from "@/lib/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  if (isHostedMode() && !tenantOf(req)) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  return NextResponse.json({ ceilingUsdg: await ceilingFor(req, isHostedMode(), "spot") });
}
