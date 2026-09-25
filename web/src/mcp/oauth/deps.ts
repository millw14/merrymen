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

const FORM_MAX = 16 * 1024;

/** Read a token-endpoint body: form-encoded per RFC 6749; JSON tolerated. Bounded. */
export async function readForm(request: Request): Promise<URLSearchParams | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > FORM_MAX) return null;
  const text = await request.text();
  if (text.length > FORM_MAX) return null;
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
