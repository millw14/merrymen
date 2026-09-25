/**
 * MCP readiness. Public and data-free: whether the server is enabled, whether
 * its database answers, and the version. 503 (with Retry-After) when not ready,
 * so a load balancer or client backs off instead of hammering.
 */
import { mcpConfig } from "@/mcp/config";
import { mcpDb } from "@/mcp/db";
import { SERVER_VERSION } from "@/mcp/instructions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const cfg = mcpConfig();
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (!cfg.enabled) return new Response(JSON.stringify({ ready: false, enabled: false, why: cfg.disabledWhy }), { status: 503, headers: { ...headers, "Retry-After": "300" } });
  const started = Date.now();
  try {
    const d = await mcpDb();
    await Promise.race([
      d.db.prepare("SELECT 1 AS ok").get(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    return new Response(JSON.stringify({
      ready: true, enabled: true, version: SERVER_VERSION, endpoint: cfg.resource, issuer: cfg.issuer,
      db_ms: Date.now() - started, commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? "").slice(0, 12) || null,
    }), { status: 200, headers });
  } catch {
    return new Response(JSON.stringify({ ready: false, enabled: true, why: "database unavailable" }), { status: 503, headers: { ...headers, "Retry-After": "15" } });
  }
}
