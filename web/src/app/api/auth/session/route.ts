/**
 * GET /api/auth/session — who am I? Returns the authenticated tenant address,
 * or { address: null } when not logged in. Read-only, safe to poll.
 *
 * `fomo` says whether this deployment runs Fomo research (always self-hosted;
 * hosted only with MERRYMEN_FOMO_ENABLED=1), so the Settings page shows its
 * switches only where they do something.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { hostedFomoEnabled } from "@/lib/fomo-switch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isHostedMode()) return NextResponse.json({ hosted: false, address: null, fomo: true });
  return NextResponse.json({ hosted: true, address: tenantOf(req), fomo: hostedFomoEnabled() });
}
