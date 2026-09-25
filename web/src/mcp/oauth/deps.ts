/**
 * Production wiring for the OAuth routes, plus the small HTTP helpers they share.
 */
import { mcpConfig } from "../config";
import { mcpDb } from "../db";
import { agentDirectory } from "../agents";
import { rateHit, writeAudit } from "../observe";
import type { OAuthDeps } from "./server";
import { jsonResponse } from "./metadata";

export async function oauthDeps(): Promise<OAuthDeps> {
  const d = await mcpDb();
  return {
    d,
    cfg: mcpConfig(),
    now: () => Math.floor(Date.now() / 1000),
    agents: agentDirectory(),
    audit: (e) => writeAudit(d, { action: e.action, outcome: e.outcome, tenant: e.tenant, connectionId: e.connectionId, clientId: e.clientId, detail: e.detail }),
  };
}

/**
 * The address Railway's edge saw. X-Forwarded-For's LAST entry is appended by
 * the proxy we trust; earlier entries are whatever the client claimed.
 */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  return request.headers.get("x-real-ip")?.slice(0, 64) ?? "unknown";
}

/** Coarse per-IP abuse limit for the public OAuth endpoints. Null when allowed. */
export async function ipLimited(deps: OAuthDeps, request: Request, name: string, windowSec: number, limit: number): Promise<Response | null> {
  const v = await rateHit(deps.d, `ip:${name}:${clientIp(request)}`, windowSec, limit, deps.now());
  if (v.ok) return null;
  return jsonResponse({ error: "slow_down", error_description: "Too many requests; retry later." }, 429, { "Retry-After": String(v.retryAfterSec), ...PUBLIC_CORS });
}

/** The token, registration and revocation endpoints use no cookies, so any origin may call them. */
export const PUBLIC_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "600",
} as const;

export function preflight(): Response {
  return new Response(null, { status: 204, headers: PUBLIC_CORS });
}

export const FORM_MAX = 16 * 1024;

/**
 * Read a request body of at most `limit` bytes, or null when it is larger.
 *
 * These endpoints are public and outside /api (so no middleware body cap), and
 * `request.text()` would buffer a chunked body of any size before a length
 * check could run. This refuses a declared Content-Length over the limit and
 * otherwise reads the stream chunk by chunk, cancelling it as soon as the
 * running total passes the limit: at most one chunk past `limit` is ever held.
 */
export async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/** Read a token-endpoint body: form-encoded per RFC 6749; JSON tolerated. Bounded. */
export async function readForm(request: Request): Promise<URLSearchParams | null> {
  const text = await readBoundedText(request, FORM_MAX);
  if (text === null) return null;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) if (typeof v === "string") p.set(k, v);
      return p;
    } catch {
      return null;
    }
  }
  return new URLSearchParams(text);
}
