/**
 * MCP readiness (/api/mcp/health). Public and data-free: whether the server is
 * enabled, whether its database answers, the version, and the two addresses it
 * serves: the canonical endpoint and the directory profile's (or why that one
 * is off), so an operator can see a misconfigured
 * MERRYMEN_MCP_DIRECTORY_RESOURCE_URL without reading logs. 503 (with
 * Retry-After) when not ready, so a load balancer or client backs off instead
 * of hammering.
 */
import { mcpConfig, type McpConfig } from "./config";
import { mcpDb, type McpDb } from "./db";
import { SERVER_VERSION } from "./instructions";

export interface DirectoryHealth {
  /** The directory profile's resource URL, or null when it is off. */
  endpoint: string | null;
  /** Why it is off; null while it is on. Names the variable to fix, never its value. */
  why: string | null;
}

/**
 * The directory profile as configured. config.ts turns every unusable setting
 * into "" (off); this says which setting did it.
 */
export function directoryHealth(cfg: McpConfig, env: NodeJS.ProcessEnv = process.env): DirectoryHealth {
  if (cfg.directoryResource) return { endpoint: cfg.directoryResource, why: null };
  if (env.MERRYMEN_MCP_DIRECTORY === "0") return { endpoint: null, why: "switched off (MERRYMEN_MCP_DIRECTORY=0)" };
  if (!cfg.resource) return { endpoint: null, why: "no canonical endpoint to derive it from (MERRYMEN_MCP_RESOURCE_URL)" };
  return { endpoint: null, why: "MERRYMEN_MCP_DIRECTORY_RESOURCE_URL is not usable: it must be an https URL (http only for localhost) with no query, fragment or credentials, and a path other than the canonical endpoint's" };
}

export interface HealthDeps {
  cfg?: McpConfig;
  env?: NodeJS.ProcessEnv;
  mcp?: () => Promise<McpDb>;
  timeoutMs?: number;
}

export async function mcpHealth(deps: HealthDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const cfg = deps.cfg ?? mcpConfig(env);
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (!cfg.enabled) return new Response(JSON.stringify({ ready: false, enabled: false, why: cfg.disabledWhy }), { status: 503, headers: { ...headers, "Retry-After": "300" } });
  const directory = directoryHealth(cfg, env);
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const d = await (deps.mcp ?? mcpDb)();
    await Promise.race([
      d.db.prepare("SELECT 1 AS ok").get(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), deps.timeoutMs ?? 3000); }),
    ]);
    return new Response(JSON.stringify({
      ready: true, enabled: true, version: SERVER_VERSION, endpoint: cfg.resource, directory, issuer: cfg.issuer,
      db_ms: Date.now() - started, commit: (env.RAILWAY_GIT_COMMIT_SHA ?? "").slice(0, 12) || null,
    }), { status: 200, headers });
  } catch {
    return new Response(JSON.stringify({ ready: false, enabled: true, why: "database unavailable", directory }), { status: 503, headers: { ...headers, "Retry-After": "15" } });
  } finally {
    clearTimeout(timer);
  }
}
