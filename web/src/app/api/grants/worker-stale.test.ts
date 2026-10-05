/**
 * /api/grants SAYS WHETHER THE WORKER HAS STOPPED — run, not read.
 *
 * The actual GET, over real read-only SQLite and no network: the heartbeat it
 * judges is the one it read (the mirrored row hosted, the file self-hosted),
 * by this server's clock, against the window for THIS owner's tick. The pure
 * rule is pinned in terminal/stale-autonomy.test.ts; this pins that the route
 * feeds it the right three facts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, mock, test } from "node:test";
import type { MerrymenSettings, StoredGrant } from "@merrymen/core";
import { freshWithin } from "@/lib/services/agent-status";
import { WORKER_STALE_MARGIN_SEC } from "@/terminal/worker-stale";
import type { AgentStatus } from "./route";

const A = `0x${"a".repeat(40)}` as `0x${string}`;
const ACCOUNT = `0x${"c".repeat(40)}` as `0x${string}`;
const NOW = Date.parse("2026-10-05T12:00:00Z") / 1000;
const ORIGIN = "https://app.merrymen.dev";
const saved = new Map(["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK",
  "MERRYMEN_SETTINGS_FILE", "MERRYMEN_TICK_SECONDS"].map(key => [key, process.env[key]]));
let home: string, db: DatabaseSync;
let auth: typeof import("@/lib/auth");
let settingsStore: typeof import("../../../../../worker/src/settings-store");
let GET: (req: Request) => Promise<Response>;
/** What the tenant's settings read returns: settings, or an Error to throw. */
let settings: MerrymenSettings | Error | null;
const settingsReads: string[] = [];
let restoreBalances: (() => void) | undefined;

const grant = (): StoredGrant => ({
  serialized: "fixture-serialized-secret", demoSessionPrivateKey: "fixture-session-secret",
  demoOwnerPrivateKey: "fixture-owner-secret", owner: A, smartAccount: ACCOUNT,
  chainId: 4663, grantedAt: NOW - 86_400, expiresAt: NOW + 86_400 * 30,
} as unknown as StoredGrant);

before(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "merrymen-grants-stale-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-grants-worker-stale-secret-at-least-32-characters";
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_STORE_DEK;
  delete process.env.MERRYMEN_SETTINGS_FILE;
  delete process.env.MERRYMEN_TICK_SECONDS;
  mock.method(Date, "now", () => NOW * 1000);
  mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden in this fixture."); });
  auth = await import("@/lib/auth");
  // The route's CJS module instances, as recovery.test.ts takes them.
  const require = createRequire(import.meta.url);
  const grants = require("../../../../../worker/src/grant-store.ts") as typeof import("../../../../../worker/src/grant-store");
  grants.resetGrantStoreForTest();
  mock.method(grants.getGrantStore(), "get", async (tenant: string) => (tenant === A ? grant() : null));
  settingsStore = require("../../../../../worker/src/settings-store.ts") as typeof settingsStore;
  settingsStore.useSettingsStoreForTest({
    get: async (tenant: `0x${string}`) => {
      settingsReads.push(tenant);
      if (settings instanceof Error) throw settings;
      return settings;
    },
  } as unknown as import("../../../../../worker/src/settings-store").SettingsStore);
  const balances = require("../../../lib/grant-balances.ts") as typeof import("@/lib/grant-balances");
  const cachedBalances = require.cache[require.resolve("../../../lib/grant-balances.ts")]!;
  cachedBalances.exports = { ...balances, readGrantBalancesFrom: async () => ({ ethWei: null, cashUsdg: null, vaultUsdg: null }) };
  restoreBalances = () => { cachedBalances.exports = balances; };
  db = new DatabaseSync(path.join(home, "merrymen.db"));
  ({ GET } = await import("./route"));
});

beforeEach(() => {
  settings = null;
  settingsReads.length = 0;
  process.env.MERRYMEN_HOSTED = "1";
  db.exec(`DROP TABLE IF EXISTS agents;
    CREATE TABLE agents(smart_account TEXT PRIMARY KEY,mode TEXT,beat_at INTEGER,sponsor_gas INTEGER,live_blocker TEXT,energy TEXT);`);
});

after(() => {
  db?.close(); mock.restoreAll(); restoreBalances?.(); settingsStore?.resetSettingsStoreForTest();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

async function status(beatAt: number | null): Promise<AgentStatus> {
  db.prepare("DELETE FROM agents").run();
  db.prepare("INSERT INTO agents VALUES(?,'live',?,0,NULL,NULL)").run(ACCOUNT, beatAt);
  const response = await GET(new Request(`${ORIGIN}/api/grants`, {
    headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(A)}` },
  }));
  assert.equal(response.status, 200);
  return response.json() as Promise<AgentStatus>;
}

test("a worker that beat recently is not stopped, and one that went quiet is", async () => {
  settings = { tickSeconds: 60 };
  const edge = freshWithin(60) + WORKER_STALE_MARGIN_SEC;
  const fresh = await status(NOW - 10);
  assert.equal(fresh.workerStale, false);
  assert.equal(fresh.mode, "live", "the last word is still reported as it was said");
  assert.equal((await status(NOW - edge)).workerStale, false, "the edge is fresh");
  const quiet = await status(NOW - edge - 1);
  assert.equal(quiet.workerStale, true);
  assert.equal(quiet.workerAliveAt, NOW - edge - 1, "the heartbeat itself is unchanged");
  assert.equal(settingsReads.at(-1), A, "the cadence read is the signed-in tenant's");
});

test("the window is THIS owner's tick, not a fixed number", async () => {
  const silence = 15 * 60;
  settings = { tickSeconds: 60 };
  assert.equal((await status(NOW - silence)).workerStale, true);
  settings = { tickSeconds: 600 };
  assert.equal((await status(NOW - silence)).workerStale, false, "a ten-minute tick is allowed fifteen quiet minutes");
});

test("a failed or empty settings read is the default window, never a guess", async () => {
  const edge = freshWithin(null) + WORKER_STALE_MARGIN_SEC;
  for (const answer of [new Error("store unreadable"), null, {}]) {
    settings = answer;
    assert.equal((await status(NOW - edge)).workerStale, false, String(answer));
    assert.equal((await status(NOW - edge - 1)).workerStale, true, String(answer));
  }
});

test("never heard from is null — not stopped", async () => {
  const body = await status(null);
  assert.equal(body.workerAliveAt, null);
  assert.equal(body.workerStale, null);
  assert.deepEqual(settingsReads, [], "and no tick is needed to say so");
});

test("self-hosted judges the heartbeat file, with the worker's own tick", async () => {
  delete process.env.MERRYMEN_HOSTED;
  writeFileSync(path.join(home, "grant.json"), JSON.stringify(grant()), { mode: 0o600 });
  // No settings.json: the worker's default tick, as resolveConfig reads it.
  const beat = (at: number) => writeFileSync(path.join(home, "heartbeat.json"), JSON.stringify({ at, mode: "paper", sponsorGas: false }));
  const read = async () => {
    const response = await GET(new Request(`${ORIGIN}/api/grants`));
    assert.equal(response.status, 200);
    return response.json() as Promise<AgentStatus>;
  };
  beat(NOW - 30);
  assert.equal((await read()).workerStale, false);
  beat(NOW - 86_400);
  const quiet = await read();
  assert.equal(quiet.workerStale, true);
  assert.equal(quiet.workerAliveAt, NOW - 86_400);
  assert.deepEqual(settingsReads, [], "self-hosted never asks the tenant store");
});
