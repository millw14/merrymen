/**
 * The /mcp HTTP endpoint (Streamable HTTP, stateless).
 *
 * Order of checks, cheapest first, each with its own status:
 *   off (404) → Host (421) → Origin (403) → a person opening the address in a
 *   browser (307 to the connect help page) → bearer token (401 + discovery
 *   challenge) → per-connection and per-owner request rate (429) → process
 *   concurrency (503) → the SDK handler, which serves both the 2026-07-28
 *   stateless protocol and 2025-era clients through its stateless fallback.
 * Every answer after the Origin check carries CORS headers for a configured
 * browser origin (withCors).
 *
 * The bearer token is looked up (opaque, hashed at rest), audience-checked
 * against the configured resource URL, and never passed anywhere else.
 *
 * The same handler serves the directory profile (/mcp/directory, see
 * app/mcp/directory/route.ts) with profile "directory": its own resource URL
 * for the audience check and the 401 challenge, only directory tokens
 * accepted, and a server built without anything outside the profile. Off
 * (404) when the directory profile is switched off.
 */
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { mcpConfig, resourceFor, type McpConfig } from "./config";
import { mcpDb, type McpDb } from "./db";
import { connectHelpUrl, isBrowserNavigation } from "./landing";
import { bearerChallenge, jsonResponse } from "./oauth/metadata";
import { verifyAccessToken, type Principal } from "./oauth/server";
import { Gate, count, logEvent, pseudonym, rateHit, traceId } from "./observe";
import { buildServer, principalOf } from "./server";
import type { McpProfile } from "./scopes";

const PER_CONNECTION_PER_MINUTE = 240;
const PER_OWNER_PER_HOUR = 3000;
const MAX_BODY = 1024 * 1024;

const gate = new Gate(64, 8);

/** One SDK handler per profile: the profile is fixed by the route, never by anything in the request. */
const handlerFor = (profile: McpProfile) => createMcpHandler(({ authInfo }) => buildServer(principalOf(authInfo), { profile }), {
  legacy: "stateless",
  responseMode: "auto",
  maxRequestBodySize: MAX_BODY,
  onerror: (error) => logEvent("transport_error", { error: error.name }),
});
const handlers: Record<McpProfile, ReturnType<typeof handlerFor>> = { full: handlerFor("full"), directory: handlerFor("directory") };

export interface EndpointDeps {
  cfg?: McpConfig;
  mcp?: () => Promise<McpDb>;
  now?: () => number;
  fetch?: (request: Request, authInfo: AuthInfo) => Promise<Response>;
  /** Which endpoint this is: the canonical /mcp (default) or the directory profile. Set by the route. */
  profile?: McpProfile;
}

function hostAllowed(cfg: McpConfig, request: Request): boolean {
  const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
  return cfg.allowedHosts.has(host);
}

/** Browsers always send Origin on cross-origin POSTs; server-side clients send none. */
function originAllowed(cfg: McpConfig, request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return cfg.allowedOrigins.has(origin);
}

/**
 * Response headers a browser client may read. The preflight (app/mcp/route.ts)
 * lists them too, but only the actual response's list takes effect: without it
 * a browser client could not read the 401's WWW-Authenticate (discovery) or a
 * 429's Retry-After.
 */
export const MCP_EXPOSED_HEADERS = "WWW-Authenticate, Mcp-Session-Id, X-Trace-Id, Retry-After";

/**
 * CORS for a configured browser origin (MERRYMEN_MCP_ALLOWED_ORIGINS), on every
 * answer after the Origin check: a browser discards any response without
 * Access-Control-Allow-Origin, the 401 challenge and the 429 included. No
 * credentials are allowed (the bearer token is an explicit header, never a
 * cookie), and a request with no Origin or another origin gets none of this.
 */
function withCors(cfg: McpConfig, request: Request, res: Response): Response {
  const origin = request.headers.get("origin");
  if (!origin || !cfg.allowedOrigins.has(origin)) return res;
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Access-Control-Expose-Headers", MCP_EXPOSED_HEADERS);
  const vary = res.headers.get("vary");
  if (!vary || !/(^|,)\s*(origin|\*)\s*(,|$)/i.test(vary)) res.headers.set("Vary", vary ? `${vary}, Origin` : "Origin");
  return res;
}

function bearerOf(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(h.trim());
  return m ? m[1] : "";
}

/** Pass a body through, calling `release` exactly once when it ends, errors or is cancelled. */
function releasing(body: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}

/**
 * What an assistant shows (and a person reads) when no token came with the
 * request. Signing in to the website does not help here, which the old text
 * implied: the assistant has to be given the server first, and it opens the
 * Merrymen sign-in itself.
 */
function noTokenHelp(cfg: McpConfig): string {
  return `Add this server to your assistant as a connector, then sign in to Merrymen when it asks. Help: ${connectHelpUrl(cfg.issuer)}`;
}

function unauthorized(cfg: McpConfig, presented: boolean, trace: string, profile: McpProfile): Response {
  return jsonResponse(
    { error: "unauthorized", error_description: presented ? "The access token is invalid, expired or revoked." : noTokenHelp(cfg), trace_id: trace },
    401,
    { "WWW-Authenticate": bearerChallenge(cfg, presented ? { error: "invalid_token", profile } : { profile }), "X-Trace-Id": trace },
  );
}

export async function handleMcpRequest(request: Request, deps: EndpointDeps = {}): Promise<Response> {
  const cfg = deps.cfg ?? mcpConfig();
  const trace = traceId();
  if (!cfg.enabled) return new Response("Not found", { status: 404 });
  // The directory profile switched off (MERRYMEN_MCP_DIRECTORY=0): no such endpoint.
  if (!resourceFor(cfg, deps.profile ?? "full")) return new Response("Not found", { status: 404 });
  if (!hostAllowed(cfg, request)) return jsonResponse({ error: "misdirected_request" }, 421, { "X-Trace-Id": trace });
  if (!originAllowed(cfg, request)) {
    count("origin_refused");
    return jsonResponse({ error: "forbidden", error_description: "Origin not allowed" }, 403, { "X-Trace-Id": trace });
  }
  return withCors(cfg, request, await answer(request, deps, cfg, trace));
}

/** Everything after the Host and Origin checks; the caller adds CORS to whatever this returns. */
async function answer(request: Request, deps: EndpointDeps, cfg: McpConfig, trace: string): Promise<Response> {
  const profile: McpProfile = deps.profile ?? "full";
  // An owner who pasted the server address into a browser gets the page that
  // explains it, not a JSON 401. Only a page load with no Authorization and
  // no MCP-Protocol-Version header qualifies (landing.ts), so every client
  // request still meets the bearer check below, and Host and Origin were
  // already checked for everyone.
  if (isBrowserNavigation(request.method, request.headers)) {
    return new Response(null, { status: 307, headers: { Location: connectHelpUrl(cfg.issuer), "Cache-Control": "no-store", "X-Trace-Id": trace } });
  }
  const token = bearerOf(request);
  if (token === null) return unauthorized(cfg, false, trace, profile);

  let d: McpDb;
  try {
    d = await (deps.mcp ?? mcpDb)();
  } catch {
    return jsonResponse({ error: "temporarily_unavailable", trace_id: trace }, 503, { "Retry-After": "15", "X-Trace-Id": trace });
  }
  const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
  let principal: Principal | null;
  try {
    principal = token ? await verifyAccessToken(d, cfg, token, now, profile) : null;
  } catch {
    return jsonResponse({ error: "temporarily_unavailable", trace_id: trace }, 503, { "Retry-After": "15", "X-Trace-Id": trace });
  }
  if (!principal) {
    count("token_refused");
    return unauthorized(cfg, true, trace, profile);
  }

  try {
    const perConnection = await rateHit(d, `req:${principal.connectionId}:m`, 60, PER_CONNECTION_PER_MINUTE, now);
    const perOwner = perConnection.ok ? await rateHit(d, `req:${principal.tenant}:h`, 3600, PER_OWNER_PER_HOUR, now) : perConnection;
    const limited = !perConnection.ok ? perConnection : !perOwner.ok ? perOwner : null;
    if (limited) {
      count("rate_limited");
      return jsonResponse({ error: "rate_limited", retry_after_s: limited.retryAfterSec, trace_id: trace }, 429, { "Retry-After": String(limited.retryAfterSec), "X-Trace-Id": trace });
    }
  } catch {
    return jsonResponse({ error: "temporarily_unavailable", trace_id: trace }, 503, { "Retry-After": "15", "X-Trace-Id": trace });
  }

  const release = gate.tryEnter(principal.tenant);
  if (!release) {
    count("busy");
    return jsonResponse({ error: "busy", retry_after_s: 2, trace_id: trace }, 503, { "Retry-After": "2", "X-Trace-Id": trace });
  }
  const authInfo: AuthInfo = {
    token: "redacted",
    clientId: principal.clientId,
    scopes: [...principal.scopes],
    expiresAt: principal.tokenExpiresAt,
    resource: new URL(resourceFor(cfg, profile)),
    extra: { principal },
  };
  let body: ReadableStream<Uint8Array> | null = null;
  try {
    const response = await (deps.fetch ?? ((req, auth) => handlers[profile].fetch(req, { authInfo: auth })))(request, authInfo);
    const headers = new Headers(response.headers);
    headers.set("X-Trace-Id", trace);
    // A 2025-era response is an SSE stream that is still being written after
    // fetch() returns; hold the concurrency slot until it ends or the client
    // goes away.
    body = response.body ? releasing(response.body, release) : null;
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    logEvent("mcp_request_failed", { trace, tenant: pseudonym(principal.tenant), error: error instanceof Error ? error.name : "unknown" });
    return jsonResponse({ error: "internal", trace_id: trace }, 500, { "X-Trace-Id": trace });
  } finally {
    // No body to stream (or failure): release now. Released twice is a no-op.
    if (!body) release();
    else setTimeout(release, 120_000).unref?.();
  }
}
