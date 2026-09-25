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
  acceptableCimdResponse, isCimdClientId, ownHostsOf, registerClient, parseCimd, redirectMatches, resolveClient, validRedirectUri, type CimdFetcher,
} from "./clients";
import { pkceS256 } from "./crypto";
import { FORM_MAX, readBoundedText, readForm } from "./deps";
import {
  OAuthError, authenticateClient, createPersonalToken, decideRequest, describeRequest, exchangeCode, listConnections,
  refreshTokens, revokeConnection, revokeToken, startAuthorization, verifyAccessToken,
} from "./server";
import { authorizationServerMetadata, protectedResourceMetadata, bearerChallenge } from "./metadata";
import { ACCOUNT_A, OWNER_A, OWNER_B, SLUG_A, SLUG_B, VERIFIER, connectAs, makeDeps, makeTestDb, testConfig } from "../testing";

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
  // Narrowing is allowed; widening is not.
  await assert.rejects(refreshTokens(deps, r(second.refresh_token, { scope: "market:read chat:write" }), client), /cannot add scopes/);
  const narrowed = await refreshTokens(deps, r(second.refresh_token, { scope: "market:read" }), client);
  assert.equal(narrowed.scope, "market:read");
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
  ]) {
    const r = await registerClient(d, bad, 1);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
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

test("CIMD: only the parsed fields are stored, never the fetched body", async () => {
  const d = await makeTestDb();
  const own = ownHostsOf(testConfig());
  const padded = cimdFetcher(["https://client.example/cb"], {}, { padding: "x".repeat(60_000) });
  for (let i = 0; i < 5; i++) await resolveClient(d, `https://client.example/c/${i}`, 1_800_000_000, { ownHosts: own, fetcher: padded });
  const rows = d.raw.prepare("SELECT metadata_json FROM mcp_clients WHERE kind = 'cimd'").all() as Array<{ metadata_json: string }>;
  assert.equal(rows.length, 5);
  for (const r of rows) {
    assert.ok(r.metadata_json.length < 200, `stored ${r.metadata_json.length} bytes`);
    assert.deepEqual(JSON.parse(r.metadata_json), { client_name: "Claude Code", redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none" });
  }
  // A document whose redirect list alone is oversized is refused, so no row can grow past a few KB.
  const long = Array.from({ length: 10 }, (_, i) => `https://client.example/${"p".repeat(1000)}/${i}`);
  await assert.rejects(resolveClient(d, "https://client.example/long", 1_800_000_000, { ownHosts: own, fetcher: cimdFetcher(long) }), /too long/);
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
  const LOCK = /^tx SELECT id, tenant, status, scopes FROM mcp_connections WHERE id = \? FOR UPDATE$/;
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
