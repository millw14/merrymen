/**
 * The consent page's server half. `describe` works signed out (it shows who is
 * asking, never anything about an owner); `decide` requires the owner's own
 * Merrymen session and a same-origin request, so another site cannot approve a
 * connection on an owner's behalf (the /api middleware also refuses
 * cross-site Sec-Fetch-Site, and the consent request id is a single-use
 * 256-bit secret that only ever travelled in a URL fragment).
 */
import { tenantOf } from "@/lib/auth";
import { mcpConfig } from "@/mcp/config";
import { oauthDeps } from "@/mcp/oauth/deps";
import { jsonResponse } from "@/mcp/oauth/metadata";
import { OAuthError, decideRequest, describeRequest } from "@/mcp/oauth/server";
import { ClientError } from "@/mcp/oauth/clients";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX = 8 * 1024;

export async function POST(req: Request): Promise<Response> {
  const cfg = mcpConfig();
  if (!cfg.enabled) return jsonResponse({ error: "not_found" }, 404);
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== cfg.issuer) return jsonResponse({ error: "forbidden", error_description: "cross-site request" }, 403);
  const text = await req.text();
  if (text.length > MAX) return jsonResponse({ error: "invalid_request" }, 400);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  const tenant = tenantOf(req);
  const deps = await oauthDeps();
  try {
    if (body.action === "describe") {
      return jsonResponse(await describeRequest(deps, body.request, tenant));
    }
    if (body.action === "decide") {
      if (!tenant) return jsonResponse({ error: "login_required", error_description: "Sign in to Merrymen first." }, 401);
      if (origin !== cfg.issuer) return jsonResponse({ error: "forbidden", error_description: "cross-site request" }, 403);
      const out = await decideRequest(deps, body.request, tenant, { approve: body.approve === true, scopes: body.scopes, agentSlugs: body.agents });
      return jsonResponse({ redirect: out.location });
    }
    return jsonResponse({ error: "invalid_request", error_description: "unknown action" }, 400);
  } catch (error) {
    if (error instanceof OAuthError) return jsonResponse(error.body(), error.status);
    if (error instanceof ClientError) return jsonResponse({ error: error.code, error_description: error.message }, error.code === "temporarily_unavailable" ? 503 : 400);
    return jsonResponse({ error: "server_error", error_description: "Something went wrong. Try again." }, 500);
  }
}
