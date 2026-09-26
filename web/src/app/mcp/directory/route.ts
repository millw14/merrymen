/**
 * The directory profile of the Merrymen MCP endpoint (Streamable HTTP):
 * https://mcp.merrymen.dev/mcp/directory, the address listed in Anthropic's
 * connector directory. The same server as /mcp (app/mcp/route.ts) with the
 * same Host, Origin, browser-navigation, bearer, rate and concurrency checks
 * (web/src/mcp/http.ts), but its own OAuth resource: only tokens issued for
 * this address are accepted, and trade:propose, drafts:write, social:write
 * and staff scopes can never be granted or used here. 404 unless hosted MCP
 * is enabled and the directory profile is on (MERRYMEN_MCP_DIRECTORY).
 */
import { MCP_EXPOSED_HEADERS, handleMcpRequest } from "@/mcp/http";
import { mcpConfig } from "@/mcp/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request) => handleMcpRequest(req, { profile: "directory" });
export const GET = (req: Request) => handleMcpRequest(req, { profile: "directory" });
export const DELETE = (req: Request) => handleMcpRequest(req, { profile: "directory" });

export function OPTIONS(req: Request): Response {
  const cfg = mcpConfig();
  if (!cfg.enabled || !cfg.directoryResource) return new Response(null, { status: 404 });
  const origin = req.headers.get("origin");
  // As on /mcp: CORS only for configured origins, and the actual answers
  // carry Allow-Origin and Expose-Headers too (handleMcpRequest).
  if (!origin || !cfg.allowedOrigins.has(origin)) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID",
      "Access-Control-Expose-Headers": MCP_EXPOSED_HEADERS,
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}
