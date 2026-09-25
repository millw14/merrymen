/**
 * Connected apps, for the owner: list the MCP connections that can reach
 * their Merrymen, see what each may do and what it did recently, revoke any of
 * them, and create or revoke personal access tokens. Session-only; every
 * statement is scoped to the signed-in tenant.
 */
import { tenantOf } from "@/lib/auth";
import { mcpConfig } from "@/mcp/config";
import { mcpDb } from "@/mcp/db";
import { agentDirectory } from "@/mcp/agents";
import { jsonResponse } from "@/mcp/oauth/metadata";
import { OAuthError, createPersonalToken, listConnections, revokeConnection } from "@/mcp/oauth/server";
import { scopeInfo, SCOPES } from "@/mcp/scopes";
import { writeAudit } from "@/mcp/observe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const cfg = mcpConfig();
  if (!cfg.enabled) return jsonResponse({ enabled: false, why: cfg.disabledWhy }, 404);
  const tenant = tenantOf(req);
  if (!tenant) return jsonResponse({ error: "login_required" }, 401);
  const d = await mcpDb();
  const connections = await listConnections(d, tenant);
  const ids = connections.map((c) => c.id);
  const recent = ids.length
    ? await d.db.prepare(`SELECT connection_id, action, outcome, at FROM mcp_audit WHERE tenant = ? AND at > ? ORDER BY at DESC LIMIT 200`)
      .all(tenant, Math.floor(Date.now() / 1000) - 30 * 86_400) as Array<{ connection_id: string | null; action: string; outcome: string; at: number }>
    : [];
  const agents = await agentDirectory().agentsFor(tenant);
  const staff = cfg.staffTenants.has(tenant);
  return jsonResponse({
    endpoint: cfg.resource,
    connections: connections.map((c) => ({
      ...c,
      scopes: c.scopes.map((s) => ({ id: s, title: scopeInfo(s)?.title ?? s, level: scopeInfo(s)?.level ?? "read" })),
      recent: recent.filter((r) => r.connection_id === c.id).slice(0, 12).map((r) => ({ action: r.action, outcome: r.outcome, at: r.at })),
    })),
    agents: agents.map((a) => ({ slug: a.slug, account: a.account })),
    available_scopes: SCOPES.filter((s) => s.id !== "offline_access" && (s.level !== "staff" || staff)).map((s) => ({ id: s.id, title: s.title, detail: s.detail, level: s.level, needsAgent: s.needsAgent })),
  });
}

export async function POST(req: Request): Promise<Response> {
  const cfg = mcpConfig();
  if (!cfg.enabled) return jsonResponse({ error: "not_found" }, 404);
  if (req.headers.get("origin") !== cfg.issuer) return jsonResponse({ error: "forbidden", error_description: "cross-site request" }, 403);
  const tenant = tenantOf(req);
  if (!tenant) return jsonResponse({ error: "login_required" }, 401);
  const text = await req.text();
  if (text.length > 8 * 1024) return jsonResponse({ error: "invalid_request" }, 400);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  const d = await mcpDb();
  const now = Math.floor(Date.now() / 1000);
  try {
    if (body.action === "revoke") {
      if (typeof body.id !== "string" || !/^mcpcon_[0-9a-f]{32}$/.test(body.id)) return jsonResponse({ error: "invalid_request" }, 400);
      const ok = await revokeConnection(d, tenant, body.id, now, "owner");
      await writeAudit(d, { action: "owner.revoke_connection", outcome: ok ? "ok" : "not_found", tenant, connectionId: body.id });
      return ok ? jsonResponse({ revoked: true }) : jsonResponse({ error: "not_found" }, 404);
    }
    if (body.action === "create_token") {
      const owned = (await agentDirectory().agentsFor(tenant)).map((a) => a.slug);
      const out = await createPersonalToken(d, cfg, tenant, { label: body.label, scopes: body.scopes, agentSlugs: body.agents, days: body.days }, owned, now);
      await writeAudit(d, { action: "owner.create_personal_token", outcome: "ok", tenant, connectionId: out.connectionId, detail: { scopes: out.scopes.join(" ") } });
      // Shown once. Only its hash is stored.
      return jsonResponse({ token: out.token, connection_id: out.connectionId, expires_at: out.expiresAt, scopes: out.scopes, endpoint: cfg.resource });
    }
    return jsonResponse({ error: "invalid_request", error_description: "unknown action" }, 400);
  } catch (error) {
    if (error instanceof OAuthError) return jsonResponse(error.body(), error.status);
    return jsonResponse({ error: "server_error" }, 500);
  }
}
