/**
 * What a browser, or a client given the bare domain, gets on the MCP host.
 *
 * The server address (https://mcp.merrymen.dev/mcp) is meant for AI
 * assistants, but owners open it in a browser too. The MCP host is the same
 * web service under a second domain, so before this a browser there got the
 * whole terminal, signed out (the sign-in cookie lives on the issuer host and
 * never reaches this one); an MCP client given https://mcp.merrymen.dev got
 * an HTML page for its POST and never started OAuth; and /mcp answered a
 * browser with raw JSON. Now a page load is sent to the issuer, where the
 * owner is signed in, and "/" points a client at the endpoint.
 *
 * Edge-safe on purpose: middleware.ts imports this, so it pulls in no node
 * module and re-derives the issuer and resource exactly as config.ts does (a
 * test pins the two together). As there, every URL comes from configuration
 * and never from the Host header. The only request data a redirect carries is
 * the path and query of the same request, set on the configured issuer origin.
 */

/** Where an owner who opened the server address in a browser is sent: the page on connecting an assistant. */
export function connectHelpUrl(issuer: string): string {
  return `${issuer}/connect/mcp`;
}

/**
 * A top-level page load in a browser, as opposed to an MCP client, a fetch()
 * or curl. Sec-Fetch-Dest settles it where the browser sends it (every current
 * one does); without it, only a GET that asks for HTML counts. An
 * Authorization or MCP-Protocol-Version header means a client, never a person
 * at a browser, so those requests keep their normal answer.
 */
export function isBrowserNavigation(method: string, headers: Headers): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (headers.has("authorization") || headers.has("mcp-protocol-version")) return false;
  const dest = headers.get("sec-fetch-dest");
  if (dest !== null) return dest.trim().toLowerCase() === "document";
  return (headers.get("accept") ?? "").toLowerCase().includes("text/html");
}

/** A dedicated MCP domain: the resource URL's host, which is not the issuer's. */
export interface DedicatedMcpHost {
  /** e.g. mcp.merrymen.dev (URL-normalised: lowercase, no default port). */
  host: string;
  /** OAuth issuer origin, e.g. https://app.merrymen.dev. */
  issuer: string;
  /** Canonical resource URL, e.g. https://mcp.merrymen.dev/mcp. */
  resource: string;
  /** Its path, e.g. /mcp. */
  resourcePath: string;
}

/** config.ts's originOf, verbatim in behaviour (see the parity test). */
function originOf(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return url;
    return null;
  } catch {
    return null;
  }
}

type McpEnv = Partial<Record<"MERRYMEN_OAUTH_ISSUER" | "MERRYMEN_PUBLIC_ORIGIN" | "MERRYMEN_MCP_RESOURCE_URL", string>>;

/**
 * The dedicated MCP host, or null when there is none: not hosted (MCP is a
 * hosted feature, and a self-hosted install must behave exactly as before), no
 * valid issuer or resource, a resource at the root (then "/" IS the endpoint),
 * or a resource on the issuer's own host (then there is no second domain, and
 * "/" is the terminal, as it should be).
 */
export function dedicatedMcpHost(env: McpEnv, hosted: boolean): DedicatedMcpHost | null {
  if (!hosted) return null;
  const issuerUrl = originOf(env.MERRYMEN_OAUTH_ISSUER ?? env.MERRYMEN_PUBLIC_ORIGIN);
  if (!issuerUrl) return null;
  const issuer = issuerUrl.origin;
  const resourceUrl = originOf(env.MERRYMEN_MCP_RESOURCE_URL ?? `${issuer}/mcp`);
  if (!resourceUrl || resourceUrl.host === issuerUrl.host) return null;
  const resourcePath = resourceUrl.pathname.replace(/\/+$/, "");
  if (!resourcePath) return null;
  return { host: resourceUrl.host, issuer, resource: `${resourceUrl.origin}${resourcePath}`, resourcePath };
}

/**
 * What the MCP host serves itself, whoever asks: the endpoint, discovery,
 * OAuth, the API, Next's assets and any file (icons, the service worker, the
 * manifest). Redirecting any of these would break a client or a page.
 */
function servedHere(pathname: string, resourcePath: string): boolean {
  const first = (pathname.split("/")[1] ?? "").toLowerCase();
  if (first === "mcp" || first === ".well-known" || first === "api" || first === "oauth" || first === "_next") return true;
  if (pathname === resourcePath || pathname.startsWith(`${resourcePath}/`)) return true;
  return /\.[a-z0-9]+$/i.test(pathname);
}

export interface Landing {
  status: 307 | 308;
  location: string;
}

/**
 * The redirect for a request on the dedicated MCP host, or null to serve it
 * as today. Null on every other host: the Host header is only compared with
 * the configured one, never used to build anything.
 *
 * - A browser page load of "/" goes to the connect help page on the issuer;
 *   any other page goes to the same path and query on the issuer, where the
 *   owner is signed in (307: a GET stays a GET).
 * - Anything else at "/" (an MCP client that was given the bare domain) gets
 *   308 to the resource URL, which keeps the method and body. A permissive
 *   client then connects. A spec-strict one still refuses, correctly: the
 *   protected-resource metadata names the /mcp URL, not the one it was given.
 */
export function mcpHostLanding(
  mcp: DedicatedMcpHost | null,
  req: { method: string; headers: Headers; pathname: string; search: string },
): Landing | null {
  if (!mcp) return null;
  if ((req.headers.get("host") ?? "").trim().toLowerCase() !== mcp.host) return null;
  if (servedHere(req.pathname, mcp.resourcePath)) return null;
  const browser = isBrowserNavigation(req.method, req.headers);
  if (req.pathname === "/") return browser ? { status: 307, location: connectHelpUrl(mcp.issuer) } : { status: 308, location: mcp.resource };
  if (!browser) return null;
  // Set on a URL built from the issuer, never concatenated or resolved: a path
  // like "//evil.test" then stays a path on the issuer instead of becoming a
  // protocol-relative host.
  const to = new URL(mcp.issuer);
  to.pathname = req.pathname;
  to.search = req.search;
  return to.origin === mcp.issuer ? { status: 307, location: to.toString() } : null;
}
