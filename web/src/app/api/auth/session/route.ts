/**
 * GET /api/auth/session — who am I? Returns the authenticated tenant address,
 * or { address: null } when not logged in. Read-only, safe to poll.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(req: Request) {
  if (!isHostedMode()) return NextResponse.json({ hosted: false, address: null }, { headers });
  return NextResponse.json({ hosted: true, address: tenantOf(req) }, { headers });
}
