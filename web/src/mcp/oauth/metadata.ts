/**
 * Discovery documents:
 * - RFC 9728 protected-resource metadata for the MCP endpoint, which names the
 *   authorization server;
 * - RFC 8414 authorization-server metadata.
 *
 * Claude uses Client ID Metadata Documents only when the server advertises
 * BOTH `client_id_metadata_document_supported: true` and "none" among the
 * token endpoint auth methods; otherwise it falls back to dynamic
 * registration. Both are advertised.
 */
import { protectedResourceMetadataUrl, resourceFor, type McpConfig } from "../config";
import { ADVERTISED_SCOPES, advertisedScopesFor, type McpProfile } from "../scopes";

export function authorizationServerMetadata(cfg: McpConfig): Record<string, unknown> {
  const i = cfg.issuer;
  return {
    issuer: i,
    authorization_endpoint: `${i}/oauth/authorize`,
    token_endpoint: `${i}/oauth/token`,
    registration_endpoint: `${i}/oauth/register`,
    revocation_endpoint: `${i}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...ADVERTISED_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${i}/connect/mcp`,
  };
}

/**
 * One document per resource. The directory profile's names its own URL and
 * only the scopes it can grant, so a client that discovers it never asks for a
 * sensitive scope (and could not be granted one if it did: oauth/server.ts).
 */
export function protectedResourceMetadata(cfg: McpConfig, profile: McpProfile = "full"): Record<string, unknown> {
  return {
    resource: resourceFor(cfg, profile),
    authorization_servers: [cfg.issuer],
    scopes_supported: [...advertisedScopesFor(profile)],
    bearer_methods_supported: ["header"],
    resource_name: "Merrymen",
    resource_documentation: `${cfg.issuer}/connect/mcp`,
  };
}

/**
 * The 401 challenge that sends a client to discovery (RFC 9728 §5.1, RFC 6750 §3).
 *
 * Its `scope` is every scope a client may be granted (`scopes_supported`, never
 * the staff scope), not a narrow default. MCP clients request exactly the
 * challenge's scope (Claude Code and the SDK clients use it before
 * `scopes_supported`), and the consent page can offer only what was requested:
 * a read-only challenge would mean no OAuth client could EVER be granted a
 * write scope, however the owner answered. Asking for everything grants
 * nothing by itself: the owner ticks what the app gets, and the sensitive
 * scopes (trade:propose, drafts:write, social:write) start unticked.
 * DEFAULT_REQUEST_SCOPES remains only what an /oauth/authorize request with
 * no `scope` at all is treated as asking for (parseScopeParam).
 *
 * On the directory profile both halves are its own: its metadata document,
 * and only the scopes it can grant (never a sensitive one).
 */
export function bearerChallenge(cfg: McpConfig, opts: { error?: "invalid_token" | "insufficient_scope"; description?: string; scope?: readonly string[]; profile?: McpProfile } = {}): string {
  const profile = opts.profile ?? "full";
  const parts = [`resource_metadata="${protectedResourceMetadataUrl(cfg, profile)}"`];
  parts.push(`scope="${(opts.scope ?? advertisedScopesFor(profile)).join(" ")}"`);
  if (opts.error) parts.push(`error="${opts.error}"`);
  if (opts.description) parts.push(`error_description="${opts.description.replace(/["\\]/g, "")}"`);
  return `Bearer ${parts.join(", ")}`;
}

export const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...NO_STORE, ...headers },
  });
}

/** Public discovery JSON may be read cross-origin by browser-based MCP inspectors. */
export function discoveryResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
