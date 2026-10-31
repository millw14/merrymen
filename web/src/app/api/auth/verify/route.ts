/**
 * POST /api/auth/verify { nonce, signature } — complete wallet login.
 *
 * Recovers the address from the signature over the challenge, burns the nonce,
 * and sets the session cookie. The recovered address IS the tenant id from this
 * point on — nothing the client sends may override it.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { SESSION_COOKIE, mintSession, sessionCookieOptions, verifySignedChallenge } from "@/lib/auth";
import { walletNotSupported } from "@/lib/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function originOf(req: Request): string {
  const configured = process.env.MERRYMEN_PUBLIC_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  return new URL(req.url).origin;
}

export async function POST(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  if (!isHostedMode()) return new NextResponse("not found", { status: 404 });
  let body: { nonce?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!nonce || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return NextResponse.json({ error: "nonce and 0x signature required" }, { status: 400 });
  }

  let result;
  try {
    result = await verifySignedChallenge({ origin: originOf(req), nonce, signature: signature as `0x${string}` });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "verify failed" }, { status: 500 });
  }
  if (!result.ok) return NextResponse.json({ error: result.why }, { status: 401 });

  const res = NextResponse.json({ address: result.address });
  res.cookies.set(SESSION_COOKIE, mintSession(result.address), sessionCookieOptions());
  return res;
}
