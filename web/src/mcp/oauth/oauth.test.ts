/**
 * The MCP authorization server end to end, on SQLite: registration, the
 * authorize → consent → code → token flow, PKCE, redirect matching, audience
 * binding, refresh rotation with reuse detection, revocation by client and by
 * owner, personal tokens, and the consent rules (own agents only, no scope
 * escalation, staff scope only for staff).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, Stmt } from "../../../../worker/src/db";
import type { McpDb } from "../db";
import {
  CIMD_REDIRECTS_MAX_BYTES, acceptableCimdResponse, isCimdClientId, ownHostsOf, registerClient, parseCimd, redirectMatches, resolveClient, transientCimdAnswer, validRedirectUri, type CimdFetcher,
} from "./clients";
import { pkceS256 } from "./crypto";
import { FORM_MAX, readBoundedText, readForm } from "./deps";
import {
  OAuthError, authenticateClient, createPersonalToken, decideRequest, describeRequest, exchangeCode, listConnections,
  refreshTokens, revokeConnection, revokeToken, startAuthorization, verifyAccessToken,
} from "./server";
import { authorizationServerMetadata, protectedResourceMetadata, bearerChallenge } from "./metadata";
import { SCOPES, scopeInfo } from "../scopes";
import { DOC_RESOURCES } from "../resources-catalog";
import { mintSession } from "../../lib/auth";
import { POST as connectionsPost } from "../../app/api/mcp/connections/route";
import { ACCOUNT_A, ACCOUNT_B, OWNER_A, OWNER_B, SLUG_A, SLUG_B, VERIFIER, agentFixture, connectAs, fixtureDirectory, installFixtures, makeDeps, makeTestDb, testConfig } from "../testing";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../../worker/src/db";
import { applyLedgerSchema } from "../../../../worker/src/store";
import { MCP_SCHEMA, ensureMcpSchema } from "../../../../worker/src/mcp/schema";
import { mcpConfig, profileOfResource, protectedResourceMetadataUrl, resourcePath } from "../config";
import { ADVERTISED_SCOPES, DIRECTORY_SCOPES, advertisedScopesFor } from "../scopes";
import { randomCredential, randomId, sha256hex } from "./crypto";

const REDIRECT = "http://127.0.0.1:33418/callback";

async function publicClient(deps: ReturnType<typeof makeDeps>, redirect = REDIRECT) {
  const reg = await registerClient(deps.d, { redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: "Claude Code" }, deps.now());
  assert.equal(reg.status, 201);
  return String(reg.body.client_id);
}

function authorizeParams(clientId: string, over: Record<string, string | null> = {}) {
  const p = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkceS256(VERIFIER), code_challenge_method: "S256",
    state: "xyz", scope: "market:read agents:read portfolio:read offline_access", resource: "https://app.test/mcp",
  });
  for (const [k, v] of Object.entries(over)) { if (v === null) p.delete(k); else p.set(k, v); }
  return p;
}

const requestOf = (location: string) => decodeURIComponent(location.split("#request=")[1]);

test("discovery metadata advertises what Claude needs for CIMD and PKCE", () => {
  const cfg = testConfig();
  const as = authorizationServerMetadata(cfg);
  assert.equal(as.issuer, "https://app.test");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.ok((as.token_endpoint_auth_methods_supported as string[]).includes("none"));
  assert.ok(!(as.scopes_supported as string[]).includes("staff:diagnostics"), "staff scope is never advertised");
  const pr = protectedResourceMetadata(cfg);
  assert.equal(pr.resource, "https://app.test/mcp");
  assert.deepEqual(pr.authorization_servers, ["https://app.test"]);
  assert.match(bearerChallenge(cfg), /resource_metadata="https:\/\/app\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("redirect URIs: https or loopback only, exact match except the loopback port", () => {
  assert.ok(validRedirectUri("https://claude.ai/api/mcp/auth_callback"));
  assert.ok(validRedirectUri("http://localhost:1234/callback"));
  assert.equal(validRedirectUri("http://evil.test/cb"), null);
  assert.equal(validRedirectUri("myapp://callback"), null);
  assert.equal(validRedirectUri("https://x.test/cb#frag"), null);
  assert.ok(redirectMatches(["http://127.0.0.1:1/callback"], "http://127.0.0.1:54321/callback"));
  assert.ok(!redirectMatches(["http://127.0.0.1:1/callback"], "http://localhost:54321/callback"), "localhost is not 127.0.0.1");
  assert.ok(!redirectMatches(["http://127.0.0.1:1/callback"], "http://127.0.0.1:1/other"));
  assert.ok(!redirectMatches(["https://claude.ai/api/mcp/auth_callback"], "https://claude.ai/api/mcp/auth_callback/../x"));
  assert.ok(!redirectMatches(["https://claude.ai/cb"], "https://claude.ai:8443/cb"), "port counts for https");
});

test("the full flow issues an audience-bound token that resolves to the consenting owner", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const { tokens, principal } = await connectAs(deps, OWNER_A);
  assert.match(tokens.access_token, /^mcp_at_/);
  assert.match(tokens.refresh_token, /^mcp_rt_/);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(principal.tenant, OWNER_A);
  assert.deepEqual([...principal.agentSlugs], [SLUG_A]);
  assert.ok(principal.scopes.has("portfolio:read"));
  // Only hashes are stored.
  const raw = d.raw.prepare("SELECT token_hash FROM mcp_tokens").all() as Array<{ token_hash: string }>;
  assert.ok(raw.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
  assert.ok(!JSON.stringify(d.raw.prepare("SELECT * FROM mcp_tokens").all()).includes(tokens.access_token));
  // A token minted for this server is useless for a differently configured resource.
  assert.equal(await verifyAccessToken(d, testConfig({ resource: "https://other.test/mcp" }), tokens.access_token, deps.now()), null);
});

test("authorize refuses unknown clients and unregistered redirects without redirecting", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const unknown = await startAuthorization(deps, authorizeParams("mcpc_nope"));
  assert.equal(unknown.kind, "page_error");
  const clientId = await publicClient(deps);
  const badRedirect = await startAuthorization(deps, authorizeParams(clientId, { redirect_uri: "https://attacker.test/cb" }));
  assert.equal(badRedirect.kind, "page_error");
});

const BAD_AUTHORIZE = [
  [{ code_challenge_method: "plain" }, "invalid_request"],
  [{ code_challenge: null }, "invalid_request"],
  [{ response_type: "token" }, "unsupported_response_type"],
  [{ response_type: null }, "unsupported_response_type"],
  [{ resource: "https://evil.test/mcp" }, "invalid_target"],
  [{ scope: "admin:everything" }, "invalid_scope"],
  [{ state: "s".repeat(1025) }, "invalid_request"],
] as const;

/** A CIMD fetcher that serves a well-formed document for any URL, with the given redirects. */
function cimdFetcher(redirects: string[], over: Partial<Awaited<ReturnType<CimdFetcher>>> = {}, extra: Record<string, unknown> = {}): CimdFetcher {
  return async (url) => ({
    status: 200, contentType: "application/json; charset=utf-8", cacheControl: "max-age=60",
    body: Buffer.from(JSON.stringify({ client_id: url, client_name: "Claude Code", redirect_uris: redirects, ...extra })),
    ...over,
  });
}

test("authorize errors before consent render our page, never a bounce to a self-registered redirect", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  // An open registration naming an https landing page, and a loopback one: before
  // the owner has seen consent, neither gets a redirect (RFC 9700 §4.11.2).
  const evil = await registerClient(d, { redirect_uris: ["https://evil.example/landing"], token_endpoint_auth_method: "none" }, deps.now());
  const evilId = String(evil.body.client_id);
  const loopbackId = await publicClient(deps);
  for (const [over, error] of BAD_AUTHORIZE) {
    for (const [id, redirect] of [[evilId, "https://evil.example/landing"], [loopbackId, REDIRECT]]) {
      const out = await startAuthorization(deps, authorizeParams(id, { ...over, redirect_uri: redirect } as Record<string, string | null>));
      assert.equal(out.kind, "page_error", `${redirect} ${JSON.stringify(over)}`);
      assert.equal((out as { error: string }).error, error);
      assert.equal((out as { status: number }).status, 400);
    }
  }
  // A metadata-document client whose redirect is https: also a page.
  const cimdId = "https://client.example/oauth/metadata.json";
  const web = makeDeps(d, { fetcher: cimdFetcher(["https://client.example/cb", "http://127.0.0.1/callback"]) });
  const webOut = await startAuthorization(web, authorizeParams(cimdId, { response_type: null, redirect_uri: "https://client.example/cb" }));
  assert.equal(webOut.kind, "page_error");
  // A trailing slash on the resource is the same resource.
  assert.equal((await startAuthorization(deps, authorizeParams(loopbackId, { resource: "https://app.test/mcp/" }))).kind, "consent");
});

test("a metadata-document client returning to loopback gets the error at its listener", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d, { fetcher: cimdFetcher(["http://127.0.0.1/callback"]) });
  const id = "https://client.example/oauth/metadata.json";
  for (const [over, error] of BAD_AUTHORIZE) {
    const out = await startAuthorization(deps, authorizeParams(id, { ...over, redirect_uri: "http://127.0.0.1:61234/callback" } as Record<string, string | null>));
    assert.equal(out.kind, "redirect", JSON.stringify(over));
    const url = new URL((out as { location: string }).location);
    assert.equal(url.host, "127.0.0.1:61234");
    assert.equal(url.searchParams.get("error"), error);
    assert.equal(url.searchParams.get("iss"), "https://app.test");
    if (!("state" in over)) assert.equal(url.searchParams.get("state"), "xyz");
  }
});

test("after the owner has seen consent, a decline goes back to a self-registered client", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const reg = await registerClient(d, { redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none" }, deps.now());
  const start = await startAuthorization(deps, authorizeParams(String(reg.body.client_id), { redirect_uri: "https://client.example/cb" }));
  assert.equal(start.kind, "consent");
  const declined = await decideRequest(deps, requestOf((start as { location: string }).location), OWNER_A, { approve: false });
  const url = new URL(declined.location);
  assert.equal(url.host, "client.example");
  assert.equal(url.searchParams.get("error"), "access_denied");
  assert.equal(url.searchParams.get("state"), "xyz");
});

test("consent: signed-out view shows only the client; an owner can share only their own agents", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const clientId = await publicClient(deps);
  const start = await startAuthorization(deps, authorizeParams(clientId));
  assert.equal(start.kind, "consent");
  const req = requestOf((start as { location: string }).location);
  const anon = await describeRequest(deps, req, null);
  assert.equal(anon.signedIn, false);
  assert.deepEqual(anon.agents, []);
  assert.equal(anon.client.redirectHost, "127.0.0.1:33418");
  assert.equal(anon.client.local, true);
  const mine = await describeRequest(deps, req, OWNER_A);
  assert.deepEqual(mine.agents.map((a) => a.slug), [SLUG_A]);
  await assert.rejects(decideRequest(deps, req, OWNER_A, { approve: true, agentSlugs: [SLUG_B] }), (e: unknown) => e instanceof OAuthError && e.status === 403);
  await assert.rejects(decideRequest(deps, req, OWNER_A, { approve: true, scopes: ["trade:propose"], agentSlugs: [SLUG_A] }), /did not request/);
});

test("consent is single use, expires, and a decline returns access_denied", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const clientId = await publicClient(deps);
  const req = requestOf(((await startAuthorization(deps, authorizeParams(clientId))) as { location: string }).location);
  const declined = await decideRequest(deps, req, OWNER_A, { approve: false });
  assert.equal(new URL(declined.location).searchParams.get("error"), "access_denied");
  await assert.rejects(decideRequest(deps, req, OWNER_A, { approve: true, agentSlugs: [SLUG_A] }), /expired or was already used/);
  const req2 = requestOf(((await startAuthorization(deps, authorizeParams(clientId))) as { location: string }).location);
  deps.advance(1201);
  await assert.rejects(describeRequest(deps, req2, OWNER_A), /expired/);
});

test("agent scopes are dropped when no agent is shared", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const { principal } = await connectAs(deps, OWNER_A, { agents: [] });
  assert.deepEqual([...principal.scopes].sort(), ["market:read", "offline_access"]);
  assert.deepEqual([...principal.agentSlugs], []);
});

test("the token endpoint checks PKCE, redirect and client, and a replayed code revokes what it minted", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const clientId = await publicClient(deps);
  const client = await resolveClient(d, clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  const newCode = async () => {
    const req = requestOf(((await startAuthorization(deps, authorizeParams(clientId))) as { location: string }).location);
    return new URL((await decideRequest(deps, req, OWNER_A, { approve: true, agentSlugs: [SLUG_A] })).location).searchParams.get("code")!;
  };
  const form = (code: string, over: Record<string, string> = {}) => new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId, ...over });

  await assert.rejects(exchangeCode(deps, form(await newCode(), { code_verifier: "x".repeat(50) }), client), /PKCE/);
  await assert.rejects(exchangeCode(deps, form(await newCode(), { redirect_uri: "http://127.0.0.1:1/other" }), client), /redirect_uri/);
  const otherId = await publicClient(deps);
  const other = await resolveClient(d, otherId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  await assert.rejects(exchangeCode(deps, form(await newCode(), { client_id: otherId }), other), /another client/);

  const code = await newCode();
  const first = await exchangeCode(deps, form(code), client);
  assert.ok(await verifyAccessToken(d, deps.cfg, first.access_token, deps.now()));
  await assert.rejects(exchangeCode(deps, form(code), client), /already used/);
  assert.equal(await verifyAccessToken(d, deps.cfg, first.access_token, deps.now()), null, "replay revokes the tokens minted from the code");

  const late = await newCode();
  deps.advance(301);
  await assert.rejects(exchangeCode(deps, form(late), client), /expired/);
});

test("refresh rotates; reusing a spent refresh token revokes the whole family", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const { tokens, clientId } = await connectAs(deps, OWNER_A);
  const client = await resolveClient(d, clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  const r = (token: string, over: Record<string, string> = {}) => new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId, ...over });
  const second = await refreshTokens(deps, r(tokens.refresh_token), client);
  assert.notEqual(second.refresh_token, tokens.refresh_token);
  assert.ok(await verifyAccessToken(d, deps.cfg, second.access_token, deps.now()));
  // Narrowing is allowed; widening is not: an unheld scope in the request is
  // dropped (clients re-send their original request), and a request that keeps
  // nothing is refused without spending the token.
  await assert.rejects(refreshTokens(deps, r(second.refresh_token, { scope: "chat:write" }), client), /cannot add scopes/);
  const narrowed = await refreshTokens(deps, r(second.refresh_token, { scope: "market:read chat:write trade:propose" }), client);
  assert.equal(narrowed.scope, "market:read", "chat:write and trade:propose were never held: not added");
  // The rotated-away token is spent: presenting it again is theft evidence.
  await assert.rejects(refreshTokens(deps, r(tokens.refresh_token), client), /already used/);
  assert.equal(await verifyAccessToken(d, deps.cfg, narrowed.access_token, deps.now()), null, "family revoked");
  await assert.rejects(refreshTokens(deps, r(narrowed.refresh_token), client), /revoked/);
});

test("access tokens expire; refresh tokens cannot outlive the family", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d, { cfg: testConfig({ accessTtlSec: 600, refreshTtlSec: 3600, refreshFamilyMaxSec: 5000 }) });
  const { tokens, clientId } = await connectAs(deps, OWNER_A);
  const client = await resolveClient(d, clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  deps.advance(601);
  assert.equal(await verifyAccessToken(d, deps.cfg, tokens.access_token, deps.now()), null);
  const next = await refreshTokens(deps, new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }), client);
  deps.advance(3000);
  const again = await refreshTokens(deps, new URLSearchParams({ grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: clientId }), client);
  assert.ok(again.expires_in <= 5000 - 3601, "access expiry is capped at the family end");
  deps.advance(2000);
  await assert.rejects(refreshTokens(deps, new URLSearchParams({ grant_type: "refresh_token", refresh_token: again.refresh_token, client_id: clientId }), client), /expired/);
});

test("revocation: by the client (RFC 7009) and by the owner, effective immediately", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const a = await connectAs(deps, OWNER_A);
  const client = await resolveClient(d, a.clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  await revokeToken(deps, new URLSearchParams({ token: a.tokens.access_token, client_id: a.clientId }), client);
  assert.equal(await verifyAccessToken(d, deps.cfg, a.tokens.access_token, deps.now()), null);

  const b = await connectAs(deps, OWNER_A);
  assert.equal((await listConnections(d, OWNER_A)).length, 2);
  assert.equal(await revokeConnection(d, OWNER_B, b.principal.connectionId, deps.now()), false, "another owner cannot revoke it");
  assert.equal(await revokeConnection(d, OWNER_A, b.principal.connectionId, deps.now()), true);
  assert.equal(await verifyAccessToken(d, deps.cfg, b.tokens.access_token, deps.now()), null);
  const bClient = await resolveClient(d, b.clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  await assert.rejects(refreshTokens(deps, new URLSearchParams({ grant_type: "refresh_token", refresh_token: b.tokens.refresh_token, client_id: b.clientId }), bClient), /revoked/);
});

test("a client cannot revoke another client's token", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const a = await connectAs(deps, OWNER_A);
  const otherId = await publicClient(deps);
  const other = await resolveClient(d, otherId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  await revokeToken(deps, new URLSearchParams({ token: a.tokens.access_token, client_id: otherId }), other);
  assert.ok(await verifyAccessToken(d, deps.cfg, a.tokens.access_token, deps.now()));
});

test("confidential DCR clients must authenticate with their secret", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const reg = await registerClient(d, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_post" }, deps.now());
  const id = String(reg.body.client_id);
  const secret = String(reg.body.client_secret);
  assert.ok(secret.startsWith("mcps_"));
  await assert.rejects(authenticateClient(deps, new URLSearchParams({ client_id: id }), null), /failed/);
  await assert.rejects(authenticateClient(deps, new URLSearchParams({ client_id: id, client_secret: "wrong" }), null), /failed/);
  assert.equal((await authenticateClient(deps, new URLSearchParams({ client_id: id, client_secret: secret }), null)).clientId, id);
  const basic = await registerClient(d, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }, deps.now());
  const header = `Basic ${Buffer.from(`${basic.body.client_id}:${basic.body.client_secret}`).toString("base64")}`;
  assert.equal((await authenticateClient(deps, new URLSearchParams(), header)).clientId, basic.body.client_id);
  await assert.rejects(authenticateClient(deps, new URLSearchParams({ client_id: String(basic.body.client_id), client_secret: String(basic.body.client_secret) }), null), /HTTP Basic/);
});

test("DCR rejects unsafe metadata", async () => {
  const d = await makeTestDb();
  for (const bad of [
    {},
    { redirect_uris: ["http://evil.test/cb"] },
    { redirect_uris: ["https://ok.test/cb"], grant_types: ["client_credentials"] },
    { redirect_uris: ["https://ok.test/cb"], response_types: ["token"] },
    { redirect_uris: ["https://ok.test/cb"], token_endpoint_auth_method: "private_key_jwt" },
    // Only app-scheme callbacks: nothing a code could be sent to.
    { redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"] },
    // An app scheme is ignored, a bad http(s) redirect still fails the registration.
    { redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback", "http://evil.test/cb"] },
    // Not app schemes, just malformed: a scheme-less loopback, and schemes with no "//".
    { redirect_uris: ["localhost:8787/callback", "https://ok.test/cb"] },
    { redirect_uris: ["javascript:alert(1)", "https://ok.test/cb"] },
    { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://ok.test/cb${i}`) },
  ]) {
    const r = await registerClient(d, bad, 1);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

test("DCR: Cursor's three callbacks register; its app-scheme one is ignored and never receives a code", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  // Cursor (IDE/CLI) registers all three together, per its staff on the Cursor forum (2026-07).
  const cursorScheme = "cursor://anysphere.cursor-mcp/oauth/callback";
  const loopback = "http://localhost:8787/callback";
  const reg = await registerClient(d, {
    client_name: "Cursor", token_endpoint_auth_method: "none",
    redirect_uris: [cursorScheme, "https://www.cursor.com/agents/mcp/oauth/callback", loopback],
  }, deps.now());
  assert.equal(reg.status, 201);
  assert.deepEqual(reg.body.redirect_uris, ["https://www.cursor.com/agents/mcp/oauth/callback", loopback], "the response lists only what was kept");
  const clientId = String(reg.body.client_id);
  assert.deepEqual(await startAuthorization(deps, authorizeParams(clientId, { redirect_uri: cursorScheme })),
    { kind: "page_error", status: 400, error: "invalid_request", description: "redirect_uri is missing or not registered for this client" });
  const start = await startAuthorization(deps, authorizeParams(clientId, { redirect_uri: loopback }));
  const view = await describeRequest(deps, requestOf((start as { location: string }).location), OWNER_A);
  assert.equal(view.client.redirectHost, "localhost:8787");
});

test("CIMD: app-scheme callbacks in a metadata document are ignored, not fatal", () => {
  const id = "https://client.example/oauth/metadata.json";
  const doc = { client_id: id, redirect_uris: ["myapp://callback", "http://127.0.0.1/callback"], token_endpoint_auth_method: "none" };
  assert.deepEqual(parseCimd(id, Buffer.from(JSON.stringify(doc))).redirectUris, ["http://127.0.0.1/callback"]);
  assert.throws(() => parseCimd(id, Buffer.from(JSON.stringify({ ...doc, redirect_uris: ["myapp://callback"] }))), /redirect_uris/);
});

test("CIMD: the document must name itself, be public, and list safe redirects", async () => {
  const id = "https://claude.ai/oauth/claude-code-client-metadata";
  const ok = parseCimd(id, Buffer.from(JSON.stringify({ client_id: id, client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"], token_endpoint_auth_method: "none" })));
  assert.equal(ok.displayHost, "claude.ai");
  assert.throws(() => parseCimd(id, Buffer.from(JSON.stringify({ client_id: "https://evil.test/x", redirect_uris: ["https://evil.test/cb"] }))), /does not match/);
  assert.throws(() => parseCimd(id, Buffer.from(JSON.stringify({ client_id: id, redirect_uris: ["https://ok/cb"], token_endpoint_auth_method: "client_secret_basic" }))), /public clients/);
  assert.throws(() => parseCimd(id, Buffer.from(JSON.stringify({ client_id: id, redirect_uris: ["javascript:alert(1)"] }))), /redirect_uris/);
  assert.throws(() => parseCimd(id, Buffer.from(JSON.stringify({ client_id: id, client_name: "Claude\u202e", redirect_uris: ["https://ok.test/cb"], client_secret: "x" }))), /secret/);

  const d = await makeTestDb();
  const deps = makeDeps(d, {
    fetcher: cimdFetcher(["http://localhost/callback"]),
  });
  const start = await startAuthorization(deps, new URLSearchParams({
    response_type: "code", client_id: id, redirect_uri: "http://localhost:61234/callback", code_challenge: pkceS256(VERIFIER), code_challenge_method: "S256", resource: "https://app.test/mcp",
  }));
  assert.equal(start.kind, "consent");
  const view = await describeRequest(deps, requestOf((start as { location: string }).location), OWNER_A);
  assert.equal(view.client.registration, "metadata-document");
  assert.equal(view.client.host, "claude.ai");
  const refused = makeDeps(d, { fetcher: async () => { throw new Error("dns"); } });
  const fail = await startAuthorization(refused, new URLSearchParams({ client_id: "https://unreachable.test/client.json", redirect_uri: "https://x/cb" }));
  assert.equal(fail.kind, "page_error");
});

test("staff scope is only granted to staff tenants, and re-checked on every request", async () => {
  const d = await makeTestDb();
  const staffCfg = testConfig({ staffTenants: new Set([OWNER_A]) });
  const deps = makeDeps(d, { cfg: staffCfg });
  const a = await connectAs(deps, OWNER_A, { scopes: ["market:read", "staff:diagnostics"] });
  assert.ok(a.principal.staff);
  assert.ok(a.principal.scopes.has("staff:diagnostics"));
  const demoted = await verifyAccessToken(d, testConfig(), a.tokens.access_token, deps.now());
  assert.ok(demoted && !demoted.scopes.has("staff:diagnostics") && !demoted.staff);
  // A non-staff owner is never offered it, and cannot slip it into the decision.
  await assert.rejects(connectAs(deps, OWNER_B, { scopes: ["market:read", "staff:diagnostics"], agents: [SLUG_B] }), /did not request/);
  const reg = await registerClient(d, { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }, deps.now());
  const start = await startAuthorization(deps, authorizeParams(String(reg.body.client_id), { scope: "market:read staff:diagnostics" }));
  const view = await describeRequest(deps, requestOf((start as { location: string }).location), OWNER_B);
  assert.deepEqual(view.scopes.map((s) => s.id), ["market:read"]);
});

test("re-consenting narrows the live connection: older tokens lose the removed scopes", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const first = await connectAs(deps, OWNER_A, { scopes: ["market:read", "portfolio:read"] });
  const client = await resolveClient(d, first.clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  // Same client, same owner, narrower consent.
  const params = new URLSearchParams({ response_type: "code", client_id: first.clientId, redirect_uri: "http://127.0.0.1:33418/callback", code_challenge: pkceS256(VERIFIER), code_challenge_method: "S256", scope: "market:read portfolio:read" });
  const req = requestOf(((await startAuthorization(deps, params)) as { location: string }).location);
  await decideRequest(deps, req, OWNER_A, { approve: true, scopes: ["market:read"], agentSlugs: [SLUG_A] });
  const old = await verifyAccessToken(d, deps.cfg, first.tokens.access_token, deps.now());
  assert.deepEqual([...old!.scopes], ["market:read"]);
  assert.equal(client.clientId, first.clientId);
});

test("personal access tokens are per-owner, scoped, expiring and revocable", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const out = await createPersonalToken(d, deps.cfg, OWNER_A, { label: "Codex", scopes: ["market:read", "portfolio:read", "staff:diagnostics"], agentSlugs: [SLUG_A], days: 400 }, [SLUG_A], deps.now());
  assert.match(out.token, /^mcp_pat_/);
  assert.deepEqual(out.scopes, ["market:read", "portfolio:read"]);
  assert.equal(out.expiresAt, deps.now() + 90 * 86_400);
  const p = await verifyAccessToken(d, deps.cfg, out.token, deps.now());
  assert.equal(p?.kind, "personal");
  await assert.rejects(createPersonalToken(d, deps.cfg, OWNER_A, { label: "x", scopes: ["market:read"], agentSlugs: [SLUG_B], days: 1 }, [SLUG_A], deps.now()), /own agents/);
  await revokeConnection(d, OWNER_A, out.connectionId, deps.now());
  assert.equal(await verifyAccessToken(d, deps.cfg, out.token, deps.now()), null);
});

test("malformed bearer strings never hit the database as a match", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  for (const t of ["", "x", "mcp_at_' OR 1=1 --", `mcp_rt_${"a".repeat(43)}`, `Bearer mcp_at_${"a".repeat(43)}`]) {
    assert.equal(await verifyAccessToken(d, deps.cfg, t, deps.now()), null, t);
  }
  // A refresh token is not an access token.
  const { tokens } = await connectAs(deps, OWNER_A);
  assert.equal(await verifyAccessToken(d, deps.cfg, tokens.refresh_token, deps.now()), null);
  assert.equal(ACCOUNT_A.length, 42);
});

// ── review fixes ────────────────────────────────────────────────────────────

test("CIMD: a client_id on one of our own hosts, or with a query, fragment or dot segments, is refused before any fetch", async () => {
  const cfg = testConfig({ resource: "https://mcp.app.test/mcp", allowedHosts: new Set(["app.test", "edge.app.test:8443"]) });
  const own = ownHostsOf(cfg);
  assert.deepEqual([...own].sort(), ["app.test", "edge.app.test", "mcp.app.test"]);
  assert.ok(isCimdClientId("https://claude.ai/oauth/claude-code-client-metadata", own));
  for (const bad of [
    // The image proxy echoes any https body labelled image/*: "Verified at app.test" would be a lie.
    "https://app.test/api/coin-image?uri=https%3A%2F%2Fattacker.example%2Fdoc.json",
    "https://app.test/api/coin-image/doc.json",
    "https://app.test./api/coin-image/doc.json",
    "https://app.test:8443/doc.json",
    "https://mcp.app.test/doc.json",
    "https://edge.app.test/doc.json",
    "https://client.example/doc.json?v=1",
    "https://client.example/doc.json?",
    "https://client.example/doc.json#x",
    "https://client.example/a/../doc.json",
    "https://client.example/a/%2e%2e/doc.json",
    "https://client.example/./doc.json",
    "https://client.example:443/doc.json",
    "https://Client.example/doc.json",
    "https://user@client.example/doc.json",
    "http://client.example/doc.json",
    "https://client.example/",
  ]) assert.equal(isCimdClientId(bad, own), false, bad);

  const d = await makeTestDb();
  let fetches = 0;
  const serve = cimdFetcher(["https://attacker.example/cb"]);
  const deps = makeDeps(d, { cfg, fetcher: async (url) => { fetches += 1; return serve(url); } });
  const selfId = "https://app.test/api/coin-image/doc.json";
  await assert.rejects(resolveClient(d, selfId, deps.now(), { ownHosts: own, fetcher: deps.fetcher }), /client_id must be/);
  const out = await startAuthorization(deps, authorizeParams(selfId, { redirect_uri: "https://attacker.example/cb" }));
  assert.equal(out.kind, "page_error");
  assert.equal((out as { error: string }).error, "invalid_client");
  assert.equal(fetches, 0, "our own host is never fetched");
  // A copy cached under the old, looser rule is not served either.
  d.raw.prepare(`INSERT INTO mcp_clients (client_id, kind, client_name, redirect_uris, auth_method, secret_hash, metadata_json, created_at, fetched_at, expires_at)
    VALUES (?, 'cimd', 'Merrymen Assistant', '["https://attacker.example/cb"]', 'none', NULL, '{}', 1, ?, ?)`).run(selfId, deps.now(), deps.now() + 3600);
  await assert.rejects(resolveClient(d, selfId, deps.now(), { ownHosts: own }), /client_id must be/);
});

test("CIMD: only a 200 answer labelled JSON is a metadata document", async () => {
  for (const t of ["application/json", "application/json; charset=utf-8", "Application/JSON", "application/client-metadata+json"]) {
    assert.ok(acceptableCimdResponse(200, t), t);
  }
  for (const [status, t] of [[200, "image/png"], [200, undefined], [200, ""], [200, "text/plain"], [200, "text/json"], [200, "application/jsonp"], [200, "application/json-seq"], [201, "application/json"], [404, "application/json"]] as const) {
    assert.equal(acceptableCimdResponse(status, t), false, `${status} ${t}`);
  }
  const d = await makeTestDb();
  const own = ownHostsOf(testConfig());
  const id = "https://client.example/oauth/metadata.json";
  // What an image proxy hop would return: a valid document labelled image/png.
  await assert.rejects(resolveClient(d, id, 1_800_000_000, { ownHosts: own, fetcher: cimdFetcher(["https://client.example/cb"], { contentType: "image/png" }) }), /application\/json/);
  await assert.rejects(resolveClient(d, id, 1_800_000_000, { ownHosts: own, fetcher: cimdFetcher(["https://client.example/cb"], { contentType: undefined }) }), /application\/json/);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM mcp_clients").get() as { n: number }).n, 0);
  const ok = await resolveClient(d, id, 1_800_000_000, { ownHosts: own, fetcher: cimdFetcher(["https://client.example/cb"]) });
  assert.equal(ok.displayHost, "client.example");
});

test("CIMD: only the parsed fields are stored, once, as canonical ASCII, bounded in bytes", async () => {
  const d = await makeTestDb();
  const own = ownHostsOf(testConfig());
  const at = 1_800_000_000;
  const padded = cimdFetcher(["https://client.example/cb"], {}, { padding: "x".repeat(60_000) });
  for (let i = 0; i < 5; i++) await resolveClient(d, `https://client.example/c/${i}`, at, { ownHosts: own, fetcher: padded, cacheNew: true });
  const rows = d.raw.prepare("SELECT client_name, metadata_json, redirect_uris FROM mcp_clients WHERE kind = 'cimd'").all() as Array<{ client_name: string; metadata_json: string; redirect_uris: string }>;
  assert.equal(rows.length, 5);
  for (const r of rows) {
    // The name and the redirects have their own columns: nothing is stored twice.
    assert.equal(r.metadata_json, "{}");
    assert.equal(r.client_name, "Claude Code");
    assert.deepEqual(JSON.parse(r.redirect_uris), ["https://client.example/cb"]);
  }

  // Stored as canonical hrefs (the form a code is actually sent to), and the
  // document's own spellings still match at authorize.
  const han = String.fromCodePoint(0x6f22);
  const spelled = [`https://client.example/${han}/cb`, "http://127.0.0.1:33418", "https://Client.Example:443/a/../back"];
  const canon = await resolveClient(d, "https://client.example/canon", at, { ownHosts: own, fetcher: cimdFetcher(spelled), cacheNew: true });
  assert.deepEqual(canon.redirectUris, ["https://client.example/%E6%BC%A2/cb", "http://127.0.0.1:33418/", "https://client.example/back"]);
  const stored = (d.raw.prepare("SELECT redirect_uris FROM mcp_clients WHERE client_id = ?").get("https://client.example/canon") as { redirect_uris: string }).redirect_uris;
  assert.equal(Buffer.byteLength(stored, "utf8"), stored.length, "ASCII only");
  for (const raw of spelled) assert.ok(redirectMatches(canon.redirectUris, raw), raw);
  assert.ok(redirectMatches(canon.redirectUris, "http://127.0.0.1:50000"), "a loopback redirect may use any port");
  assert.ok(!redirectMatches(canon.redirectUris, "https://client.example/other"));
  assert.ok(!redirectMatches(canon.redirectUris, "https://client.example/x/../other"));
  const deps = makeDeps(d, { fetcher: cimdFetcher(spelled) });
  const start = await startAuthorization(deps, authorizeParams("https://client.example/canon", { redirect_uri: spelled[0] }));
  assert.equal(start.kind, "consent");
  const decided = await decideRequest(deps, requestOf((start as { location: string }).location), OWNER_A, { approve: true, agentSlugs: [SLUG_A] });
  assert.equal(new URL(decided.location).pathname, "/%E6%BC%A2/cb", "the code goes to the registered (canonical) URL");

  // The cap is UTF-8 bytes of what is stored: ten short-looking non-ASCII
  // redirects that fit a 4096-character count are refused.
  const wide = Array.from({ length: 10 }, (_, i) => `https://e.example/${i}${han.repeat(100)}`);
  assert.ok(JSON.stringify(wide).length < 4096);
  await assert.rejects(resolveClient(d, "https://client.example/wide", at, { ownHosts: own, fetcher: cimdFetcher(wide), cacheNew: true }), /too long/);
  const long = Array.from({ length: 10 }, (_, i) => `https://client.example/${"p".repeat(1000)}/${i}`);
  await assert.rejects(resolveClient(d, "https://client.example/long", at, { ownHosts: own, fetcher: cimdFetcher(long), cacheNew: true }), /too long/);

  // The worst row anyone can make this server keep: the longest client_id, the
  // longest name in 3-byte characters, and redirects at the byte cap.
  const fits = Array.from({ length: 10 }, (_, i) => `https://client.example/${"p".repeat(160)}/${i}`);
  assert.ok(Buffer.byteLength(JSON.stringify(fits)) <= CIMD_REDIRECTS_MAX_BYTES);
  const longId = `https://client.example/${"a".repeat(512 - 23)}`;
  assert.equal(longId.length, 512);
  const worst: CimdFetcher = async (url) => ({
    status: 200, contentType: "application/json", cacheControl: "max-age=86400",
    body: Buffer.from(JSON.stringify({ client_id: url, client_name: han.repeat(100), redirect_uris: fits })),
  });
  await resolveClient(d, longId, at, { ownHosts: own, fetcher: worst, cacheNew: true });
  const row = d.raw.prepare("SELECT client_id, client_name, redirect_uris, metadata_json FROM mcp_clients WHERE client_id = ?").get(longId) as Record<string, string>;
  const bytes = Object.values(row).reduce((n, v) => n + Buffer.byteLength(v, "utf8"), 0);
  assert.ok(bytes < 3 * 1024, `the row holds ${bytes} bytes`);
});

test("CIMD: the token and revocation endpoints never cache a new metadata document; they only refresh one authorize cached", async () => {
  const d = await makeTestDb();
  let fetches = 0;
  const serve = cimdFetcher(["http://127.0.0.1/callback"], { cacheControl: "max-age=86400" });
  const deps = makeDeps(d, { fetcher: async (url) => { fetches += 1; return serve(url); } });
  const count = () => (d.raw.prepare("SELECT COUNT(*) AS n FROM mcp_clients").get() as { n: number }).n;
  for (let i = 0; i < 20; i++) {
    const id = `https://client.example/probe/${i}`;
    // /oauth/token and /oauth/revoke authenticate the client first, and a public
    // metadata-document client passes that step; with no code or token it can go no further.
    const client = await authenticateClient(deps, new URLSearchParams({ client_id: id, grant_type: "authorization_code", code: "x" }), null);
    assert.equal(client.clientId, id);
    await assert.rejects(exchangeCode(deps, new URLSearchParams({ grant_type: "authorization_code", code: "c".repeat(40), client_id: id }), client), /invalid/);
    await revokeToken(deps, new URLSearchParams({ token: "t".repeat(40), client_id: id }), client);
  }
  assert.equal(fetches, 20);
  assert.equal(count(), 0, "nothing is stored for a client that never started an authorization");

  // A copy cached at authorize is used while fresh, then re-fetched and refreshed in place.
  const id = "https://client.example/oauth/metadata.json";
  const start = await startAuthorization(deps, authorizeParams(id, { redirect_uri: "http://127.0.0.1:61234/callback" }));
  assert.equal(start.kind, "consent");
  assert.equal(count(), 1);
  const fetchedAt = () => (d.raw.prepare("SELECT fetched_at FROM mcp_clients WHERE client_id = ?").get(id) as { fetched_at: number }).fetched_at;
  const cachedAt = fetchedAt();
  const before = fetches;
  await authenticateClient(deps, new URLSearchParams({ client_id: id }), null);
  assert.equal(fetches, before, "a fresh cached copy is used without fetching");
  deps.advance(86_401);
  await authenticateClient(deps, new URLSearchParams({ client_id: id }), null);
  assert.equal(fetches, before + 1);
  assert.equal(count(), 1);
  assert.equal(fetchedAt(), cachedAt + 86_401);
});

test("CIMD: the stored redirect list is capped at exactly 2 KB of UTF-8 (the documented bound)", async () => {
  assert.equal(CIMD_REDIRECTS_MAX_BYTES, 2048, "docs/mcp/oauth.md states this bound; change both together");
  const d = await makeTestDb();
  const own = ownHostsOf(testConfig());
  // JSON of a one-element list is the URL plus 4 bytes (brackets and quotes).
  const url = (bytes: number) => `https://client.example/${"p".repeat(bytes - 4 - "https://client.example/".length)}`;
  assert.equal(Buffer.byteLength(JSON.stringify([url(2048)])), 2048);
  await resolveClient(d, "https://client.example/at-cap", 1_000, { ownHosts: own, fetcher: cimdFetcher([url(2048)]), cacheNew: true });
  await assert.rejects(resolveClient(d, "https://client.example/over-cap", 1_000, { ownHosts: own, fetcher: cimdFetcher([url(2049)]), cacheNew: true }), /too long/);
});

test("CIMD: an app the owner is connected to gets its cached copy back at the token endpoint, so one failed fetch cannot disconnect it", async () => {
  const d = await makeTestDb();
  let down = false;
  const serve = cimdFetcher(["http://127.0.0.1/callback"], { cacheControl: "max-age=3600" });
  const deps = makeDeps(d, { fetcher: async (url) => { if (down) throw new Error("ECONNRESET"); return serve(url); } });
  const id = "https://client.example/oauth/metadata.json";
  const count = () => (d.raw.prepare("SELECT COUNT(*) AS n FROM mcp_clients WHERE client_id = ?").get(id) as { n: number }).n;
  const start = await startAuthorization(deps, authorizeParams(id, { redirect_uri: "http://127.0.0.1:61234/callback" }));
  assert.equal(start.kind, "consent");
  const decided = await decideRequest(deps, requestOf((start as { location: string }).location), OWNER_A, { approve: true, agentSlugs: [SLUG_A] });
  const code = new URL(decided.location).searchParams.get("code")!;
  const client = await authenticateClient(deps, new URLSearchParams({ client_id: id }), null);
  const tokens = await exchangeCode(deps, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1:61234/callback", code_verifier: VERIFIER, client_id: id, resource: "https://app.test/mcp" }), client);

  // Days later retention has dropped the row (its stale window passed).
  deps.advance(3 * 86_400);
  d.raw.prepare("DELETE FROM mcp_clients WHERE client_id = ?").run(id);
  assert.equal(count(), 0);
  const refreshed = await refreshTokens(deps, new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: id }), await authenticateClient(deps, new URLSearchParams({ client_id: id }), null));
  assert.equal(count(), 1, "the actively connected client's row is restored by the token endpoint");

  // Ten minutes after the copy expires, the client's host is unreachable: the copy serves.
  deps.advance(3_600 + 600);
  down = true;
  const again = await authenticateClient(deps, new URLSearchParams({ client_id: id }), null);
  assert.equal(again.clientId, id);
  assert.ok(refreshed.access_token);

  // With no copy at all, an outage is a retryable 503, never a fatal 401 invalid_client.
  d.raw.prepare("DELETE FROM mcp_clients WHERE client_id = ?").run(id);
  await assert.rejects(authenticateClient(deps, new URLSearchParams({ client_id: id }), null),
    (e: unknown) => e instanceof OAuthError && e.status === 503 && e.error === "temporarily_unavailable");

  // A client nobody is connected to still stores nothing at the token endpoint.
  down = false;
  await authenticateClient(deps, new URLSearchParams({ client_id: "https://client.example/other.json" }), null);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM mcp_clients WHERE client_id = ?").get("https://client.example/other.json") as { n: number }).n, 0);
});

test("OAuth bodies are read with a bound: a chunked body with no Content-Length is cut off, not buffered", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(4096).fill(97);
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled >= 1000) { c.close(); return; }
      pulled += 1;
      c.enqueue(chunk);
    },
  });
  const chunked = new Request("https://app.test/oauth/token", { method: "POST", body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
  assert.equal(chunked.headers.get("content-length"), null);
  assert.equal(await readForm(chunked), null);
  assert.ok(pulled <= Math.ceil(FORM_MAX / chunk.length) + 3, `pulled ${pulled} of 1000 chunks`);

  const post = (body: string, type = "application/x-www-form-urlencoded") => new Request("https://app.test/oauth/token", { method: "POST", body, headers: { "content-type": type } });
  assert.equal((await readForm(post("grant_type=refresh_token&refresh_token=x")))?.get("grant_type"), "refresh_token");
  assert.equal((await readForm(post(JSON.stringify({ grant_type: "authorization_code" }), "application/json")))?.get("grant_type"), "authorization_code");
  const atLimit = `a=${"b".repeat(FORM_MAX - 2)}`;
  assert.equal((await readBoundedText(post(atLimit), FORM_MAX))?.length, FORM_MAX);
  assert.equal(await readBoundedText(post(`${atLimit}c`), FORM_MAX), null);
  assert.equal(await readBoundedText(new Request("https://app.test/oauth/register", { method: "POST" }), 10), "");
});

test("offline_access is never an owner choice: not offered, echoed when asked, and refresh tokens are issued either way", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const clientId = await publicClient(deps);
  const req = requestOf(((await startAuthorization(deps, authorizeParams(clientId))) as { location: string }).location);
  const view = await describeRequest(deps, req, OWNER_A);
  assert.ok(!view.scopes.some((s) => s.id === "offline_access"), "never shown as a choice");
  assert.equal(view.maxDays, 90);
  // The consent page sends back only what it showed; the grant still echoes offline_access.
  const decided = await decideRequest(deps, req, OWNER_A, { approve: true, scopes: view.scopes.filter((s) => s.defaultOn).map((s) => s.id), agentSlugs: [SLUG_A] });
  const code = new URL(decided.location).searchParams.get("code")!;
  const client = await resolveClient(d, clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  const tokens = await exchangeCode(deps, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId }), client);
  assert.ok(tokens.scope.split(" ").includes("offline_access"));
  assert.match(tokens.refresh_token, /^mcp_rt_/);
  // Choosing only offline_access is choosing nothing.
  const req2 = requestOf(((await startAuthorization(deps, authorizeParams(clientId))) as { location: string }).location);
  await assert.rejects(decideRequest(deps, req2, OWNER_A, { approve: true, scopes: ["offline_access"], agentSlugs: [SLUG_A] }), /at least one/);
  // Not asked for: not granted, and a rotating refresh token is still issued (docs/mcp/oauth.md says so).
  const plain = await connectAs(deps, OWNER_A, { scopes: ["market:read", "portfolio:read"], redirect: "http://127.0.0.1:40001/callback" });
  assert.equal(plain.tokens.scope, "market:read portfolio:read");
  assert.match(plain.tokens.refresh_token, /^mcp_rt_/);
});

test("offline_access is described to assistants as what it is: accepted for compatibility, granting nothing extra", async () => {
  const info = scopeInfo("offline_access")!;
  assert.match(info.detail, /compatibility/);
  assert.match(info.detail, /grants nothing extra/);
  assert.match(info.detail, /refresh tokens whether or not/);
  assert.match(info.detail, /disconnect/);
  // The scope catalogue every connection can read is built from this text.
  const catalogue = DOC_RESOURCES.find((r) => r.name === "capabilities")!;
  const doc = await catalogue.read(new URL(catalogue.uri), {}, undefined as never);
  const line = (doc as { text: string }).text.split("\n").find((l) => l.startsWith("- `offline_access`"))!;
  assert.match(line, /grants nothing extra/);
  assert.doesNotMatch(line, /without signing in again|stay connected/i);
});

test("Connected apps: the owner's POST body is read with a bound, never buffered whole", async () => {
  const keys = ["MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_PUBLIC_ORIGIN", "MERRYMEN_SESSION_SECRET", "MERRYMEN_OAUTH_ISSUER", "MERRYMEN_MCP_RESOURCE_URL", "MERRYMEN_MCP_ENABLED"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { MERRYMEN_HOSTED: "1", DATABASE_URL: "postgres://unused-in-tests", MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_SESSION_SECRET: "s".repeat(48) });
  for (const k of ["MERRYMEN_OAUTH_ISSUER", "MERRYMEN_MCP_RESOURCE_URL", "MERRYMEN_MCP_ENABLED"]) delete process.env[k];
  const d = await makeTestDb();
  const restore = installFixtures(d);
  try {
    const headers = { origin: "https://app.test", cookie: `mm_session=${mintSession(OWNER_A)}`, "content-type": "application/json" };
    let pulled = 0;
    const chunk = new Uint8Array(4096).fill(32);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= 1000) { c.close(); return; }
        pulled += 1;
        c.enqueue(chunk);
      },
    });
    const big = await connectionsPost(new Request("https://app.test/api/mcp/connections", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit & { duplex: "half" }));
    assert.equal(big.status, 400);
    assert.ok(pulled <= Math.ceil((8 * 1024) / chunk.length) + 3, `pulled ${pulled} of 1000 chunks`);
    // An ordinary body is still read: revoking a connection the owner does not have is not_found.
    const small = await connectionsPost(new Request("https://app.test/api/mcp/connections", {
      method: "POST", headers, body: JSON.stringify({ action: "revoke", id: `mcpcon_${"0".repeat(32)}` }),
    }));
    assert.equal(small.status, 404);
    assert.deepEqual(await small.json(), { error: "not_found" });
  } finally {
    restore();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("a self-registered app is shown and recorded under the host its code actually goes to", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const reg = await registerClient(d, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"], token_endpoint_auth_method: "none" }, deps.now());
  const start = await startAuthorization(deps, authorizeParams(String(reg.body.client_id), { redirect_uri: "https://evil.example/cb" }));
  const req = requestOf((start as { location: string }).location);
  const view = await describeRequest(deps, req, OWNER_A);
  assert.deepEqual({ name: view.client.name, host: view.client.host, registration: view.client.registration, redirectHost: view.client.redirectHost },
    { name: null, host: "evil.example", registration: "dynamic", redirectHost: "evil.example" });
  const decided = await decideRequest(deps, req, OWNER_A, { approve: true, agentSlugs: [SLUG_A] });
  assert.equal(new URL(decided.location).host, "evil.example");
  const [conn] = await listConnections(d, OWNER_A);
  assert.equal(conn.clientHost, "evil.example", "Connected apps names where the tokens went, not the first registered redirect");
});

test("client names with control, format or line-separator characters are dropped", async () => {
  const d = await makeTestDb();
  const id = "https://client.example/oauth/metadata.json";
  // C1 controls (CSI, NEL), the Arabic letter mark, line/paragraph separators, bidi marks, BOM, soft hyphen, DEL, ESC.
  for (const cp of [0x9b, 0x85, 0x61c, 0x2028, 0x2029, 0x200e, 0x202e, 0x2066, 0xfeff, 0xad, 0x7f, 0x1b]) {
    const name = `Claude${String.fromCodePoint(cp)}Code`;
    const reg = await registerClient(d, { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: name }, 1);
    assert.equal(reg.status, 201);
    assert.equal(reg.body.client_name, undefined, `U+${cp.toString(16)}`);
    const doc = parseCimd(id, Buffer.from(JSON.stringify({ client_id: id, client_name: name, redirect_uris: ["https://client.example/cb"] })));
    assert.equal(doc.clientName, null, `U+${cp.toString(16)}`);
  }
  for (const name of ["Claude Code", "Клод · 코드 (beta)"]) {
    const reg = await registerClient(d, { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: name }, 1);
    assert.equal(reg.body.client_name, name);
  }
});

/**
 * Runs on SQLite but reports itself as Postgres, so the `FOR UPDATE` clauses
 * are emitted: each statement is recorded (with whether it ran inside a
 * transaction), then the lock clause is stripped before SQLite sees it.
 */
function recordingDb(inner: McpDb): { d: McpDb; log: string[] } {
  const log: string[] = [];
  const wrap = (db: Db, inTx: boolean): Db => ({
    prepare(sql: string): Stmt {
      const flat = sql.replace(/\s+/g, " ").trim();
      const stmt = db.prepare(sql.replace(/ FOR UPDATE/g, ""));
      const rec = <T>(f: () => Promise<T>) => { log.push(`${inTx ? "tx" : "--"} ${flat}`); return f(); };
      return { run: (...p) => rec(() => stmt.run(...p)), get: (...p) => rec(() => stmt.get(...p)), all: (...p) => rec(() => stmt.all(...p)) };
    },
    exec: (sql) => db.exec(sql),
    tx: (fn) => db.tx(async (scoped) => {
      log.push("BEGIN");
      const out = await fn(wrap(scoped, true));
      log.push("COMMIT");
      return out;
    }),
  });
  return { d: { db: wrap(inner.db, false), dialect: "postgres" }, log };
}

test("token-family writes are serialised on the connection row, so a revocation cannot miss a concurrently minted pair", async () => {
  // Postgres READ COMMITTED: a statement sees what was committed when IT began.
  // Taking the connection lock in an earlier statement than the one that decides
  // (or revokes) means a revoker queued behind a rotation runs its UPDATE after
  // that rotation committed, and a rotation queued behind a revoker re-reads its
  // token after the revocation committed. SQLite cannot interleave the two, so
  // this pins the statement order that makes it true on Postgres.
  const base = await makeTestDb();
  const setup = makeDeps(base);
  const a = await connectAs(setup, OWNER_A);
  const { d, log } = recordingDb(base);
  const deps = makeDeps(d);
  const client = await resolveClient(d, a.clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  const LOCK = /^tx SELECT id, tenant, status, scopes, resource FROM mcp_connections WHERE id = \? FOR UPDATE$/;
  const at = (re: RegExp) => log.findIndex((l) => re.test(l));
  const r = (token: string) => new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: a.clientId });

  // Rotation: before the lock, only the connection id is looked up; the token is decided on, spent and replaced after it.
  log.length = 0;
  const second = await refreshTokens(deps, r(a.tokens.refresh_token), client);
  const lock = at(LOCK);
  assert.ok(lock > 0, log.join("\n"));
  for (const l of log.slice(0, lock)) assert.ok(l === "BEGIN" || l === "tx SELECT connection_id FROM mcp_tokens WHERE token_hash = ?", l);
  assert.ok(at(/^tx SELECT token_hash, connection_id, kind, family, .* FROM mcp_tokens WHERE token_hash = \? FOR UPDATE$/) > lock);
  assert.ok(at(/^tx UPDATE mcp_tokens SET used_at/) > lock);
  assert.ok(at(/^tx INSERT INTO mcp_tokens/) > lock);

  // Reuse of the spent token: lock, then the family UPDATE, in one transaction.
  log.length = 0;
  await assert.rejects(refreshTokens(deps, r(a.tokens.refresh_token), client), /already used/);
  const reuseLock = at(LOCK);
  const reuseRevoke = at(/^tx UPDATE mcp_tokens SET revoked_at = \? WHERE family = \?/);
  assert.ok(reuseLock >= 0 && reuseRevoke > reuseLock, log.join("\n"));
  assert.ok(!log.slice(reuseLock, reuseRevoke).includes("COMMIT"));
  assert.equal(await verifyAccessToken(base, deps.cfg, second.access_token, deps.now()), null, "the pair the rotation minted is in the revoked family");

  // Client revocation (RFC 7009) of a refresh token: its own transaction, lock, then revoke, then commit.
  const b = await connectAs(setup, OWNER_A, { redirect: "http://127.0.0.1:40002/callback" });
  const bClient = await resolveClient(d, b.clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  log.length = 0;
  await revokeToken(deps, new URLSearchParams({ token: b.tokens.refresh_token, client_id: b.clientId }), bClient);
  const begin = log.indexOf("BEGIN");
  const revLock = at(LOCK);
  const revUpdate = at(/^tx UPDATE mcp_tokens SET revoked_at = \? WHERE family = \?/);
  assert.ok(begin >= 0 && revLock > begin && revUpdate > revLock && log.indexOf("COMMIT") > revUpdate, log.join("\n"));
  assert.equal(await verifyAccessToken(base, deps.cfg, b.tokens.access_token, deps.now()), null);

  // Code exchange mints under the lock (code row → connection row → tokens); a replay revokes under it.
  const start = await startAuthorization(deps, authorizeParams(a.clientId, { redirect_uri: "http://127.0.0.1:33418/callback" }));
  const decided = await decideRequest(deps, requestOf((start as { location: string }).location), OWNER_A, { approve: true, agentSlugs: [SLUG_A] });
  const code = new URL(decided.location).searchParams.get("code")!;
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1:33418/callback", code_verifier: VERIFIER, client_id: a.clientId });
  log.length = 0;
  const minted = await exchangeCode(deps, form, client);
  const codeLock = at(/^tx SELECT code_hash, .* FROM mcp_codes WHERE code_hash = \? FOR UPDATE$/);
  const mintLock = at(LOCK);
  assert.ok(codeLock >= 0 && mintLock > codeLock && at(/^tx INSERT INTO mcp_tokens/) > mintLock, log.join("\n"));
  log.length = 0;
  await assert.rejects(exchangeCode(deps, form, client), /already used/);
  const replayLock = at(LOCK);
  assert.ok(replayLock >= 0 && at(/^tx UPDATE mcp_tokens SET revoked_at = \? WHERE family = \?/) > replayLock, log.join("\n"));
  assert.equal(await verifyAccessToken(base, deps.cfg, minted.access_token, deps.now()), null);
});

// ── round 3 ─────────────────────────────────────────────────────────────────

test("a client that requests exactly the 401 challenge's scope can be granted any non-staff scope, and only what the owner ticks", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  // What a spec-following client (Claude Code, the SDK clients) sends to /oauth/authorize.
  const asked = /scope="([^"]*)"/.exec(bearerChallenge(deps.cfg))![1]!;
  const clientId = await publicClient(deps);
  const newRequest = async () => {
    const start = await startAuthorization(deps, authorizeParams(clientId, { scope: asked }));
    assert.equal(start.kind, "consent");
    return requestOf((start as { location: string }).location);
  };
  const req = await newRequest();
  const view = await describeRequest(deps, req, OWNER_A);
  const offered = view.scopes.map((s) => s.id);
  for (const s of ["watchlist:manage", "notifications:manage", "jobs:run", "drafts:write", "trade:propose", "social:write"]) assert.ok(offered.includes(s), `${s} is offered`);
  assert.ok(!offered.includes("staff:diagnostics"));
  for (const s of view.scopes) if (s.level === "sensitive") assert.equal(s.defaultOn, false, `${s.id} starts unticked`);
  // The owner ticks trade:propose: it is granted, and nothing else they left unticked.
  const decided = await decideRequest(deps, req, OWNER_A, { approve: true, scopes: ["market:read", "agents:read", "trade:propose"], agentSlugs: [SLUG_A] });
  const code = new URL(decided.location).searchParams.get("code")!;
  const client = await resolveClient(d, clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  const tokens = await exchangeCode(deps, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId }), client);
  const p = await verifyAccessToken(d, deps.cfg, tokens.access_token, deps.now());
  assert.ok(p?.scopes.has("trade:propose"));
  assert.ok(!p?.scopes.has("drafts:write") && !p?.scopes.has("social:write"));
  // A decision that names no scopes gets what the page starts with ticked, never a sensitive scope.
  const req2 = await newRequest();
  await decideRequest(deps, req2, OWNER_A, { approve: true, agentSlugs: [SLUG_A] });
  const [conn] = await listConnections(d, OWNER_A);
  for (const s of ["trade:propose", "drafts:write", "social:write", "staff:diagnostics"]) assert.ok(!conn!.scopes.includes(s), s);
  assert.ok(conn!.scopes.includes("market:read"));
});

test("CIMD: a host outage answered over HTTP (5xx, 408, 429, a non-JSON error page) is like a network failure, never a fatal invalid_client", async () => {
  // What defaultFetcher returns for a refused answer: the status and type, an empty body.
  for (const [status, type] of [[503, "text/html"], [502, undefined], [500, "application/json"], [429, "application/json"], [408, "text/plain"], [403, "text/html; charset=utf-8"]] as const) {
    assert.ok(transientCimdAnswer(status, type), `${status} ${type}`);
  }
  for (const [status, type] of [[404, "application/json"], [404, "text/html"], [410, "text/html; charset=utf-8"], [410, "application/problem+json"], [403, "application/json"], [200, "text/plain"], [200, "application/json"]] as const) {
    assert.equal(transientCimdAnswer(status, type), false, `${status} ${type}`);
  }

  const d = await makeTestDb();
  let answer: Awaited<ReturnType<CimdFetcher>> | null = null;
  const serve = cimdFetcher(["http://127.0.0.1/callback"], { cacheControl: "max-age=3600" });
  const deps = makeDeps(d, { fetcher: async (url) => answer ?? serve(url) });
  const id = "https://client.example/oauth/metadata.json";
  const start = await startAuthorization(deps, authorizeParams(id, { redirect_uri: "http://127.0.0.1:61234/callback" }));
  assert.equal(start.kind, "consent");
  // 70 minutes later the cached copy has expired, and the host is having a bad minute.
  deps.advance(70 * 60);
  const refused = (status: number, contentType: string | undefined) => ({ status, contentType, body: Buffer.alloc(0) });
  for (const [status, type] of [[503, "text/html"], [502, undefined], [429, "application/json"], [403, "text/html"]] as const) {
    answer = refused(status, type);
    const c = await authenticateClient(deps, new URLSearchParams({ client_id: id }), null);
    assert.equal(c.clientId, id, `${status}: the recently verified copy serves`);
    assert.deepEqual(c.redirectUris, ["http://127.0.0.1/callback"]);
  }
  // A definite answer is still a definite no.
  answer = refused(404, "application/json");
  await assert.rejects(authenticateClient(deps, new URLSearchParams({ client_id: id }), null),
    (e: unknown) => e instanceof OAuthError && e.status === 401 && e.error === "invalid_client");
  // No copy at all: a retryable 503 at the token endpoint, a 503 page at authorize.
  d.raw.prepare("DELETE FROM mcp_clients WHERE client_id = ?").run(id);
  answer = refused(503, "text/html");
  await assert.rejects(authenticateClient(deps, new URLSearchParams({ client_id: id }), null),
    (e: unknown) => e instanceof OAuthError && e.status === 503 && e.error === "temporarily_unavailable");
  const page = await startAuthorization(deps, authorizeParams(id, { redirect_uri: "http://127.0.0.1:61234/callback" }));
  assert.deepEqual([page.kind, (page as { status: number }).status, (page as { error: string }).error], ["page_error", 503, "temporarily_unavailable"]);
  // A copy older than the stale window is not used.
  answer = null;
  await startAuthorization(deps, authorizeParams(id, { redirect_uri: "http://127.0.0.1:61234/callback" }));
  deps.advance(86_400 + 1);
  answer = refused(503, "text/html");
  await assert.rejects(authenticateClient(deps, new URLSearchParams({ client_id: id }), null),
    (e: unknown) => e instanceof OAuthError && e.status === 503);
});

test("malformed percent-encoding in HTTP Basic client credentials is 401 invalid_client, not a server error", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;
  for (const creds of ["mcpc_abc%zz:secret", "mcpc_abc:sec%E0%A4%A", "%:x", "mcpc_abc:%"]) {
    await assert.rejects(authenticateClient(deps, new URLSearchParams(), basic(creds)),
      (e: unknown) => e instanceof OAuthError && e.status === 401 && e.error === "invalid_client", creds);
  }
  // Well-formed encoding still decodes.
  const reg = await registerClient(d, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }, deps.now());
  const header = basic(`${encodeURIComponent(String(reg.body.client_id))}:${encodeURIComponent(String(reg.body.client_secret))}`);
  assert.equal((await authenticateClient(deps, new URLSearchParams(), header)).clientId, reg.body.client_id);
});

test("authorize refuses a state with a control character on its own page, never storing or echoing it", async () => {
  const d = await makeTestDb();
  // A metadata-document client on loopback would normally get authorize errors at its listener.
  const deps = makeDeps(d, { fetcher: cimdFetcher(["http://127.0.0.1/callback"]) });
  const id = "https://client.example/oauth/metadata.json";
  const dcr = await publicClient(deps);
  const parked = () => (d.raw.prepare("SELECT COUNT(*) AS n FROM mcp_auth_requests").get() as { n: number }).n;
  for (const cp of [0x00, 0x01, 0x0a, 0x1f, 0x7f, 0x85, 0x9b]) {
    const state = `abc${String.fromCharCode(cp)}def`;
    for (const [clientId, redirect] of [[id, "http://127.0.0.1:61234/callback"], [dcr, REDIRECT]]) {
      const out = await startAuthorization(deps, authorizeParams(clientId, { state, redirect_uri: redirect }));
      assert.equal(out.kind, "page_error", `U+${cp.toString(16)} ${clientId}`);
      assert.equal((out as { error: string }).error, "invalid_request");
      assert.equal((out as { status: number }).status, 400);
    }
  }
  // Even an over-long state with a control character is not bounced back.
  const long = await startAuthorization(deps, authorizeParams(id, { state: `${"s".repeat(1100)}${String.fromCharCode(0)}`, redirect_uri: "http://127.0.0.1:61234/callback" }));
  assert.equal(long.kind, "page_error");
  assert.equal(parked(), 0, "nothing was stored");
  // Visible ASCII and non-ASCII letters are still fine.
  for (const state of ["xyz-._~+/=", `${String.fromCharCode(0xe9)}tat`]) {
    assert.equal((await startAuthorization(deps, authorizeParams(dcr, { state }))).kind, "consent", state);
  }
});

test("after the endpoint moves, refreshing a connection made for the old address is invalid_grant, not a token /mcp refuses", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const { tokens, clientId } = await connectAs(deps, OWNER_A);
  const client = await resolveClient(d, clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
  const moved = { ...deps, cfg: { ...deps.cfg, resource: "https://mcp.app.test/mcp" } };
  await assert.rejects(
    refreshTokens(moved, new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId }), client),
    (e: unknown) => e instanceof OAuthError && e.error === "invalid_grant" && /Connect again/.test(e.description),
  );
  // A client that already switched to the new address sends it as `resource` with its old token:
  // still told to reconnect (invalid_grant), not invalid_target.
  await assert.rejects(
    refreshTokens(moved, new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: "https://mcp.app.test/mcp" }), client),
    (e: unknown) => e instanceof OAuthError && e.error === "invalid_grant" && /Connect again/.test(e.description),
  );
  // Where the address did not move, the same token still refreshes.
  const same = await refreshTokens(deps, new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId }), client);
  assert.ok(same.access_token);
});

// ── one-click consent ───────────────────────────────────────────────────────

test("every scope has a short lowercase phrase for the consent screen's summary", () => {
  for (const s of SCOPES) {
    assert.ok(s.phrase.trim().length > 0, `${s.id} has a phrase`);
    assert.equal(s.phrase, s.phrase.trim(), s.id);
    assert.match(s.phrase, /^[a-z]/, `${s.id} starts lowercase, to read after a verb`);
    assert.doesNotMatch(s.phrase, /[.!?;:]$/, `${s.id} is a phrase, not a sentence`);
    assert.ok(s.phrase.split(/\s+/).length <= 6, `${s.id} is short`);
  }
});

/** Connect OWNER_A to one client with trade:propose ticked, then park a new request from that same client. */
async function reconnecting(deps: ReturnType<typeof makeDeps>, scope?: string) {
  const first = await connectAs(deps, OWNER_A, { scopes: ["market:read", "portfolio:read", "trade:propose", "offline_access"] });
  const asked = scope ?? /scope="([^"]*)"/.exec(bearerChallenge(deps.cfg))![1]!;
  const start = await startAuthorization(deps, authorizeParams(first.clientId, { scope: asked }));
  assert.equal(start.kind, "consent");
  return { first, req: requestOf((start as { location: string }).location) };
}

test("a reconnect from the same app is described with what its active connection holds, so a sensitive permission is not dropped", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const since = deps.now();
  const { first, req } = await reconnecting(deps);
  deps.advance(60);
  const view = await describeRequest(deps, req, OWNER_A);
  assert.deepEqual(view.previous, { scopes: ["market:read", "portfolio:read", "trade:propose"], agentSlugs: [SLUG_A], since, partial: false });
  // The tenant is matched however the session spells it.
  const upper = `0x${OWNER_A.slice(2).toUpperCase()}` as const;
  assert.deepEqual((await describeRequest(deps, req, upper)).previous?.scopes, view.previous!.scopes);
  // The page sends that choice back explicitly: the reconnect keeps trade:propose on the same connection.
  await decideRequest(deps, req, OWNER_A, { approve: true, scopes: view.previous!.scopes, agentSlugs: view.previous!.agentSlugs });
  const conns = await listConnections(d, OWNER_A);
  assert.equal(conns.length, 1);
  assert.equal(conns[0]!.id, first.principal.connectionId);
  assert.ok(conns[0]!.scopes.includes("trade:propose"));
});

test("previous is null signed out, for another app, for another owner, and after the owner disconnects", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const { first, req } = await reconnecting(deps);
  assert.equal((await describeRequest(deps, req, null)).previous, null);
  // Owner B has no connection with this app; owner A's is never shown to them.
  assert.equal((await describeRequest(deps, req, OWNER_B)).previous, null);
  // Another app owner A never connected starts from the defaults.
  const other = await publicClient(deps, "http://127.0.0.1:44001/callback");
  const otherStart = await startAuthorization(deps, authorizeParams(other, { redirect_uri: "http://127.0.0.1:44001/callback" }));
  assert.equal((await describeRequest(deps, requestOf((otherStart as { location: string }).location), OWNER_A)).previous, null);
  // Disconnected on Connected apps: the next consent starts fresh.
  assert.ok(await revokeConnection(d, OWNER_A, first.principal.connectionId, deps.now()));
  assert.equal((await describeRequest(deps, req, OWNER_A)).previous, null);
});

test("previous never holds a scope the request does not offer, nor offline_access, nor an agent the owner no longer has", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const { req } = await reconnecting(deps, "market:read agents:read offline_access");
  const view = await describeRequest(deps, req, OWNER_A);
  assert.deepEqual(view.previous?.scopes, ["market:read"]);
  assert.equal(view.previous?.partial, true, "approving would remove portfolio:read and trade:propose");
  const offered = new Set(view.scopes.map((s) => s.id));
  for (const s of view.previous!.scopes) assert.ok(offered.has(s), s);
  // The agent is gone from the owner's directory: it is not carried over.
  const moved = { ...deps, agents: fixtureDirectory({ [OWNER_A]: [agentFixture(SLUG_B, ACCOUNT_A)] }) };
  assert.deepEqual((await describeRequest(moved, req, OWNER_A)).previous?.agentSlugs, []);
});

test("the agent's name comes from the optional dependency, for the signed-in owner only, and never fails the page", async () => {
  const d = await makeTestDb();
  const clientDeps = makeDeps(d);
  const clientId = await publicClient(clientDeps);
  const park = async (deps: ReturnType<typeof makeDeps>) => requestOf(((await startAuthorization(deps, authorizeParams(clientId))) as { location: string }).location);
  const asked: string[] = [];
  const named = makeDeps(d, { agentName: async (tenant) => { asked.push(tenant); return tenant === OWNER_A ? "  Sherwood  " : null; } });
  const req = await park(named);
  assert.deepEqual((await describeRequest(named, req, null)).agents, []);
  assert.deepEqual(asked, [], "signed out: nobody's name is read");
  assert.deepEqual((await describeRequest(named, req, OWNER_A)).agents, [{ slug: SLUG_A, account: ACCOUNT_A, name: "Sherwood" }]);
  assert.deepEqual(asked, [OWNER_A], "only the signed-in owner's name is read");
  // A throwing or missing dependency, or an empty name, is no name, never an error.
  const throwing = makeDeps(d, { agentName: async () => { throw new Error("settings store down"); } });
  assert.equal((await describeRequest(throwing, await park(throwing), OWNER_A)).agents[0]!.name, null);
  assert.equal((await describeRequest(clientDeps, await park(clientDeps), OWNER_A)).agents[0]!.name, null);
  const blank = makeDeps(d, { agentName: async () => "   " });
  assert.equal((await describeRequest(blank, await park(blank), OWNER_A)).agents[0]!.name, null);
  // The name is per owner: with several agents it could label the wrong one, so none is given.
  const several = makeDeps(d, {
    agentName: async () => "Sherwood",
    agents: fixtureDirectory({ [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A), agentFixture(SLUG_B, ACCOUNT_B)] }),
  });
  const both = (await describeRequest(several, await park(several), OWNER_A)).agents;
  assert.deepEqual(both.map((a) => [a.slug, a.name]), [[SLUG_A, null], [SLUG_B, null]]);
});

test("the consent view gives every offered scope its phrase", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const { req } = await reconnecting(deps);
  const view = await describeRequest(deps, req, OWNER_A);
  for (const s of view.scopes) assert.equal(s.phrase, scopeInfo(s.id)!.phrase, s.id);
});

// ── the directory profile (/mcp/directory) ──────────────────────────────────

const DIR = "https://app.test/mcp/directory";
const CANONICAL = "https://app.test/mcp";
const SENSITIVE = ["drafts:write", "social:write", "trade:propose"];
/** Everything a client could ask for, the staff scope included. */
const EVERYTHING = [...ADVERTISED_SCOPES, "staff:diagnostics"].join(" ");
const refreshForm = (token: string, clientId: string, over: Record<string, string> = {}) =>
  new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId, ...over });
const clientOf = (deps: ReturnType<typeof makeDeps>, clientId: string) => resolveClient(deps.d, clientId, deps.now(), { ownHosts: ownHostsOf(deps.cfg) });
const noneSensitive = (scopes: Iterable<string>, what: string) => {
  for (const s of scopes) assert.ok(!SENSITIVE.includes(s) && s !== "staff:diagnostics", `${what}: ${s}`);
};

async function parkRequest(deps: ReturnType<typeof makeDeps>, clientId: string, over: Record<string, string | null>) {
  const start = await startAuthorization(deps, authorizeParams(clientId, over));
  assert.equal(start.kind, "consent", JSON.stringify(start));
  return requestOf((start as { location: string }).location);
}

async function exchange(deps: ReturnType<typeof makeDeps>, clientId: string, location: string, resource?: string) {
  const code = new URL(location).searchParams.get("code")!;
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId });
  if (resource) form.set("resource", resource);
  return exchangeCode(deps, form, await clientOf(deps, clientId));
}

test("directory profile: <resource>/directory by default, overridable, off with MERRYMEN_MCP_DIRECTORY=0, never the canonical path", () => {
  const base = { MERRYMEN_PUBLIC_ORIGIN: "https://app.test", MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp" } as unknown as NodeJS.ProcessEnv;
  const cfg = mcpConfig(base);
  assert.equal(cfg.resource, "https://mcp.test/mcp");
  assert.equal(cfg.directoryResource, "https://mcp.test/mcp/directory");
  assert.equal(resourcePath(cfg), "/mcp");
  assert.equal(resourcePath(cfg, "directory"), "/mcp/directory");
  assert.equal(protectedResourceMetadataUrl(cfg), "https://mcp.test/.well-known/oauth-protected-resource/mcp");
  assert.equal(protectedResourceMetadataUrl(cfg, "directory"), "https://mcp.test/.well-known/oauth-protected-resource/mcp/directory");
  assert.equal(mcpConfig({ ...base, MERRYMEN_MCP_DIRECTORY: "0" }).directoryResource, "", "the kill switch");
  assert.equal(mcpConfig({ ...base, MERRYMEN_MCP_DIRECTORY: "1" }).directoryResource, "https://mcp.test/mcp/directory");
  assert.equal(mcpConfig({ ...base, MERRYMEN_MCP_DIRECTORY: "0" }).resource, "https://mcp.test/mcp", "switching the directory off leaves the canonical endpoint alone");
  const over = mcpConfig({ ...base, MERRYMEN_MCP_DIRECTORY_RESOURCE_URL: "https://dir.test/listing/" });
  assert.equal(over.directoryResource, "https://dir.test/listing");
  assert.ok(over.allowedHosts.has("dir.test"), "the directory answers on its own host");
  for (const bad of ["http://dir.test/x", "https://mcp.test/mcp", "https://other.test/mcp", "https://mcp.test/", "not a url", "https://dir.test/x?y=1", "https://u:p@dir.test/x"]) {
    assert.equal(mcpConfig({ ...base, MERRYMEN_MCP_DIRECTORY_RESOURCE_URL: bad }).directoryResource, "", bad);
  }
  assert.equal(profileOfResource(cfg, "https://mcp.test/mcp"), "full");
  assert.equal(profileOfResource(cfg, "https://mcp.test/mcp/directory"), "directory");
  for (const other of ["https://mcp.test/mcp/", "https://mcp.test/mcp/directory/x", "", null]) assert.equal(profileOfResource(cfg, other), null, String(other));
  assert.equal(profileOfResource(testConfig({ directoryResource: "" }), ""), null, "an empty directory URL names nothing");
});

test("directory profile: its own protected-resource document and 401 challenge list only what it can grant; the canonical ones are unchanged", () => {
  const cfg = testConfig();
  // Exactly the three sensitive scopes and the staff scope are outside it.
  assert.deepEqual(SCOPES.filter((s) => s.level === "sensitive").map((s) => s.id).sort(), SENSITIVE);
  assert.deepEqual([...DIRECTORY_SCOPES].sort(), SCOPES.filter((s) => !SENSITIVE.includes(s.id) && s.level !== "staff").map((s) => s.id).sort());
  const full = protectedResourceMetadata(cfg);
  assert.equal(full.resource, CANONICAL);
  assert.deepEqual(full.scopes_supported, [...ADVERTISED_SCOPES]);
  const dir = protectedResourceMetadata(cfg, "directory");
  assert.equal(dir.resource, DIR, "resource is exactly the directory URL");
  assert.deepEqual(dir.authorization_servers, ["https://app.test"]);
  assert.deepEqual(dir.scopes_supported, ADVERTISED_SCOPES.filter((s) => !SENSITIVE.includes(s)));
  assert.deepEqual(dir.scopes_supported, [...advertisedScopesFor("directory")]);
  noneSensitive(dir.scopes_supported as string[], "directory metadata");
  const challenge = bearerChallenge(cfg, { profile: "directory", error: "invalid_token" });
  assert.match(challenge, /resource_metadata="https:\/\/app\.test\/\.well-known\/oauth-protected-resource\/mcp\/directory"/);
  assert.equal(/scope="([^"]*)"/.exec(challenge)![1], (dir.scopes_supported as string[]).join(" "));
  assert.match(bearerChallenge(cfg), /resource_metadata="https:\/\/app\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal(/scope="([^"]*)"/.exec(bearerChallenge(cfg))![1], ADVERTISED_SCOPES.join(" "), "the canonical challenge still asks for everything grantable");
  assert.deepEqual(authorizationServerMetadata(cfg).scopes_supported, [...ADVERTISED_SCOPES], "authorization-server metadata unchanged");
});

test("directory profile: a request for trade:propose (or any sensitive or staff scope) is cut down before it is parked, so consent never offers it", async () => {
  const d = await makeTestDb();
  // Owner A is staff here: even so, the directory offers no staff scope.
  const deps = makeDeps(d, { cfg: testConfig({ staffTenants: new Set([OWNER_A]) }) });
  const clientId = await publicClient(deps);
  const req = await parkRequest(deps, clientId, { resource: DIR, scope: EVERYTHING });
  const parked = d.raw.prepare("SELECT scopes, resource FROM mcp_auth_requests WHERE id_hash = ?").get(sha256hex(req)) as { scopes: string; resource: string };
  assert.equal(parked.resource, DIR);
  noneSensitive(parked.scopes.split(" "), "parked");
  assert.ok(parked.scopes.split(" ").includes("market:read"));
  const view = await describeRequest(deps, req, OWNER_A);
  assert.equal(view.profile, "directory");
  noneSensitive(view.scopes.map((s) => s.id), "offered");
  assert.ok(!view.scopes.some((s) => s.level === "sensitive" || s.level === "staff"));
  assert.ok(view.scopes.some((s) => s.id === "chat:write"));
  // With a trailing slash the resource is the same address.
  assert.equal((await describeRequest(deps, await parkRequest(deps, clientId, { resource: `${DIR}/`, scope: EVERYTHING }), OWNER_A)).profile, "directory");
  // A request that asks only for what the directory cannot grant has nothing to offer.
  const only = await startAuthorization(deps, authorizeParams(clientId, { resource: DIR, scope: "trade:propose drafts:write social:write staff:diagnostics" }));
  assert.equal(only.kind, "page_error");
  assert.equal((only as { error: string }).error, "invalid_scope");
  // No resource still means the canonical one, which still offers trade:propose (and, to staff, staff).
  const canonical = await parkRequest(deps, clientId, { resource: null, scope: EVERYTHING });
  assert.equal((d.raw.prepare("SELECT resource FROM mcp_auth_requests WHERE id_hash = ?").get(sha256hex(canonical)) as { resource: string }).resource, CANONICAL);
  const fullView = await describeRequest(deps, canonical, OWNER_A);
  assert.equal(fullView.profile, "full");
  for (const s of [...SENSITIVE, "staff:diagnostics"]) assert.ok(fullView.scopes.some((x) => x.id === s), s);
  // Any other address, or the directory's once it is switched off, is invalid_target.
  const off = makeDeps(d, { cfg: testConfig({ directoryResource: "" }) });
  for (const [deps2, resource] of [[deps, "https://app.test/mcp/other"], [deps, "https://app.test/mcp/directory/x"], [off, DIR]] as const) {
    const out = await startAuthorization(deps2, authorizeParams(clientId, { resource }));
    assert.equal((out as { error?: string }).error, "invalid_target", resource);
  }
});

test("directory profile: consent can never grant a sensitive scope: not by default, not by an explicit choice, not from a tampered parked request", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const clientId = await publicClient(deps);
  const req = await parkRequest(deps, clientId, { resource: DIR, scope: EVERYTHING });
  // An explicit choice of a sensitive scope is refused with a reason (and the request survives).
  await assert.rejects(
    decideRequest(deps, req, OWNER_A, { approve: true, scopes: ["market:read", "trade:propose"], agentSlugs: [SLUG_A] }),
    (e: unknown) => e instanceof OAuthError && e.error === "invalid_scope" && /directory listing/.test(e.description),
  );
  // A parked row that somehow holds every scope (written by hand here) is still cut down at each later step.
  d.raw.prepare("UPDATE mcp_auth_requests SET scopes = ? WHERE id_hash = ?").run(EVERYTHING.split(" ").sort().join(" "), sha256hex(req));
  const view = await describeRequest(deps, req, OWNER_A);
  noneSensitive(view.scopes.map((s) => s.id), "offered from a tampered row");
  for (const s of SENSITIVE) {
    await assert.rejects(decideRequest(deps, req, OWNER_A, { approve: true, scopes: ["market:read", s], agentSlugs: [SLUG_A] }), /directory listing/, s);
  }
  // Ticking everything the page shows grants no sensitive scope; the connection is the directory's.
  const decided = await decideRequest(deps, req, OWNER_A, { approve: true, scopes: view.scopes.map((s) => s.id), agentSlugs: [SLUG_A] });
  const row = d.raw.prepare("SELECT scopes, resource FROM mcp_connections WHERE id = ?").get(decided.connectionId) as { scopes: string; resource: string | null };
  assert.equal(row.resource, DIR);
  noneSensitive(row.scopes.split(" "), "stored");
  const tokens = await exchange(deps, clientId, decided.location, DIR);
  noneSensitive(tokens.scope.split(" "), "issued");
  // The default (no explicit choice) likewise.
  const req2 = await parkRequest(deps, clientId, { resource: DIR, scope: EVERYTHING });
  d.raw.prepare("UPDATE mcp_auth_requests SET scopes = ? WHERE id_hash = ?").run(EVERYTHING.split(" ").sort().join(" "), sha256hex(req2));
  const second = await decideRequest(deps, req2, OWNER_A, { approve: true, agentSlugs: [SLUG_A] });
  assert.equal(second.connectionId, decided.connectionId, "the same directory connection");
  noneSensitive((d.raw.prepare("SELECT scopes FROM mcp_connections WHERE id = ?").get(second.connectionId) as { scopes: string }).scopes.split(" "), "default");
});

test("directory profile: a code or token row that somehow carries a sensitive scope still mints, refreshes and verifies without it", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const clientId = await publicClient(deps);
  const all = EVERYTHING.split(" ").sort().join(" ");
  // Code exchange: the code row says everything.
  const req = await parkRequest(deps, clientId, { resource: DIR });
  const decided = await decideRequest(deps, req, OWNER_A, { approve: true, agentSlugs: [SLUG_A] });
  d.raw.prepare("UPDATE mcp_codes SET scopes = ?").run(all);
  const tokens = await exchange(deps, clientId, decided.location);
  noneSensitive(tokens.scope.split(" "), "code exchange");
  // Verification and refresh: the token and the connection both say everything.
  d.raw.prepare("UPDATE mcp_connections SET scopes = ? WHERE id = ?").run(all, decided.connectionId);
  d.raw.prepare("UPDATE mcp_tokens SET scopes = ? WHERE connection_id = ?").run(all, decided.connectionId);
  const p = await verifyAccessToken(d, deps.cfg, tokens.access_token, deps.now(), "directory");
  assert.ok(p);
  assert.equal(p.profile, "directory");
  noneSensitive(p.scopes, "verified");
  assert.ok(p.scopes.has("market:read"));
  const client = await clientOf(deps, clientId);
  const refreshed = await refreshTokens(deps, refreshForm(tokens.refresh_token, clientId, { scope: all }), client);
  noneSensitive(refreshed.scope.split(" "), "refresh asking for everything");
  const noScope = await refreshTokens(deps, refreshForm(refreshed.refresh_token, clientId), client);
  noneSensitive(noScope.scope.split(" "), "refresh with no scope parameter");
  await assert.rejects(refreshTokens(deps, refreshForm(noScope.refresh_token, clientId, { scope: "trade:propose" }), client), /cannot add scopes/);
});

test("directory profile: a code only ever mints for a connection on its own address", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const full = await connectAs(deps, OWNER_A);
  const req = await parkRequest(deps, full.clientId, { resource: DIR });
  const decided = await decideRequest(deps, req, OWNER_A, { approve: true, agentSlugs: [SLUG_A] });
  assert.notEqual(decided.connectionId, full.principal.connectionId);
  // Point the directory code at the full-server connection (never written by the server): refused.
  d.raw.prepare("UPDATE mcp_codes SET connection_id = ? WHERE connection_id = ?").run(full.principal.connectionId, decided.connectionId);
  await assert.rejects(exchange(deps, full.clientId, decided.location), (e: unknown) => e instanceof OAuthError && e.error === "invalid_grant");
  // A code whose address stopped being served while it was in flight mints nothing either.
  const req2 = await parkRequest(deps, full.clientId, { resource: DIR });
  const decided2 = await decideRequest(deps, req2, OWNER_A, { approve: true, agentSlugs: [SLUG_A] });
  const off = { ...deps, cfg: testConfig({ directoryResource: "" }) };
  // So does a consent screen left open while the directory was switched off.
  const parkedThenOff = await parkRequest(deps, full.clientId, { resource: DIR });
  await assert.rejects(describeRequest(off, parkedThenOff, OWNER_A), (e: unknown) => e instanceof OAuthError && e.status === 410);
  await assert.rejects(decideRequest(off, parkedThenOff, OWNER_A, { approve: true, agentSlugs: [SLUG_A] }), (e: unknown) => e instanceof OAuthError && e.status === 410);
  const code = new URL(decided2.location).searchParams.get("code")!;
  await assert.rejects(
    exchangeCode(off, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: full.clientId }), await clientOf(deps, full.clientId)),
    (e: unknown) => e instanceof OAuthError && e.error === "invalid_grant",
  );
});

test("the same app can hold a full-server and a directory connection at once; approving or revoking either leaves the other's scopes and tokens alone", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const full = await connectAs(deps, OWNER_A, { scopes: ["market:read", "portfolio:read", "trade:propose", "offline_access"] });
  const dir = await connectAs(deps, OWNER_A, { profile: "directory", clientId: full.clientId, scopes: ["market:read", "portfolio:read", "chat:write", "offline_access"] });
  assert.notEqual(dir.principal.connectionId, full.principal.connectionId);
  const byId = async () => new Map((await listConnections(d, OWNER_A)).map((c) => [c.id, c]));
  let conns = await byId();
  assert.equal(conns.size, 2);
  assert.equal(conns.get(full.principal.connectionId)!.profile, "full");
  assert.equal(conns.get(dir.principal.connectionId)!.profile, "directory");
  assert.ok(conns.get(full.principal.connectionId)!.scopes.includes("trade:propose"), "connecting the directory did not touch the full connection");
  // Each token works at its own endpoint only.
  const at = (token: string, profile: "full" | "directory") => verifyAccessToken(d, deps.cfg, token, deps.now(), profile);
  assert.ok((await at(full.tokens.access_token, "full"))?.scopes.has("trade:propose"));
  assert.equal(await at(full.tokens.access_token, "directory"), null);
  assert.ok((await at(dir.tokens.access_token, "directory"))?.scopes.has("chat:write"));
  assert.equal(await at(dir.tokens.access_token, "full"), null);

  // Reconnecting through the directory starts from the DIRECTORY connection, never the full one's trade:propose.
  const dirReq = await parkRequest(deps, full.clientId, { resource: DIR, scope: EVERYTHING });
  const dirView = await describeRequest(deps, dirReq, OWNER_A);
  assert.deepEqual(dirView.previous?.scopes, dirView.scopes.map((s) => s.id).filter((s) => ["chat:write", "market:read", "portfolio:read"].includes(s)));
  assert.equal(dirView.previous?.partial, false);
  const again = await decideRequest(deps, dirReq, OWNER_A, { approve: true, scopes: ["market:read"], agentSlugs: [SLUG_A] });
  assert.equal(again.connectionId, dir.principal.connectionId, "the directory connection is updated in place");
  conns = await byId();
  assert.deepEqual(conns.get(dir.principal.connectionId)!.scopes, ["market:read", "offline_access"]);
  assert.deepEqual(conns.get(full.principal.connectionId)!.scopes, ["market:read", "offline_access", "portfolio:read", "trade:propose"]);
  assert.ok((await at(full.tokens.access_token, "full"))?.scopes.has("trade:propose"), "the full connection's tokens keep working, unchanged");

  // Reconnecting the full server starts from the full connection, and leaves the directory's alone.
  const fullReq = await parkRequest(deps, full.clientId, { scope: EVERYTHING });
  const fullView = await describeRequest(deps, fullReq, OWNER_A);
  assert.ok(fullView.previous?.scopes.includes("trade:propose"));
  const fullAgain = await decideRequest(deps, fullReq, OWNER_A, { approve: true, scopes: ["market:read", "portfolio:read"], agentSlugs: [SLUG_A] });
  assert.equal(fullAgain.connectionId, full.principal.connectionId);
  conns = await byId();
  assert.deepEqual(conns.get(dir.principal.connectionId)!.scopes, ["market:read", "offline_access"]);
  const dirP = await at(dir.tokens.access_token, "directory");
  assert.deepEqual([...dirP!.scopes].sort(), ["market:read", "offline_access"], "the directory token still verifies, narrowed only by its own connection");

  // At most one active connection per (owner, app, address), enforced by the database too.
  assert.throws(() => d.raw.prepare(`INSERT INTO mcp_connections (id, tenant, client_id, kind, scopes, agent_slugs, status, created_at, updated_at, resource)
    VALUES ('x1', ?, ?, 'oauth', 'market:read', '[]', 'active', 0, 0, ?)`).run(OWNER_A, full.clientId, DIR), /UNIQUE/);
  assert.throws(() => d.raw.prepare(`INSERT INTO mcp_connections (id, tenant, client_id, kind, scopes, agent_slugs, status, created_at, updated_at, resource)
    VALUES ('x2', ?, ?, 'oauth', 'market:read', '[]', 'active', 0, 0, NULL)`).run(OWNER_A, full.clientId), /UNIQUE/);

  // Disconnecting one leaves the other working.
  assert.ok(await revokeConnection(d, OWNER_A, dir.principal.connectionId, deps.now()));
  assert.equal(await at(dir.tokens.access_token, "directory"), null);
  assert.ok(await at(full.tokens.access_token, "full"));
  assert.equal((await listConnections(d, OWNER_A)).length, 1);
  // A fresh directory consent after the disconnect starts from the defaults, with a new connection.
  const fresh = await parkRequest(deps, full.clientId, { resource: DIR, scope: EVERYTHING });
  assert.equal((await describeRequest(deps, fresh, OWNER_A)).previous, null);
});

test("refresh keeps each token on its own address, on both; a moved or switched-off directory is invalid_grant and leaves /mcp alone", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const full = await connectAs(deps, OWNER_A);
  const dir = await connectAs(deps, OWNER_A, { profile: "directory", clientId: full.clientId });
  const client = await clientOf(deps, full.clientId);
  const resourceOf = (token: string) => (d.raw.prepare("SELECT resource FROM mcp_tokens WHERE token_hash = ?").get(sha256hex(token)) as { resource: string }).resource;
  const f2 = await refreshTokens(deps, refreshForm(full.tokens.refresh_token, full.clientId), client);
  const d2 = await refreshTokens(deps, refreshForm(dir.tokens.refresh_token, full.clientId, { resource: DIR }), client);
  assert.equal(resourceOf(f2.access_token), CANONICAL);
  assert.equal(resourceOf(f2.refresh_token), CANONICAL);
  assert.equal(resourceOf(d2.access_token), DIR);
  assert.equal(resourceOf(d2.refresh_token), DIR);
  assert.ok(await verifyAccessToken(d, deps.cfg, f2.access_token, deps.now(), "full"));
  assert.equal(await verifyAccessToken(d, deps.cfg, f2.access_token, deps.now(), "directory"), null);
  assert.ok(await verifyAccessToken(d, deps.cfg, d2.access_token, deps.now(), "directory"));
  assert.equal(await verifyAccessToken(d, deps.cfg, d2.access_token, deps.now()), null);
  // Asking to move a token to the other address is invalid_target, and spends nothing.
  await assert.rejects(refreshTokens(deps, refreshForm(d2.refresh_token, full.clientId, { resource: CANONICAL }), client), (e: unknown) => e instanceof OAuthError && e.error === "invalid_target");
  await assert.rejects(refreshTokens(deps, refreshForm(f2.refresh_token, full.clientId, { resource: DIR }), client), (e: unknown) => e instanceof OAuthError && e.error === "invalid_target");
  // The directory address moved, or was switched off: its tokens say "connect again"; the full server's refresh as before.
  for (const cfg of [testConfig({ directoryResource: "https://app.test/mcp/listing" }), testConfig({ directoryResource: "" })]) {
    const moved = { ...deps, cfg };
    await assert.rejects(refreshTokens(moved, refreshForm(d2.refresh_token, full.clientId), client), (e: unknown) => e instanceof OAuthError && e.error === "invalid_grant" && /Connect again/.test(e.description));
    assert.equal(await verifyAccessToken(d, cfg, d2.access_token, deps.now(), "directory"), null);
  }
  const f3 = await refreshTokens({ ...deps, cfg: testConfig({ directoryResource: "" }) }, refreshForm(f2.refresh_token, full.clientId), client);
  assert.ok(await verifyAccessToken(d, deps.cfg, f3.access_token, deps.now()));
  // And the canonical endpoint moving is still caught for the canonical token (the existing rule).
  await assert.rejects(refreshTokens({ ...deps, cfg: testConfig({ resource: "https://mcp.app.test/mcp" }) }, refreshForm(f3.refresh_token, full.clientId), client), /Connect again/);
  // Where nothing moved, the directory token still refreshes.
  assert.ok((await refreshTokens(deps, refreshForm(d2.refresh_token, full.clientId), client)).access_token);
});

test("personal access tokens are canonical only: never accepted at the directory endpoint", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const pat = await createPersonalToken(d, deps.cfg, OWNER_A, { label: "Codex", scopes: ["market:read"], agentSlugs: [SLUG_A], days: 7 }, [SLUG_A], deps.now());
  assert.ok(await verifyAccessToken(d, deps.cfg, pat.token, deps.now()));
  assert.equal(await verifyAccessToken(d, deps.cfg, pat.token, deps.now(), "directory"), null);
  // Even a personal token row relabelled with the directory address (never written by the server) is refused.
  d.raw.prepare("UPDATE mcp_tokens SET resource = ? WHERE connection_id = ?").run(DIR, pat.connectionId);
  d.raw.prepare("UPDATE mcp_connections SET resource = ? WHERE id = ?").run(DIR, pat.connectionId);
  assert.equal(await verifyAccessToken(d, deps.cfg, pat.token, deps.now(), "directory"), null);
  const [listed] = await listConnections(d, OWNER_A);
  assert.equal(listed!.kind, "personal");
});

test("after the migration, a connection and tokens written before the resource column existed still verify, refresh and reconnect as the canonical ones", async () => {
  // The database as it was: mcp_connections without `resource`, and the old (tenant, client_id) one-active index.
  const OLD = MCP_SCHEMA.replace("revoked_why TEXT,\n  resource TEXT\n);", "revoked_why TEXT\n);").replace("(tenant, client_id, COALESCE(resource, ''))", "(tenant, client_id)");
  assert.ok(!OLD.includes("COALESCE") && !OLD.includes("revoked_why TEXT,\n  resource TEXT"), "the old DDL was rebuilt");
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.exec(OLD);
  const d = { db, dialect: "sqlite" as const, raw };
  const deps = makeDeps(d);
  const now = deps.now();
  const clientId = await publicClient(deps);
  // Rows exactly as the old code wrote them.
  const conn = randomId("mcpcon_");
  raw.prepare(`INSERT INTO mcp_connections (id, tenant, client_id, client_name, client_host, kind, scopes, agent_slugs, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Claude Code', '127.0.0.1', 'oauth', ?, ?, 'active', ?, ?)`).run(conn, OWNER_A, clientId, "market:read offline_access portfolio:read trade:propose", JSON.stringify([SLUG_A]), now, now);
  const access = randomCredential("mcp_at_");
  const refresh = randomCredential("mcp_rt_");
  const family = randomId("fam_");
  const tok = raw.prepare(`INSERT INTO mcp_tokens (token_hash, connection_id, kind, family, scopes, resource, client_id, label, created_at, expires_at, family_expires_at, used_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL)`);
  tok.run(sha256hex(access), conn, "access", family, "market:read offline_access portfolio:read trade:propose", CANONICAL, clientId, now, now + 3600, now + 86_400);
  tok.run(sha256hex(refresh), conn, "refresh", family, "market:read offline_access portfolio:read trade:propose", CANONICAL, clientId, now, now + 86_400, now + 86_400);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('mcp_connections') WHERE name = 'resource'").get() as { n: number }).n, 0);

  await ensureMcpSchema(db, "sqlite");
  assert.equal((raw.prepare("SELECT resource FROM mcp_connections WHERE id = ?").get(conn) as { resource: string | null }).resource, null, "an old row reads as canonical");
  assert.match((raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'mcp_connections_one_active'").get() as { sql: string }).sql, /COALESCE\(resource, ''\)/);

  const p = await verifyAccessToken(d, deps.cfg, access, now);
  assert.equal(p?.connectionId, conn);
  assert.equal(p?.profile, "full");
  assert.ok(p?.scopes.has("trade:propose"), "nothing it held is lost");
  assert.equal(await verifyAccessToken(d, deps.cfg, access, now, "directory"), null);
  const client = await clientOf(deps, clientId);
  const next = await refreshTokens(deps, refreshForm(refresh, clientId), client);
  assert.ok((await verifyAccessToken(d, deps.cfg, next.access_token, now))?.scopes.has("trade:propose"));
  assert.equal((await listConnections(d, OWNER_A))[0]!.profile, "full");
  // A reconnect of the same app to the full server is that same (NULL) row; a directory connection sits beside it.
  const req = await parkRequest(deps, clientId, { scope: EVERYTHING });
  assert.ok((await describeRequest(deps, req, OWNER_A)).previous?.scopes.includes("trade:propose"));
  assert.equal((await decideRequest(deps, req, OWNER_A, { approve: true, scopes: ["market:read", "trade:propose"], agentSlugs: [SLUG_A] })).connectionId, conn);
  const dir = await connectAs(deps, OWNER_A, { profile: "directory", clientId });
  assert.notEqual(dir.principal.connectionId, conn);
  assert.equal((await listConnections(d, OWNER_A)).length, 2);
  assert.ok((await verifyAccessToken(d, deps.cfg, next.access_token, now))?.scopes.has("trade:propose"), "the old connection kept its grant");
});
