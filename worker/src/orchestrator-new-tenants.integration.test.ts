/**
 * MERRYMEN_ROLLOUT_NEW_TENANTS, THROUGH THE REAL reconcile().
 *
 * Under an explicit MERRYMEN_FLEET_ROLLOUT a tenant the list does not name is
 * held. With the variable set, one that is genuinely new (no home or archive
 * on the volume, no history in Postgres, no accounting hold, no kill) is
 * proved so, recorded durably in fleet_new_tenant_admissions under its lease
 * BEFORE its first spawn, and started at the variable's level; the record,
 * not a fresh look, admits it from then on. Everything else the list does not
 * name stays held, and every way the proof can fail holds it too.
 *
 * Driven as orchestrator-rollout.integration.test.ts drives the rollout: the
 * file-backed grant store, the no-op lease with every request recorded
 * (setLeaseAcquireForTest), the worker replaced by a fake (setSpawnForTest),
 * and a sqlite "Postgres" (setRetirementMemoryStoreForTest).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import { DEPLOY_GUARD_IMAGE, hostedOrchestratorRefusals, onRailway } from "./deploy-guard-checks";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-new-tenants-")));
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

const {
  childEnv, childHome, fleetHaltFile, forgetNewTenantAdmissionsForTest, hasLeaseForTest, newTenantAdmissionsForTest, reconcile,
  rolloutCountsForTest, runOrchestrator, setKillConfirmForTest, setLeaseAcquireForTest, setPaperRestoreForTest, setPhantomProcessesForTest,
  setRetirementMemoryStoreForTest, setSpawnForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { writeKillRequest } = await import("./kill-request");
const { acquireTenantLease } = await import("./tenant-lease");

const NEW = "MERRYMEN_ROLLOUT_NEW_TENANTS";
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
/** Each tenant its own owner key, as each browser makes one: the proof reads agents by owner. */
const grant = (account: `0x${string}`, expiresAt = nowSec() + 86_400): StoredGrant => ({
  smartAccount: account, owner: address(Number(BigInt(account) % 0xfffffn) + 0xa00000), sessionKeyAddress: address(0xf02),
  serialized: `eyJ-new-tenant-${account}`, chainId: 4663, grantedAt: nowSec() - 3600, expiresAt,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
}) as unknown as StoredGrant;

class FakeProc extends EventEmitter {
  static next = 93_000;
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

/** The shared store of the test in progress. */
let raw: DatabaseSync;
let shared: Db;
const recorded = (tenant: string): boolean => {
  try { return !!raw.prepare("SELECT 1 FROM fleet_new_tenant_admissions WHERE tenant = ?").get(tenant); } catch { return false; }
};
const rows = (): string[] => {
  try { return (raw.prepare("SELECT tenant FROM fleet_new_tenant_admissions ORDER BY tenant").all() as Array<{ tenant: string }>).map((r) => r.tenant); }
  catch { return []; }
};

const spawned: FakeProc[] = [];
/** For each spawn, whether its tenant's admission was on record at that moment. */
const recordedAtSpawn = new Map<string, boolean>();
setSpawnForTest((_command: string, _args: readonly string[], options: SpawnOptions) => {
  const proc = new FakeProc(options.env ?? {});
  const tenant = path.basename(String(options.env?.MERRYMEN_HOME ?? ""));
  if (!recordedAtSpawn.has(tenant)) recordedAtSpawn.set(tenant, recorded(tenant));
  spawned.push(proc);
  return proc as unknown as ChildProcess;
});
const leaseAsks: string[] = [];
/** Per test: run before a lease is granted (a race to stage), or refuse it (another replica holds it). */
let beforeLease: ((tenant: string) => Promise<void>) | null = null;
const leasedElsewhere = new Set<string>();
setLeaseAcquireForTest(async (tenant) => {
  const lc = tenant.toLowerCase();
  leaseAsks.push(lc);
  if (beforeLease) await beforeLease(lc);
  if (leasedElsewhere.has(lc)) return null;
  return acquireTenantLease(tenant);
});
setKillConfirmForTest(async () => {});
setPaperRestoreForTest(async () => ({ ok: true, line: null }));

const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const pass = async () => { await reconcile(); await settle(); };
const store = getGrantStore();
const used: `0x${string}`[] = [];
let n = 0x300;
/** A tenant and its account, with a grant stored. */
const tenantWithGrant = async (): Promise<{ t: `0x${string}`; account: `0x${string}` }> => {
  n += 0x10;
  const t = address(n), account = address(n + 1);
  used.push(t);
  await store.put(t, grant(account));
  return { t, account };
};
/** One row, every other NOT NULL column filled with something of its type (new-tenant-admission.test.ts says why). */
let fill = 0;
function insertRow(table: string, values: Record<string, string | number>): void {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
  const row: Record<string, string | number> = {};
  for (const c of cols) {
    if (c.name in values) row[c.name] = values[c.name]!;
    else if (c.notnull || c.pk) row[c.name] = /INT|REAL/i.test(c.type) ? ++fill : `fill-${++fill}`;
  }
  const names = Object.keys(row);
  raw.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((k) => row[k]!));
}
const spawnedFor = (tenant: string) => spawned.filter((p) => p.env.MERRYMEN_HOME === childHome(tenant));
const running = (tenant: string) => spawnedFor(tenant).filter((p) => !p.gone);
const saidOf = (re: RegExp) => said.filter((l) => re.test(l));
const archiveOf = (tenant: string) => path.join(fleet, "archive", tenant);

beforeEach(async () => {
  raw = new DatabaseSync(":memory:");
  shared = wrapSqlite(raw);
  await applyLedgerSchema(shared);
  await shared.exec(MIRROR_STATE_DDL);
  await shared.exec(PAPER_CHECKPOINT_SCHEMA);
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
  delete process.env[NEW];
  delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
  setPhantomProcessesForTest(0);
  beforeLease = null;
  leasedElsewhere.clear();
  for (const tenant of used) await store.remove(tenant);
  await pass();
  for (const tenant of used.splice(0)) {
    rmSync(childHome(tenant), { recursive: true, force: true });
    rmSync(archiveOf(tenant), { recursive: true, force: true });
  }
  setRetirementMemoryStoreForTest(null);
  raw.close();
  forgetNewTenantAdmissionsForTest();
  spawned.length = 0;
  recordedAtSpawn.clear();
  leaseAsks.length = 0;
  said.length = 0;
});

describe("unset: exactly today's behaviour", () => {
  it("an unnamed brand-new tenant is held; nothing is read, made or recorded; the counts carry no `new`", async () => {
    const named = await tenantWithGrant(), fresh = await tenantWithGrant();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${named.t}:trade`;
    await pass();
    await pass();
    assert.equal(spawnedFor(named.t).length, 1);
    assert.deepEqual(spawnedFor(fresh.t), []);
    assert.ok(!leaseAsks.includes(fresh.t), "never leased");
    assert.equal(existsSync(childHome(fresh.t)), false);
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'fleet_new_tenant_admissions'").get(), undefined, "the table is not even made");
    assert.deepEqual(rolloutCountsForTest(), { trade: 1, "exits-only": 0, observe: 0, held: 1, expired: 0, absent: 0 });
    assert.deepEqual(saidOf(/new tenants/), []);
  });
});

describe("set, under an explicit list", () => {
  it("a genuinely new tenant is recorded BEFORE its first spawn and runs at the variable's level, after every named tenant", async () => {
    const named = await tenantWithGrant(), fresh = await tenantWithGrant();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${named.t}:trade`;
    process.env[NEW] = "observe";
    await pass();
    assert.equal(spawnedFor(fresh.t).length, 1, said.join("\n"));
    assert.equal(recordedAtSpawn.get(fresh.t), true, "on record before the fork");
    assert.deepEqual(rows(), [fresh.t]);
    const row = raw.prepare("SELECT * FROM fleet_new_tenant_admissions").get() as Record<string, unknown>;
    assert.equal(row.smart_account, fresh.account);
    assert.equal(row.level_at_admission, "observe");
    assert.match(String(row.evidence_digest), /^[0-9a-f]{64}$/);
    const env = spawnedFor(fresh.t)[0]!.env;
    assert.equal(env.MERRYMEN_ADMISSION_LEVEL, "observe");
    assert.equal(env[NEW], undefined, "the fleet-wide variable never reaches a child");
    assert.equal(env.MERRYMEN_FLEET_ROLLOUT, undefined);
    assert.equal(spawnedFor(named.t)[0]!.env.MERRYMEN_ADMISSION_LEVEL, "trade", "the list's tenant keeps the list's level");
    assert.ok(leaseAsks.indexOf(named.t) < leaseAsks.indexOf(fresh.t), "named tenants first");
    assert.equal(saidOf(new RegExp(`new tenants: ${fresh.t} admitted at observe .*recorded in fleet_new_tenant_admissions .*before its first spawn`)).length, 1);
    assert.deepEqual(rolloutCountsForTest(), { trade: 1, "exits-only": 0, observe: 1, held: 0, expired: 0, absent: 0, new: 1 });
    assert.deepEqual(newTenantAdmissionsForTest(), [fresh.t]);
    // RAISING THE VARIABLE RAISES IT, on its next spawn; its record still says what it was admitted at.
    process.env[NEW] = "trade";
    assert.equal(childEnv(fresh.t).MERRYMEN_ADMISSION_LEVEL, "trade");
  });

  it("pre-incident and otherwise not-new tenants stay held: a home, an archive, history under its account, a cursor under an old one, an accounting hold", async () => {
    const homed = await tenantWithGrant(), archived = await tenantWithGrant(), traded = await tenantWithGrant();
    const recreated = await tenantWithGrant(), accountingHeld = await tenantWithGrant(), named = await tenantWithGrant(), fresh = await tenantWithGrant();
    mkdirSync(childHome(homed.t), { recursive: true });
    writeFileSync(path.join(childHome(homed.t), "merrymen.db"), "original-book-not-opened", { mode: 0o600 });
    mkdirSync(path.join(archiveOf(archived.t), "gen-1"), { recursive: true });
    insertRow("trades", { agent_id: traded.account, status: "filled" });
    // Its book destroyed by the incident, and its agent re-created under a new
    // account: only its cursor, keyed by the tenant, remembers it ran.
    insertRow("mirror_state", { tenant: recreated.t, table_name: "trades", last_id: 0 });
    process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = accountingHeld.t;
    process.env.MERRYMEN_FLEET_ROLLOUT = `${named.t}:exits-only`;
    process.env[NEW] = "trade";
    await pass();
    await pass();
    for (const held of [homed, archived, traded, recreated, accountingHeld]) {
      assert.deepEqual(spawnedFor(held.t), [], held.t);
      assert.ok(!leaseAsks.includes(held.t), `never leased: ${held.t}`);
      assert.equal(hasLeaseForTest(held.t), false);
    }
    assert.equal(existsSync(childHome(archived.t)), false, "nothing made for it either");
    assert.deepEqual(rows(), [fresh.t], "only the genuinely new tenant is on record");
    assert.equal(spawnedFor(named.t)[0]!.env.MERRYMEN_ADMISSION_LEVEL, "exits-only", "a named fresh tenant runs at the list's level");
    assert.equal(recorded(named.t), false, "and is never recorded as new");
    assert.equal(spawnedFor(fresh.t)[0]!.env.MERRYMEN_ADMISSION_LEVEL, "trade");
    // Each said once, by its reason, and never again by this process.
    assert.equal(saidOf(new RegExp(`${homed.t} is not new — it has a home on the volume; it stays held`)).length, 1);
    assert.equal(saidOf(new RegExp(`${archived.t} is not new — an archive of its home is on the volume`)).length, 1);
    assert.equal(saidOf(new RegExp(`${traded.t} is not new — Postgres holds history for it \\(trades\\)`)).length, 1);
    assert.equal(saidOf(new RegExp(`${recreated.t} is not new — Postgres holds a mirror cursor for it`)).length, 1);
    assert.deepEqual(saidOf(new RegExp(accountingHeld.t)), [], "an accounting-held tenant is not even looked at");
    assert.deepEqual(rolloutCountsForTest(), { trade: 1, "exits-only": 1, observe: 0, held: 5, expired: 0, absent: 0, new: 1 });
    assert.ok(saidOf(/new tenants \(MERRYMEN_ROLLOUT_NEW_TENANTS=trade\): \d+ admitted this pass · 0 waiting for a process slot · 4 not new and held \(2 with a home or archive on the volume, 2 with history in Postgres\)/).length >= 1, said.join("\n"));
  });

  it("an expired key is not admitted, and a queued web order is history", async () => {
    const expired = await tenantWithGrant(), ordered = await tenantWithGrant();
    await store.put(expired.t, grant(expired.account, nowSec() - 60));
    insertRow("agent_commands", { id: "c1", agent_id: ordered.account, kind: "trade" });
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfff1)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    assert.deepEqual(rows(), []);
    assert.deepEqual(spawned, []);
    assert.equal(saidOf(new RegExp(`${ordered.t} is not new — Postgres holds history for it \\(agent_commands\\)`)).length, 1);
  });

  it("a tenant with a pending kill is never admitted, and its kill is carried out", async () => {
    const killed = await tenantWithGrant();
    // A request lives in a home, so a tenant with one is never without one.
    mkdirSync(childHome(killed.t), { recursive: true });
    writeKillRequest(childHome(killed.t), grant(killed.account), nowSec());
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfff2)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    assert.equal(await store.get(killed.t), null, "the kill removed the grant");
    assert.deepEqual(rows(), []);
    assert.deepEqual(spawned, []);
  });

  it("does nothing under none, and records nothing under all", async () => {
    const fresh = await tenantWithGrant();
    process.env[NEW] = "trade";
    process.env.MERRYMEN_FLEET_ROLLOUT = "none";
    await pass();
    assert.deepEqual(spawned, []);
    assert.deepEqual(leaseAsks, []);
    assert.deepEqual(rows(), []);
    assert.deepEqual(saidOf(/new tenants/), []);
    process.env.MERRYMEN_FLEET_ROLLOUT = "all";
    await pass();
    assert.equal(spawnedFor(fresh.t)[0]?.env.MERRYMEN_ADMISSION_LEVEL, "trade");
    assert.deepEqual(rows(), [], "all admits everybody already; nothing to record");
  });
});

describe("restarts and races", () => {
  it("the record survives a restart: an agent it admitted, home and all, is never stood down or re-proved", async () => {
    const fresh = await tenantWithGrant();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfff3)}:trade`;
    process.env[NEW] = "exits-only";
    await pass();
    const child = spawnedFor(fresh.t)[0]!;
    // Its first spawn gave it a home, and a worker soon gives it history.
    mkdirSync(childHome(fresh.t), { recursive: true });
    insertRow("trades", { agent_id: fresh.account, status: "paper" });
    forgetNewTenantAdmissionsForTest(); // what this process knew, gone, as after a restart
    said.length = 0;
    await pass();
    await pass();
    assert.deepEqual(child.signals, [], "never stood down");
    assert.equal(spawnedFor(fresh.t).length, 1);
    assert.deepEqual(newTenantAdmissionsForTest(), [fresh.t], "read back from the record");
    assert.deepEqual(saidOf(/is not new/), [], "and never looked at again");
    assert.equal(rolloutCountsForTest()?.new, 1);
  });

  it("a crash between the record and the spawn: the next process spawns it from the record alone", async () => {
    const fresh = await tenantWithGrant();
    raw.exec(`CREATE TABLE fleet_new_tenant_admissions (tenant TEXT PRIMARY KEY, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL,
      level_at_admission TEXT NOT NULL, admitted_at_ms BIGINT NOT NULL, evidence_digest TEXT NOT NULL)`);
    raw.prepare("INSERT INTO fleet_new_tenant_admissions VALUES (?, ?, 4663, 'observe', 1, 'd')").run(fresh.t, fresh.account);
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfff4)}:trade`;
    process.env[NEW] = "observe";
    await pass();
    assert.equal(spawnedFor(fresh.t)[0]?.env.MERRYMEN_ADMISSION_LEVEL, "observe");
    assert.deepEqual(saidOf(/admitted at/), [], "no second proof or record");
  });

  it("another replica's record admits it here too, home and all", async () => {
    const theirs = await tenantWithGrant();
    mkdirSync(childHome(theirs.t), { recursive: true });
    raw.exec(`CREATE TABLE fleet_new_tenant_admissions (tenant TEXT PRIMARY KEY, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL,
      level_at_admission TEXT NOT NULL, admitted_at_ms BIGINT NOT NULL, evidence_digest TEXT NOT NULL)`);
    raw.prepare("INSERT INTO fleet_new_tenant_admissions VALUES (?, ?, 4663, 'trade', 1, 'd')").run(theirs.t, theirs.account);
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfff5)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    assert.equal(spawnedFor(theirs.t).length, 1);
  });

  it("a lease another replica holds: nothing recorded here, and the next pass that gets it records and starts it", async () => {
    const fresh = await tenantWithGrant();
    leasedElsewhere.add(fresh.t);
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfff6)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    assert.deepEqual(rows(), []);
    assert.deepEqual(spawned, []);
    leasedElsewhere.clear();
    await pass();
    assert.deepEqual(rows(), [fresh.t]);
    assert.equal(spawnedFor(fresh.t).length, 1);
  });

  it("history that appears between the first look and the record: proved again under the lease, not recorded, lease given back", async () => {
    const fresh = await tenantWithGrant();
    beforeLease = async (t) => {
      if (t === fresh.t) insertRow("flows", { agent_id: fresh.account, direction: "in" });
    };
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfff7)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    assert.deepEqual(rows(), []);
    assert.deepEqual(spawned, []);
    assert.equal(hasLeaseForTest(fresh.t), false, "the lease taken only to record it went back");
    assert.equal(saidOf(new RegExp(`${fresh.t} is not new — Postgres holds history for it \\(flows\\)`)).length, 1);
    leaseAsks.length = 0;
    await pass();
    assert.deepEqual(leaseAsks, [], "known not new: not leased again");
  });

  it("a grant that changes between the first look and the record is not recorded on the old proof", async () => {
    const fresh = await tenantWithGrant();
    const replacement = address(0xabcdef);
    let once = true;
    beforeLease = async (t) => {
      if (t === fresh.t && once) { once = false; await store.put(fresh.t, grant(replacement)); }
    };
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfff8)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    assert.deepEqual(rows(), []);
    assert.equal(saidOf(new RegExp(`${fresh.t}'s grant changed while it was being checked`)).length, 1);
    await pass();
    assert.deepEqual(rows(), [fresh.t], "proved again, on the grant as it now stands");
    assert.equal((raw.prepare("SELECT smart_account FROM fleet_new_tenant_admissions").get() as { smart_account: string }).smart_account, replacement);
  });
});

describe("fails closed", () => {
  it("a history read that fails holds it with an alert, records nothing, and is asked again", async () => {
    const fresh = await tenantWithGrant();
    raw.exec("ALTER TABLE paper_checkpoints RENAME TO paper_checkpoints_gone");
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfff9)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    assert.deepEqual(rows(), []);
    assert.deepEqual(spawned, []);
    assert.ok(!leaseAsks.includes(fresh.t), "no lease on a failed look");
    assert.equal(saidOf(new RegExp(`\\[alert\\] new tenants: ${fresh.t} not admitted this pass — its history could not be read \\(Error`)).length, 1);
    raw.exec("ALTER TABLE paper_checkpoints_gone RENAME TO paper_checkpoints");
    await pass();
    assert.deepEqual(rows(), [fresh.t]);
  });

  it("a record that cannot be read admits nobody new, keeps what it admitted running, and says so once", async () => {
    const first = await tenantWithGrant();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfffa)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    const child = spawnedFor(first.t)[0]!;
    const second = await tenantWithGrant();
    raw.exec("ALTER TABLE fleet_new_tenant_admissions RENAME TO fleet_new_tenant_admissions_x");
    raw.exec("CREATE TABLE fleet_new_tenant_admissions (who TEXT)");
    await pass();
    await pass();
    assert.deepEqual(child.signals, [], "a failed read stands nobody down");
    assert.deepEqual(spawnedFor(second.t), []);
    assert.equal(saidOf(/\[alert\] new tenants: fleet_new_tenant_admissions could not be read/).length, 1);
    raw.exec("DROP TABLE fleet_new_tenant_admissions");
    raw.exec("ALTER TABLE fleet_new_tenant_admissions_x RENAME TO fleet_new_tenant_admissions");
    await pass();
    assert.equal(spawnedFor(second.t).length, 1);
    assert.equal(saidOf(/new tenants: fleet_new_tenant_admissions reads again/).length, 1);
  });

  it("with no shared database to record in, nobody is admitted new", async () => {
    const fresh = await tenantWithGrant();
    setRetirementMemoryStoreForTest(null);
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfffb)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    assert.deepEqual(spawnedFor(fresh.t), []);
    assert.equal(saidOf(/\[alert\] new tenants: MERRYMEN_ROLLOUT_NEW_TENANTS is set, but there is no shared database/).length, 1);
  });

  it("FLEET_HALT: the record is not written while the halt is present", async () => {
    const fresh = await tenantWithGrant();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfffc)}:trade`;
    process.env[NEW] = "trade";
    beforeLease = async (t) => { if (t === fresh.t) writeFileSync(fleetHaltFile(), "halt"); };
    try {
      await pass();
      assert.deepEqual(rows(), []);
      assert.deepEqual(spawnedFor(fresh.t), []);
      assert.equal(saidOf(new RegExp(`${fresh.t} not admitted this pass — the right to record it went first`)).length, 1, said.join("\n"));
      assert.equal(hasLeaseForTest(fresh.t), false);
    } finally {
      rmSync(fleetHaltFile(), { force: true });
    }
  });
});

describe("the process cap", () => {
  it("a new tenant leaves the automatic lanes' headroom free, is not proved meanwhile, and starts once a slot frees", async () => {
    const named = await tenantWithGrant(), fresh = await tenantWithGrant();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${named.t}:trade`;
    process.env[NEW] = "trade";
    setPhantomProcessesForTest(48 - 8 - 1); // the named tenant takes the last slot above the headroom
    await pass();
    assert.equal(spawnedFor(named.t).length, 1, "the named tenant still starts");
    assert.deepEqual(spawnedFor(fresh.t), []);
    assert.deepEqual(rows(), [], "not recorded while it waits");
    assert.ok(!leaseAsks.includes(fresh.t));
    assert.equal(saidOf(/\[alert\] new tenants: 1 wait for a process slot — workers and holds leave fewer than 8 of the 48 free/).length, 1);
    await pass();
    assert.equal(saidOf(/\[alert\] new tenants: 1 wait for a process slot/).length, 1, "said once per change, not every pass");
    setPhantomProcessesForTest(0);
    await pass();
    assert.equal(spawnedFor(fresh.t).length, 1);
  });

  it("never takes a slot while a named tenant waits for one", async () => {
    const named = await tenantWithGrant(), fresh = await tenantWithGrant();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${named.t}:trade`;
    process.env[NEW] = "trade";
    setPhantomProcessesForTest(48);
    await pass();
    assert.deepEqual(spawned, []);
    assert.deepEqual(rows(), []);
  });
});

describe("revoking an admission", () => {
  it("the accounting hold stands it down, whatever the record says, and lifting it starts it again", async () => {
    const fresh = await tenantWithGrant();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfffd)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    const child = spawnedFor(fresh.t)[0]!;
    process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = fresh.t;
    await pass();
    assert.equal(child.gone, true, "stood down");
    assert.equal(rolloutCountsForTest()?.held, 1);
    delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
    await pass();
    assert.equal(running(fresh.t).length, 1, "the record still admits it");
  });

  it("deleting its row stands it down on the next pass, and with a home by then it is never proved new again", async () => {
    const fresh = await tenantWithGrant();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfffe)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    mkdirSync(childHome(fresh.t), { recursive: true });
    const child = spawnedFor(fresh.t)[0]!;
    raw.prepare("DELETE FROM fleet_new_tenant_admissions WHERE tenant = ?").run(fresh.t);
    await pass();
    await pass();
    assert.equal(child.gone, true);
    assert.equal(spawnedFor(fresh.t).length, 1, "not started again");
    assert.deepEqual(rows(), []);
    assert.equal(saidOf(new RegExp(`${fresh.t} is not new — it has a home on the volume`)).length, 1);
  });

  it("removing the variable holds every tenant it admitted; setting it again lets the record admit them", async () => {
    const fresh = await tenantWithGrant();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xffff)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    const child = spawnedFor(fresh.t)[0]!;
    delete process.env[NEW];
    await pass();
    assert.equal(child.gone, true);
    process.env[NEW] = "observe";
    await pass();
    assert.equal(running(fresh.t)[0]?.env.MERRYMEN_ADMISSION_LEVEL, "observe");
  });

  it("naming it in the list gives it the list's level instead", async () => {
    const fresh = await tenantWithGrant();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfef0)}:trade`;
    process.env[NEW] = "trade";
    await pass();
    process.env.MERRYMEN_FLEET_ROLLOUT = `${address(0xfef0)}:trade,${fresh.t}:observe`;
    assert.equal(childEnv(fresh.t).MERRYMEN_ADMISSION_LEVEL, "observe");
    await pass();
    assert.equal(rolloutCountsForTest()?.new, 0);
  });
});

describe("startup", () => {
  /** orchestrator-rollout.integration.test.ts's boot, with this variable beside the rollout. */
  const boot = async (rollout: string, value: string, extra: Record<string, string> = {}) => {
    const saved = { ...process.env };
    process.env.MERRYMEN_FLEET_ROLLOUT = rollout;
    process.env[NEW] = value;
    process.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY = "1";
    Object.assign(process.env, extra);
    if (onRailway(process.env)) {
      const service = process.env.RAILWAY_SERVICE_ID || "227ff49a-1111-4222-8333-444455556666";
      Object.assign(process.env, {
        RAILWAY_SERVICE_ID: service, MERRYMEN_FLEET_SERVICE_ID: service,
        MERRYMEN_PERSISTENT_HOME_REQUIRED: "1", MERRYMEN_IMAGE: DEPLOY_GUARD_IMAGE,
      });
    }
    try {
      assert.deepEqual(hostedOrchestratorRefusals(process.env), []);
      await runOrchestrator();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  };

  it("refuses a malformed value before either entry path, under any scope", async () => {
    for (const [rollout, value] of [[`${address(1)}:trade`, "bogus"], [`${address(1)}:trade`, ""], ["none", "halt"], ["all", "Trade"]]) {
      assert.match((await boot(rollout!, value!))!, /^MERRYMEN_ROLLOUT_NEW_TENANTS is not observe, exits-only or trade/, `${rollout} / ${value}`);
    }
  });

  it("accepts a valid value, under an explicit list and beside none, and goes on to the next check in line", async () => {
    assert.match((await boot(`${address(1)}:trade`, "trade"))!, /names tenants to start, and MERRYMEN_FLEET_RECOVERY_REPORT_ONLY=1 starts none/);
    assert.match((await boot("none", "exits-only", { RAILWAY_ENVIRONMENT: "production" }))!, /report-only prerequisites/);
  });
});
