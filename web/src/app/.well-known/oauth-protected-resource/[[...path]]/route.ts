/**
 * RFC 9728 protected-resource metadata, at both the root well-known URL and
 * the path-inserted one (/.well-known/oauth-protected-resource/mcp), which is
 * what MCP clients try first; and the directory profile's own document at
 * /.well-known/oauth-protected-resource/mcp/directory.
 */
import { mcpConfig, resourcePath } from "@/mcp/config";
import { discoveryResponse, protectedResourceMetadata } from "@/mcp/oauth/metadata";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, context: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const cfg = mcpConfig();
  if (!cfg.enabled) return new Response("Not found", { status: 404 });
  const { path } = await context.params;
  const suffix = path?.length ? `/${path.join("/")}` : "";
  // Root (the canonical resource, unchanged), exactly the resource's own
  // path, or the directory profile's (/mcp/directory, its own resource with
  // its own scopes). Anything else is not a resource here.
  if (!suffix || suffix === resourcePath(cfg)) return discoveryResponse(protectedResourceMetadata(cfg));
  if (cfg.directoryResource && suffix === resourcePath(cfg, "directory")) return discoveryResponse(protectedResourceMetadata(cfg, "directory"));
  return new Response("Not found", { status: 404 });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "MCP-Protocol-Version" } });
}
