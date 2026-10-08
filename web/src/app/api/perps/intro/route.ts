import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { requestOrigin, tenantOf } from "@/lib/auth";
import { getPerpsIntroStore } from "@/lib/perps-intro-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

/** Atomically claim one lifetime intro for the authenticated human, never their agent. */
export async function POST(req: Request) {
  const hosted = isHostedMode();
  const owner = hosted ? tenantOf(req) : "local";
  if (!owner) return reply({ error: "not signed in" }, 401);
  // Next normalizes loopback request URLs to localhost. In local mode the
  // browser's actual Host (already checked by the API middleware against DNS
  // rebinding) identifies the requested origin; a configured signing origin
  // must not turn a legitimate 127.0.0.1 tab into a cross-origin request.
  let origin = requestOrigin(req);
  if (!hosted) {
    const url = new URL(req.url), host = req.headers.get("host");
    origin = url.origin;
    if (host) {
      try {
        const actual = new URL(`${url.protocol}//${host}`);
        if (actual.host !== host || actual.username || actual.password || actual.pathname !== "/" || actual.search || actual.hash)
          return reply({ error: "invalid request host" }, 403);
        origin = actual.origin;
      } catch { return reply({ error: "invalid request host" }, 403); }
    }
  }
  const site = req.headers.get("sec-fetch-site");
  if (req.headers.get("origin") !== origin || (site !== null && site !== "same-origin" && site !== "none"))
    return reply({ error: "same-origin request required" }, 403);
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 256) return reply({ error: "invalid intro claim" }, 400);
    body = JSON.parse(text);
  } catch { return reply({ error: "invalid intro claim" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !("owner" in body) ||
      typeof body.owner !== "string" || Object.keys(body).length !== 1)
    return reply({ error: "expected owner" }, 400);
  if (body.owner !== owner) return reply({ error: "owner changed" }, 409);
  try { return reply({ owner, play: await getPerpsIntroStore().claim(owner) }); }
  catch { return reply({ error: "intro state unavailable" }, 503); }
}
