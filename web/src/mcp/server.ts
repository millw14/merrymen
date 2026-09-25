/**
 * Builds the MCP server a request is answered by.
 *
 * One McpServer instance per request (the SDK's stateless model), built from
 * the authenticated principal: only tools the connection holds a scope for are
 * listed, staff tools only for staff. Listing is a convenience — every call is
 * re-checked by the policy inside runTool, so a client that calls an unlisted
 * tool by name gets `insufficient_scope`, not the tool.
 */
import { McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { hasCapability } from "./policy";
import type { Principal } from "./oauth/server";
import { runTool, type RunDeps, type ToolDef } from "./tool";
import { registerResources, type ResourceDef } from "./resources";
import { registerPrompts } from "./prompts";
import { SERVER_INSTRUCTIONS, SERVER_VERSION } from "./instructions";
import { ALL_TOOLS } from "./tools";
import { ALL_RESOURCES } from "./resources-catalog";
import { traceId as newTraceId } from "./observe";

export function principalOf(authInfo: AuthInfo | undefined): Principal | null {
  const p = authInfo?.extra?.principal as Principal | undefined;
  return p && typeof p.tenant === "string" ? p : null;
}

export function buildServer(principal: Principal | null, opts: { tools?: readonly ToolDef[]; resources?: readonly ResourceDef[]; deps?: RunDeps; trace?: string } = {}): McpServer {
  const server = new McpServer(
    { name: "merrymen", title: "Merrymen", version: SERVER_VERSION, websiteUrl: "https://merrymen.dev" },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  if (!principal) return server;
  const trace = opts.trace ?? newTraceId();
  for (const def of opts.tools ?? ALL_TOOLS) {
    const usable = def.anyOf?.length ? def.anyOf.some((c) => hasCapability(principal, c)) : hasCapability(principal, def.capability);
    if (!usable) continue;
    server.registerTool(def.name, {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      outputSchema: def.output,
      annotations: { title: def.title, ...def.annotations },
      ...(def.meta ? { _meta: def.meta } : {}),
    }, async (args: unknown) => runTool(def, args, principal, trace, opts.deps) as never);
  }
  registerResources(server, principal, opts.resources ?? ALL_RESOURCES, trace, opts.deps);
  registerPrompts(server, principal);
  return server;
}
