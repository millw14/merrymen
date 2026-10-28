import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, mock, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Encode } from "../../../packages/core/src/ids";
import { makePgDb, wrapSqlite, type Db } from "../../../worker/src/db";
import { SqlSolanaBindingStore, SolanaBindingError, SOLANA_OTHER_SIGN_IN } from "./solana-binding-store";

/**
 * SOLANA OWNER KEY RECOVERY (solana-binding-store.ts): a tenant whose verified
 * Privy identity changed re-binds by proving the SAME Solana owner key with a
 * fresh challenge. The store half first, on SQLite and (when
 * MERRYMEN_TEST_PG_URL is set) PostgreSQL; then the remap end to end, through
 * the real Robinhood identity store (file backend), sign-in check, session
 * cookie, bind, status, owner and setup routes and binding store.
 *
 * The end-to-end proofs are signed with raw ed25519 keys, OUTSIDE the page's
 * wallet selection: the page signs only with the signed-in Privy user's own
 * embedded wallet (useSolanaOwner), so a second Privy user's page can never
 * sign with the bound key. For an owner the app created, the recovery a user
 * can take from the page is signing in again with the original login (the
 * last test); a re-bind needs the bound key itself (an exported key imported
 * into the new identity, or an external signer).
 */
const W = `0x${"11".repeat(20)}` as const, OTHER = `0x${"22".repeat(20)}` as const;
const OWNER_SEED = new Uint8Array(32).fill(7), OWNER = base58Encode(ed25519.getPublicKey(OWNER_SEED));
const SECOND_SEED = new Uint8Array(32).fill(8), SECOND = base58Encode(ed25519.getPublicKey(SECOND_SEED));
const THIRD_SEED = new Uint8Array(32).fill(9), THIRD = base58Encode(ed25519.getPublicKey(THIRD_SEED));
const NOW = 1_000_000;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3_600_000 };
const strategy = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 60 };

async function storeFor(t: TestContext, dialect: "sqlite" | "postgres", now = () => NOW): Promise<SqlSolanaBindingStore> {
  let db: Db;
  if (dialect === "sqlite") { const raw = new DatabaseSync(":memory:"); t.after(() => raw.close()); db = wrapSqlite(raw); }
  else {
    const url = new URL(process.env.MERRYMEN_TEST_PG_URL!), schema = `solana_rebind_${randomUUID().replaceAll("-", "")}`;
    const admin = await makePgDb(url.toString()); await admin.exec(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`); db = await makePgDb(url.toString());
    t.after(async () => { await admin.exec(`DROP SCHEMA ${schema} CASCADE`); });
  }
  return new SqlSolanaBindingStore(async () => db, dialect, now);
}
for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: a re-bind replaces only the DID it names on the same tenant and owner, turns the strategy off, bumps the revision and is recorded`, options, async (t) => {
    let clock = NOW;
    const store = await storeFor(t, dialect, () => clock);
    await store.bind(W, "did:privy:alice", OWNER); await store.settings(W, OWNER, 0, "live", limits);
    const on = await store.strategy(W, OWNER, 1, strategy);
    const other = await store.bind(OTHER, "did:privy:carol", SECOND);
    clock += 5;
    // Not this binding: another owner key, a DID it does not hold, a tenant without one.
    for (const [tenant, did, owner, previous, code] of [[W, "did:privy:bob", SECOND, "did:privy:alice", "conflict"], [W, "did:privy:bob", OWNER, "did:privy:mallory", "conflict"],
      [OTHER, "did:privy:bob", OWNER, "did:privy:alice", "conflict"], [`0x${"33".repeat(20)}`, "did:privy:bob", OWNER, "did:privy:alice", "missing"],
      [W, "not-a-did", OWNER, "did:privy:alice", "invalid"]] as const) {
      await assert.rejects(store.rebind(tenant, did, owner, previous), (error: unknown) => error instanceof SolanaBindingError && error.code === code, `${tenant} ${did} ${owner} ${previous}`);
    }
    assert.deepEqual(await store.get(W), on); assert.deepEqual(await store.get(OTHER), other);
    const rebound = await store.rebind(W, "did:privy:bob", OWNER, "did:privy:alice");
    assert.deepEqual(rebound, { ...on, did: "did:privy:bob", strategy: { ...strategy, enabled: false }, revision: on.revision + 1, updatedAtMs: clock },
      "the DID changes, the owner, mode and limits stay, the strategy waits to be turned on again");
    // A retry of the same re-bind changes nothing; the old DID cannot take it back by this path without its own proof naming it.
    assert.deepEqual(await store.rebind(W, "did:privy:bob", OWNER, "did:privy:alice"), rebound);
    assert.deepEqual(await store.rebinds(W), [{ owner: OWNER, previousDid: "did:privy:alice", did: "did:privy:bob", revision: rebound.revision, reboundAtMs: clock }]);
    assert.deepEqual(await store.rebinds(OTHER), []); assert.deepEqual(await store.get(OTHER), other);
    // A first bind is unchanged: it still never replaces an identity.
    await assert.rejects(store.bind(W, "did:privy:alice", OWNER), (error: unknown) => error instanceof SolanaBindingError && error.code === "conflict");
  });
  test(`${dialect}: concurrent re-binds of one binding to two new DIDs: exactly one wins`, options, async (t) => {
    const store = await storeFor(t, dialect);
    await store.bind(W, "did:privy:alice", OWNER);
    const results = await Promise.allSettled([store.rebind(W, "did:privy:bob", OWNER, "did:privy:alice"), store.rebind(W, "did:privy:dave", OWNER, "did:privy:alice")]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1, JSON.stringify(results.map(result => result.status)));
    assert.equal((await store.rebinds(W)).length, 1);
  });
}

// ── end to end ───────────────────────────────────────────────────────────────

const WEB = fileURLToPath(new URL("../", import.meta.url));
const API = join(WEB, "app/api/solana");
const saved: Record<string, string | undefined> = {};
const env = { MERRYMEN_SOLANA: "1", MERRYMEN_SESSION_SECRET: "rebind-fixture-secret-0123456789abcdef", MERRYMEN_HOSTED: undefined, MERRYMEN_PUBLIC_ORIGIN: undefined, DATABASE_URL: undefined } as Record<string, string | undefined>;
let home = "", tokens: Record<string, string> = {}, runtimeCalls: Array<{ method: string; scope: unknown }> = [];
let raw: DatabaseSync, store: SqlSolanaBindingStore;
let mintSession: (address: `0x${string}`) => string;
let identities: { resolveOrClaimDid(tenant: `0x${string}`, social: { did: string; provider: "email" | "twitter"; subject: string }): Promise<{ ok: boolean; tenant?: string }>; byDid(did: string): Promise<{ tenant: string } | null> };
const routes: Record<string, Record<string, (req: Request) => Promise<Response>>> = {};
before(() => {
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  home = mkdtempSync(join(tmpdir(), "merrymen-solana-rebind-"));
  saved.MERRYMEN_HOME = process.env.MERRYMEN_HOME; process.env.MERRYMEN_HOME = home;
  const load = createRequire(import.meta.url);
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const loaded: Record<string, unknown> = {};
  const interception = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    const from = parent?.filename ?? "";
    if (from.startsWith(WEB)) {
      // Only Privy token verification (a network call) is stood in; the identity store is the real one.
      if (id === "./privy" && from.endsWith("solana-auth.ts")) {
        const privy = original.call(this, id, parent, isMain) as Record<string, unknown>;
        return { ...privy, verifyPrivyToken: async (token: string | null) => token && tokens[token] ? { ok: true, identity: { did: tokens[token] } } : { ok: false } };
      }
      if (id.endsWith("worker/src/solana-app-runtime") && from.startsWith(API)) {
        const real = original.call(this, id, parent, isMain) as Record<string, unknown>;
        return { ...real, getSolanaAppRuntime: () => new Proxy({}, { get: (_target, method) => async (scope: unknown) => { runtimeCalls.push({ method: String(method), scope }); return { fixture: true }; } }) };
      }
      if (id === "./solana-binding-store" || id === "@/lib/solana-binding-store") {
        const real = original.call(this, join(WEB, "lib/solana-binding-store.ts"), parent, isMain) as Record<string, unknown>;
        return { ...real, getSolanaBindingStore: () => store };
      }
      for (const name of ["solana-auth", "solana-api", "solana-enabled"]) {
        if (id === `@/lib/${name}`) return loaded[name] ??= original.call(this, join(WEB, `lib/${name}.ts`), parent, isMain);
      }
    }
    return original.call(this, id, parent, isMain);
  });
  try {
    ({ mintSession } = load(join(WEB, "lib/auth.ts")) as { mintSession: typeof mintSession });
    for (const route of ["bind", "status", "owner", "setup", "settings"]) {
      const mod = load(join(API, route, "route.ts")) as Record<string, unknown>;
      routes[route] = Object.fromEntries(["GET", "POST"].filter((method) => typeof mod[method] === "function").map((method) => [method, mod[method] as (req: Request) => Promise<Response>]));
    }
    // The same module instance solana-auth reads DIDs through.
    const identity = load(join(WEB, "../../worker/src/identity-store.ts")) as { getIdentityStore(): typeof identities; resetIdentityStoreForTest(): void };
    identity.resetIdentityStoreForTest(); identities = identity.getIdentityStore();
  } finally { interception.mock.restore(); }
  raw = new DatabaseSync(":memory:");
});
after(() => {
  raw?.close(); rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
beforeEach(() => {
  runtimeCalls = [];
  tokens = { "token-alice": "did:privy:alice", "token-bob": "did:privy:bob", "token-carol": "did:privy:carol" };
  raw.exec("DROP TABLE IF EXISTS solana_wallet_bindings; DROP TABLE IF EXISTS solana_wallet_binding_rebinds");
  store = new SqlSolanaBindingStore(async () => wrapSqlite(raw), "sqlite");
});

const ORIGIN = "https://app.example.test";
function request(route: string, method: string, { token, tenant, body, query = "" }: { token: string; tenant: `0x${string}`; body?: unknown; query?: string }) {
  const headers: Record<string, string> = { origin: ORIGIN, authorization: `Bearer ${token}`, cookie: `mm_session=${encodeURIComponent(mintSession(tenant))}` };
  return routes[route]![method]!(new Request(`${ORIGIN}/api/solana/${route}${query}`, method === "GET" ? { headers }
    : { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }));
}
/** The page's bind: a fresh challenge for this identity, signed by `seed`'s key. */
async function bind(token: string, tenant: `0x${string}`, owner: string, seed: Uint8Array) {
  const challenge = await request("bind", "GET", { token, tenant, query: `?owner=${owner}` });
  assert.equal(challenge.status, 200);
  const { nonce, message } = await challenge.json() as { nonce: string; message: string };
  return { nonce, message, response: await request("bind", "POST", { token, tenant, body: { owner, nonce, signature: base58Encode(ed25519.sign(new TextEncoder().encode(message), seed)) } }) };
}

test("a Privy DID remap on the tenant: the new identity re-binds by proving the same owner key, and only that tenant's binding moves", async () => {
  // Alice signs in (her wallet is tenant W), binds her Solana owner key and turns automation on.
  assert.equal((await identities.resolveOrClaimDid(W, { did: "did:privy:alice", provider: "email", subject: "alice" })).tenant, W);
  const original = await bind("token-alice", W, OWNER, OWNER_SEED);
  assert.equal(original.response.status, 200);
  await store.settings(W, OWNER, 0, "live", { ...limits, expiresAtMs: Date.now() + 3_600_000 });
  await store.strategy(W, OWNER, 1, strategy);
  // Carol is another tenant with her own binding; nothing below may touch it.
  await identities.resolveOrClaimDid(OTHER, { did: "did:privy:carol", provider: "email", subject: "carol" });
  assert.equal((await bind("token-carol", OTHER, SECOND, SECOND_SEED)).response.status, 200);
  const carol = await store.get(OTHER);
  // The same wallet signs in as a second Privy user: Robinhood sign-in re-points W at that DID.
  assert.equal((await identities.resolveOrClaimDid(W, { did: "did:privy:bob", provider: "twitter", subject: "bob" })).tenant, W);
  assert.equal((await identities.byDid("did:privy:alice")), null, "the old DID maps to no tenant now");
  // Locked out as before: the binding names Alice, Bob signs in for W, and Alice no longer does.
  for (const [route, method, body] of [["status", "GET"], ["owner", "POST", { stage: "prepare", action: "revoke" }], ["setup", "POST", { stage: "prepare", sessionPublicKey: SECOND }]] as const) {
    assert.equal((await request(route, method, { token: "token-bob", tenant: W, body })).status, 403, `bob ${route}`);
    assert.equal((await request(route, method, { token: "token-alice", tenant: W, body })).status, 403, `alice ${route}`);
  }
  assert.equal(runtimeCalls.length, 0, "nothing reached the runtime");
  // Another wallet's proof (what the page offers Bob: his own embedded key) is still a conflict, and the answer points to
  // the original login; a proof naming another tenant's owner key cannot reach it either.
  for (const [owner, seed] of [[THIRD, THIRD_SEED], [SECOND, SECOND_SEED]] as const) {
    const refused = (await bind("token-bob", W, owner, seed)).response;
    assert.equal(refused.status, 409); assert.equal((await refused.json() as { error: string }).error, SOLANA_OTHER_SIGN_IN);
  }
  // A challenge for the bound owner signed by another key, or a replay of a used one, re-binds nothing.
  const forged = await request("bind", "GET", { token: "token-bob", tenant: W, query: `?owner=${OWNER}` });
  const { nonce } = await forged.json() as { nonce: string; message: string };
  assert.equal((await request("bind", "POST", { token: "token-bob", tenant: W, body: { owner: OWNER, nonce, signature: base58Encode(ed25519.sign(new TextEncoder().encode("anything"), SECOND_SEED)) } })).status, 401);
  // Alice's original proof names her identity (and its nonce is spent): replayed by Bob it re-binds nothing.
  assert.equal((await request("bind", "POST", { token: "token-bob", tenant: W, body: { owner: OWNER, nonce: original.nonce,
    signature: base58Encode(ed25519.sign(new TextEncoder().encode(original.message), OWNER_SEED)) } })).status, 401);
  assert.equal((await store.get(W))!.did, "did:privy:alice");
  // The ordinary binding message ("grants no trading or withdrawal authority") never moves a binding, even signed by the
  // bound key over a fresh re-bind nonce naming Bob: only the re-bind message does.
  const ordinary = await request("bind", "GET", { token: "token-bob", tenant: W, query: `?owner=${OWNER}` });
  const offered = await ordinary.json() as { nonce: string; message: string; rebind?: boolean };
  assert.equal(offered.rebind, true); assert.doesNotMatch(offered.message, /grants no trading/);
  // The module instance the routes use (loaded under the Privy stand-in in before()).
  const { solanaBindingMessage } = createRequire(import.meta.url)(join(WEB, "lib/solana-auth.ts")) as typeof import("./solana-auth");
  const binding = solanaBindingMessage({ tenant: W, did: "did:privy:bob" }, OWNER, ORIGIN, offered.nonce);
  assert.match(binding, /grants no trading or withdrawal authority/);
  assert.equal((await request("bind", "POST", { token: "token-bob", tenant: W, body: { owner: OWNER, nonce: offered.nonce,
    signature: base58Encode(ed25519.sign(new TextEncoder().encode(binding), OWNER_SEED)) } })).status, 401);
  assert.equal((await store.get(W))!.did, "did:privy:alice"); assert.deepEqual(await store.rebinds(W), []);
  // Bob proves the SAME owner key over a fresh re-bind challenge naming both identities and what moves: the binding is re-bound.
  const proof = await bind("token-bob", W, OWNER, OWNER_SEED);
  assert.match(proof.message, /^Merrymen Solana wallet re-bind v1\n/);
  assert.match(proof.message, /Move this Solana account's controls to my current Merrymen sign-in\./);
  assert.match(proof.message, /live mode and trading limits, the trading permission registered on Solana, the autonomous strategy \(turned off until I turn it on again\), and owner actions such as revoking and withdrawing/);
  assert.match(proof.message, /\nPrevious identity: did:privy:alice\n/); assert.match(proof.message, /\nIdentity: did:privy:bob\n/); assert.match(proof.message, new RegExp(`Tenant: ${W}`));
  assert.equal(proof.response.status, 200);
  const rebound = (await proof.response.json() as { binding: { did: string; owner: string; strategy: { enabled: boolean } } }).binding;
  assert.equal(rebound.did, "did:privy:bob"); assert.equal(rebound.owner, OWNER); assert.equal(rebound.strategy.enabled, false, "automation waits for the new identity");
  assert.equal((await request("bind", "POST", { token: "token-bob", tenant: W, body: { owner: OWNER, nonce: proof.nonce, signature: base58Encode(ed25519.sign(new TextEncoder().encode(proof.message), OWNER_SEED)) } })).status, 401, "a used challenge is never accepted twice");
  // Status, revoke and withdrawal now reach the runtime for W's own owner, with Bob's sign-in only.
  assert.equal((await request("status", "GET", { token: "token-bob", tenant: W })).status, 200);
  assert.equal((await request("owner", "POST", { token: "token-bob", tenant: W, body: { stage: "prepare", action: "revoke" } })).status, 200);
  assert.equal((await request("owner", "POST", { token: "token-bob", tenant: W, body: { stage: "prepare", action: "withdraw", mint: OWNER, amountRaw: "1" } })).status, 200);
  assert.deepEqual(runtimeCalls.map(call => call.method), ["status", "prepareOwnerAction", "prepareOwnerAction"]);
  assert.ok(runtimeCalls.every(call => JSON.stringify(call.scope) === JSON.stringify({ tenant: W, owner: OWNER })), JSON.stringify(runtimeCalls));
  assert.equal((await request("status", "GET", { token: "token-alice", tenant: W })).status, 403, "the old identity maps to no tenant");
  // Carol's binding, and her access, are untouched; Bob cannot reach her tenant.
  assert.deepEqual(await store.get(OTHER), carol);
  assert.equal((await request("status", "GET", { token: "token-bob", tenant: OTHER })).status, 403);
  assert.deepEqual(await store.rebinds(OTHER), []);
  assert.deepEqual((await store.rebinds(W)).map(row => [row.previousDid, row.did]), [["did:privy:alice", "did:privy:bob"]]);
});

test("a proof for another wallet, challenged before another sign-in verified the tenant's wallet, is refused with the way back, and moves nothing", async () => {
  assert.equal((await identities.resolveOrClaimDid(W, { did: "did:privy:bob", provider: "twitter", subject: "bob" })).tenant, W);
  const challenge = await request("bind", "GET", { token: "token-bob", tenant: W, query: `?owner=${THIRD}` });
  assert.equal(challenge.status, 200);
  const { nonce, message } = await challenge.json() as { nonce: string; message: string };
  // Meanwhile the tenant's wallet was verified by another sign-in.
  const bound = await store.bind(W, "did:privy:alice", OWNER);
  const answer = await request("bind", "POST", { token: "token-bob", tenant: W, body: { owner: THIRD, nonce, signature: base58Encode(ed25519.sign(new TextEncoder().encode(message), THIRD_SEED)) } });
  assert.equal(answer.status, 409); assert.equal((await answer.json() as { error: string }).error, SOLANA_OTHER_SIGN_IN);
  assert.deepEqual(await store.get(W), bound); assert.deepEqual(await store.rebinds(W), []);
});

test("signing in again with the original identity needs no re-bind, and Robinhood sign-in is unchanged by it", async () => {
  await identities.resolveOrClaimDid(W, { did: "did:privy:alice", provider: "email", subject: "alice" });
  assert.equal((await bind("token-alice", W, OWNER, OWNER_SEED)).response.status, 200);
  const before = await store.get(W);
  await identities.resolveOrClaimDid(W, { did: "did:privy:bob", provider: "twitter", subject: "bob" });
  assert.equal((await request("status", "GET", { token: "token-bob", tenant: W })).status, 403);
  // Alice signs in again with the same wallet: the identity store re-points W at her, as it always did.
  assert.equal((await identities.resolveOrClaimDid(W, { did: "did:privy:alice", provider: "email", subject: "alice" })).tenant, W);
  assert.equal((await request("status", "GET", { token: "token-alice", tenant: W })).status, 200);
  assert.deepEqual(await store.get(W), before); assert.deepEqual(await store.rebinds(W), []);
});
