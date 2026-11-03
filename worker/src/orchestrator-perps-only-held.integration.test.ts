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

it("A LOGIN WITH NO UNEXPIRED SPOT GRANT THE ROLLOUT HOLDS IS NAMED ONCE AND COUNTED HELD, never as one that may run; a login with one is not named here, run or held, nor one the accounting hold or a shut route holds", async () => {
  const NAMED = address(0x500), SPOT_NEW = address(0x600), PERPS_ONLY = address(0x700), BOTH = address(0x800), OLD = address(0x900);
  const EXPIRED = address(0xa00), ACCT = address(0xb00), LATE = address(0xc00);
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
  // A Spot grant that expired before the route could admit it: the route asks only unexpired Spot keys, so this login is held as a Perps-only one is.
  await getGrantStore("spot").put(EXPIRED, grant(EXPIRED, address(0xa01), { grantedAt: nowSec() - 7200, expiresAt: nowSec() - 60 }));
  await getGrantStore("perps").put(EXPIRED, grant(EXPIRED, address(0xa02), { purpose: "perps" }));
  // A Perps-only login the accounting hold holds: held like any other login it names, and not this line's to say.
  await getGrantStore("perps").put(ACCT, grant(ACCT, address(0xb01), { purpose: "perps" }));
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = ACCT;
  process.env.MERRYMEN_FLEET_ROLLOUT = `${NAMED}:trade`;
  process.env.MERRYMEN_ROLLOUT_NEW_TENANTS = "observe";
  process.env.MERRYMEN_PERPS = "paper";
  const rosterNow = () => said.filter((l) => l.startsWith("perps roster:")).at(-1);
  await reconcile(); await settle();
  // The pass that admits the two-wallet login counts its Perps worker as one that may run, not held: asked again after the spawn loop.
  assert.equal(rosterNow(), "perps roster: 5 Perps wallets, 1 unexpired may run, 4 held as their owners are (MERRYMEN_PERPS=paper)");
  for (let i = 0; i < 3; i++) { await reconcile(); await settle(); }

  const homes = spawned.map((p) => p.env.MERRYMEN_HOME);
  const key = (owner: `0x${string}`) => `${owner}:perps` as `0x${string}`;
  const held = key(PERPS_ONLY);
  // The rule this build keeps: a login with no unexpired Spot grant is admitted only when named.
  assert.ok(homes.includes(childHome(SPOT_NEW)), "a new Spot-only login is proved new and runs");
  assert.ok(homes.includes(childHome(BOTH)) && homes.includes(childHome(key(BOTH))), "a new login with both wallets runs both, through its Spot grant");
  assert.deepEqual(newTenantAdmissionsForTest(), [SPOT_NEW, BOTH].sort());
  for (const owner of [PERPS_ONLY, EXPIRED, ACCT]) {
    assert.ok(!homes.includes(childHome(key(owner))), `${owner}: its Perps worker is not started`);
    assert.ok(!leaseAsks.includes(key(owner)), `${owner}: nor leased`);
    assert.equal(existsSync(childHome(key(owner))), false, `${owner}: no Perps home`);
  }
  assert.ok(!homes.includes(childHome(OLD)) && !homes.includes(childHome(key(OLD))), "the pre-incident login stays held, both wallets");
  assert.ok(said.some((l) => l.startsWith(`new tenants: ${OLD} is not new`)), "and its Spot wallet's own line says why");

  // ...and says so, once each, with what to do.
  for (const owner of [PERPS_ONLY, EXPIRED]) {
    const named = said.filter((l) => l.startsWith(`perps: ${key(owner)} is held`));
    assert.equal(named.length, 1, `${owner}: said once across four passes: ${JSON.stringify(named)}`);
    const line = named[0]!;
    assert.match(line, /MERRYMEN_FLEET_ROLLOUT does not name its owner, and a login with no unexpired Spot grant is never admitted by MERRYMEN_ROLLOUT_NEW_TENANTS/);
    // True whether or not its book has reported (perps-book-reported.ts).
    assert.match(line, /so no Close, Close all or practice reset is carried out: each is refused while its book has not reported, and queued and left to expire once it has\. Its owner's kill still stops the wallet, and settings and renewals are still saved\./);
    assert.doesNotMatch(line, /nothing its owner asks/, "a held login's kill is carried out (fleet-rollout.ts): the line never says otherwise");
    assert.ok(line.includes(`name ${owner} in MERRYMEN_FLEET_ROLLOUT`), line);
  }
  for (const owner of [BOTH, OLD, ACCT]) {
    assert.equal(said.filter((l) => l.startsWith(`perps: ${key(owner)}`)).length, 0, `${owner}: not said here (an unexpired Spot grant, run or held; or the accounting hold)`);
  }
  const roster = said.filter((l) => l.startsWith("perps roster:"));
  assert.equal(rosterNow(), "perps roster: 5 Perps wallets, 1 unexpired may run, 4 held as their owners are (MERRYMEN_PERPS=paper)");
  assert.ok(roster.every((l) => !/ [2-5] unexpired may run/.test(l)), `a held wallet is never counted as one that may run: ${JSON.stringify(roster)}`);

  // Named, it runs, and the roster says so.
  process.env.MERRYMEN_FLEET_ROLLOUT = `${NAMED}:trade,${PERPS_ONLY}:observe`;
  for (let i = 0; i < 2; i++) { await reconcile(); await settle(); }
  assert.ok(spawned.map((p) => p.env.MERRYMEN_HOME).includes(childHome(held)), "named, its Perps worker starts");
  assert.equal(rosterNow(), "perps roster: 5 Perps wallets, 2 unexpired may run, 3 held as their owners are (MERRYMEN_PERPS=paper)");

  // The route shut: an explicit list without it holds a new Perps-only login as it holds any login it does not name, and this line is not said.
  await getGrantStore("perps").put(LATE, grant(LATE, address(0xc01), { purpose: "perps" }));
  delete process.env.MERRYMEN_ROLLOUT_NEW_TENANTS;
  for (let i = 0; i < 2; i++) { await reconcile(); await settle(); }
  assert.ok(!spawned.map((p) => p.env.MERRYMEN_HOME).includes(childHome(key(LATE))), "the route shut, it is not started");
  assert.equal(said.filter((l) => l.startsWith(`perps: ${key(LATE)}`)).length, 0, "and not said here: the route is shut");
  // Without the route its record admits no one, so the two-wallet login is held again too; only the named Perps-only login may run.
  assert.equal(rosterNow(), "perps roster: 6 Perps wallets, 1 unexpired may run, 5 held as their owners are (MERRYMEN_PERPS=paper)", "counted with the held");
  delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
});
