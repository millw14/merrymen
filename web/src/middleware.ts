import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, GATE_PATH, gatePassword, isGatedPath, sameSecret } from "@/lib/site-gate";

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

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── the two API guards, unchanged and still API-only ────────────────────
  //
  // The matcher below now sees pages as well, so these are scoped explicitly.
  // Applying the host allowlist to a PAGE would newly refuse a self-hosted
  // install reached over a LAN or a domain — a behaviour change nobody asked
  // for, hidden inside a change about a holding page.
  const isApi = pathname.startsWith("/api/");
  if (isApi) {
    if (!HOSTED && !hostAllowed(req.headers.get("host"))) {
      return new NextResponse("blocked: unexpected Host header (possible DNS-rebinding)", { status: 403 });
    }
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") {
      return new NextResponse("blocked: cross-site request to the local API", { status: 403 });
    }
    // Falls through to the gate rather than returning. The API used to be
    // exempt, which left every agent's name and forty posts of reasoning
    // readable by anyone who knew the URLs while the pages showing them were
    // behind a password.
  }

  // ── the holding page ────────────────────────────────────────────────────
  //
  // OFF UNLESS A PASSWORD IS SET, which is what keeps every local and
  // self-hosted install exactly as it was. It is a notice with a doorknob,
  // not authentication: one password for everyone, no session, and the
  // things here that actually move money are guarded by the signed-session
  // checks inside each route handler, which this neither replaces nor
  // strengthens.
  const expected = gatePassword();
  if (!expected || !isGatedPath(pathname)) return NextResponse.next();

  const held = req.cookies.get(GATE_COOKIE)?.value ?? "";
  if (sameSecret(held, expected)) return NextResponse.next();

  // AN API REQUEST GETS A STATUS, NOT A PAGE. Rewriting it to the notice would
  // hand a caller expecting JSON a lump of HTML with status 200, which is a
  // worse answer than a refusal — the browser code reading it would parse the
  // failure as data. 401 says what happened, and a visitor through the door
  // never sees it: their cookie rides along on same-origin requests.
  if (isApi) {
    return NextResponse.json(
      { error: "gated", detail: "This deployment is behind a password while it is being worked on." },
      { status: 401 },
    );
  }

  // A REWRITE, NOT A REDIRECT, and the difference is load-bearing here.
  //
  // This service runs behind a proxy with `next start -H 0.0.0.0`, so the
  // origin the server sees is the internal listen address. A redirect built
  // from it would send the visitor to 0.0.0.0:8080 — which is exactly the bug
  // the POST handler had, found by asking the deployed site for it.
  //
  // A rewrite is resolved server-side and never reaches the browser, so an
  // internal host cannot leak into one. It also leaves the visitor's own URL
  // alone, which means that once they are through they are already where they
  // were trying to go.
  const to = req.nextUrl.clone();
  to.pathname = GATE_PATH;
  to.search = "";
  return NextResponse.rewrite(to);
}

/**
 * Pages and the API, but never the framework's own assets.
 *
 * Gate /_next and the holding page renders unstyled; gate the API and a live
 * fleet stops — Telegram posts webhooks to it and the browser calls it after
 * every page load. isGatedPath() draws the same line again for the paths this
 * pattern cannot express.
 */
export const config = {
  // THE APP ICONS ARE EXEMPT, and they have to be. The Privy login modal runs
  // in an auth.privy.io iframe and loads our logo cross-origin; the gate cookie
  // is SameSite, so that request arrives unauthenticated and the gate answered
  // it with the password page — which the browser rendered as a broken image at
  // the top of the sign-in dialog. An icon is not a secret; the gate exists to
  // keep people out of the app, not out of a PNG.
  matcher: ["/api/:path*", "/((?!_next/static|_next/image|favicon.ico|icon-|apple-touch-icon|logo\.svg|merrymenlogo).*)"],
};
