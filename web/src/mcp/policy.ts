/**
 * The server-side authorization policy for MCP.
 *
 * Two questions, asked on EVERY tool call and resource read, independent of
 * which tools were listed to the client:
 *
 * 1. May this connection use this capability? The connection's scopes (the
 *    intersection of what the token carries and what the owner currently
 *    consents to) must include the scope that grants it. Staff diagnostics
 *    additionally require the owner to be on the staff allowlist right now.
 * 2. May it touch this object? An agent is reachable only if the owner shared
 *    it with this connection AND the owner still owns it according to the
 *    identity store at the moment of the call. A slug, address or id supplied
 *    by the client is a name to look up, never proof of anything. An object
 *    that exists but is not reachable is reported as `not_found`, so a client
 *    cannot probe which agents or ids exist.
 */
import { McpError } from "./errors";
import { capabilityAllowedIn, scopeFor, type Capability } from "./scopes";
import type { AgentDirectory, OwnedAgent } from "./agents";
import type { Principal } from "./oauth/server";

export function hasCapability(p: Principal, capability: Capability): boolean {
  if (capability === "staff.diagnostics" && !p.staff) return false;
  // A connection through the directory listing never reaches a capability
  // outside it, even holding the scope (it cannot be granted one: this is the
  // last of several independent checks).
  if (!capabilityAllowedIn(p.profile ?? "full", capability)) return false;
  return p.scopes.has(scopeFor(capability));
}

export function requireCapability(p: Principal, capability: Capability): void {
  if (!capabilityAllowedIn(p.profile ?? "full", capability)) {
    // No reconnect can fix this one: the directory listing never offers it.
    throw new McpError("insufficient_scope", `This connection was made through the Merrymen directory listing, which cannot be granted "${scopeFor(capability)}". The owner can add the full Merrymen server as a custom connector to use it.`, {
      details: { required_scope: scopeFor(capability) },
    });
  }
  if (!hasCapability(p, capability)) {
    // The recovery named here must actually work: a client holding a live token
    // never re-asks by itself, so the owner disconnects it on Connected apps,
    // and its next sign-in asks for every scope (the 401 challenge's scope, see
    // bearerChallenge), where the owner ticks this one.
    throw new McpError("insufficient_scope", `This connection was not granted "${scopeFor(capability)}". To allow it, the owner can disconnect this app on Merrymen's Connected apps page, connect it again and tick that permission on the Merrymen consent page, or use a personal access token that includes it.`, {
      details: { required_scope: scopeFor(capability) },
    });
  }
}

const SLUG = /^[0-9a-hjkmnp-tv-z]{16}$/;

/**
 * The agent a tool call is about. `ref` is the agent's public slug; when
 * omitted and exactly one agent is shared with this connection, that one.
 */
export async function resolveOwnedAgent(p: Principal, ref: string | undefined, directory: AgentDirectory): Promise<OwnedAgent> {
  if (ref !== undefined && !SLUG.test(ref)) throw new McpError("invalid_input", "agent must be an agent id (16 characters) from list_agents");
  if (!p.agentSlugs.length) {
    throw new McpError("forbidden", "No agent is shared with this connection. The owner can reconnect the app and choose which agent it may see.");
  }
  const slug = ref ?? (p.agentSlugs.length === 1 ? p.agentSlugs[0] : undefined);
  if (!slug) throw new McpError("invalid_input", "Several agents are shared with this connection; pass `agent` (see list_agents).");
  if (!p.agentSlugs.includes(slug)) throw new McpError("not_found", "No such agent is shared with this connection.");
  const owned = await directory.agentsFor(p.tenant);
  const agent = owned.find((a) => a.slug === slug);
  // Shared once but no longer the owner's (or the identity is gone): not reachable.
  if (!agent) throw new McpError("not_found", "No such agent is shared with this connection.");
  return agent;
}

/** All agents this connection may see that the owner still owns. */
export async function reachableAgents(p: Principal, directory: AgentDirectory): Promise<OwnedAgent[]> {
  if (!p.agentSlugs.length) return [];
  const owned = await directory.agentsFor(p.tenant);
  return owned.filter((a) => p.agentSlugs.includes(a.slug));
}

/** An object row carries its owner's tenant; anything else is not_found. */
export function requireOwner(p: Principal, rowTenant: string | null | undefined, what = "object"): void {
  if (!rowTenant || rowTenant.toLowerCase() !== p.tenant) throw new McpError("not_found", `No such ${what}.`);
}
