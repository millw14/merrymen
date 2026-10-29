/**
 * A PERPS-ONLY LOGIN THE ROLLOUT HOLDS IS SAID, NOT SILENT (orchestrator.ts
 * sayPerpsOnlyHeld and the perps roster line).
 *
 * Hosted, under the production rollout (an explicit MERRYMEN_FLEET_ROLLOUT
 * list, with MERRYMEN_ROLLOUT_NEW_TENANTS open) at MERRYMEN_PERPS=paper. The
 * new-tenant route proves a login new only through its Spot grant, so a new
 * Spot-only login runs at the route's level, and a login with both wallets
 * runs its Perps worker beside its Spot one, while a new Perps-only login
 * (which POST /api/grants?wallet=perps can make) waits until the operator
 * names it. That is this build's rule, and pinned here. What it must not be
 * is silent: the roster line called such a wallet one that "may run", and no
 * line named it. Its owner saw a wallet that never reports, and every exit
 * and reset refused until it does.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-perps-only-held-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
delete process.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY;
delete process.env.MERRYMEN_PERSISTENT_HOME_REQUIRED;
delete process.env.MERRYMEN_FLEET_ROLLOUT;
delete process.env.MERRYMEN_ROLLOUT_NEW_TENANTS;
for (const key of Object.keys(process.env)) if (key.startsWith("RAILWAY_")) delete process.env[key];
const dek = Buffer.alloc(32, 84);
process.env.MERRYMEN_STORE_DEK = dek.toString("base64");

const { childHome, newTenantAdmissionsForTest, reconcile, setKillConfirmForTest, setLeaseAcquireForTest,
  setPaperRestoreForTest, setPerpsFeedStartForTest, setRetirementMemoryStoreForTest, setSpawnForTest } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { acquireTenantLease } = await import("./tenant-lease");

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const grant = (owner: `0x${string}`, account: `0x${string}`, extra: Record<string, unknown> = {}): StoredGrant => ({
  smartAccount: account, owner, sessionKeyAddress: address(0xf02),
  serialized: `eyJ-held-${account}`, chainId: 4663, grantedAt: nowSec() - 3600, expiresAt: nowSec() + 86_400,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"ab".repeat(32)}`, ...extra,
}) as unknown as StoredGrant;

class FakeProc extends EventEmitter {
  static next = 96_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  gone = false;
  constructor(readonly env: NodeJS.ProcessEnv = {}) { super(); }
  kill(): boolean { setImmediate(() => { this.gone = true; this.emit("exit", null, "SIGTERM"); }); return true; }
}
const spawned: FakeProc[] = [];
setSpawnForTest((_c: string, _a: readonly string[], options: SpawnOptions) => {
  const p = new FakeProc(options.env ?? {});
  spawned.push(p);
  return p as unknown as ChildProcess;
});
const leaseAsks: string[] = [];
setLeaseAcquireForTest(async (tenant) => { leaseAsks.push(tenant.toLowerCase()); return acquireTenantLease(tenant); });
setKillConfirmForTest(async () => {});
setPaperRestoreForTest(async () => ({ ok: true, line: null }));
setPerpsFeedStartForTest(() => ({ stop: () => {} }));
const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ").replace(/^\[orchestrator\] /, "")); };
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const raw = new DatabaseSync(":memory:");
const shared: Db = wrapSqlite(raw);
await applyLedgerSchema(shared);
await shared.exec(MIRROR_STATE_DDL);
await shared.exec(PAPER_CHECKPOINT_SCHEMA);
setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });

after(() => {
  console.log = realLog;
  setRetirementMemoryStoreForTest(null);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("A NEW PERPS-ONLY LOGIN THE ROLLOUT HOLDS IS NAMED ONCE AND COUNTED HELD, never as one that may run; a login with a Spot wallet is not named here, run or held", async () => {
  const NAMED = address(0x500), SPOT_NEW = address(0x600), PERPS_ONLY = address(0x700), BOTH = address(0x800), OLD = address(0x900);
  await getGrantStore("spot").put(NAMED, grant(NAMED, address(0x501)));
  await getGrantStore("spot").put(SPOT_NEW, grant(SPOT_NEW, address(0x601)));
  // What POST /api/grants?wallet=perps stores for a login with no Spot wallet (owner = the login, D4).
  await getGrantStore("perps").put(PERPS_ONLY, grant(PERPS_ONLY, address(0x701), { purpose: "perps" }));
  await getGrantStore("spot").put(BOTH, grant(BOTH, address(0x801)));
  await getGrantStore("perps").put(BOTH, grant(BOTH, address(0x802), { purpose: "perps" }));
  // A pre-incident login with both wallets: its home is on the volume, so the route finds it not new and it stays held, Perps worker and all.
  await getGrantStore("spot").put(OLD, grant(OLD, address(0x901)));
  await getGrantStore("perps").put(OLD, grant(OLD, address(0x902), { purpose: "perps" }));
  mkdirSync(childHome(OLD), { recursive: true });
  process.env.MERRYMEN_FLEET_ROLLOUT = `${NAMED}:trade`;
  process.env.MERRYMEN_ROLLOUT_NEW_TENANTS = "observe";
  process.env.MERRYMEN_PERPS = "paper";
  for (let i = 0; i < 4; i++) { await reconcile(); await settle(); }

  const homes = spawned.map((p) => p.env.MERRYMEN_HOME);
  const held = `${PERPS_ONLY}:perps` as `0x${string}`;
  const both = `${BOTH}:perps` as `0x${string}`;
  const old = `${OLD}:perps` as `0x${string}`;
  // The rule this build keeps: a Perps-only login is admitted only when named.
  assert.ok(homes.includes(childHome(SPOT_NEW)), "a new Spot-only login is proved new and runs");
  assert.ok(homes.includes(childHome(BOTH)) && homes.includes(childHome(both)), "a new login with both wallets runs both, through its Spot grant");
  assert.deepEqual(newTenantAdmissionsForTest(), [SPOT_NEW, BOTH].sort());
  assert.ok(!homes.includes(childHome(held)), "the Perps-only login's worker is not started");
  assert.ok(!leaseAsks.includes(held), "nor leased");
  assert.equal(existsSync(childHome(held)), false, "no Perps home");
  assert.ok(!homes.includes(childHome(OLD)) && !homes.includes(childHome(old)), "the pre-incident login stays held, both wallets");
  assert.ok(said.some((l) => l.startsWith(`new tenants: ${OLD} is not new`)), "and its Spot wallet's own line says why");

  // ...and says so: once, with what to do.
  const named = said.filter((l) => l.startsWith(`perps: ${held} is held`));
  assert.equal(named.length, 1, `said once across four passes: ${JSON.stringify(named)}`);
  const line = named[0]!;
  assert.match(line, /MERRYMEN_FLEET_ROLLOUT does not name its owner, and a login with no Spot wallet is never admitted by MERRYMEN_ROLLOUT_NEW_TENANTS/);
  assert.match(line, /refused until its book reports/);
  assert.ok(line.includes(`name ${PERPS_ONLY} in MERRYMEN_FLEET_ROLLOUT`), line);
  for (const key of [both, old]) assert.equal(said.filter((l) => l.startsWith(`perps: ${key}`)).length, 0, `${key}: a login with a Spot wallet is not said here, run or held`);
  const roster = said.filter((l) => l.startsWith("perps roster:"));
  assert.ok(roster.length > 0, "the roster line is said");
  assert.equal(roster.at(-1), "perps roster: 3 Perps wallets, 1 unexpired may run, 2 held as their owners are (MERRYMEN_PERPS=paper)");
  assert.ok(roster.every((l) => !/ [23] unexpired may run/.test(l)), "a held wallet is never counted as one that may run");

  // Named, it runs, and the roster says so.
  process.env.MERRYMEN_FLEET_ROLLOUT = `${NAMED}:trade,${PERPS_ONLY}:observe`;
  for (let i = 0; i < 2; i++) { await reconcile(); await settle(); }
  assert.ok(spawned.map((p) => p.env.MERRYMEN_HOME).includes(childHome(held)), "named, its Perps worker starts");
  assert.equal(said.filter((l) => l.startsWith("perps roster:")).at(-1), "perps roster: 3 Perps wallets, 2 unexpired may run, 1 held as its owner is (MERRYMEN_PERPS=paper)");
});
