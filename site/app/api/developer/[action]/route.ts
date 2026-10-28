import { NextRequest, NextResponse } from "next/server";
import { developerGateway as gateway } from "../../../../lib/developer-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A payment check reads the chain (up to 10 s a read) before it answers.
export const maxDuration = 60;
const COOKIE = "mm_developer";
const UNAVAILABLE = "Developer sign-in is temporarily unavailable. Please try again shortly.";
const fail = (message: string, status: number) => NextResponse.json({ error: { message } }, { status, headers: { "Cache-Control": "no-store" } });
const clientIp = (req: NextRequest) => req.headers.get("x-vercel-forwarded-for")?.split(",")[0] || req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
/**
 * What the console may ask the gateway for, by method. Anything else is a 404
 * here, before the portal secret is attached to it.
 *
 * `plans` is public (the Plans section reads it signed out) and is sent
 * without the session cookie: what everyone may read needs nobody's session.
 */
const ROUTES: Record<string, readonly string[]> = {
  GET: ["keys", "plans", "account"],
  POST: ["challenge", "verify", "keys", "revoke", "test", "account", "plan", "payments"],
};
const PUBLIC = new Set(["plans"]);
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
    // Revoke the session on the gateway first, so a copied cookie stops working
    // too. Best effort: the cookie is cleared whatever happens, and a failure
    // only leaves the token to expire on its own, as every token used to.
    const session = req.cookies.get(COOKIE)?.value, target = session ? gateway() : null;
    if (session && target) {
      try {
        await fetch(`${target.origin}/developer/v1/logout`, { method: "POST", body: "{}", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
          headers: { "content-type": "application/json", authorization: `Bearer ${target.secret}`, "x-developer-session": session, "x-developer-ip": clientIp(req) } });
      } catch { /* Best effort; see above. */ }
    }
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/api/developer", maxAge: 0 });
    return response;
  }
  if (!Object.hasOwn(ROUTES, req.method) || !ROUTES[req.method].includes(action)) return fail("Not found", 404);
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
        "x-developer-session": PUBLIC.has(action) ? "" : req.cookies.get(COOKIE)?.value || "", "x-developer-ip": clientIp(req) },
      ...(raw !== undefined ? { body: raw } : {}), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(action === "payments" ? 45_000 : 20_000),
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
