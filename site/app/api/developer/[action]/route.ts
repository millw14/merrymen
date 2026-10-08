import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const COOKIE = "mm_developer";
const UNAVAILABLE = "Developer sign-in is temporarily unavailable. Please try again shortly.";
const fail = (message: string, status: number) => NextResponse.json({ error: { message } }, { status, headers: { "Cache-Control": "no-store" } });
const clientIp = (req: NextRequest) => req.headers.get("x-vercel-forwarded-for")?.split(",")[0] || req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
/**
 * Where the portal credential goes, or null to fail closed.
 *
 * MERRYMEN_DEVELOPER_GATEWAY_ORIGIN points a preview or local site at another
 * gateway. The secret travels with every request, so the override must be a
 * bare https origin (plain http only on localhost), and a malformed one is
 * refused rather than ignored. The secret needs 32+ bytes, as the gateway
 * already requires: a shorter one could only ever be refused there.
 */
function gateway(): { origin: string; secret: string } | null {
  const secret = process.env.MERRYMEN_DEVELOPER_PORTAL_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) { console.error("[developer] MERRYMEN_DEVELOPER_PORTAL_SECRET is unset or under 32 bytes"); return null; }
  try {
    const url = new URL(process.env.MERRYMEN_DEVELOPER_GATEWAY_ORIGIN || "https://ai.merrymen.dev");
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol === "https:" || local) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) return { origin: url.origin, secret };
  } catch { /* Reported below. */ }
  console.error("[developer] MERRYMEN_DEVELOPER_GATEWAY_ORIGIN must be an https origin, or http on localhost");
  return null;
}
async function handle(req: NextRequest, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (action === "sdk" && req.method === "GET") {
    try {
      const response = await fetch("https://app.merrymen.dev/sdk/merrymen-browser.js", { signal: AbortSignal.timeout(15_000), cache: "no-store" });
      if (!response.ok) return fail("SDK download unavailable. Try again shortly.", 503);
      return new Response(response.body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Content-Disposition": 'attachment; filename="merrymen-browser.js"', "Cache-Control": "public, max-age=300" } });
    } catch { return fail("SDK download unavailable. Try again shortly.", 503); }
  }
  if (req.method === "POST" && (req.headers.get("origin") !== new URL(req.url).origin || ["cross-site", "same-site"].includes(req.headers.get("sec-fetch-site") || ""))) return fail("Open the developer page to perform this action.", 403);
  if (action === "logout" && req.method === "POST") {
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/api/developer", maxAge: 0 });
    return response;
  }
  if (!(req.method === "GET" && action === "keys") && !(req.method === "POST" && ["challenge", "verify", "keys", "revoke", "test"].includes(action))) return fail("Not found", 404);
  const target = gateway();
  if (!target) return fail(UNAVAILABLE, 503);
  try {
    let raw: string | undefined;
    if (req.method === "POST") {
      if (Number(req.headers.get("content-length")) > 8192) return fail("Request too large", 413);
      const reader = req.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (reader) { try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 8192) { await reader.cancel(); return fail("Request too large", 413); } chunks.push(next.value); } } finally { reader.releaseLock(); } }
      raw = Buffer.concat(chunks).toString("utf8");
    }
    const upstream = await fetch(`${target.origin}/developer/v1/${action}`, {
      method: req.method, headers: { "content-type": "application/json", authorization: `Bearer ${target.secret}`,
        "x-developer-session": req.cookies.get(COOKIE)?.value || "", "x-developer-ip": clientIp(req) },
      ...(raw !== undefined ? { body: raw } : {}), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    const data = await upstream.json();
    const session = data.session; delete data.session;
    const response = NextResponse.json(data, { status: upstream.status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    if (action === "verify" && upstream.ok && typeof session === "string") response.cookies.set(COOKIE, session, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/api/developer", maxAge: 8 * 3600 });
    return response;
  } catch { return fail("Could not reach the developer service. Please try again.", 503); }
}
export const GET = handle;
export const POST = handle;
