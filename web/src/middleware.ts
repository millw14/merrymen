import { NextResponse, type NextRequest } from "next/server";

/**
 * The dashboard has NO login and can move real funds (/api/recover sweeps to any
 * address; /api/grants is the kill switch; /api/settings repoints the bundler).
 * Binding to localhost does NOT protect it: a web page you visit can fire
 * cross-origin requests at http://localhost:3100 from your own browser (CSRF),
 * and a DNS-rebinding attack can point an attacker domain at loopback so it
 * becomes "same-origin". This guard runs on every /api/* request and closes both:
 *
 *   1. Host allowlist — reject any Host that isn't loopback or a private-LAN IP
 *      literal. DNS rebinding needs a PUBLIC domain name in the Host header, so
 *      this kills it, while still allowing the explicit MERRYMEN_HOST=0.0.0.0 LAN
 *      opt-in (reached via a private IP like 192.168.x.x).
 *   2. Cross-site block — reject requests whose Sec-Fetch-Site is cross-site or
 *      same-site (a different site the browser labels as such). same-origin (the
 *      dashboard itself) and none (a top-level navigation, or a non-browser client
 *      like curl on your own machine) are allowed. Modern browsers always send
 *      this header, and an attacker page cannot forge it to "same-origin".
 *
 * Without this, a single unauthenticated cross-origin POST drains the account.
 */

/** True only for loopback + RFC1918 private + link-local hosts (never a public domain/IP). */
function hostAllowed(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const first = hostHeader.split(",")[0].trim();
  const hostname = first
    .replace(/:\d+$/, "") // drop :port (won't touch bare IPv6, handled below)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (hostname === "localhost") return true;

  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  if (hostname === "::1") return true; // IPv6 loopback
  if (hostname.startsWith("fe80:")) return true; // IPv6 link-local
  if (hostname.startsWith("fc") || hostname.startsWith("fd")) return true; // IPv6 ULA
  return false; // a public domain or public IP → blocked (this is the DNS-rebind kill)
}

export function middleware(req: NextRequest) {
  if (!hostAllowed(req.headers.get("host"))) {
    return new NextResponse("blocked: unexpected Host header (possible DNS-rebinding)", { status: 403 });
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return new NextResponse("blocked: cross-site request to the local API", { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
