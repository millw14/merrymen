/** Actual authenticated GET, real read-only SQLite reads, and no balance RPC transport. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, mock, test } from "node:test";
import type { StoredGrant } from "@merrymen/core";
import { FLEET_RECOVERY_SCHEMA } from "../../../../../worker/src/fleet-recovery";
import type { AgentStatus } from "./route";

const A = `0x${"a".repeat(40)}` as `0x${string}`;
const B = `0x${"b".repeat(40)}` as `0x${string}`;
const ACCOUNT_A = `0x${"c".repeat(40)}` as `0x${string}`;
const ACCOUNT_B = `0x${"d".repeat(40)}` as `0x${string}`;
const NOW = Date.parse("2026-10-04T12:00:00Z") / 1000;
const ORIGIN = "https://app.merrymen.dev";
const saved = new Map(["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK"]
  .map(key => [key, process.env[key]]));
let home: string, database: string, db: DatabaseSync;
let auth: typeof import("@/lib/auth");
let grants: typeof import("../../../../../worker/src/grant-store");
let GET: (req: Request) => Promise<Response>;
let current: Record<string, StoredGrant | null>;
const grantReads: string[] = [];
const balanceReads: Array<{ account: string; chainId: number }> = [];
let networkCalls = 0, grantWrites = 0;
let restoreBalances: (() => void) | undefined;

const grant = (account: `0x${string}`, chainId = 4663): StoredGrant => ({
  // Disposable non-key strings suffice for GET; nothing is signed or installed.
  serialized: "fixture-serialized-secret", demoSessionPrivateKey: "fixture-session-secret",
  demoOwnerPrivateKey: "fixture-owner-secret", owner: B, smartAccount: account,
  chainId, grantedAt: NOW - 100, expiresAt: NOW + 100,
} as unknown as StoredGrant);

before(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "merrymen-grants-recovery-"));
  database = path.join(home, "merrymen.db");
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-grants-recovery-secret-at-least-32-characters";
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_STORE_DEK;
  mock.method(Date, "now", () => NOW * 1000);
  mock.method(globalThis, "fetch", async () => { networkCalls++; throw new Error("Network forbidden in this fixture."); });
  auth = await import("@/lib/auth");
  // Match the route's CJS module instances, as owner-facing.test.ts does.
  const require = createRequire(import.meta.url);
  grants = require("../../../../../worker/src/grant-store.ts") as typeof grants;
  grants.resetGrantStoreForTest();
  const store = grants.getGrantStore();
  mock.method(store, "get", async (tenant: string) => { grantReads.push(tenant); return current[tenant] ?? null; });
  for (const method of ["put", "remove", "stopForReplacement"] as const) {
    mock.method(store, method, async () => { grantWrites++; throw new Error("GET cannot change a grant."); });
  }
  const balances = require("../../../lib/grant-balances.ts") as typeof import("@/lib/grant-balances");
  // tsx's named exports are nonconfigurable getters, so preserve the cached
  // CJS module and replace only its exported transport seam before GET loads.
  const cachedBalances = require.cache[require.resolve("../../../lib/grant-balances.ts")]!;
  const balanceStub = async (client: { chain: { id: number } }, account: string) => {
    balanceReads.push({ account, chainId: client.chain.id });
    return { ethWei: null, cashUsdg: null, vaultUsdg: null };
  };
  cachedBalances.exports = { ...balances, readGrantBalancesFrom: balanceStub };
  restoreBalances = () => { cachedBalances.exports = balances; };
  db = new DatabaseSync(database);
  ({ GET } = await import("./route"));
});

beforeEach(() => {
  grantReads.length = 0; balanceReads.length = 0; networkCalls = 0; grantWrites = 0;
  current = { [A]: grant(ACCOUNT_A), [B]: grant(ACCOUNT_B) };
  db.exec(`DROP TABLE IF EXISTS fleet_recovery_health; DROP TABLE IF EXISTS agents;
    DROP TABLE IF EXISTS trades; DROP TABLE IF EXISTS posts; DROP TABLE IF EXISTS flows;
    ${FLEET_RECOVERY_SCHEMA}
    CREATE TABLE agents(smart_account TEXT PRIMARY KEY,owner_address TEXT,mode TEXT,beat_at INTEGER,
      sponsor_gas INTEGER,live_blocker TEXT,energy TEXT);
    CREATE TABLE trades(agent_id TEXT); CREATE TABLE posts(agent_id TEXT); CREATE TABLE flows(agent_id TEXT);`);
  const hold = db.prepare("INSERT INTO fleet_recovery_health VALUES(?,?,?,1,'source-continuity',?,?)");
  hold.run(A, ACCOUNT_A, 4663, NOW - 25, NOW);
  hold.run(B, ACCOUNT_A, 4663, NOW - 325, NOW - 300);
  hold.run(A, ACCOUNT_B, 4663, NOW - 225, NOW - 200);
  hold.run(A, ACCOUNT_A, 46630, NOW - 425, NOW - 400);
  db.prepare("INSERT INTO posts VALUES(?)").run(ACCOUNT_A);
  // owner_address deliberately contradicts the cookie: only the current
  // authenticated grant, not legacy owner bookkeeping, scopes the report.
  const agent = db.prepare("INSERT INTO agents VALUES(?,?,'live',?,?,'dead-policy',NULL)");
  agent.run(ACCOUNT_A, B, NOW - 10, 1);
  agent.run(ACCOUNT_B, A, NOW - 20, 0);
  writeFileSync(path.join(home, "heartbeat.json"), JSON.stringify({ at: NOW + 100, mode: "paper", sponsorGas: false }));
  writeFileSync(path.join(home, "grant.json"), JSON.stringify(grant(ACCOUNT_B, 46630)), { mode: 0o600 });
});

after(() => {
  db?.close(); mock.restoreAll(); restoreBalances?.(); grants?.resetGrantStoreForTest();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function request(tenant: `0x${string}` | null = A): Request {
  // Browser-declared scope is deliberately foreign and has no authority.
  return new Request(`${ORIGIN}/api/grants?tenant=${B}&smartAccount=${ACCOUNT_B}&chainId=46630`, {
    headers: tenant ? { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(tenant)}` } : {},
  });
}
async function status(tenant: `0x${string}` = A): Promise<AgentStatus> {
  const response = await GET(request(tenant));
  assert.equal(response.status, 200);
  return response.json() as Promise<AgentStatus>;
}
async function refused(): Promise<void> {
  const response = await GET(request());
  const body = await response.json() as { ownerFacing?: boolean; error?: string; recovery?: unknown; mode?: unknown };
  assert.equal(response.status, 503, JSON.stringify(body));
  assert.equal(body.ownerFacing, true);
  assert.match(body.error ?? "", /confirm.*recovery status/);
  assert.equal(body.recovery, undefined); assert.equal(body.mode, undefined);
  assert.equal(networkCalls, 0); assert.equal(grantWrites, 0);
}

test("GET scopes a source hold to the cookie tenant and current grant account/chain, retaining unknown memory", async () => {
  const before = readFileSync(database);
  const body = await status();
  assert.equal(body.exists, true); assert.equal(body.tenant, A);
  assert.equal(body.grant?.smartAccount, ACCOUNT_A); assert.equal(body.grant?.chainId, 4663);
  assert.deepEqual(grantReads, [A]);
  assert.deepEqual(balanceReads, [{ account: ACCOUNT_A, chainId: 4663 }]);
  assert.deepEqual(body.recovery, { state: "history-only", tradingPaused: true, history: "available", memory: "unknown",
    checkedAt: NOW, lastVerifiedHeartbeatAt: NOW - 10 });
  assert.deepEqual(body.balances, { ethWei: null, cashUsdg: null, vaultUsdg: null });
  assert.doesNotMatch(JSON.stringify(body), /fixture-serialized-secret|fixture-session-secret|fixture-owner-secret/);
  assert.deepEqual(readFileSync(database), before, "GET's real readonly driver never changes schema or source rows");
  assert.equal(networkCalls, 0); assert.equal(grantWrites, 0);
});

test("hosted status ignores the unscoped heartbeat file and uses only the grant account's recorded heartbeat", async () => {
  const body = await status();
  assert.equal(body.workerAliveAt, NOW - 10); assert.equal(body.mode, "live"); assert.equal(body.gasSponsored, true);
  assert.equal(body.recovery?.tradingPaused, true, "a saved live heartbeat cannot override a source hold");
  db.prepare("UPDATE agents SET beat_at=NULL WHERE smart_account=?").run(ACCOUNT_A);
  const unknown = await status();
  assert.equal(unknown.workerAliveAt, null); assert.equal(unknown.mode, null); assert.equal(unknown.gasSponsored, null);
  assert.equal(unknown.recovery?.lastVerifiedHeartbeatAt, null);
});

test("foreign tenant/account/chain rows cannot become the current authenticated hold", async () => {
  const other = await status(B);
  assert.equal(other.tenant, B); assert.equal(other.grant?.smartAccount, ACCOUNT_B); assert.equal(other.recovery, null);
  current[A] = grant(ACCOUNT_A, 46630);
  const changedChain = await status();
  assert.equal(changedChain.recovery?.checkedAt, NOW - 400);
  assert.deepEqual(balanceReads.at(-1), { account: ACCOUNT_A, chainId: 46630 });
  current[A] = grant(ACCOUNT_B);
  assert.equal((await status()).recovery?.checkedAt, NOW - 200, "the newly read current grant determines the account scope");
  db.prepare("DELETE FROM fleet_recovery_health WHERE tenant=? AND smart_account=? AND chain_id=4663").run(A, ACCOUNT_A);
  current[A] = grant(ACCOUNT_A);
  assert.equal((await status()).recovery, null, "other tenant and chain evidence never fills a missing exact hold");
});

test("expired current grants still expose their source hold, without claiming restored memory or execution authority", async () => {
  current[A] = { ...grant(ACCOUNT_A), expiresAt: NOW - 1 };
  const body = await status();
  assert.equal(body.grant?.expiresAt, NOW - 1);
  assert.equal(body.recovery?.tradingPaused, true); assert.equal(body.recovery?.history, "available");
  assert.equal(body.recovery?.memory, "unknown");
  assert.equal(grantWrites, 0); assert.equal(networkCalls, 0);
});

test("malformed current scope or health records fail with an owner-facing 503", async () => {
  for (const sql of ["held=7", "checked_at=-1", "cause='invented-authority'"]) {
    db.prepare(`UPDATE fleet_recovery_health SET ${sql} WHERE tenant=? AND smart_account=? AND chain_id=4663`).run(A, ACCOUNT_A);
    await refused();
    db.prepare("UPDATE fleet_recovery_health SET held=1,checked_at=?,cause='source-continuity' WHERE tenant=? AND smart_account=? AND chain_id=4663")
      .run(NOW, A, ACCOUNT_A);
  }
  current[A] = { ...grant(ACCOUNT_A), chainId: 0 };
  await refused();
});

test("an unreadable health table refuses instead of returning normal status; a truly missing table stays compatible", async () => {
  db.exec("DROP TABLE fleet_recovery_health; CREATE TABLE fleet_recovery_health(wrong TEXT)");
  await refused();
  db.exec("DROP TABLE fleet_recovery_health");
  const before = readFileSync(database);
  const body = await status();
  assert.equal(body.recovery, null); assert.equal(body.tenant, A);
  assert.deepEqual(readFileSync(database), before, "legacy compatibility never creates the optional health table");
});

test("an absent or corrupt SQLite driver cannot use the hosted heartbeat file as a fallback", async () => {
  const heldAside = `${database}.fixture-aside`;
  renameSync(database, heldAside);
  try {
    await refused();
    writeFileSync(database, "invalid SQLite fixture only");
    await refused();
  } finally { rmSync(database, { force: true }); renameSync(heldAside, database); }
});

test("signed-out and absent-grant responses do not consult balances or recovery rows", async () => {
  const signedOut = await GET(request(null));
  assert.equal(signedOut.status, 200); assert.deepEqual(await signedOut.json(), { exists: false, tenant: null });
  assert.deepEqual(grantReads, []); assert.deepEqual(balanceReads, []);
  current[A] = null;
  const absent = await GET(request());
  assert.equal(absent.status, 200); assert.deepEqual(await absent.json(), { exists: false, tenant: A });
  assert.deepEqual(grantReads, [A]); assert.deepEqual(balanceReads, []);
  assert.equal(networkCalls, 0); assert.equal(grantWrites, 0);
});
