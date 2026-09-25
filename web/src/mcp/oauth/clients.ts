/**
 * Who is asking: MCP client identification for the authorization server.
 *
 * Two registration mechanisms, in the order the MCP authorization spec prefers:
 *
 * 1. Client ID Metadata Documents (CIMD). The client_id IS an https URL that
 *    serves the client's metadata. The URL must be canonical (no query, no
 *    fragment, no dot segments) and must not be on one of our own hosts: the
 *    consent page shows "Verified at <host>", and a document served through
 *    one of our own routes (the image proxy, say) would borrow our name. We
 *    fetch it through the repo's SSRF-guarded transport (DNS pinned to public
 *    addresses, https only, no redirects, byte cap, timeout), accept only a 200
 *    JSON answer, require the document's client_id to equal the URL exactly,
 *    and cache only the fields we use (bounded, canonical), briefly, and only
 *    from the consent steps (see ResolveOptions.cacheNew). Claude and Codex
 *    both use this when advertised.
 * 2. Dynamic Client Registration (RFC 7591), kept for clients that have not
 *    moved to CIMD. Registration is open (as the MCP spec expects) but rate
 *    limited, and a registered client proves nothing about who it is: the
 *    consent screen shows the host of the redirect the code will actually go
 *    to, and marks the app as not verified.
 *
 * A client identity is never authority over a user. It only says where the
 * authorization code may be sent; the owner's consent creates the connection.
 */
import { fetchPublicHttps } from "../../../../packages/core/src/server/public-network";
import type { McpConfig } from "../config";
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
  /**
   * The CIMD host (verified: it served the document). For a DCR client this is
   * only the first registered redirect's host and proves nothing; what an owner
   * is shown and what a connection records is `consentHost()` instead.
   */
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
/**
 * A metadata document's redirect_uris, as stored (canonical hrefs, serialised
 * as JSON), may not exceed this many UTF-8 bytes. Real clients list a few
 * short URLs. With the ≤ 512-byte client_id and the ≤ 300-byte name, a cached
 * row stays under about 3 KB.
 */
export const CIMD_REDIRECTS_MAX_BYTES = 2048;
const NAME_MAX = 100;

/**
 * Printable, single-line, bounded. Refused (spoofing on the consent screen):
 * every control character (C0, DEL and C1, e.g. U+009B CSI, U+0085 NEL), every
 * format character (bidi marks and overrides including U+061C, zero-width
 * characters, word joiners, BOM, soft hyphen) and the line/paragraph
 * separators U+2028/U+2029. By Unicode category, so no literal list can drift.
 */
const UNSAFE_NAME_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > NAME_MAX) return null;
  if (UNSAFE_NAME_CHAR.test(name)) return null;
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

/**
 * A valid redirect URI in canonical form (URL.href): ASCII only (IDNA host,
 * percent-encoded path and query), default port and dot segments removed.
 * That is also the form a code is actually sent to (the redirect Location is
 * built by the same parser), so storing it loses nothing redirectMatches needs.
 */
function canonicalRedirectUri(raw: unknown): string | null {
  const ok = validRedirectUri(raw);
  return ok === null ? null : new URL(ok).href;
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

/** A loopback (http://localhost|127.0.0.1|[::1]) redirect: a program on the owner's own computer. */
export function isLoopbackRedirect(raw: string): boolean {
  try {
    return isLoopback(new URL(raw));
  } catch {
    return false;
  }
}

/**
 * Exact redirect matching, with the one exception RFC 8252 §7.3 requires: a
 * loopback redirect may use any port, because native clients bind an
 * ephemeral one. Scheme, host, path and query must still match exactly, and
 * localhost never matches 127.0.0.1 (they can be different listeners).
 *
 * A metadata document's redirects are stored in canonical form (URL.href), so
 * the requested URI also matches when ITS canonical form is registered. That
 * form is exactly where the code goes (the redirect Location is serialised by
 * the same parser), so this compares the real destination, not a looser one.
 */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!validRedirectUri(requested)) return false;
  const destination = req.href;
  for (const r of registered) {
    if (r === requested || r === destination) return true;
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

/**
 * The hostnames that are ours: the issuer's, the resource's and every host the
 * MCP endpoints answer on. A metadata document may never be served from one of
 * them, because whatever route answered (the coin-image proxy echoes any
 * https body labelled image/*) the consent page would read "Verified at" our
 * own name.
 */
export function ownHostsOf(cfg: Pick<McpConfig, "issuer" | "resource" | "allowedHosts">): ReadonlySet<string> {
  const hosts = new Set<string>();
  const add = (raw: string, base = false) => {
    try {
      hosts.add(bareHostname(new URL(base ? `https://${raw}` : raw)));
    } catch {
      /* not a host */
    }
  };
  add(cfg.issuer);
  add(cfg.resource);
  for (const h of cfg.allowedHosts) add(h, true);
  hosts.delete("");
  return hosts;
}

/**
 * A client_id that is an acceptable CIMD URL: https, canonical as written (so
 * no dot segments, percent-encoded or not, no default port, no upper-case
 * host), a path, no query string, no fragment, no credentials, and not on one
 * of our own hosts.
 */
export function isCimdClientId(clientId: string, ownHosts: ReadonlySet<string>): boolean {
  if (clientId.includes("?") || clientId.includes("#")) return false;
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.pathname.length <= 1 || u.username || u.password) return false;
  // The WHATWG parser resolves "." / ".." / "%2e" segments; if it changed the
  // string, the URL was not the one the document must name exactly.
  if (u.href !== clientId) return false;
  if (u.pathname.split("/").some((seg) => seg === "." || seg === ".." || /^(%2e|\.){1,2}$/i.test(seg))) return false;
  return !ownHosts.has(bareHostname(u));
}

/** Lower-case hostname without a trailing root dot ("app.test." resolves to the same place as "app.test"). */
function bareHostname(u: URL): string {
  return u.hostname.toLowerCase().replace(/\.+$/, "");
}

/** A client_id shaped like a URL (DCR ids are `mcpc_…` and never contain a scheme). */
function looksLikeUrl(clientId: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(clientId);
}

/**
 * The host an owner is shown for this client and that a connection records:
 * the verified CIMD host, or, for a DCR client (which proves nothing about
 * itself), the host of the redirect the code will actually be sent to — never
 * a different registered redirect that might name a host the owner trusts.
 */
export function consentHost(client: Pick<McpClient, "kind" | "displayHost">, redirectUri: string): string {
  return client.kind === "cimd" ? client.displayHost : hostOf(redirectUri);
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

export type CimdFetcher = (url: string) => Promise<{ status: number; body: Buffer; contentType: string | undefined; cacheControl?: string | string[] }>;

/** application/json or a structured-syntax suffix (application/<x>+json), parameters allowed. */
const JSON_MEDIA_TYPE = /^application\/([\w.+-]+\+)?json\s*(;|$)/i;

/** A metadata document is only a 200 answer labelled JSON. Anything else is not read at all. */
export function acceptableCimdResponse(status: number, contentType: string | undefined): boolean {
  return status === 200 && JSON_MEDIA_TYPE.test((contentType ?? "").trim());
}

const defaultFetcher: CimdFetcher = async (url) => {
  // One retry on a network-level failure: a single dropped connection should
  // not turn "Connect" into an error page. A refused answer (non-200, or not
  // JSON) is a definite "no" and is neither read nor retried.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const seen: { refused?: { status: number; contentType: string | undefined } } = {};
    try {
      const res = await fetchPublicHttps(url, {
        maxBytes: CIMD_MAX_BYTES, timeoutMs: CIMD_TIMEOUT_MS, maxRedirects: 0,
        accept: (r) => {
          const status = r.statusCode ?? 0;
          const contentType = r.headers["content-type"];
          if (acceptableCimdResponse(status, contentType)) return true;
          seen.refused = { status, contentType };
          return false;
        },
      });
      return { status: res.status, body: res.body, contentType: res.headers["content-type"], cacheControl: res.headers["cache-control"] };
    } catch (error) {
      if (seen.refused) return { ...seen.refused, body: Buffer.alloc(0) };
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
  // Canonical ASCII hrefs, never the raw strings: what is stored is what a
  // code can be sent to, and its size is its byte count.
  const redirectUris = uris.map(canonicalRedirectUri).filter((u): u is string => !!u);
  if (!redirectUris.length || redirectUris.length !== uris.length || redirectUris.length > MAX_REDIRECTS) {
    throw new ClientError("invalid_redirect_uri", "client metadata redirect_uris must be https or loopback URLs");
  }
  if (Buffer.byteLength(JSON.stringify(redirectUris), "utf8") > CIMD_REDIRECTS_MAX_BYTES) {
    throw new ClientError("invalid_redirect_uri", "client metadata redirect_uris are too long");
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

export interface ResolveOptions {
  /** Hostnames a metadata document may never be served from: `ownHostsOf(cfg)`. */
  ownHosts: ReadonlySet<string>;
  fetcher?: CimdFetcher;
  /**
   * May a freshly fetched metadata document create a NEW cache row? Only the
   * consent steps (authorize, and the consent page, which only ever resolves
   * the client_id its parked request names) pass true. Any URL is a client_id
   * until fetched, so every endpoint that cached would let anyone park rows in
   * the shared database. Everywhere else (the token and revocation endpoints,
   * where a client holding no code or token cannot succeed anyway) a fetched
   * document serves that one request and only refreshes a row that already
   * exists — or restores the row of a client an owner is actively connected
   * to, so its stale fallback survives retention. Default false.
   */
  cacheNew?: boolean;
}

export async function resolveClient(d: McpDb, clientId: unknown, now: number, opts: ResolveOptions): Promise<McpClient> {
  if (typeof clientId !== "string" || !clientId || clientId.length > 512) throw new ClientError("invalid_client", "missing or malformed client_id");
  // A URL-shaped id is judged before the cache, so a copy cached under an
  // earlier, looser rule (or a config change that made its host ours) is not used.
  const urlShaped = looksLikeUrl(clientId);
  if (urlShaped && !isCimdClientId(clientId, opts.ownHosts)) {
    throw new ClientError("invalid_client", "client_id must be a plain https metadata document URL on the client's own host (no query, fragment or dot segments)");
  }
  const row = await d.db.prepare("SELECT client_id, kind, client_name, redirect_uris, auth_method, secret_hash, expires_at, fetched_at FROM mcp_clients WHERE client_id = ?").get(clientId) as ClientRow | undefined;
  if (row && (row.kind !== "cimd" || (row.expires_at ?? 0) > now)) return rowToClient(row);
  if (!urlShaped) throw new ClientError("invalid_client", "unknown client_id");
  const fetcher = opts.fetcher ?? defaultFetcher;

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
  if (!acceptableCimdResponse(fetched.status, fetched.contentType)) {
    throw new ClientError("invalid_client", "client metadata document must be served as application/json");
  }
  const client = parseCimd(clientId, fetched.body);
  const ttl = maxAge(fetched.cacheControl);
  // Only the fields we use are kept, each once and bounded (name ≤ 100
  // characters, redirects ≤ CIMD_REDIRECTS_MAX_BYTES of canonical ASCII), never
  // the fetched body: anyone can make this server fetch a document, so the raw
  // bytes (padding and all) must not land in the shared database. The name and
  // redirects have their own columns, so metadata_json holds nothing more.
  const redirects = JSON.stringify(client.redirectUris);
  if (opts.cacheNew) {
    await d.db.prepare(`INSERT INTO mcp_clients (client_id, kind, client_name, redirect_uris, auth_method, secret_hash, metadata_json, created_at, fetched_at, expires_at)
      VALUES (?, 'cimd', ?, ?, 'none', NULL, '{}', ?, ?, ?)
      ON CONFLICT (client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris,
        metadata_json = excluded.metadata_json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`)
      .run(clientId, client.clientName, redirects, now, now, now + ttl);
  } else if (row) {
    await d.db.prepare(`UPDATE mcp_clients SET client_name = ?, redirect_uris = ?, metadata_json = '{}', fetched_at = ?, expires_at = ?
      WHERE client_id = ? AND kind = 'cimd'`)
      .run(client.clientName, redirects, now, now + ttl, clientId);
  } else {
    // A client an owner has an ACTIVE connection with may have its row back:
    // retention drops a used row once its stale window passes, and without a
    // row a single failed fetch at the next refresh would have no copy to fall
    // back on and disconnect the app. Growth stays bounded by owner consents.
    await d.db.prepare(`INSERT INTO mcp_clients (client_id, kind, client_name, redirect_uris, auth_method, secret_hash, metadata_json, created_at, fetched_at, expires_at)
      SELECT ?, 'cimd', ?, ?, 'none', NULL, '{}', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM mcp_connections WHERE client_id = ? AND status = 'active')
      ON CONFLICT (client_id) DO NOTHING`)
      .run(clientId, client.clientName, redirects, now, now, now + ttl, clientId);
  }
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
