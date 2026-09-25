/**
 * The Merrymen OAuth 2.1 authorization server for MCP clients.
 *
 * Flow: authorization code + PKCE (S256 only), with the owner's consent given
 * on a Merrymen page while signed in with their own Merrymen session. Tokens
 * are opaque, audience-bound to the one MCP resource URL, short-lived (access)
 * or rotated on every use (refresh, with reuse detection that revokes the whole
 * family). Revocation — by the client (RFC 7009) or by the owner on the
 * Connected apps page — takes effect on the next request, because every
 * access token is looked up.
 *
 * What a connection can NEVER get from here, whatever the client asks for:
 * the owner's session, their keys, trading authority, or access to another
 * owner's agents. The owner picks which of their agents a connection may see;
 * the tenant comes from the owner's own sign-in, never from the client.
 */
import type { McpConfig } from "../config";
import { lockSuffix, type McpDb } from "../db";
import { scopeInfo, normalizeScopes, parseScopeParam, scopeString, type ScopeInfo } from "../scopes";
import type { AgentDirectory } from "../agents";
import {
  ClientError, consentHost, isLoopbackRedirect, ownHostsOf, redirectMatches, resolveClient, type CimdFetcher, type McpClient,
} from "./clients";
import { PKCE_CHALLENGE, constantTimeEqual, randomCredential, randomId, sha256hex, verifyPkce } from "./crypto";

export type Tenant = `0x${string}`;

export interface OAuthDeps {
  d: McpDb;
  cfg: McpConfig;
  now: () => number;
  agents: AgentDirectory;
  fetcher?: CimdFetcher;
  audit?: (event: AuditEvent) => void | Promise<void>;
}

export interface AuditEvent {
  action: string;
  outcome: string;
  tenant?: string | null;
  connectionId?: string | null;
  clientId?: string | null;
  detail?: Record<string, unknown>;
}

export class OAuthError extends Error {
  constructor(public error: string, public description: string, public status = 400) {
    super(description);
    this.name = "OAuthError";
  }
  body(): Record<string, string> {
    return { error: this.error, error_description: this.description };
  }
}

// ── /authorize ──────────────────────────────────────────────────────────────

export type AuthorizeOutcome =
  | { kind: "consent"; location: string }
  | { kind: "redirect"; location: string }
  | { kind: "page_error"; status: number; error: string; description: string };

function withParams(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

function normalizeResource(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.hash || u.search) return raw;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw;
  }
}

/**
 * Resolve a client_id the way every endpoint must: never a metadata document
 * served from one of our own hosts. `cacheNew` (may a fetched metadata document
 * create a cache row) is for the consent steps only: authorize, and the consent
 * page resolving the client its parked request names. The token and revocation
 * endpoints never pass it: there a fetched document only refreshes a cached
 * row, or restores the row of a client some owner has an ACTIVE connection
 * with, so a caller with no code or token cannot make this server store a row
 * for a client no owner connected (see ResolveOptions.cacheNew).
 */
export function clientFor(deps: Pick<OAuthDeps, "d" | "cfg" | "fetcher">, clientId: unknown, now: number, o: { cacheNew?: boolean } = {}): Promise<McpClient> {
  return resolveClient(deps.d, clientId, now, { ownHosts: ownHostsOf(deps.cfg), fetcher: deps.fetcher, cacheNew: o.cacheNew === true });
}

/** Any control character (C0 incl. NUL, DEL, C1), by Unicode category so no literal list can drift. */
const STATE_CONTROL = /\p{Cc}/u;

export async function startAuthorization(deps: OAuthDeps, p: URLSearchParams): Promise<AuthorizeOutcome> {
  const { d, cfg } = deps;
  const now = deps.now();
  let client: McpClient;
  try {
    client = await clientFor(deps, p.get("client_id"), now, { cacheNew: true });
  } catch (e) {
    const ce = e instanceof ClientError ? e : new ClientError("invalid_client", "unknown client");
    return { kind: "page_error", status: ce.code === "temporarily_unavailable" ? 503 : 400, error: ce.code, description: ce.message };
  }
  const redirectUri = p.get("redirect_uri") ?? "";
  // Without a registered, exactly matching redirect there is nowhere safe to
  // send even an error: an open redirector is how codes get stolen.
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
    return { kind: "page_error", status: 400, error: "invalid_request", description: "redirect_uri is missing or not registered for this client" };
  }
  const state = p.get("state") ?? undefined;
  // Before the owner has seen the consent screen, an error is shown on our own
  // page, not bounced to the client: registration is open (and a metadata
  // document is whatever its author serves), so a "registered" https redirect
  // proves nothing, and bouncing would make every Merrymen authorize link an
  // open redirector to any site that registered itself (RFC 9700 §4.11.2).
  // The one exception is a metadata-document client returning to loopback —
  // a program on the owner's own computer (Claude Code, Codex CLI) that is
  // waiting on that port and would otherwise hang. After consent, decline and
  // approval go back to the client as usual.
  const redirectErrors = client.kind === "cimd" && isLoopbackRedirect(redirectUri);
  const fail = (error: string, description: string): AuthorizeOutcome => redirectErrors
    ? { kind: "redirect", location: withParams(redirectUri, { error, error_description: description, state, iss: cfg.issuer }) }
    : { kind: "page_error", status: 400, error, description };
  // RFC 6749 allows only visible characters in state. A control character is
  // refused on our own page, never echoed back to any redirect (so this comes
  // before every fail()), and never stored (Postgres TEXT cannot hold NUL: the
  // INSERT below would fail as a 500).
  if (state !== undefined && STATE_CONTROL.test(state)) {
    return { kind: "page_error", status: 400, error: "invalid_request", description: "state must not contain control characters" };
  }
  if (state !== undefined && state.length > 1024) return fail("invalid_request", "state is too long");
  if (p.get("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
  if (p.get("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  const challenge = p.get("code_challenge") ?? "";
  if (!PKCE_CHALLENGE.test(challenge)) return fail("invalid_request", "code_challenge must be a base64url SHA-256 value");
  const resources = p.getAll("resource");
  if (resources.length > 1) return fail("invalid_target", "exactly one resource may be requested");
  const resource = resources[0] ? normalizeResource(resources[0]) : cfg.resource;
  if (resource !== cfg.resource) return fail("invalid_target", `this authorization server only issues tokens for ${cfg.resource}`);
  // Staff scope is filtered per owner at consent time; keep it in the request.
  const scopes = parseScopeParam(p.get("scope"), { staff: true });
  if (!scopes.length) return fail("invalid_scope", "none of the requested scopes exist");

  const requestId = randomCredential("mcpr_", 32);
  await d.db.prepare(`INSERT INTO mcp_auth_requests (id_hash, client_id, redirect_uri, code_challenge, state, scopes, resource, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .run(sha256hex(requestId), client.clientId, redirectUri, challenge, state ?? null, scopeString(scopes), resource, now, now + cfg.requestTtlSec);
  await d.db.prepare("DELETE FROM mcp_auth_requests WHERE expires_at < ?").run(now - 86_400);
  // A fragment is never sent to a server or a Referer, so the request handle
  // stays out of logs on its way to the consent page.
  return { kind: "consent", location: `${cfg.issuer}/connect/app#request=${encodeURIComponent(requestId)}` };
}

// ── consent ─────────────────────────────────────────────────────────────────

interface RequestRow {
  id_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scopes: string;
  resource: string;
  expires_at: number;
  status: string;
}

export interface ConsentView {
  client: {
    name: string | null;
    /** The verified CIMD host, or for a dynamically registered app the host the code will actually go to. */
    host: string;
    registration: "metadata-document" | "dynamic";
    redirectHost: string;
    /** Loopback redirects mean a program on the owner's own computer (Claude Code, Codex CLI). */
    local: boolean;
  };
  /** The choices the owner makes. `offline_access` is never one of them: see OFFLINE_ACCESS. */
  scopes: Array<Pick<ScopeInfo, "id" | "title" | "detail" | "level" | "needsAgent" | "defaultOn">>;
  agents: Array<{ slug: string; account: string | null }>;
  signedIn: boolean;
  expiresAt: number;
  /** A connection lasts at most this many days (the refresh-token family limit) before the owner approves again. */
  maxDays: number;
}

/**
 * Refresh tokens are ALWAYS issued (rotating; idle and absolute family limits
 * from config), because MCP clients depend on them. `offline_access` is
 * therefore accepted and echoed for compatibility and grants nothing extra; it
 * is never offered as a choice, so no consent text can suggest it controls how
 * long a connection lasts. Disconnecting on Connected apps ends everything.
 */
const OFFLINE_ACCESS = "offline_access";

async function pendingRequest(d: McpDb, requestId: unknown, now: number, lock = false): Promise<RequestRow> {
  if (typeof requestId !== "string" || requestId.length < 20 || requestId.length > 200) {
    throw new OAuthError("invalid_request", "this sign-in link is invalid", 404);
  }
  const row = await d.db.prepare(`SELECT id_hash, client_id, redirect_uri, code_challenge, state, scopes, resource, expires_at, status
    FROM mcp_auth_requests WHERE id_hash = ?${lock ? lockSuffix(d) : ""}`).get(sha256hex(requestId)) as RequestRow | undefined;
  if (!row || row.status !== "pending" || row.expires_at <= now) {
    throw new OAuthError("invalid_request", "this sign-in link has expired or was already used; start the connection again from your app", 410);
  }
  return row;
}

function offeredScopes(requested: string[], staff: boolean): string[] {
  return requested.filter((s) => {
    const info = scopeInfo(s);
    return !!info && (info.level !== "staff" || staff);
  });
}

export async function describeRequest(deps: OAuthDeps, requestId: unknown, tenant: Tenant | null): Promise<ConsentView> {
  const now = deps.now();
  const row = await pendingRequest(deps.d, requestId, now);
  // The client_id comes from the parked request (cached at authorize), never from this caller.
  const client = await clientFor(deps, row.client_id, now, { cacheNew: true });
  const redirect = new URL(row.redirect_uri);
  const staff = !!tenant && deps.cfg.staffTenants.has(tenant.toLowerCase());
  const scopes = offeredScopes(row.scopes.split(" ").filter(Boolean), staff).filter((id) => id !== OFFLINE_ACCESS).map((id) => {
    const i = scopeInfo(id)!;
    return { id: i.id, title: i.title, detail: i.detail, level: i.level, needsAgent: i.needsAgent, defaultOn: i.defaultOn };
  });
  const agents = tenant ? (await deps.agents.agentsFor(tenant)).map((a) => ({ slug: a.slug, account: a.account })) : [];
  return {
    client: {
      name: client.clientName,
      host: consentHost(client, row.redirect_uri),
      registration: client.kind === "cimd" ? "metadata-document" : "dynamic",
      redirectHost: redirect.host,
      local: redirect.protocol === "http:",
    },
    scopes,
    agents,
    signedIn: !!tenant,
    expiresAt: row.expires_at,
    maxDays: Math.max(1, Math.floor(deps.cfg.refreshFamilyMaxSec / 86_400)),
  };
}

export interface ConsentDecision {
  approve: boolean;
  scopes?: unknown;
  agentSlugs?: unknown;
}

export async function decideRequest(deps: OAuthDeps, requestId: unknown, tenant: Tenant, decision: ConsentDecision): Promise<{ location: string; connectionId: string | null }> {
  const { d, cfg } = deps;
  const now = deps.now();
  const owner = tenant.toLowerCase() as Tenant;
  const staff = cfg.staffTenants.has(owner);
  // Everything that can touch the network or another connection happens
  // before the transaction: the owner's agents (the identity store has its own
  // connection) and the client (a metadata document may need re-fetching).
  const owned = decision.approve ? await deps.agents.agentsFor(owner) : [];
  const peek = await pendingRequest(d, requestId, now);
  const client = await clientFor(deps, peek.client_id, now, { cacheNew: true });
  const result = await d.db.tx(async (db) => {
    const tx: McpDb = { db, dialect: d.dialect };
    const row = await pendingRequest(tx, requestId, now, true);
    if (row.client_id !== client.clientId) throw new OAuthError("invalid_request", "this sign-in link is invalid", 404);
    const back = (params: Record<string, string | undefined>) => withParams(row.redirect_uri, { ...params, state: row.state ?? undefined, iss: cfg.issuer });
    if (!decision.approve) {
      await db.prepare("UPDATE mcp_auth_requests SET status = 'denied' WHERE id_hash = ?").run(row.id_hash);
      return { location: back({ error: "access_denied", error_description: "the owner declined the connection" }), connectionId: null };
    }
    const requested = offeredScopes(row.scopes.split(" ").filter(Boolean), staff);
    // No explicit choice means what the consent page starts with ticked, never
    // every requested scope: clients ask for all of them (see bearerChallenge),
    // and a sensitive scope is granted only when the owner ticks it.
    const chosen = Array.isArray(decision.scopes)
      ? decision.scopes.filter((s): s is string => typeof s === "string")
      : requested.filter((s) => scopeInfo(s)?.defaultOn === true);
    if (chosen.some((s) => !requested.includes(s))) throw new OAuthError("invalid_scope", "consent includes a scope the app did not request");
    const ownedSlugs = new Set(owned.map((a) => a.slug));
    const slugs = Array.isArray(decision.agentSlugs) ? [...new Set(decision.agentSlugs.filter((s): s is string => typeof s === "string"))] : [];
    if (slugs.some((s) => !ownedSlugs.has(s))) throw new OAuthError("access_denied", "you can only share your own agents", 403);
    // Agent scopes are meaningless without an agent to apply them to; do not
    // leave a dormant grant that would silently widen if an agent appeared.
    const granted = chosen.filter((s) => s !== OFFLINE_ACCESS && (slugs.length > 0 || !scopeInfo(s)?.needsAgent));
    if (!granted.length) throw new OAuthError("invalid_scope", "choose at least one kind of access, or cancel");
    // offline_access is not the owner's choice (it controls nothing): echoed when asked for.
    const scopes = normalizeScopes(requested.includes(OFFLINE_ACCESS) ? [...granted, OFFLINE_ACCESS] : granted);
    // What Connected apps will show: for a self-registered app, the host the
    // code is actually going to, not whichever redirect it registered first.
    const host = consentHost(client, row.redirect_uri);

    await db.prepare("UPDATE mcp_auth_requests SET status = 'approved' WHERE id_hash = ?").run(row.id_hash);
    const existing = await db.prepare(`SELECT id FROM mcp_connections WHERE tenant = ? AND client_id = ? AND kind = 'oauth' AND status = 'active'${lockSuffix(tx)}`)
      .get(owner, client.clientId) as { id: string } | undefined;
    const connectionId = existing?.id ?? randomId("mcpcon_");
    if (existing) {
      await db.prepare("UPDATE mcp_connections SET scopes = ?, agent_slugs = ?, client_name = ?, client_host = ?, updated_at = ? WHERE id = ?")
        .run(scopeString(scopes), JSON.stringify(slugs), client.clientName, host, now, connectionId);
    } else {
      await db.prepare(`INSERT INTO mcp_connections (id, tenant, client_id, client_name, client_host, kind, scopes, agent_slugs, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'oauth', ?, ?, 'active', ?, ?)`)
        .run(connectionId, owner, client.clientId, client.clientName, host, scopeString(scopes), JSON.stringify(slugs), now, now);
    }
    const code = randomCredential("mcpcode_", 32);
    await db.prepare(`INSERT INTO mcp_codes (code_hash, connection_id, client_id, redirect_uri, code_challenge, resource, scopes, family, expires_at, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(sha256hex(code), connectionId, client.clientId, row.redirect_uri, row.code_challenge, row.resource, scopeString(scopes), randomId("fam_"), now + cfg.codeTtlSec);
    return { location: back({ code }), connectionId };
  });
  await deps.audit?.({
    action: decision.approve ? "oauth.consent_granted" : "oauth.consent_denied",
    outcome: "ok", tenant: owner, connectionId: result.connectionId, clientId: client.clientId,
  });
  return { location: result.location, connectionId: result.connectionId };
}

// ── /token ──────────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Client authentication at the token and revocation endpoints (RFC 6749 §2.3). */
export async function authenticateClient(deps: OAuthDeps, form: URLSearchParams, authorization: string | null): Promise<McpClient> {
  let clientId = form.get("client_id");
  let secret = form.get("client_secret");
  let viaBasic = false;
  if (authorization && /^basic\s+/i.test(authorization)) {
    let decoded = "";
    try {
      decoded = Buffer.from(authorization.replace(/^basic\s+/i, ""), "base64").toString("utf8");
    } catch {
      throw new OAuthError("invalid_client", "malformed Basic authorization", 401);
    }
    const i = decoded.indexOf(":");
    if (i < 0) throw new OAuthError("invalid_client", "malformed Basic authorization", 401);
    // RFC 6749 §2.3.1 percent-encodes both parts. A stray "%" makes
    // decodeURIComponent throw URIError; that is failed client authentication
    // (401 invalid_client, §5.2), not a server error.
    const formDecode = (s: string): string => {
      try {
        return decodeURIComponent(s);
      } catch {
        throw new OAuthError("invalid_client", "malformed Basic authorization", 401);
      }
    };
    const basicId = formDecode(decoded.slice(0, i));
    if (clientId && clientId !== basicId) throw new OAuthError("invalid_client", "client_id does not match the Authorization header", 401);
    clientId = basicId;
    secret = formDecode(decoded.slice(i + 1));
    viaBasic = true;
  }
  let client: McpClient;
  try {
    // Never caches a new metadata document (a client with no code or token
    // cannot succeed here, so this endpoint must not let it store a row); it
    // only refreshes a cached row or restores that of an actively connected client.
    client = await clientFor(deps, clientId, deps.now());
  } catch (e) {
    // A metadata document we could not fetch just now is an outage, not an
    // unknown client: clients treat 401 invalid_client as fatal and would drop
    // a working connection over one network blip.
    if (e instanceof ClientError && e.code === "temporarily_unavailable") {
      throw new OAuthError("temporarily_unavailable", "the client's metadata document could not be fetched; try again shortly", 503);
    }
    throw new OAuthError("invalid_client", "unknown client", 401);
  }
  if (client.authMethod === "none") return client;
  if (!secret || !client.secretHash) throw new OAuthError("invalid_client", "client authentication failed", 401);
  if (client.authMethod === "client_secret_basic" && !viaBasic) throw new OAuthError("invalid_client", "this client must authenticate with HTTP Basic", 401);
  if (!constantTimeEqual(sha256hex(secret), client.secretHash)) throw new OAuthError("invalid_client", "client authentication failed", 401);
  return client;
}

interface ConnectionRow {
  id: string;
  tenant: string;
  status: string;
  scopes: string;
}

async function issuePair(db: McpDb["db"], cfg: McpConfig, now: number, o: {
  connectionId: string; clientId: string; family: string; familyExpiresAt: number; scopes: string[]; resource: string;
}): Promise<TokenResponse> {
  const access = randomCredential("mcp_at_", 32);
  const refresh = randomCredential("mcp_rt_", 32);
  const scope = scopeString(o.scopes);
  const accessExp = Math.min(now + cfg.accessTtlSec, o.familyExpiresAt);
  const refreshExp = Math.min(now + cfg.refreshTtlSec, o.familyExpiresAt);
  const insert = db.prepare(`INSERT INTO mcp_tokens (token_hash, connection_id, kind, family, scopes, resource, client_id, label, created_at, expires_at, family_expires_at, used_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL)`);
  await insert.run(sha256hex(access), o.connectionId, "access", o.family, scope, o.resource, o.clientId, now, accessExp, o.familyExpiresAt);
  await insert.run(sha256hex(refresh), o.connectionId, "refresh", o.family, scope, o.resource, o.clientId, now, refreshExp, o.familyExpiresAt);
  return { access_token: access, token_type: "Bearer", expires_in: Math.max(1, accessExp - now), refresh_token: refresh, scope };
}

/**
 * Every write to a token family is serialised on its connection row.
 *
 * Postgres runs these transactions at READ COMMITTED, where each statement
 * sees only what was committed when THAT statement started. A family
 * revocation written as one bare UPDATE can then miss a pair minted by a
 * rotation running at the same time: the UPDATE blocks on the row the rotation
 * is spending, re-checks only that row once the rotation commits, and the new
 * pair (invisible to the UPDATE's snapshot) stays live after reuse was
 * detected.
 *
 * So every transaction that mints into a family (code exchange, rotation) or
 * revokes one (refresh reuse, code replay, client revocation) first takes
 * `SELECT … FOR UPDATE` on the connection row, and only in LATER statements
 * reads the token state it decides on or runs the revoking UPDATE:
 * - a revoker queued behind a rotation starts its UPDATE after that rotation
 *   committed, so the UPDATE's snapshot includes the new pair;
 * - a rotation queued behind a revoker re-reads its token after the
 *   revocation committed, sees it revoked, and refuses.
 * Lock order is always code row → connection row → token rows (and
 * revokeConnection updates the connection row before its tokens), so these
 * paths cannot deadlock one another. SQLite serialises writers; there the
 * lock clause is empty and the order of statements is what the tests pin.
 */
async function lockConnection(tx: McpDb, connectionId: string): Promise<ConnectionRow | undefined> {
  return await tx.db.prepare(`SELECT id, tenant, status, scopes FROM mcp_connections WHERE id = ?${lockSuffix(tx)}`)
    .get(connectionId) as ConnectionRow | undefined;
}

/** Revoke a whole family. Must run inside a transaction (the connection lock is held until it commits). */
async function revokeFamily(tx: McpDb, connectionId: string, family: string, now: number): Promise<void> {
  await lockConnection(tx, connectionId);
  await tx.db.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL").run(now, family);
}

export async function exchangeCode(deps: OAuthDeps, form: URLSearchParams, client: McpClient): Promise<TokenResponse> {
  const { d, cfg } = deps;
  const now = deps.now();
  const code = form.get("code");
  if (!code || code.length > 200) throw new OAuthError("invalid_request", "code is required");
  const out = await d.db.tx(async (db) => {
    const tx: McpDb = { db, dialect: d.dialect };
    const row = await db.prepare(`SELECT code_hash, connection_id, client_id, redirect_uri, code_challenge, resource, scopes, family, expires_at, used_at
      FROM mcp_codes WHERE code_hash = ?${lockSuffix(tx)}`).get(sha256hex(code)) as {
      code_hash: string; connection_id: string; client_id: string; redirect_uri: string; code_challenge: string; resource: string;
      scopes: string; family: string; expires_at: number; used_at: number | null;
    } | undefined;
    if (!row) throw new OAuthError("invalid_grant", "the authorization code is invalid");
    if (row.used_at !== null) {
      // A replayed code means it leaked: kill everything minted from it (RFC 6749 §4.1.2).
      await revokeFamily(tx, row.connection_id, row.family, now);
      return { replay: true as const, row };
    }
    if (row.client_id !== client.clientId) throw new OAuthError("invalid_grant", "the code was issued to another client");
    if (row.expires_at <= now) throw new OAuthError("invalid_grant", "the authorization code has expired");
    if (form.get("redirect_uri") !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
    if (!verifyPkce(form.get("code_verifier"), row.code_challenge)) throw new OAuthError("invalid_grant", "PKCE verification failed");
    const resource = form.get("resource");
    if (resource && normalizeResource(resource) !== row.resource) throw new OAuthError("invalid_target", "resource does not match the authorization request");
    const marked = await db.prepare("UPDATE mcp_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").run(now, row.code_hash);
    if (marked.changes !== 1) throw new OAuthError("invalid_grant", "the authorization code was already used");
    const conn = await lockConnection(tx, row.connection_id);
    if (!conn || conn.status !== "active") throw new OAuthError("invalid_grant", "the connection was revoked");
    const tokens = await issuePair(db, cfg, now, {
      connectionId: row.connection_id, clientId: client.clientId, family: row.family,
      familyExpiresAt: now + cfg.refreshFamilyMaxSec, scopes: row.scopes.split(" ").filter(Boolean), resource: row.resource,
    });
    return { replay: false as const, row, tokens, tenant: conn.tenant };
  });
  if (out.replay) {
    await deps.audit?.({ action: "oauth.code_replay", outcome: "revoked_family", connectionId: out.row.connection_id, clientId: client.clientId });
    throw new OAuthError("invalid_grant", "the authorization code was already used");
  }
  await deps.audit?.({ action: "oauth.token_issued", outcome: "ok", tenant: out.tenant, connectionId: out.row.connection_id, clientId: client.clientId });
  return out.tokens;
}

export async function refreshTokens(deps: OAuthDeps, form: URLSearchParams, client: McpClient): Promise<TokenResponse> {
  const { d, cfg } = deps;
  const now = deps.now();
  const raw = form.get("refresh_token");
  if (!raw || raw.length > 200) throw new OAuthError("invalid_request", "refresh_token is required");
  const hash = sha256hex(raw);
  const out = await d.db.tx(async (db) => {
    const tx: McpDb = { db, dialect: d.dialect };
    // Which connection? A plain read (it locks and waits for nothing); every
    // decision below is made on a re-read taken after the connection lock.
    const owner = await db.prepare("SELECT connection_id FROM mcp_tokens WHERE token_hash = ?").get(hash) as { connection_id: string } | undefined;
    if (!owner) throw new OAuthError("invalid_grant", "the refresh token is invalid");
    const conn = await lockConnection(tx, owner.connection_id);
    const row = await db.prepare(`SELECT token_hash, connection_id, kind, family, scopes, resource, client_id, expires_at, family_expires_at, used_at, revoked_at
      FROM mcp_tokens WHERE token_hash = ?${lockSuffix(tx)}`).get(hash) as {
      token_hash: string; connection_id: string; kind: string; family: string; scopes: string; resource: string; client_id: string;
      expires_at: number; family_expires_at: number; used_at: number | null; revoked_at: number | null;
    } | undefined;
    if (!row || row.kind !== "refresh") throw new OAuthError("invalid_grant", "the refresh token is invalid");
    if (row.client_id !== client.clientId) throw new OAuthError("invalid_grant", "the refresh token was issued to another client");
    if (row.revoked_at !== null) throw new OAuthError("invalid_grant", "the refresh token was revoked");
    if (row.used_at !== null) {
      // Rotation reuse: either the client or an attacker holds a stale copy.
      // OAuth 2.1 §4.3.1: revoke the family so neither keeps access.
      await revokeFamily(tx, row.connection_id, row.family, now);
      return { reuse: true as const, row };
    }
    if (row.expires_at <= now || row.family_expires_at <= now) throw new OAuthError("invalid_grant", "the refresh token has expired; reconnect the app");
    const resource = form.get("resource");
    if (resource && normalizeResource(resource) !== row.resource) throw new OAuthError("invalid_target", "resource does not match");
    if (!conn || conn.status !== "active") throw new OAuthError("invalid_grant", "the connection was revoked");
    // A refresh can narrow scope, never widen it, and never beyond what the
    // owner's current consent allows. A requested scope the token does not
    // hold is dropped, not refused (RFC 6749 §6 lets the server issue fewer):
    // many clients re-send their ORIGINAL request on refresh, which since the
    // 401 challenge asks for every advertised scope usually includes ones the
    // owner left unticked. Only a request that keeps nothing is refused.
    const held = new Set(row.scopes.split(" ").filter(Boolean));
    const allowed = new Set(conn.scopes.split(" ").filter(Boolean));
    const asked = form.get("scope");
    const wanted = asked ? asked.split(/\s+/).filter(Boolean) : [...held];
    const scopes = wanted.filter((s) => held.has(s) && allowed.has(s));
    if (!scopes.length) throw new OAuthError("invalid_scope", "none of the requested scopes are held by this connection; a refresh cannot add scopes");
    const marked = await db.prepare("UPDATE mcp_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL").run(now, row.token_hash);
    if (marked.changes !== 1) {
      await revokeFamily(tx, row.connection_id, row.family, now);
      return { reuse: true as const, row };
    }
    const tokens = await issuePair(db, cfg, now, {
      connectionId: row.connection_id, clientId: client.clientId, family: row.family,
      familyExpiresAt: row.family_expires_at, scopes, resource: row.resource,
    });
    return { reuse: false as const, row, tokens, tenant: conn.tenant };
  });
  if (out.reuse) {
    await deps.audit?.({ action: "oauth.refresh_reuse", outcome: "revoked_family", connectionId: out.row.connection_id, clientId: client.clientId });
    throw new OAuthError("invalid_grant", "the refresh token was already used; reconnect the app");
  }
  await deps.audit?.({ action: "oauth.token_refreshed", outcome: "ok", tenant: out.tenant, connectionId: out.row.connection_id, clientId: client.clientId });
  return out.tokens;
}

/** RFC 7009. Always "succeeds" for tokens the client does not own, so it cannot probe others' tokens. */
export async function revokeToken(deps: OAuthDeps, form: URLSearchParams, client: McpClient): Promise<void> {
  const raw = form.get("token");
  if (!raw || raw.length > 200) throw new OAuthError("invalid_request", "token is required");
  const now = deps.now();
  const { d } = deps;
  const row = await d.db.prepare("SELECT token_hash, kind, family, client_id, connection_id FROM mcp_tokens WHERE token_hash = ?")
    .get(sha256hex(raw)) as { token_hash: string; kind: string; family: string; client_id: string; connection_id: string } | undefined;
  if (!row || row.client_id !== client.clientId) return;
  // A family revocation holds the connection lock until it commits (see lockConnection).
  if (row.kind === "refresh") await d.db.tx((db) => revokeFamily({ db, dialect: d.dialect }, row.connection_id, row.family, now));
  else await d.db.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(now, row.token_hash);
  await deps.audit?.({ action: "oauth.token_revoked", outcome: "ok", connectionId: row.connection_id, clientId: client.clientId, detail: { kind: row.kind } });
}

// ── verification (every MCP request) ────────────────────────────────────────

export interface Principal {
  tenant: Tenant;
  connectionId: string;
  clientId: string;
  clientName: string | null;
  clientHost: string | null;
  kind: "oauth" | "personal";
  scopes: ReadonlySet<string>;
  agentSlugs: readonly string[];
  tokenExpiresAt: number;
  staff: boolean;
}

const TOUCH_EVERY_SEC = 60;

/** Resolve a bearer token to its principal, or null. Never throws for a bad token. */
export async function verifyAccessToken(d: McpDb, cfg: McpConfig, raw: string, now: number): Promise<Principal | null> {
  if (!/^mcp_(at|pat)_[A-Za-z0-9_-]{20,100}$/.test(raw)) return null;
  const row = await d.db.prepare(`SELECT t.kind, t.scopes AS token_scopes, t.resource, t.expires_at, t.revoked_at, t.client_id,
      c.id AS connection_id, c.tenant, c.status, c.scopes AS connection_scopes, c.agent_slugs, c.client_name, c.client_host, c.kind AS connection_kind, c.last_used_at
    FROM mcp_tokens t JOIN mcp_connections c ON c.id = t.connection_id WHERE t.token_hash = ?`).get(sha256hex(raw)) as {
    kind: string; token_scopes: string; resource: string; expires_at: number; revoked_at: number | null; client_id: string;
    connection_id: string; tenant: string; status: string; connection_scopes: string; agent_slugs: string; client_name: string | null;
    client_host: string | null; connection_kind: string; last_used_at: number | null;
  } | undefined;
  if (!row) return null;
  if (row.kind !== "access" && row.kind !== "personal") return null;
  if (row.revoked_at !== null || row.expires_at <= now || row.status !== "active") return null;
  // Audience binding (RFC 8707): a token minted for another resource is not ours.
  if (row.resource !== cfg.resource) return null;
  const tenant = row.tenant.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(tenant)) return null;
  const staff = cfg.staffTenants.has(tenant);
  const connectionScopes = new Set(row.connection_scopes.split(" ").filter(Boolean));
  const scopes = new Set(row.token_scopes.split(" ").filter((s) => connectionScopes.has(s) && (s !== "staff:diagnostics" || staff)));
  let agentSlugs: string[] = [];
  try {
    const parsed = JSON.parse(row.agent_slugs);
    if (Array.isArray(parsed)) agentSlugs = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    agentSlugs = [];
  }
  if ((row.last_used_at ?? 0) < now - TOUCH_EVERY_SEC) {
    await d.db.prepare("UPDATE mcp_connections SET last_used_at = ? WHERE id = ?").run(now, row.connection_id).catch(() => undefined);
  }
  return {
    tenant: tenant as Tenant,
    connectionId: row.connection_id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientHost: row.client_host,
    kind: row.connection_kind === "personal" ? "personal" : "oauth",
    scopes,
    agentSlugs,
    tokenExpiresAt: row.expires_at,
    staff,
  };
}

// ── owner-side management (Connected apps page) ─────────────────────────────

export interface ConnectionSummary {
  id: string;
  kind: "oauth" | "personal";
  clientName: string | null;
  clientHost: string | null;
  clientId: string;
  scopes: string[];
  agentSlugs: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

export async function listConnections(d: McpDb, tenant: Tenant): Promise<ConnectionSummary[]> {
  const rows = await d.db.prepare(`SELECT id, kind, client_name, client_host, client_id, scopes, agent_slugs, created_at, last_used_at
    FROM mcp_connections WHERE tenant = ? AND status = 'active' ORDER BY created_at DESC LIMIT 100`).all(tenant.toLowerCase()) as Array<{
    id: string; kind: string; client_name: string | null; client_host: string | null; client_id: string; scopes: string; agent_slugs: string; created_at: number; last_used_at: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === "personal" ? "personal" : "oauth",
    clientName: r.client_name,
    clientHost: r.client_host,
    clientId: r.client_id,
    scopes: r.scopes.split(" ").filter(Boolean),
    agentSlugs: (() => { try { return JSON.parse(r.agent_slugs) as string[]; } catch { return []; } })(),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/** The owner disconnects an app: the connection and every token under it stop working at once. */
export async function revokeConnection(d: McpDb, tenant: Tenant, connectionId: string, now: number, why = "owner"): Promise<boolean> {
  return d.db.tx(async (db) => {
    const res = await db.prepare("UPDATE mcp_connections SET status = 'revoked', revoked_at = ?, revoked_why = ?, updated_at = ? WHERE id = ? AND tenant = ? AND status = 'active'")
      .run(now, why, now, connectionId, tenant.toLowerCase());
    if (res.changes !== 1) return false;
    await db.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL").run(now, connectionId);
    return true;
  });
}

/**
 * A personal access token, for clients that cannot run an OAuth flow (for
 * example Codex with `bearer_token_env_var`). It is still a per-owner, scoped,
 * expiring, revocable connection: an app-level key that could reach every
 * owner does not exist.
 */
export async function createPersonalToken(d: McpDb, cfg: McpConfig, tenant: Tenant, input: {
  label: unknown; scopes: unknown; agentSlugs: unknown; days: unknown;
}, owned: string[], now: number): Promise<{ token: string; connectionId: string; expiresAt: number; scopes: string[] }> {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label || label.length > 60 || /[\u0000-\u001f]/.test(label)) throw new OAuthError("invalid_request", "give the token a short name (1-60 characters)");
  const staff = cfg.staffTenants.has(tenant.toLowerCase());
  const asked = Array.isArray(input.scopes) ? input.scopes.filter((s): s is string => typeof s === "string") : [];
  const slugs = Array.isArray(input.agentSlugs) ? [...new Set(input.agentSlugs.filter((s): s is string => typeof s === "string"))] : [];
  if (slugs.some((s) => !owned.includes(s))) throw new OAuthError("access_denied", "you can only share your own agents", 403);
  const scopes = normalizeScopes(asked.filter((s) => {
    const info = scopeInfo(s);
    return !!info && s !== "offline_access" && (info.level !== "staff" || staff) && (slugs.length > 0 || !info.needsAgent);
  }));
  if (!scopes.length) throw new OAuthError("invalid_scope", "choose at least one kind of access");
  const days = typeof input.days === "number" && Number.isInteger(input.days) ? input.days : 30;
  const ttl = Math.min(Math.max(days, 1) * 86_400, cfg.personalTokenMaxSec);
  const connectionId = randomId("mcpcon_");
  const token = randomCredential("mcp_pat_", 32);
  const expiresAt = now + ttl;
  await d.db.tx(async (db) => {
    await db.prepare(`INSERT INTO mcp_connections (id, tenant, client_id, client_name, client_host, kind, scopes, agent_slugs, status, created_at, updated_at)
      VALUES (?, ?, 'personal', ?, NULL, 'personal', ?, ?, 'active', ?, ?)`)
      .run(connectionId, tenant.toLowerCase(), label, scopeString(scopes), JSON.stringify(slugs), now, now);
    await db.prepare(`INSERT INTO mcp_tokens (token_hash, connection_id, kind, family, scopes, resource, client_id, label, created_at, expires_at, family_expires_at, used_at, revoked_at)
      VALUES (?, ?, 'personal', ?, ?, ?, 'personal', ?, ?, ?, ?, NULL, NULL)`)
      .run(sha256hex(token), connectionId, randomId("fam_"), scopeString(scopes), cfg.resource, label, now, expiresAt, expiresAt);
  });
  return { token, connectionId, expiresAt, scopes };
}
