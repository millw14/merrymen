/**
 * POST /api/auth/logout — clear the session cookie. The wallet stays in the
 * browser; this only forgets the server-side login.
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { walletNotSupported } from "@/lib/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}
