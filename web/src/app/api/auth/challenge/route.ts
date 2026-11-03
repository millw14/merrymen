/**
 * GET /api/auth/challenge — issue a one-time nonce for wallet login.
 *
 * The browser signs the message built from this nonce with the owner key, then
 * POSTs the signature to /api/auth/verify. The nonce is signed and origin-bound
 * so it cannot be forged or reused at another site.
 *
 * Hosted mode only. Self-hosted has no login (the localhost guard is its
 * perimeter), so this returns 404 there rather than inventing an auth flow
 * nobody asked for.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { challengeMessage, issueChallengeNonce, requestOrigin } from "@/lib/auth";
import { walletNotSupported } from "@/lib/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  if (!isHostedMode()) return new NextResponse("not found", { status: 404 });
  try {
    // Shared with the grant route, which verifies nonces this one issues — two
    // copies of this could disagree and every binding would fail opaquely.
    const origin = requestOrigin(req);
    const nonce = issueChallengeNonce(origin);
    return NextResponse.json({ origin, nonce, message: challengeMessage(origin, nonce) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "challenge failed" }, { status: 500 });
  }
}
