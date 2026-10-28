import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Encode } from "../../../packages/core/src/ids";
import { wrapSqlite } from "../../../worker/src/db";
import { SOLANA_OTHER_SIGN_IN } from "./solana-sign-in";

/**
 * THE DID GUARD, THROUGH THE REAL ROUTES.
 *
 * solana-routes.test.ts replaces solanaContext with a stub, so nothing ran the
 * check that a binding's Privy DID is the DID that just signed in. It is the
 * only thing standing between a remapped identity and someone else's vault: a
 * wallet-signed login with a new DID re-points tenant W at that DID
 * (identity-store's ON CONFLICT (tenant)), authenticateSolana then accepts the
 * new DID for W, and only `binding.did !== principal.did` (solanaContext, and
 * the status route's own copy) stops it changing W's live settings or trading
 * W's vault with the session key the server holds.
 *
 * Here the real solanaContext, authenticateSolana, session cookie and binding
 * store run, against in-memory SQLite. Only Privy token verification (a network
 * call) and the DID-to-tenant lookup are stubbed, and the runtime records any
 * call that gets through.
 */

const WEB = fileURLToPath(new URL("../", import.meta.url));
const API = join(WEB, "app/api/solana");
/** Every route.ts under app/api/solana, nested ones included, by its path below it ("paper", "paper/write-off"). */
function solanaRoutes(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const route = prefix ? `${prefix}/${entry.name}` : entry.name;
    return [...(existsSync(join(dir, route, "route.ts")) ? [route] : []), ...solanaRoutes(dir, route)];
  });
}
const W = `0x${"11".repeat(20)}` as const, OTHER = `0x${"22".repeat(20)}` as const;
const OWNER_SEED = new Uint8Array(32).fill(7), OWNER = base58Encode(ed25519.getPublicKey(OWNER_SEED));
const SECOND_SEED = new Uint8Array(32).fill(8), SECOND = base58Encode(ed25519.getPublicKey(SECOND_SEED));
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: Date.now() + 3_600_000 };

const saved: Record<string, string | undefined> = {};
const env = { MERRYMEN_SOLANA: "1", MERRYMEN_SESSION_SECRET: "identity-guard-fixture-secret-0123456789", MERRYMEN_HOSTED: undefined, MERRYMEN_PUBLIC_ORIGIN: undefined, DATABASE_URL: undefined } as Record<string, string | undefined>;
let home = "";
/** Privy access token -> verified DID, and DID -> tenant in the identity store. */
let tokens: Record<string, string> = {}, identities: Record<string, `0x${string}`> = {};
let runtimeCalls: string[] = [];
let raw: DatabaseSync;
let store: import("./solana-binding-store").SqlSolanaBindingStore;
let mintSession: (address: `0x${string}`) => string;
const routes: Record<string, Record<string, (req: Request) => Promise<Response>>> = {};

before(() => {
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  home = mkdtempSync(join(tmpdir(), "merrymen-solana-guard-"));
  saved.MERRYMEN_HOME = process.env.MERRYMEN_HOME; process.env.MERRYMEN_HOME = home;
  const load = createRequire(import.meta.url);
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const loaded: Record<string, unknown> = {};
  const interception = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    const from = parent?.filename ?? "";
    if (from.startsWith(WEB)) {
      if (id === "./privy" && from.endsWith("solana-auth.ts")) {
        const privy = original.call(this, id, parent, isMain) as Record<string, unknown>;
        return { ...privy, verifyPrivyToken: async (token: string | null) => token && tokens[token] ? { ok: true, identity: { did: tokens[token] } } : { ok: false } };
      }
      if (id.endsWith("worker/src/identity-store")) return { getIdentityStore: () => ({ byDid: async (did: string) => identities[did] ? { tenant: identities[did] } : null }) };
      if (id.endsWith("worker/src/solana-app-runtime") && from.startsWith(API)) {
        const real = original.call(this, id, parent, isMain) as Record<string, unknown>;
        return { ...real, getSolanaAppRuntime: () => new Proxy({}, { get: (_target, method) => async () => { runtimeCalls.push(String(method)); return { fixture: true }; } }) };
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
    for (const route of solanaRoutes(API)) {
      const mod = load(join(API, route, "route.ts")) as Record<string, unknown>;
      routes[route] = Object.fromEntries(["GET", "POST"].filter((method) => typeof mod[method] === "function").map((method) => [method, mod[method] as (req: Request) => Promise<Response>]));
    }
    const { SqlSolanaBindingStore } = load(join(WEB, "lib/solana-binding-store.ts")) as typeof import("./solana-binding-store");
    raw = new DatabaseSync(":memory:");
    store = new SqlSolanaBindingStore(async () => wrapSqlite(raw), "sqlite");
  } finally {
    interception.mock.restore();
  }
});
after(() => {
  raw?.close();
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
beforeEach(() => {
  runtimeCalls = [];
  tokens = { "token-alice": "did:privy:alice", "token-bob": "did:privy:bob" };
  identities = { "did:privy:alice": W };
  raw.exec("DROP TABLE IF EXISTS solana_wallet_bindings");
  // A fresh store re-creates the schema on first use.
  store = new (store.constructor as typeof import("./solana-binding-store").SqlSolanaBindingStore)(async () => wrapSqlite(raw), "sqlite");
});

const ORIGIN = "https://app.example.test";
function request(route: string, method: string, { token, tenant, body, query = "" }: { token?: string; tenant?: `0x${string}`; body?: unknown; query?: string }) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (token) headers.authorization = `Bearer ${token}`;
  if (tenant) headers.cookie = `mm_session=${encodeURIComponent(mintSession(tenant))}`;
  return routes[route]![method]!(new Request(`${ORIGIN}/api/solana/${route}${query}`, method === "GET" ? { headers }
    : { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }));
}
/** A plausible request for every route and method, so a refusal is the guard's and not the body's. */
const CALLS: Array<[string, string, unknown?, string?]> = [
  ["status", "GET"], ["bind", "GET", undefined, `?owner=${OWNER}`], ["bind", "POST", { owner: OWNER, nonce: "n", signature: "s" }],
  ["settings", "POST", { mode: "paper", limits, revision: 1 }],
  ["intent", "POST", { mode: "paper", action: "preview", intent: {} }],
  ["paper", "POST", { initialCashRaw: "1000000" }],
  ["paper/write-off", "POST", { mint: SECOND }],
  ["setup", "POST", { stage: "prepare", sessionPublicKey: SECOND }],
  ["owner", "POST", { stage: "prepare", action: "revoke" }],
  ["strategy", "POST", { strategy: { enabled: false, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 60 }, revision: 1 }],
];
async function bindAlice() {
  await store.bind(W, "did:privy:alice", OWNER);
  return store.settings(W, OWNER, 0, "paper", limits);
}

test("every route has a case here", () => {
  assert.deepEqual(new Set(Object.keys(routes)), new Set(CALLS.map(([route]) => route)));
  for (const [route, method] of CALLS) assert.ok(routes[route]?.[method], `${method} ${route}`);
});

test("control: the bound identity reaches its own account", async () => {
  const binding = await bindAlice();
  const status = await request("status", "GET", { token: "token-alice", tenant: W });
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).binding, binding);
  assert.equal((await request("intent", "POST", { token: "token-alice", tenant: W, body: { mode: "paper", action: "preview", intent: {} } })).status, 200);
  assert.deepEqual(runtimeCalls, ["status", "preview"]);
});

test("no session cookie: every route answers 401 before any runtime call", async () => {
  const binding = await bindAlice();
  for (const [route, method, body, query] of CALLS) {
    assert.equal((await request(route, method, { token: "token-alice", body, query })).status, 401, `${method} ${route}`);
  }
  assert.deepEqual(runtimeCalls, []);
  assert.deepEqual(await store.get(W), binding);
});

test("a token whose DID maps to another tenant answers 403 before any runtime call", async () => {
  const binding = await bindAlice();
  identities["did:privy:bob"] = OTHER;
  for (const [route, method, body, query] of CALLS) {
    const response = await request(route, method, { token: "token-bob", tenant: W, body, query });
    assert.equal(response.status, 403, `${method} ${route}`);
  }
  assert.deepEqual(runtimeCalls, []);
  assert.deepEqual(await store.get(W), binding);
});

test("a DID remapped onto the tenant cannot read, change or trade the binding another DID made", async () => {
  const binding = await bindAlice();
  // The identity store now says bob owns W, exactly what a wallet-signed login
  // with a new DID does. The cookie still names W.
  identities["did:privy:bob"] = W;
  for (const [route, method, body, query] of CALLS) {
    if (route === "bind") continue; // binding a wallet is covered below
    const response = await request(route, method, { token: "token-bob", tenant: W, body, query });
    assert.equal(response.status, 403, `${method} ${route}`);
    // The way back for an app-created owner: the login that verified the wallet.
    assert.equal((await response.json()).error, SOLANA_OTHER_SIGN_IN, `${method} ${route}`);
  }
  assert.deepEqual(runtimeCalls, []);
  assert.deepEqual(await store.get(W), binding);
});

test("a remapped DID cannot rebind the tenant to its own wallet, even with a valid wallet proof", async () => {
  const binding = await bindAlice();
  identities["did:privy:bob"] = W;
  const challenge = await request("bind", "GET", { token: "token-bob", tenant: W, query: `?owner=${SECOND}` });
  assert.equal(challenge.status, 200);
  const { nonce, message } = await challenge.json() as { nonce: string; message: string };
  const signature = base58Encode(ed25519.sign(new TextEncoder().encode(message), SECOND_SEED));
  const response = await request("bind", "POST", { token: "token-bob", tenant: W, body: { owner: SECOND, nonce, signature } });
  assert.equal(response.status, 409);
  assert.deepEqual(await store.get(W), binding);
  assert.deepEqual(runtimeCalls, []);
});
