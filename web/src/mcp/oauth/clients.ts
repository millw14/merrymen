/**
 * Who is asking: MCP client identification for the authorization server.
 *
 * Two registration mechanisms, in the order the MCP authorization spec prefers:
 *
 * 1. Client ID Metadata Documents (CIMD). The client_id IS an https URL that
 *    serves the client's metadata. We fetch it through the repo's SSRF-guarded
 *    transport (DNS pinned to public addresses, https only, no redirects, byte
 *    cap, timeout), require the document's client_id to equal the URL exactly,
 *    and cache it briefly. Claude and Codex both use this when advertised.
 * 2. Dynamic Client Registration (RFC 7591), kept for clients that have not
 *    moved to CIMD. Registration is open (as the MCP spec expects) but rate
 *    limited, and a registered client proves nothing about who it is: the
 *    consent screen always shows the redirect host, not the self-chosen name.
 *
 * A client identity is never authority over a user. It only says where the
 * authorization code may be sent; the owner's consent creates the connection.
 */
import { fetchPublicHttps } from "../../../../packages/core/src/server/public-network";
import type { McpDb } from "../db";
import { randomCredential, sha256hex } from "./crypto";

export type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface McpClient {
  clientId: string;
  kind: "cimd" | "dcr";
  /** Self-described; shown only next to the verified host. */
  clientName: string | null;
  redirectUris: string[];
  authMethod: AuthMethod;
  secretHash: string | null;
  /** The host a user should recognise: the CIMD host, or the first redirect's host. */
  displayHost: string;
}

export class ClientError extends Error {
  constructor(public code: "invalid_client" | "invalid_client_metadata" | "invalid_redirect_uri" | "temporarily_unavailable", message: string) {
    super(message);
    this.name = "ClientError";
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_TIMEOUT_MS = 5000;
const CIMD_DEFAULT_TTL = 3600;
const CIMD_MAX_TTL = 86_400;
/** How old a cached metadata document may be and still be used when a re-fetch fails. */
const CIMD_STALE_OK_SEC = 86_400;
const MAX_REDIRECTS = 10;
const NAME_MAX = 100;

/** Printable, single-line, bounded. Control and bidi characters are refused (spoofing on the consent screen). */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(name)) return null;
  return name;
}

/**
 * A redirect URI a client may register: https anywhere, or http on loopback
 * (native apps, RFC 8252). No fragment, no credentials. Custom URI schemes are
 * refused: nothing on this server can tell which app owns them.
 */
export function validRedirectUri(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash || url.username || url.password) return null;
  if (url.protocol === "https:") return raw;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return raw;
  return null;
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

/**
 * Exact redirect matching, with the one exception RFC 8252 §7.3 requires: a
 * loopback redirect may use any port, because native clients bind an
 * ephemeral one. Scheme, host, path and query must still match exactly, and
 * localhost never matches 127.0.0.1 (they can be different listeners).
 */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!validRedirectUri(requested)) return false;
  for (const r of registered) {
    if (r === requested) return true;
    let reg: URL;
    try {
      reg = new URL(r);
    } catch {
      continue;
    }
    if (isLoopback(reg) && isLoopback(req) && reg.hostname === req.hostname
      && reg.pathname === req.pathname && reg.search === req.search) return true;
  }
  return false;
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "unknown";
  }
}

/** A client_id that is a CIMD URL: https, a path, no fragment or credentials. */
export function isCimdClientId(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    return u.protocol === "https:" && u.pathname.length > 1 && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

interface ClientRow {
  client_id: string;
  kind: string;
  client_name: string | null;
  redirect_uris: string;
  auth_method: string;
  secret_hash: string | null;
  expires_at: number | null;
  fetched_at?: number | null;
}

function rowToClient(row: ClientRow): McpClient {
  const redirectUris = JSON.parse(row.redirect_uris) as string[];
  const kind = row.kind === "cimd" ? "cimd" : "dcr";
  return {
    clientId: row.client_id,
    kind,
    clientName: row.client_name,
    redirectUris,
    authMethod: (row.auth_method as AuthMethod) ?? "none",
    secretHash: row.secret_hash,
    displayHost: kind === "cimd" ? hostOf(row.client_id) : hostOf(redirectUris[0] ?? ""),
  };
}

function maxAge(cacheControl: string | string[] | undefined): number {
  const header = Array.isArray(cacheControl) ? cacheControl.join(",") : cacheControl ?? "";
  if (/no-store|no-cache/i.test(header)) return 60;
  const m = /max-age=(\d+)/i.exec(header);
  const n = m ? Number(m[1]) : CIMD_DEFAULT_TTL;
  return Math.max(60, Math.min(CIMD_MAX_TTL, n));
}

export type CimdFetcher = (url: string) => Promise<{ status: number; body: Buffer; cacheControl?: string | string[] }>;

const defaultFetcher: CimdFetcher = async (url) => {
  // One retry on a network-level failure: a single dropped connection should
  // not turn "Connect" into an error page. A non-200 answer is not retried.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchPublicHttps(url, { maxBytes: CIMD_MAX_BYTES, timeoutMs: CIMD_TIMEOUT_MS, maxRedirects: 0 });
      return { status: res.status, body: res.body, cacheControl: res.headers["cache-control"] };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

/** Parse and validate a CIMD document for `clientId`. Throws ClientError on any defect. */
export function parseCimd(clientId: string, body: Buffer): Omit<McpClient, "secretHash"> {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ClientError("invalid_client_metadata", "client metadata document is not JSON");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ClientError("invalid_client_metadata", "client metadata document is not an object");
  if (doc.client_id !== clientId) throw new ClientError("invalid_client_metadata", "client metadata client_id does not match the URL");
  const method = doc.token_endpoint_auth_method ?? "none";
  if (method !== "none") throw new ClientError("invalid_client_metadata", "only public clients (token_endpoint_auth_method none) are supported by metadata documents");
  if ("client_secret" in doc || "client_secret_expires_at" in doc) throw new ClientError("invalid_client_metadata", "a metadata document must not contain a client secret");
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
  const redirectUris = uris.map(validRedirectUri).filter((u): u is string => !!u);
  if (!redirectUris.length || redirectUris.length !== uris.length || redirectUris.length > MAX_REDIRECTS) {
    throw new ClientError("invalid_redirect_uri", "client metadata redirect_uris must be https or loopback URLs");
  }
  if (doc.grant_types !== undefined && !(Array.isArray(doc.grant_types) && doc.grant_types.includes("authorization_code"))) {
    throw new ClientError("invalid_client_metadata", "client must use the authorization_code grant");
  }
  if (doc.response_types !== undefined && !(Array.isArray(doc.response_types) && doc.response_types.includes("code"))) {
    throw new ClientError("invalid_client_metadata", "client must use the code response type");
  }
  return {
    clientId,
    kind: "cimd",
    clientName: cleanName(doc.client_name),
    redirectUris,
    authMethod: "none",
    displayHost: hostOf(clientId),
  };
}

export async function resolveClient(d: McpDb, clientId: unknown, now: number, fetcher: CimdFetcher = defaultFetcher): Promise<McpClient> {
  if (typeof clientId !== "string" || !clientId || clientId.length > 512) throw new ClientError("invalid_client", "missing or malformed client_id");
  const row = await d.db.prepare("SELECT client_id, kind, client_name, redirect_uris, auth_method, secret_hash, expires_at, fetched_at FROM mcp_clients WHERE client_id = ?").get(clientId) as ClientRow | undefined;
  if (row && (row.kind !== "cimd" || (row.expires_at ?? 0) > now)) return rowToClient(row);
  if (!isCimdClientId(clientId)) throw new ClientError("invalid_client", "unknown client_id");

  let fetched: Awaited<ReturnType<CimdFetcher>>;
  try {
    fetched = await fetcher(clientId);
  } catch {
    // Serve stale on a network failure, for a bounded time: the copy we hold
    // was verified when fetched, and a flaky network between us and the
    // client's host should not lock owners out of connecting. A document that
    // was never fetched successfully, or is over a day old, is not used.
    if (row && row.kind === "cimd" && (row.fetched_at ?? 0) > now - CIMD_STALE_OK_SEC) return rowToClient(row);
    throw new ClientError("temporarily_unavailable", "could not fetch the client metadata document");
  }
  if (fetched.status !== 200) throw new ClientError("invalid_client", "client metadata document is unavailable");
  const client = parseCimd(clientId, fetched.body);
  const ttl = maxAge(fetched.cacheControl);
  await d.db.prepare(`INSERT INTO mcp_clients (client_id, kind, client_name, redirect_uris, auth_method, secret_hash, metadata_json, created_at, fetched_at, expires_at)
    VALUES (?, 'cimd', ?, ?, 'none', NULL, ?, ?, ?, ?)
    ON CONFLICT (client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris,
      metadata_json = excluded.metadata_json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`)
    .run(clientId, client.clientName, JSON.stringify(client.redirectUris), fetched.body.toString("utf8").slice(0, CIMD_MAX_BYTES), now, now, now + ttl);
  return { ...client, secretHash: null };
}

export interface RegistrationResult {
  status: number;
  body: Record<string, unknown>;
}

/** RFC 7591 dynamic registration. Returns an RFC-shaped error body on bad metadata. */
export async function registerClient(d: McpDb, raw: unknown, now: number): Promise<RegistrationResult> {
  const fail = (error: string, description: string): RegistrationResult => ({ status: 400, body: { error, error_description: description } });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_client_metadata", "body must be a JSON object");
  const m = raw as Record<string, unknown>;
  const uris = Array.isArray(m.redirect_uris) ? m.redirect_uris : [];
  const redirectUris = uris.map(validRedirectUri).filter((u): u is string => !!u);
  if (!redirectUris.length || redirectUris.length !== uris.length || redirectUris.length > MAX_REDIRECTS) {
    return fail("invalid_redirect_uri", "redirect_uris must be 1-10 https or loopback http URLs without fragments");
  }
  const method = (m.token_endpoint_auth_method ?? "client_secret_basic") as string;
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
    return fail("invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic");
  }
  const grants = m.grant_types === undefined ? ["authorization_code", "refresh_token"] : m.grant_types;
  if (!Array.isArray(grants) || !grants.includes("authorization_code") || grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return fail("invalid_client_metadata", "grant_types may only contain authorization_code and refresh_token");
  }
  const responses = m.response_types === undefined ? ["code"] : m.response_types;
  if (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== "code") {
    return fail("invalid_client_metadata", "response_types must be [\"code\"]");
  }
  const clientName = cleanName(m.client_name);
  const clientId = randomCredential("mcpc_", 18);
  const secret = method === "none" ? null : randomCredential("mcps_", 32);
  const stored = { client_name: clientName, redirect_uris: redirectUris, token_endpoint_auth_method: method, grant_types: grants, response_types: ["code"] };
  await d.db.prepare(`INSERT INTO mcp_clients (client_id, kind, client_name, redirect_uris, auth_method, secret_hash, metadata_json, created_at, fetched_at, expires_at)
    VALUES (?, 'dcr', ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .run(clientId, clientName, JSON.stringify(redirectUris), method, secret ? sha256hex(secret) : null, JSON.stringify(stored), now, now);
  return {
    status: 201,
    body: {
      client_id: clientId,
      client_id_issued_at: now,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      ...stored,
      ...(clientName ? {} : { client_name: undefined }),
    },
  };
}
