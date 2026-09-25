/**
 * The MCP authorization server end to end, on SQLite: registration, the
 * authorize → consent → code → token flow, PKCE, redirect matching, audience
 * binding, refresh rotation with reuse detection, revocation by client and by
 * owner, personal tokens, and the consent rules (own agents only, no scope
 * escalation, staff scope only for staff).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerClient, parseCimd, redirectMatches, resolveClient, validRedirectUri } from "./clients";
import { pkceS256 } from "./crypto";
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

test("authorize requires PKCE S256, a code response and our resource", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const clientId = await publicClient(deps);
  for (const [over, error] of [
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: null }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ resource: "https://evil.test/mcp" }, "invalid_target"],
    [{ scope: "admin:everything" }, "invalid_scope"],
  ] as const) {
    const out = await startAuthorization(deps, authorizeParams(clientId, over as Record<string, string | null>));
    assert.equal(out.kind, "redirect", JSON.stringify(over));
    const url = new URL((out as { location: string }).location);
    assert.equal(url.searchParams.get("error"), error);
    assert.equal(url.searchParams.get("state"), "xyz");
    assert.equal(url.searchParams.get("iss"), "https://app.test");
  }
  // A trailing slash on the resource is the same resource.
  assert.equal((await startAuthorization(deps, authorizeParams(clientId, { resource: "https://app.test/mcp/" }))).kind, "consent");
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
  const client = await resolveClient(d, clientId, deps.now());
  const newCode = async () => {
    const req = requestOf(((await startAuthorization(deps, authorizeParams(clientId))) as { location: string }).location);
    return new URL((await decideRequest(deps, req, OWNER_A, { approve: true, agentSlugs: [SLUG_A] })).location).searchParams.get("code")!;
  };
  const form = (code: string, over: Record<string, string> = {}) => new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId, ...over });

  await assert.rejects(exchangeCode(deps, form(await newCode(), { code_verifier: "x".repeat(50) }), client), /PKCE/);
  await assert.rejects(exchangeCode(deps, form(await newCode(), { redirect_uri: "http://127.0.0.1:1/other" }), client), /redirect_uri/);
  const otherId = await publicClient(deps);
  const other = await resolveClient(d, otherId, deps.now());
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
  const client = await resolveClient(d, clientId, deps.now());
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
  const client = await resolveClient(d, clientId, deps.now());
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
  const client = await resolveClient(d, a.clientId, deps.now());
  await revokeToken(deps, new URLSearchParams({ token: a.tokens.access_token, client_id: a.clientId }), client);
  assert.equal(await verifyAccessToken(d, deps.cfg, a.tokens.access_token, deps.now()), null);

  const b = await connectAs(deps, OWNER_A);
  assert.equal((await listConnections(d, OWNER_A)).length, 2);
  assert.equal(await revokeConnection(d, OWNER_B, b.principal.connectionId, deps.now()), false, "another owner cannot revoke it");
  assert.equal(await revokeConnection(d, OWNER_A, b.principal.connectionId, deps.now()), true);
  assert.equal(await verifyAccessToken(d, deps.cfg, b.tokens.access_token, deps.now()), null);
  const bClient = await resolveClient(d, b.clientId, deps.now());
  await assert.rejects(refreshTokens(deps, new URLSearchParams({ grant_type: "refresh_token", refresh_token: b.tokens.refresh_token, client_id: b.clientId }), bClient), /revoked/);
});

test("a client cannot revoke another client's token", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const a = await connectAs(deps, OWNER_A);
  const otherId = await publicClient(deps);
  const other = await resolveClient(d, otherId, deps.now());
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
  assert.throws(() => parseCimd(id, Buffer.from(JSON.stringify({ client_id: id, client_name: "Claude‮", redirect_uris: ["https://ok.test/cb"], client_secret: "x" }))), /secret/);

  const d = await makeTestDb();
  const deps = makeDeps(d, {
    fetcher: async (url) => ({ status: 200, body: Buffer.from(JSON.stringify({ client_id: url, client_name: "Claude Code", redirect_uris: ["http://localhost/callback"] })), cacheControl: "max-age=60" }),
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
  const client = await resolveClient(d, first.clientId, deps.now());
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
