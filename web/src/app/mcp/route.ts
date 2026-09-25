/**
 * The Merrymen MCP endpoint (Streamable HTTP). Outside /api on purpose: the
 * /api middleware refuses cross-site browser requests, and MCP clients are
 * not browsers. This route does its own Host, Origin and bearer checks
 * (web/src/mcp/http.ts) and answers 404 unless hosted MCP is enabled.
 */
import { handleMcpRequest } from "@/mcp/http";
import { mcpConfig } from "@/mcp/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = (req: Request) => handleMcpRequest(req);
export const GET = (req: Request) => handleMcpRequest(req);
export const DELETE = (req: Request) => handleMcpRequest(req);

export function OPTIONS(req: Request): Response {
  const cfg = mcpConfig();
  if (!cfg.enabled) return new Response(null, { status: 404 });
  const origin = req.headers.get("origin");
  // CORS only for configured origins; everyone else gets no CORS headers.
  if (!origin || !cfg.allowedOrigins.has(origin)) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID",
      "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, X-Trace-Id",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}
