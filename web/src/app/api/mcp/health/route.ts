/**
 * MCP readiness. Public and data-free: whether the server is enabled, whether
 * its database answers, the version, and the canonical and directory
 * endpoints (mcp/health.ts). 503 (with Retry-After) when not ready, so a load
 * balancer or client backs off instead of hammering.
 */
import { mcpHealth } from "@/mcp/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return mcpHealth();
}
