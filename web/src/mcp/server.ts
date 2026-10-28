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
import { DIRECTORY_INSTRUCTIONS, SERVER_INSTRUCTIONS, SERVER_VERSION } from "./instructions";
import { capabilityAllowedIn, scopeAllowedIn, scopeFor, type Capability, type McpProfile } from "./scopes";
import { ALL_TOOLS } from "./tools";
import { hostedFomoEnabled } from "@/lib/fomo-switch";
import { ALL_RESOURCES } from "./resources-catalog";
import { traceId as newTraceId } from "./observe";

export function principalOf(authInfo: AuthInfo | undefined): Principal | null {
  const p = authInfo?.extra?.principal as Principal | undefined;
  return p && typeof p.tenant === "string" ? p : null;
}

/** Every capability a tool can be reached with (its own, and each of anyOf). */
function toolCapabilities(def: ToolDef): Capability[] {
  return [def.capability, ...(def.anyOf ?? [])];
}

/** MCP clients must receive all three safety hints on every listed tool. */
function servedAnnotations(def: ToolDef) {
  // Widen for the runtime check: a JS caller can bypass ToolAnnotations.
  const { readOnlyHint, openWorldHint, destructiveHint } = def.annotations as { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint?: boolean };
  if (typeof readOnlyHint !== "boolean" || typeof openWorldHint !== "boolean" || (!readOnlyHint && typeof destructiveHint !== "boolean") || (readOnlyHint && destructiveHint !== undefined && destructiveHint !== false)) {
    throw new Error(`${def.name}: invalid MCP tool safety annotations`);
  }
  // A read-only tool is non-destructive. Writes must classify themselves;
  // never let a missing destructiveHint on a write become false by default.
  return { title: def.title, ...def.annotations, destructiveHint: readOnlyHint ? false : destructiveHint };
}

/**
 * Whether a tool may exist at all on a profile, whatever the connection holds:
 * on the directory profile a tool reachable with ANY capability outside it
 * (quote_trade, propose_*, create_agent_draft, draft_post, follow_agent, the
 * proposal tools) is not registered. A read-only tool may explicitly declare
 * a narrower, validated set of alternatives for this profile.
 */
export function toolInProfile(def: ToolDef, profile: McpProfile): boolean {
  if (profile === "directory" && def.directoryAnyOf !== undefined) {
    if (!def.annotations.readOnlyHint || !def.anyOf?.length || !def.directoryAnyOf.length
      || !def.directoryAnyOf.every(c => def.anyOf!.includes(c))) return false;
    return [def.capability, ...def.directoryAnyOf].every(c => capabilityAllowedIn(profile, c));
  }
  return toolCapabilities(def).every((c) => capabilityAllowedIn(profile, c));
}

/**
 * Whether a resource may exist at all on a profile: its capability must be
 * allowed there, and a resource that serves only tools outside the profile
 * (profileAnyOf, e.g. the proposal view) is not listed either.
 */
export function resourceInProfile(def: ResourceDef, profile: McpProfile): boolean {
  if (def.capability && !capabilityAllowedIn(profile, def.capability)) return false;
  return !def.profileAnyOf?.length || def.profileAnyOf.some((c) => capabilityAllowedIn(profile, c));
}

/**
 * Builds the server for one request. `profile` is the endpoint the request
 * arrived at (the directory route passes "directory"); the principal is
 * narrowed to it before anything is registered, so tools, resources, prompts
 * and every later per-call check (runTool, resource reads) see the directory
 * limit even if a token somehow carried a scope outside it.
 */
export function buildServer(principal: Principal | null, opts: { tools?: readonly ToolDef[]; resources?: readonly ResourceDef[]; deps?: RunDeps; trace?: string; profile?: McpProfile } = {}): McpServer {
  const profile: McpProfile = opts.profile === "directory" || principal?.profile === "directory" ? "directory" : "full";
  if (principal && profile === "directory") {
    principal = { ...principal, profile, scopes: new Set([...principal.scopes].filter((s) => scopeAllowedIn(profile, s))) };
  }
  const issuer = mcpConfig().issuer;
  const server = new McpServer(
    {
      name: "merrymen", title: "Merrymen", version: SERVER_VERSION, websiteUrl: "https://merrymen.dev",
      description: "Your Merrymen trading agent, portfolio, trade receipts and decisions.",
      // Current connector assets; PNG also works in hosts that do not display SVG.
      ...(issuer ? { icons: [
        { src: `${issuer}/mcp-icon-512.png`, mimeType: "image/png", sizes: ["512x512"] },
        { src: `${issuer}/mcp-icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
      ] } : {}),
    },
    {
      instructions: profile === "directory" ? DIRECTORY_INSTRUCTIONS : SERVER_INSTRUCTIONS,
      // Explicit: the SDK fills a missing listChanged with true.
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
    },
  );
  if (!principal) return server;
  const p: Principal = principal;
  const trace = opts.trace ?? newTraceId();
  // Fomo research is opt-in per deployment (fomo-runtime.ts hostedFomoEnabled):
  // off, its tools are not listed at all rather than listed and refusing.
  const fomoOn = hostedFomoEnabled();
  for (const def of opts.tools ?? ALL_TOOLS) {
    if (!toolInProfile(def, profile)) continue;
    if (!fomoOn && def.name.startsWith("fomo_")) continue;
    const alternatives = profile === "directory" && def.directoryAnyOf ? def.directoryAnyOf : def.anyOf?.length ? def.anyOf : [def.capability];
    const usable = alternatives.some((c) => hasCapability(p, c));
    if (!usable) continue;
    server.registerTool(def.name, {
      title: def.title,
      // The directory profile's copy has its pointers to other tools cut (withToolRefs).
      description: profile === "directory" ? def.directoryDescription ?? def.description : def.description,
      inputSchema: def.input,
      outputSchema: def.output,
      annotations: servedAnnotations(def),
      // The pinned MCP SDK preserves _meta, but does not forward a top-level
      // securitySchemes property. ChatGPT supports this documented mirror.
      // Each scheme is an alternative: anyOf never requires every scope.
      _meta: { ...def.meta, securitySchemes: [...new Set(alternatives.map(scopeFor))]
        .map(scope => ({ type: "oauth2", scopes: [scope] })) },
    }, async (args: unknown) => runTool(def, args, p, trace, opts.deps) as never);
  }
  const resources = (opts.resources ?? ALL_RESOURCES).filter((r) => resourceInProfile(r, profile));
  registerResources(server, p, resources, trace, opts.deps);
  registerPrompts(server, p);
  return server;
}
