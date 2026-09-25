/**
 * Builds the MCP server a request is answered by.
 *
 * One McpServer instance per request (the SDK's stateless model), built from
 * the authenticated principal: only tools the connection holds a scope for are
 * registered, staff tools only for staff. A client that calls an unregistered
 * tool by name gets the SDK's JSON-RPC error -32602 "Tool … not found" (not
 * `insufficient_scope`, and never the tool). runTool still re-checks the
 * policy on every call, so a registration mistake cannot widen access.
 *
 * The lists are fixed for the life of a request and nothing here can push a
 * notification (stateless, no GET stream), so tools, resources and prompts
 * declare `listChanged: false`: a client must not wait for a list_changed that
 * never comes. A client sees a changed grant on its next tools/list.
 */
import { McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { hasCapability } from "./policy";
import { mcpConfig } from "./config";
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
  const issuer = mcpConfig().issuer;
  const server = new McpServer(
    {
      name: "merrymen", title: "Merrymen", version: SERVER_VERSION, websiteUrl: "https://merrymen.dev",
      // The current mark (the redesigned terminal's LogoMark), served by the web app.
      ...(issuer ? { icons: [{ src: `${issuer}/mcp-icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] }] } : {}),
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      // Explicit: the SDK fills a missing listChanged with true.
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
    },
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
