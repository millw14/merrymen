/**
 * A TENANT WHOSE ID IS NOT 0x, THROUGH THE REAL reconcile() (fleet-id.ts).
 *
 * Every fleet path that reads a tenant id asks fleet-id.ts, and an id that is
 * not 0x and 40 hex (a Solana agent's, `sol:<pubkey>`) is never passed over
 * without a word: it is said, and it fails closed.
 *
 *  - A grant for one is held under `all`: never leased, spawned or armed, and
 *    counted held. Under `all` it used to come back as `trade`.
 *  - A process running for one is stood down (must-stop).
 *  - A home for one, with a pending kill in it or not, is said by the order
 *    ferry and by reconcile, and left exactly as it is.
 *  - A new-tenant record for one admits nobody, and is said.
 *
 * Driven as orchestrator-rollout.integration.test.ts drives the rollout: the
 * file-backed grant store, the no-op lease with every request recorded, the
 * worker replaced by a fake, and a sqlite "Postgres". The drain's half is in
 * orchestrator-drain.integration.test.ts.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { NEW_TENANT_ADMISSIONS_DDL } from "./new-tenant-admission";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-fleet-id-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
delete process.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY;
delete process.env.MERRYMEN_PERSISTENT_HOME_REQUIRED;
delete process.env.MERRYMEN_FLEET_ROLLOUT;
delete process.env.MERRYMEN_ROLLOUT_NEW_TENANTS;
// Not Railway: unset means `all` here, every 0x tenant admitted at trade.
for (const key of Object.keys(process.env)) if (key.startsWith("RAILWAY_")) delete process.env[key];
const dek = Buffer.alloc(32, 85);
process.env.MERRYMEN_STORE_DEK = dek.toString("base64");

const {
  adoptChildForTest, childHome, forgetNewTenantAdmissionsForTest, honourPendingKills, newTenantAdmissionsForTest, reconcile,
  rolloutCountsForTest, setKillConfirmForTest, setLeaseAcquireForTest, setPaperRestoreForTest, setRetirementMemoryStoreForTest, setSpawnForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { writeKillRequest } = await import("./kill-request");
const { acquireTenantLease } = await import("./tenant-lease");

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const grant = (account: `0x${string}`): StoredGrant => ({
  smartAccount: account, owner: address(0xf01), sessionKeyAddress: address(0xf02),
  serialized: `eyJ-fleet-id-${account}`, chainId: 4663, grantedAt: nowSec() - 3600, expiresAt: nowSec() + 86_400,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
}) as unknown as StoredGrant;

/** A real Solana key. A Solana build names its agent `sol:<key>`, case and all. */
const KEY = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
const SOL_AGENT = `sol:${KEY}`;
/** As the file grant store keeps every tenant (lowercased): still not 0x, which is all that matters here. */
const SOL_STORED = SOL_AGENT.toLowerCase() as `0x${string}`;

class FakeProc extends EventEmitter {
  static next = 85_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  gone = false;
  constructor(readonly env: NodeJS.ProcessEnv = {}) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    setImmediate(() => this.die(null, String(signal ?? "SIGTERM")));
    return true;
  }
  die(code: number | null, signal: string | null = null): void {
    if (this.gone) return;
    this.gone = true;
    this.emit("exit", code, signal);
  }
}
const spawned: FakeProc[] = [];
setSpawnForTest((_command: string, _args: readonly string[], options: SpawnOptions) => {
  const proc = new FakeProc(options.env ?? {});
  spawned.push(proc);
  return proc as unknown as ChildProcess;
});
const leaseAsks: string[] = [];
setLeaseAcquireForTest(async (tenant) => {
  leaseAsks.push(tenant.toLowerCase());
  return acquireTenantLease(tenant);
});
const confirmed: string[] = [];
setKillConfirmForTest(async (tenant) => { confirmed.push(tenant); });
setPaperRestoreForTest(async () => ({ ok: true, line: null }));

const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
const saidOf = (re: RegExp) => said.filter((l) => re.test(l));
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const store = getGrantStore("spot");
const granted: `0x${string}`[] = [];
const put = async (tenant: `0x${string}`, account: `0x${string}`) => { granted.push(tenant); await store.put(tenant, grant(account)); };
const children = path.join(fleet, "children");

/** Each entry's name, mode, inode, mtime and bytes: a pass that only looked leaves it equal. */
function snapshot(dir: string): unknown {
  const st = lstatSync(dir, { bigint: true });
  const entries = readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name), s = lstatSync(file, { bigint: true });
    return [name, String(s.mode), String(s.ino), String(s.mtimeNs), s.isDirectory() ? snapshot(file) : readFileSync(file).toString("base64")];
  });
  return [String(st.mode), String(st.ino), String(st.mtimeNs), entries];
}

let raw: DatabaseSync;
let shared: Db;
beforeEach(async () => {
  raw = new DatabaseSync(":memory:");
  shared = wrapSqlite(raw);
  await applyLedgerSchema(shared);
  await shared.exec(MIRROR_STATE_DDL);
  setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
  forgetNewTenantAdmissionsForTest();
});
after(() => {
  console.log = realLog;
  setLeaseAcquireForTest(null);
  setRetirementMemoryStoreForTest(null);
  setPaperRestoreForTest(null);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
afterEach(async () => {
  delete process.env.MERRYMEN_FLEET_ROLLOUT;
  delete process.env.MERRYMEN_ROLLOUT_NEW_TENANTS;
  for (const tenant of granted) await store.remove(tenant);
  await reconcile();
  await settle();
  for (const tenant of granted.splice(0)) rmSync(childHome(tenant), { recursive: true, force: true });
  setRetirementMemoryStoreForTest(null);
  raw.close();
  forgetNewTenantAdmissionsForTest();
  spawned.length = 0;
  leaseAsks.length = 0;
  confirmed.length = 0;
  said.length = 0;
});

describe("a tenant whose id is not 0x", () => {
  it("is held under `all`: never leased, spawned or given a home, counted held, its grant kept, and said once", async () => {
    const evm = address(0x101);
    await put(evm, address(0x102));
    await put(SOL_STORED, address(0x104));
    for (let pass = 0; pass < 3; pass++) {
      await reconcile();
      await honourPendingKills(); // the order ferry's clock, as well as reconcile's
      await settle();
    }
    assert.deepEqual(spawned.map((p) => p.env.MERRYMEN_HOME), [childHome(evm)], "the 0x tenant beside it runs, as before");
    assert.equal(spawned[0]!.env.MERRYMEN_ADMISSION_LEVEL, "trade");
    assert.ok(!leaseAsks.includes(SOL_STORED), `never leased: ${leaseAsks.join(", ")}`);
    assert.equal(existsSync(path.join(children, SOL_STORED)), false, "no home is made for it");
    assert.deepEqual(rolloutCountsForTest(), { trade: 1, "exits-only": 0, observe: 0, held: 1, expired: 0, absent: 0 });
    assert.ok(await store.get(SOL_STORED), "held, not removed: its grant stays stored");
    assert.equal(saidOf(/\[alert\] fleet: the grant roster holds (Solana )?id "sol:2u1tsz.*not a Robinhood Chain address — this build never leases, starts or arms it/).length, 1,
      "said once over three passes, not every pass");
  });

  it("running, is stood down, and nothing starts in its place (must-stop)", async () => {
    await put(SOL_STORED, address(0x114));
    const proc = new FakeProc();
    adoptChildForTest(SOL_STORED, address(0x114), proc as unknown as ChildProcess);
    await reconcile();
    await settle();
    assert.deepEqual(proc.signals.slice(0, 1), ["SIGTERM"], "stood down by the hold");
    assert.equal(proc.gone, true);
    await reconcile();
    await settle();
    assert.deepEqual(spawned, [], "and never restarted or spawned again");
    assert.ok(!leaseAsks.includes(SOL_STORED));
    assert.ok(await store.get(SOL_STORED), "a stand-down, not a removal");
  });

  it("a home that is not a tenant's is said, by the order ferry and by reconcile, its pending kill named, and never wiped", async () => {
    // As a Solana build would name its home, and a 0x home not as childHome spells any.
    const solHome = path.join(children, SOL_AGENT);
    const upperHome = path.join(children, address(0xabc121).toUpperCase().replace("0X", "0x"));
    mkdirSync(solHome, { recursive: true });
    mkdirSync(upperHome, { recursive: true });
    writeFileSync(path.join(solHome, "merrymen.db"), "a book nobody here may open", { mode: 0o600 });
    writeKillRequest(solHome, grant(address(0x124)), nowSec());
    const before = snapshot(solHome);
    try {
      for (let pass = 0; pass < 3; pass++) {
        await honourPendingKills();
        await reconcile();
        await settle();
      }
      assert.equal(saidOf(/\[alert\] fleet: children\/Solana id "sol:2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH" holds a pending Telegram kill.*\(held, must-stop\)/).length, 1,
        said.join("\n"));
      assert.equal(saidOf(/\[alert\] fleet: children\/id "0x0+ABC121" is not a Robinhood Chain tenant home — this build never starts a worker in it or wipes it$/).length, 1,
        said.join("\n"));
      assert.deepEqual(snapshot(solHome), before, "left exactly as it is, its kill request and book included");
      // The personal-memory sweep reads homes case-blind (personal-memory-ferry.ts),
      // as it did before; this list only promises the home is not wiped.
      assert.equal(existsSync(upperHome), true);
      assert.deepEqual(spawned, []);
      assert.deepEqual(leaseAsks, []);
      assert.deepEqual(confirmed, [], "and no kill is reported carried out");
    } finally {
      rmSync(solHome, { recursive: true, force: true });
      rmSync(upperHome, { recursive: true, force: true });
    }
  });

  it("recorded by the new-tenant route, admits nobody and is said; it is never put through the proof", async () => {
    const named = address(0x131);
    await put(named, address(0x132));
    await put(SOL_STORED, address(0x134));
    await shared.exec(NEW_TENANT_ADMISSIONS_DDL);
    for (const tenant of [SOL_AGENT, SOL_STORED]) {
      raw.prepare("INSERT INTO fleet_new_tenant_admissions VALUES (?, ?, 4663, 'trade', 1, 'd')").run(tenant, address(0x134));
    }
    process.env.MERRYMEN_FLEET_ROLLOUT = `${named}:trade`;
    process.env.MERRYMEN_ROLLOUT_NEW_TENANTS = "trade";
    for (let pass = 0; pass < 2; pass++) {
      await reconcile();
      await settle();
    }
    assert.deepEqual(newTenantAdmissionsForTest(), [], "a record for it admits nobody");
    assert.equal(saidOf(/\[alert\] new tenants: fleet_new_tenant_admissions records Solana id "sol:2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", .*admits nobody/).length, 1,
      "named as the row holds it, once");
    assert.equal(saidOf(/\[alert\] new tenants: fleet_new_tenant_admissions records (Solana )?id "sol:2u1tszseqz/).length, 1);
    assert.deepEqual(spawned.map((p) => p.env.MERRYMEN_HOME), [childHome(named)]);
    assert.ok(!leaseAsks.includes(SOL_STORED));
    assert.deepEqual(saidOf(/could not be (read|checked)|not admitted this pass/), [], "never put through the proof, so never a failed read");
    assert.deepEqual(rolloutCountsForTest(), { trade: 1, "exits-only": 0, observe: 0, held: 1, expired: 0, absent: 0, new: 0 });
  });
});
