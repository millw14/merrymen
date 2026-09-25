/**
 * MCP resources: the same data as the read tools, addressable by URI so a
 * client can attach it as context (agent snapshots, decision records, reports,
 * and the capability/metric documentation).
 *
 * Every read goes through the same policy as a tool call: the capability is
 * checked, and an object that belongs to another owner (or is not shared with
 * this connection) reads as not found. A resource URI is a name, not a
 * capability: holding `merrymen://exports/exp_…` grants nothing by itself.
 */
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { McpError, asMcpError } from "./errors";
import { logEvent, pseudonym, rateHit, recordToolCall, writeAudit } from "./observe";
import { hasCapability, requireCapability } from "./policy";
import type { Capability } from "./scopes";
import type { Principal } from "./oauth/server";
import { makeContext, type RunDeps, type ToolContext } from "./tool";

const RESOURCE_READS_PER_MINUTE = 60;

export interface ResourceContent {
  text: string;
  mimeType: string;
}

export interface ResourceListing {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceDef {
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** Null: any authenticated connection may read it (documentation). */
  capability: Capability | null;
  /** A fixed URI, or a URI template with {variables}. */
  uri: string;
  /** For templates: the concrete resources this connection can read. */
  list?: (ctx: ToolContext) => Promise<ResourceListing[]>;
  read(uri: URL, vars: Record<string, string>, ctx: ToolContext): Promise<ResourceContent>;
  /** Protocol `_meta` (e.g. an MCP Apps view's CSP), on the list entry and the read content. Never authority. */
  meta?: Readonly<Record<string, unknown>>;
}

const isTemplate = (uri: string) => /\{[a-z_]+\}/i.test(uri);

async function runRead(def: ResourceDef, uri: URL, vars: Record<string, string>, p: Principal, trace: string, deps: RunDeps = {}) {
  const started = Date.now();
  let outcome = "ok";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new McpError("timeout")), 15_000);
  const ctx = makeContext(p, trace, controller.signal, deps);
  try {
    if (def.capability) requireCapability(p, def.capability);
    // Resource reads share the per-connection budget of a tool call: some
    // (exports, portfolio snapshots) are as costly as the matching tool.
    const v = await rateHit(await ctx.mcp(), `resource:${p.connectionId}:m`, 60, RESOURCE_READS_PER_MINUTE, ctx.now());
    if (!v.ok) throw new McpError("rate_limited", "Too many resource reads; slow down.", { retryAfterSec: v.retryAfterSec });
    const c = await def.read(uri, vars, ctx);
    return { contents: [{ uri: uri.href, mimeType: c.mimeType, text: c.text, ...(def.meta ? { _meta: def.meta } : {}) }] };
  } catch (error) {
    const e = asMcpError(error);
    outcome = e.code;
    // Resource reads have no isError channel; the SDK turns a throw into a JSON-RPC error.
    throw new Error(`${e.code}: ${e.message}`);
  } finally {
    clearTimeout(timer);
    const ms = Date.now() - started;
    recordToolCall(`resource:${def.name}`, outcome, ms);
    logEvent("resource", { resource: def.name, outcome, ms, trace, tenant: pseudonym(p.tenant) });
    try {
      await writeAudit(await ctx.mcp(), { action: `resource:${def.name}`, outcome, tenant: p.tenant, connectionId: p.connectionId, clientId: p.clientId, capability: def.capability, latencyMs: ms, traceId: trace, detail: vars });
    } catch {
      /* audit is best effort for reads */
    }
  }
}

export function registerResources(server: McpServer, p: Principal, defs: readonly ResourceDef[], trace: string, deps?: RunDeps): void {
  for (const def of defs) {
    if (def.capability && !hasCapability(p, def.capability)) continue;
    const meta = { title: def.title, description: def.description, mimeType: def.mimeType, ...(def.meta ? { _meta: def.meta } : {}) };
    if (!isTemplate(def.uri)) {
      server.registerResource(def.name, def.uri, meta, async (uri: URL) => runRead(def, uri, {}, p, trace, deps));
      continue;
    }
    const template = new ResourceTemplate(def.uri, {
      list: def.list
        ? async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          try {
            return { resources: await def.list!(makeContext(p, trace, controller.signal, deps)) };
          } catch {
            return { resources: [] };
          } finally {
            clearTimeout(timer);
          }
        }
        : undefined,
    });
    server.registerResource(def.name, template, meta, async (uri: URL, vars: Record<string, string | string[]>) => {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) flat[k] = Array.isArray(v) ? v[0] ?? "" : v;
      return runRead(def, uri, flat, p, trace, deps);
    });
  }
}
