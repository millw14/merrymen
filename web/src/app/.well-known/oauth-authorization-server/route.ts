/** RFC 8414 authorization-server metadata for the MCP OAuth server. */
import { mcpConfig } from "@/mcp/config";
import { authorizationServerMetadata, discoveryResponse } from "@/mcp/oauth/metadata";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Response {
  const cfg = mcpConfig();
  if (!cfg.enabled) return new Response("Not found", { status: 404 });
  return discoveryResponse(authorizationServerMetadata(cfg));
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "MCP-Protocol-Version" } });
}
