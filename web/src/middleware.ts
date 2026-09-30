import { NextResponse, type NextRequest } from "next/server";
import { dedicatedMcpHost, mcpHostLanding } from "@/mcp/landing";

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
  // IPv6 literals only. After the port + brackets are stripped, a real IPv6 host
  // still contains ':' — a DNS name never does. Gating the ULA/link-local checks
  // on that ':' is what stops a PUBLIC domain like "fd-x.com" or "fc2.evil.com"
  // (they start with "fd"/"fc") from being mistaken for an fc00::/7 address and
  // sailing straight through the DNS-rebind guard.
  if (hostname.includes(":")) {
    if (hostname === "::1") return true; // loopback
    if (hostname.startsWith("fe80:")) return true; // link-local fe80::/10
    if (hostname.startsWith("fc") || hostname.startsWith("fd")) return true; // ULA fc00::/7
    return false; // any other global IPv6 → blocked
  }
  return false; // a public domain or public IPv4 → blocked (this is the DNS-rebind kill)
}

/**
 * Hosted mode has a PUBLIC domain by definition, so the localhost host-allowlist
 * above would reject every request. In hosted mode the perimeter moves from
 * "only loopback can reach the API" to "only an authenticated tenant can mutate
 * anything" — enforced by tenantOf()/requireTenant in each route handler, which
 * run in the node runtime with the signing secret. Middleware keeps the one
 * defence that still applies on a public origin: the cross-site block, which no
 * attacker page can forge past. Read `MERRYMEN_HOSTED` directly (edge runtime
 * can't import node modules) rather than through isHostedMode().
 */
const HOSTED = ["1", "true", "yes"].includes((process.env.MERRYMEN_HOSTED ?? "").trim().toLowerCase());

/**
 * The dedicated MCP domain (mcp.merrymen.dev), when there is one. It is the
 * same web service as the app, so without a word from here a browser that
 * opens it gets the whole terminal, signed out, and a client given the bare
 * domain gets HTML (mcp/landing.ts has the full story). Derived from
 * configuration once, the way HOSTED is and as config.ts derives it, never
 * from the Host header. Null when hosted MCP has no second domain, which is
 * every self-hosted install: then nothing below touches a page.
 */
const MCP_HOST = dedicatedMcpHost({
  MERRYMEN_OAUTH_ISSUER: process.env.MERRYMEN_OAUTH_ISSUER,
  MERRYMEN_PUBLIC_ORIGIN: process.env.MERRYMEN_PUBLIC_ORIGIN,
  MERRYMEN_MCP_RESOURCE_URL: process.env.MERRYMEN_MCP_RESOURCE_URL,
}, HOSTED);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── the two API guards, unchanged and still API-only ────────────────────
  //
  // Scoped explicitly, and the scoping is the load-bearing part (the matcher
  // now reaches pages too, for the MCP domain below): applying the host
  // allowlist to a PAGE would newly refuse a self-hosted install reached over
  // a LAN or a domain.
  const isApi = pathname.startsWith("/api/");
  if (isApi) {
    if (!HOSTED && !hostAllowed(req.headers.get("host"))) {
      return new NextResponse("blocked: unexpected Host header (possible DNS-rebinding)", { status: 403 });
    }
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") {
      return new NextResponse("blocked: cross-site request to the local API", { status: 403 });
    }
    return NextResponse.next();
  }

  // ── pages on the dedicated MCP domain, and nowhere else ────────────────
  //
  // One header read and one string comparison on any other host, and nothing
  // at all self-hosted: that is what keeps matching every page affordable.
  // The query is as Next hands it to middleware (its URL parser rewrites a
  // 127.0.0.1 anywhere in it to localhost; see mcp/oauth/deps.ts). Harmless
  // for a page; /oauth/*, where it would matter, is never redirected.
  if (MCP_HOST) {
    const landing = mcpHostLanding(MCP_HOST, { method: req.method, headers: req.headers, pathname, search: req.nextUrl.search });
    if (landing) {
      const res = NextResponse.redirect(landing.location, landing.status);
      // The answer depends on request headers (a page load or a client), so
      // no cache may hand one caller's redirect to the other; a 308 is
      // otherwise cacheable by default.
      res.headers.set("Cache-Control", "no-store");
      return res;
    }
  }

  return NextResponse.next();
}

/**
 * The API, plus pages for the dedicated MCP domain.
 *
 * This file guards /api/* against DNS rebinding and cross-site POSTs. It once
 * also rendered a password holding page, which is why the matcher reached
 * pages at all; that is gone. Pages are matched again for one reason only:
 * a browser (or a client given the bare domain) on the MCP host is sent where
 * it can do something (mcp/landing.ts). Matching is by path because a matcher
 * cannot read runtime configuration; the host check is in the function.
 */
export const config = {
  // The two guards are and always were API-only (the isApi check above, not
  // this list, is what scopes them): running the Host allowlist over ordinary
  // navigation would newly refuse a self-hosted install reached over a LAN.
  // The page pattern skips what the MCP host must serve untouched anyway, so
  // assets and the MCP endpoints never pay for a middleware call: Next's
  // files, the endpoint, OAuth, discovery and anything with a file extension.
  matcher: ["/api/:path*", "/((?!api/|_next/|mcp(?:/|$)|oauth/|\\.well-known/|.*\\.[A-Za-z0-9]+$).*)"],
};
