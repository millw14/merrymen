/** OAuth token endpoint: authorization_code (with PKCE) and refresh_token grants. */
import { mcpConfig } from "@/mcp/config";
import { PUBLIC_CORS, ipLimited, oauthDeps, preflight, readForm } from "@/mcp/oauth/deps";
import { jsonResponse } from "@/mcp/oauth/metadata";
import { OAuthError, authenticateClient, exchangeCode, refreshTokens } from "@/mcp/oauth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (!mcpConfig().enabled) return new Response("Not found", { status: 404 });
  const deps = await oauthDeps();
  const limited = await ipLimited(deps, req, "token", 60, 120);
  if (limited) return limited;
  const form = await readForm(req);
  if (!form) return jsonResponse({ error: "invalid_request", error_description: "malformed or oversized body" }, 400, PUBLIC_CORS);
  try {
    const client = await authenticateClient(deps, form, req.headers.get("authorization"));
    const grant = form.get("grant_type");
    const tokens = grant === "authorization_code" ? await exchangeCode(deps, form, client)
      : grant === "refresh_token" ? await refreshTokens(deps, form, client)
        : null;
    if (!tokens) return jsonResponse({ error: "unsupported_grant_type", error_description: "use authorization_code or refresh_token" }, 400, PUBLIC_CORS);
    return jsonResponse(tokens, 200, PUBLIC_CORS);
  } catch (error) {
    if (error instanceof OAuthError) {
      const headers: Record<string, string> = { ...PUBLIC_CORS };
      if (error.status === 401) headers["WWW-Authenticate"] = 'Basic realm="merrymen"';
      return jsonResponse(error.body(), error.status, headers);
    }
    return jsonResponse({ error: "server_error", error_description: "unexpected error; retry" }, 500, PUBLIC_CORS);
  }
}

export const OPTIONS = preflight;
