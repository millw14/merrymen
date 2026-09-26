/**
 * Where the MCP server lives and how long its credentials last.
 *
 * Every URL here comes from configuration, never from the request's Host
 * header: the OAuth issuer and the resource URL are what access tokens are
 * bound to, and a Host-derived value would let whoever controls a proxy header
 * mint tokens for a different audience. With no configured origin the server
 * is simply off (fail closed), which is also the state of every self-hosted
 * install: MCP is a hosted feature, because a self-hosted dashboard has no
 * login and "whoever reaches localhost" is not a principal we can delegate.
 */
import { isHostedMode } from "@merrymen/core";
import type { McpProfile } from "./scopes";

export type { McpProfile } from "./scopes";

export interface McpConfig {
  /** Hosted, backed by shared Postgres, not switched off, and an issuer is configured. */
  enabled: boolean;
  /** Why it is off, for the health route and logs. Null when enabled. */
  disabledWhy: string | null;
  /** OAuth issuer, e.g. https://app.merrymen.dev (no trailing slash). */
  issuer: string;
  /**
   * Canonical MCP resource URL, e.g. https://mcp.merrymen.dev/mcp (production,
   * MERRYMEN_MCP_RESOURCE_URL). Tokens are bound to exactly this. Always at
   * CANONICAL_ROUTE_PATH; "" (and MCP off) when the configured URL is not
   * usable or names any other path.
   */
  resource: string;
  /**
   * The directory profile's resource URL, e.g. https://mcp.merrymen.dev/mcp/directory:
   * the same server with the sensitive scopes impossible to grant (scopes.ts,
   * DIRECTORY_SCOPES), for Anthropic's connector directory. Tokens are bound
   * to exactly this and refused at `resource`, and the other way round. ""
   * when switched off (MERRYMEN_MCP_DIRECTORY=0), not a usable URL, or at any
   * path but DIRECTORY_ROUTE_PATH.
   */
  directoryResource: string;
  /** Origins a browser-originated request to /mcp may carry. Requests with no Origin are server-to-server clients. */
  allowedOrigins: ReadonlySet<string>;
  /** Hosts /mcp and the OAuth endpoints answer on (DNS-rebinding guard). */
  allowedHosts: ReadonlySet<string>;
  /** Tenants (lowercase addresses) that may be granted the staff diagnostics scope. */
  staffTenants: ReadonlySet<string>;
  accessTtlSec: number;
  refreshTtlSec: number;
  /** A refresh-token family cannot be stretched past this by rotation; the owner re-consents. */
  refreshFamilyMaxSec: number;
  codeTtlSec: number;
  /** How long the consent screen can stay open (sign-in can take a while). */
  requestTtlSec: number;
  /** Personal access tokens (for clients without OAuth) may not outlive this. */
  personalTokenMaxSec: number;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * The one path the MCP endpoint is served at (app/mcp/route.ts;
 * next.config.mjs has no rewrites). The canonical resource URL may name
 * another origin (production: https://mcp.merrymen.dev/mcp), never another
 * path: the URL is what clients are told to POST to, and any other path is a
 * 404. landing.ts keeps a copy for the edge middleware (a test pins the two).
 */
export const CANONICAL_ROUTE_PATH = "/mcp";

/**
 * The one path the directory profile is served at (app/mcp/directory/route.ts;
 * next.config.mjs has no rewrites). Its resource URL may name another origin,
 * never another path, for the same reason as CANONICAL_ROUTE_PATH.
 */
export const DIRECTORY_ROUTE_PATH = "/mcp/directory";

function originOf(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol === "https:") return url;
    // Plain http only for loopback, which is how local development and the
    // end-to-end client tests run. The MCP authorization spec allows the same.
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return url;
    return null;
  } catch {
    return null;
  }
}

function positive(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

export function mcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const issuerUrl = originOf(env.MERRYMEN_OAUTH_ISSUER ?? env.MERRYMEN_PUBLIC_ORIGIN);
  const issuer = issuerUrl ? issuerUrl.origin : "";
  const configuredResource = originOf(env.MERRYMEN_MCP_RESOURCE_URL ?? (issuer ? `${issuer}${CANONICAL_ROUTE_PATH}` : undefined));
  // The resource keeps its path; normalise away a trailing slash so the
  // metadata's `resource` matches the URL clients were given exactly. Only the
  // origin may differ from the served path: any other path (the root
  // included) is treated like an unusable URL, so nothing advertises an
  // address that answers 404.
  const configuredPath = configuredResource ? configuredResource.pathname.replace(/\/+$/, "") : "";
  const resourceUrl = configuredPath === CANONICAL_ROUTE_PATH ? configuredResource : null;
  const resource = resourceUrl ? `${resourceUrl.origin}${configuredPath}` : "";
  // The directory profile: DIRECTORY_ROUTE_PATH on the canonical endpoint's
  // origin, unless overridden to another origin. Off when switched off, when
  // there is no usable canonical endpoint, and when an override names any
  // other path (nothing would answer there). It can never share the
  // canonical path: the two route paths differ.
  const directoryUrl = env.MERRYMEN_MCP_DIRECTORY === "0" || !resourceUrl
    ? null
    : originOf(env.MERRYMEN_MCP_DIRECTORY_RESOURCE_URL ?? `${resourceUrl.origin}${DIRECTORY_ROUTE_PATH}`);
  const directoryPath = directoryUrl ? directoryUrl.pathname.replace(/\/+$/, "") : "";
  const directoryResource = directoryUrl && directoryPath === DIRECTORY_ROUTE_PATH ? `${directoryUrl.origin}${directoryPath}` : "";
  const directoryHost = directoryResource ? directoryUrl?.host : undefined;

  const extraOrigins = (env.MERRYMEN_MCP_ALLOWED_ORIGINS ?? "")
    .split(",").map((s) => originOf(s)?.origin).filter((s): s is string => !!s);
  const allowedOrigins = new Set<string>([issuer, resourceUrl?.origin ?? "", directoryResource ? directoryUrl?.origin ?? "" : ""].filter(Boolean).concat(extraOrigins));
  const allowedHosts = new Set<string>([issuerUrl?.host, resourceUrl?.host, directoryHost].filter((h): h is string => !!h));
  const staffTenants = new Set(
    (env.MERRYMEN_MCP_STAFF_TENANTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => ADDRESS.test(s)),
  );

  let disabledWhy: string | null = null;
  if (!isHostedMode()) disabledWhy = "MCP is available on hosted Merrymen only";
  else if (!env.DATABASE_URL) disabledWhy = "hosted MCP requires DATABASE_URL";
  else if (env.MERRYMEN_MCP_ENABLED === "0") disabledWhy = "MCP is switched off (MERRYMEN_MCP_ENABLED=0)";
  else if (!issuer) disabledWhy = "MERRYMEN_PUBLIC_ORIGIN (or MERRYMEN_OAUTH_ISSUER) must be an https origin";
  else if (!configuredResource) disabledWhy = "MERRYMEN_MCP_RESOURCE_URL must be an https URL";
  else if (!resource) disabledWhy = `MERRYMEN_MCP_RESOURCE_URL must have the path ${CANONICAL_ROUTE_PATH}, the only path the MCP endpoint is served at (only the origin may change)`;
  else if ((env.MERRYMEN_SESSION_SECRET ?? "").length < 32) disabledWhy = "MERRYMEN_SESSION_SECRET is required for owner sign-in";

  return {
    enabled: disabledWhy === null,
    disabledWhy,
    issuer,
    resource,
    directoryResource,
    allowedOrigins,
    allowedHosts,
    staffTenants,
    accessTtlSec: positive(env.MERRYMEN_MCP_ACCESS_TTL_SEC, 3600, 300, 86_400),
    refreshTtlSec: positive(env.MERRYMEN_MCP_REFRESH_TTL_SEC, 30 * 86_400, 3600, 90 * 86_400),
    refreshFamilyMaxSec: positive(env.MERRYMEN_MCP_REFRESH_FAMILY_MAX_SEC, 90 * 86_400, 86_400, 365 * 86_400),
    codeTtlSec: 300,
    requestTtlSec: 20 * 60,
    personalTokenMaxSec: 90 * 86_400,
  };
}

/**
 * The resource URL a profile is served under: the canonical one for the full
 * server, the directory one for the directory profile ("" when that is off).
 */
export function resourceFor(cfg: McpConfig, profile: McpProfile): string {
  return profile === "directory" ? cfg.directoryResource : cfg.resource;
}

/**
 * Which profile a (normalised) resource URL names, or null when it is neither
 * address this server serves now: the endpoint moved, or the directory
 * profile was switched off.
 */
export function profileOfResource(cfg: McpConfig, resource: string | null | undefined): McpProfile | null {
  if (!resource) return null;
  if (resource === cfg.resource) return "full";
  if (resource === cfg.directoryResource) return "directory";
  return null;
}

/** The path part of the resource URL, e.g. "/mcp" (or "/mcp/directory"); "" for a profile that is off. */
export function resourcePath(cfg: McpConfig, profile: McpProfile = "full"): string {
  try {
    return new URL(resourceFor(cfg, profile)).pathname || "/";
  } catch {
    return profile === "directory" ? "" : "/mcp";
  }
}

/** RFC 9728 well-known URL for the resource: /.well-known/oauth-protected-resource/<path>. */
export function protectedResourceMetadataUrl(cfg: McpConfig, profile: McpProfile = "full"): string {
  const url = new URL(resourceFor(cfg, profile));
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}
