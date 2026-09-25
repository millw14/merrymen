/** RFC 7009 token revocation, for clients disconnecting themselves. */
import { mcpConfig } from "@/mcp/config";
import { PUBLIC_CORS, ipLimited, oauthDeps, preflight, readForm } from "@/mcp/oauth/deps";
import { jsonResponse } from "@/mcp/oauth/metadata";
import { logEvent } from "@/mcp/observe";
import { OAuthError, authenticateClient, revokeToken } from "@/mcp/oauth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (!mcpConfig().enabled) return new Response("Not found", { status: 404 });
  const deps = await oauthDeps();
  const limited = await ipLimited(deps, req, "revoke", 60, 60);
  if (limited) return limited;
  const form = await readForm(req);
  if (!form) return jsonResponse({ error: "invalid_request" }, 400, PUBLIC_CORS);
  try {
    const client = await authenticateClient(deps, form, req.headers.get("authorization"));
    await revokeToken(deps, form, client);
    return new Response(null, { status: 200, headers: { ...PUBLIC_CORS, "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof OAuthError) return jsonResponse(error.body(), error.status, PUBLIC_CORS);
    logEvent("revoke_failed", { error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown" });
    return jsonResponse({ error: "server_error" }, 500, PUBLIC_CORS);
  }
}

export const OPTIONS = preflight;
