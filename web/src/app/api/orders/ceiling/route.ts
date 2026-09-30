/**
 * THE MOST ONE CHAT ORDER MAY SPEND — the figure POST /api/orders enforces.
 *
 * Read by the chat so its amount chips clamp to the ceiling the route will
 * actually apply, rather than to the default the settings screen shows. Same
 * resolution as POST (lib/order-ceiling.ts): hosted, the tenant's own value,
 * else the house's; self-hosted, the house's file and env. A number, never a
 * guess: when this cannot be read the chat offers no amount at all.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { ceilingFor } from "@/lib/order-ceiling";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (isHostedMode() && !tenantOf(req)) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  return NextResponse.json({ ceilingUsdg: await ceilingFor(req, isHostedMode()) });
}
