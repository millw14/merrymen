import { NextResponse, type NextRequest } from "next/server";
import { dedicatedMcpHost, mcpHostLanding } from "@/mcp/landing";
import { documentPolicy } from "@/lib/browser-security";

/**
 * The self-hosted dashboard has NO login and can move real funds (/api/recover sweeps to any
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
 *   2. Cross-site block — check Origin independently of Fetch Metadata. Browsers
 *      omit Sec-Fetch-Site for ordinary private-LAN HTTP URLs, so its absence
 *      cannot authenticate a request. Referer is the fallback for older browsers;
 *      headerless non-browser clients still meet each route's own authorization.
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

/** The browser's actual origin, preserving 127.0.0.1 (Next normalizes its URL). */
function apiOrigin(req: NextRequest): string | null {
  try {
    if (HOSTED && process.env.MERRYMEN_PUBLIC_ORIGIN) return new URL(process.env.MERRYMEN_PUBLIC_ORIGIN.trim()).origin;
    const url = new URL(req.url);
    const host = req.headers.get("host");
    if (host) url.host = host;
    return url.origin;
  } catch { return null; }
}

function crossSiteApi(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const expected = apiOrigin(req);
  const origin = req.headers.get("origin");
  // "null" origins (sandboxed documents, file URLs) are not a trusted origin.
  if (origin !== null) return !expected || origin !== expected;
  const referer = req.headers.get("referer");
  if (referer !== null) {
    try { return !expected || new URL(referer).origin !== expected; }
    catch { return true; }
  }
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  const browser = site !== null || req.headers.has("sec-fetch-mode") || req.headers.has("sec-fetch-dest");
  return unsafe && browser && site !== "same-origin";
}

// Exact public files/text endpoints only. A dotted agent name or approval identifier still
// renders a document, so a generic file-extension exclusion is unsafe here.
const STATIC_ASSETS = new Set([
  "/sw.js", "/sdk/merrymen-browser.js", "/offline.html", "/manifest.webmanifest", "/llms.txt",
  "/favicon.ico", "/favicon.svg", "/logo.svg", "/og.png", "/mcp-icon.svg", "/mcp-icon-512.png",
  "/icon-192.png", "/icon-512.png", "/icon-maskable-192.png", "/icon-maskable-512.png",
  "/apple-touch-icon.png", "/merrymenlogo.png", "/atmos/sherwood-night.webp",
  ...["DMSans-latin.woff2", "DMSans-latin-ext.woff2", "DMSans-OFL.txt",
    "GeistPixel-latin.woff2", "GeistPixel-latin-ext.woff2", "Geist-numerals.woff2", "Geist-OFL.txt",
    "Inter-latin.woff2", "Inter-latin-ext.woff2", "Inter-vietnamese.woff2", "Inter-cyrillic.woff2", "Inter-OFL.txt",
    "NotoSansThai-thai.woff2", "NotoSansThai-OFL.txt", "README.md"].map(name => `/fonts/${name}`),
]);

function documentResponse(req: NextRequest): NextResponse {
  // These routes have their own protocol, not Next document scripts. The
  // matcher excludes them too; retain that boundary when invoked directly.
  if (/^\/(?:_next|mcp|oauth|\.well-known)(?:\/|$)/.test(req.nextUrl.pathname) || STATIC_ASSETS.has(req.nextUrl.pathname)) return NextResponse.next();
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const policy = documentPolicy(nonce, { development: process.env.NODE_ENV === "development", hosted: HOSTED });
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  // Next reads the request policy and nonces its framework and hydration
  // scripts. Overwrite caller-supplied values; neither is trusted input.
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── the API guards ─────────────────────────────────────────────────────
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
    if (crossSiteApi(req)) {
      return new NextResponse("blocked: cross-site request to the local API", { status: 403 });
    }
    return NextResponse.next();
  }

  if (STATIC_ASSETS.has(pathname)) return NextResponse.next();

  // ── pages on the dedicated MCP domain, and nowhere else ────────────────
  //
  // The redirect is only for the configured MCP host. Other document requests
  // continue to the nonce policy below.
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

  return documentResponse(req);
}

/**
 * The API, plus pages for the dedicated MCP domain.
 *
 * APIs receive DNS-rebinding/CSRF checks; pages receive fresh script nonces
 * and the configured MCP-host landing redirect. Protocol endpoints and files
 * keep their own content policy and never receive document script nonces.
 */
export const config = {
  // The two guards are and always were API-only (the isApi check above, not
  // this list, is what scopes them): running the Host allowlist over ordinary
  // navigation would newly refuse a self-hosted install reached over a LAN.
  // Protocol/framework namespaces retain their own policies. Exact public
  // assets are excluded inside middleware; dotted application routes and
  // unknown paths still receive document nonces, including 404 documents.
  matcher: ["/api/:path*", "/((?!api/|_next/|mcp(?:/|$)|oauth/|\\.well-known/).*)"],
};
