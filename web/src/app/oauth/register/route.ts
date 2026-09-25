/**
 * RFC 7591 dynamic client registration, for MCP clients that do not use Client
 * ID Metadata Documents. Registration creates a client identity only; it grants
 * nothing until an owner consents.
 */
import { mcpConfig } from "@/mcp/config";
import { PUBLIC_CORS, ipLimited, oauthDeps, preflight } from "@/mcp/oauth/deps";
import { jsonResponse } from "@/mcp/oauth/metadata";
import { registerClient } from "@/mcp/oauth/clients";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX = 16 * 1024;

export async function POST(req: Request): Promise<Response> {
  if (!mcpConfig().enabled) return new Response("Not found", { status: 404 });
  const deps = await oauthDeps();
  const limited = await ipLimited(deps, req, "register", 3600, 30);
  if (limited) return limited;
  const text = await req.text();
  if (text.length > MAX) return jsonResponse({ error: "invalid_client_metadata", error_description: "metadata too large" }, 400, PUBLIC_CORS);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400, PUBLIC_CORS);
  }
  const result = await registerClient(deps.d, body, deps.now());
  if (result.status === 201) await deps.audit?.({ action: "oauth.client_registered", outcome: "ok", clientId: String(result.body.client_id) });
  return jsonResponse(result.body, result.status, PUBLIC_CORS);
}

export const OPTIONS = preflight;
