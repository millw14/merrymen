/**
 * THE ROLLOUT, THROUGH THE REAL reconcile() (fleet-rollout.ts).
 *
 * A tenant MERRYMEN_FLEET_ROLLOUT does not admit is held: the supervisor
 * leases nothing for it, starts nothing for it and retires none of its expired
 * keys, so its home stays as the incident left it. It stays in the roster, so
 * the removed-agent sweep still tells "not admitted" from "removed". Its
 * owner's kill is still carried out, as under FLEET_HALT: a kill only takes
 * authority away. And the hold is one predicate
 * (operatorHold), so it is obeyed by every path that starts a process: the
 * spawn loop, a restart timer already in flight, the holder path, the last
 * check before the fork, and the stand-down of anything already running.
 *
 * Driven over the file-backed grant store and the no-op lease, with the worker
 * process replaced by a fake (setSpawnForTest) and every lease request
 * recorded (setLeaseAcquireForTest): the no-op lease is taken and released
 * without trace, so "never leased" could not otherwise be seen.
 *
 * MERRYMEN_HOME and the environment are per process (node --test runs each
 * file in its own), so nothing here leaks into another file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, describe, it } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite } from "./db";
import { DEPLOY_GUARD_IMAGE, hostedOrchestratorRefusals, onRailway } from "./deploy-guard-checks";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-rollout-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
delete process.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY;
delete process.env.MERRYMEN_PERSISTENT_HOME_REQUIRED;
delete process.env.MERRYMEN_FLEET_ROLLOUT;
// Not Railway: unset means `all` here, and each test names the scope it wants.
for (const key of Object.keys(process.env)) if (key.startsWith("RAILWAY_")) delete process.env[key];
const dek = Buffer.alloc(32, 83);
process.env.MERRYMEN_STORE_DEK = dek.toString("base64");

const {
  adoptHolderForTest, childEnv, childHome, hasLeaseForTest, honourPendingKills, isHeldForTest, isRetiringExpiredForTest,
  reconcile, rolloutCountsForTest, runOrchestrator, setFleetHeartbeatDbForTest, setKillConfirmForTest, setLeaseAcquireForTest,
  setPaperRestoreForTest, setRetirementMemoryStoreForTest, setSpawnForTest, writeOrchestratorHeartbeatForTest,
} = await import("./orchestrator");
const { readFleetHeartbeats } = await import("./fleet-heartbeat");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore, useSettingsStoreForTest } = await import("./settings-store");
const { writeKillRequest } = await import("./kill-request");
const { acquireTenantLease } = await import("./tenant-lease");

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const grant = (account: `0x${string}`, expiresAt = nowSec() + 86_400): StoredGrant => ({
  smartAccount: account, owner: address(0xf01), sessionKeyAddress: address(0xf02),
  serialized: `eyJ-rollout-${account}`, chainId: 4663, grantedAt: nowSec() - 3600, expiresAt,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
}) as unknown as StoredGrant;

/** A worker or hold process reduced to what the orchestrator does with one. */
class FakeProc extends EventEmitter {
  static next = 83_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  gone = false;
  constructor(readonly env: NodeJS.ProcessEnv = {}, readonly hold = false) { super(); }
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
setSpawnForTest((_command: string, args: readonly string[], options: SpawnOptions) => {
  const proc = new FakeProc(options.env ?? {}, args.some((arg) => arg.endsWith("telegram-hold.ts")));
  spawned.push(proc);
  return proc as unknown as ChildProcess;
});
/** Which tenants the supervisor asked a lease for, in order. */
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
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const store = getGrantStore();
const used: `0x${string}`[] = [];
const tenantAt = (n: number) => { const t = address(n); used.push(t); return t; };
const spawnedFor = (tenant: string) => spawned.filter((p) => p.env.MERRYMEN_HOME === childHome(tenant));

after(() => {
  console.log = realLog;
  setLeaseAcquireForTest(null);
  setRetirementMemoryStoreForTest(null);
  setPaperRestoreForTest(null);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
afterEach(async () => {
  // Admit everyone again, take every grant away, and let one pass stand the
  // fleet down and sweep its homes, so each test starts from nothing.
  delete process.env.MERRYMEN_FLEET_ROLLOUT;
  setRetirementMemoryStoreForTest(null);
  setPaperRestoreForTest(async () => ({ ok: true, line: null }));
  for (const tenant of used) await store.remove(tenant);
  await reconcile();
  await settle();
  for (const tenant of used.splice(0)) rmSync(childHome(tenant), { recursive: true, force: true });
  spawned.length = 0;
  leaseAsks.length = 0;
  confirmed.length = 0;
  said.length = 0;
});

/**
 * EVERYTHING ABOUT A HOME THAT A WRITE WOULD CHANGE: each entry's name, mode,
 * inode and mtime, and each file's bytes. Reading changes none of these, so a
 * pass that only looked leaves it equal; one that rewrote a file with the same
 * bytes still changes its inode or mtime.
 */
function snapshot(dir: string): unknown {
  const st = lstatSync(dir, { bigint: true });
  const entries = readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name), s = lstatSync(file, { bigint: true });
    return [name, String(s.mode), String(s.ino), String(s.mtimeNs),
      s.isDirectory() ? snapshot(file) : readFileSync(file).toString("base64")];
  });
  return [String(st.mode), String(st.ino), String(st.mtimeNs), entries];
}

/** The same, without one entry, and without the directory's own mtime, which removing that entry changes. */
function snapshotWithout(dir: string, name: string): unknown {
  const [mode, ino, , entries] = snapshot(dir) as [string, string, string, unknown[][]];
  return [mode, ino, entries.filter((entry) => entry[0] !== name)];
}

describe("a tenant the rollout does not admit", () => {
  it("is never leased, spawned, retired or reported, and its home is untouched over three passes but for an expired key's copy", async () => {
    const admitted = tenantAt(0x101), out = tenantAt(0x201), expired = tenantAt(0x301);
    const outAccount = address(0x202), expiredAccount = address(0x302);
    await store.put(admitted, grant(address(0x102)));
    await store.put(out, grant(outAccount));
    await store.put(expired, grant(expiredAccount, nowSec() - 60));
    // What the incident left in the two held homes: a book nobody may open,
    // the bot's files and a signing-key copy.
    for (const tenant of [out, expired]) {
      const home = childHome(tenant);
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "merrymen.db"), "original-book-not-opened", { mode: 0o600 });
      writeFileSync(path.join(home, "settings.json"), JSON.stringify({ paperTradingEnabled: true }), { mode: 0o600 });
      writeFileSync(path.join(home, "telegram.json"), "{}", { mode: 0o600 });
      writeFileSync(path.join(home, "heartbeat.json"), JSON.stringify({ at: nowSec() - 86_400 }), { mode: 0o600 });
      writeFileSync(path.join(home, "grant.json"), JSON.stringify(await store.get(tenant)), { mode: 0o600 });
    }
    // A shared store, so the paused-source report runs at all: it would take
    // a lease for every cold tenant it looks at.
    const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw);
    await applyLedgerSchema(shared);
    await shared.exec(MIRROR_STATE_DDL);
    setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
    try {
      process.env.MERRYMEN_FLEET_ROLLOUT = `${admitted}:trade`;
      const before = { out: snapshot(childHome(out)), expired: snapshotWithout(childHome(expired), "grant.json") };
      for (let pass = 0; pass < 3; pass++) {
        await reconcile();
        await honourPendingKills(); // the order ferry's clock, as well as reconcile's
        await settle();
      }
      assert.deepEqual(snapshot(childHome(out)), before.out, "the held home is exactly as the incident left it");
      // An expired key's copy goes, held or not: that only takes authority
      // away, and needs no lease. Nothing else in that home is touched.
      assert.equal(existsSync(path.join(childHome(expired), "grant.json")), false, "the expired signing-key copy is scrubbed");
      assert.deepEqual(snapshotWithout(childHome(expired), "grant.json"), before.expired, "and the rest of the expired home is as the incident left it");
      assert.ok(!leaseAsks.includes(out) && !leaseAsks.includes(expired), `no lease asked for a held tenant: ${leaseAsks.join(", ")}`);
      assert.ok(leaseAsks.includes(admitted), "the admitted tenant was leased");
      assert.equal(hasLeaseForTest(out), false);
      assert.equal(hasLeaseForTest(expired), false);
      assert.deepEqual(spawned.map((p) => p.env.MERRYMEN_HOME), [childHome(admitted)], "only the admitted tenant runs");
      assert.equal(isRetiringExpiredForTest(expired), false, "its expiry is not retired");
      assert.deepEqual(rolloutCountsForTest(), { trade: 1, "exits-only": 0, observe: 0, held: 2, expired: 0, absent: 0 });

      // THE LEVEL, AND ONLY THE LEVEL, REACHES THE CHILD.
      const env = spawned[0]!.env;
      assert.equal(env.MERRYMEN_ADMISSION_LEVEL, "trade");
      assert.equal(env.MERRYMEN_FLEET_ROLLOUT, undefined, "the rollout names other tenants; a child never sees it");

      // ADMISSION DOES WHAT WAS WAITING, which also shows the homes above were
      // ones these passes would have changed had they been admitted.
      process.env.MERRYMEN_FLEET_ROLLOUT = `${admitted}:trade,${out}:trade,${expired}:trade`;
      await reconcile();
      await settle();
      assert.ok(leaseAsks.includes(out), "the newly admitted tenant is leased");
      assert.equal(spawnedFor(out).length, 1, "and started");
      assert.equal(spawnedFor(out)[0]!.env.MERRYMEN_ADMISSION_LEVEL, "trade");
      assert.equal(spawnedFor(expired).length, 0, "an expired key still runs nothing");
      assert.deepEqual(rolloutCountsForTest(), { trade: 2, "exits-only": 0, observe: 0, held: 0, expired: 1, absent: 0 },
        "and the heartbeat counts it as expired, not as trading");
    } finally {
      setRetirementMemoryStoreForTest(null);
      raw.close();
    }
  });

  it("one stood down with its key expired is not retired until the pass that admits it", async () => {
    const a = tenantAt(0x1fb), account = address(0x1fc);
    await store.put(a, grant(account));
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:trade`;
    await reconcile();
    assert.equal(spawnedFor(a).length, 1);
    assert.equal(hasLeaseForTest(a), true);
    // The scope narrows and the key expires: its child is stood down, and the
    // retirement that would mirror its book under the lease, then let the
    // lease go, waits.
    await store.put(a, grant(account, nowSec() - 60));
    process.env.MERRYMEN_FLEET_ROLLOUT = "none";
    leaseAsks.length = 0;
    const retiring = () => said.filter((l) => l.includes(`${a}: signed grant expired — retiring its process`));
    for (let pass = 0; pass < 2; pass++) {
      await reconcile();
      await settle();
    }
    assert.equal(spawnedFor(a)[0]!.gone, true, "stood down");
    assert.deepEqual(retiring(), [], "not retired while held");
    assert.equal(isRetiringExpiredForTest(a), false);
    assert.equal(hasLeaseForTest(a), true, "its lease is kept, as for any held tenant still wanted");
    assert.deepEqual(leaseAsks, [], "and none asked for");
    // Admitted again, it is retired as any expired tenant is.
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:trade`;
    await reconcile();
    assert.equal(retiring().length, 1, said.join("\n"));
    assert.equal(spawnedFor(a).length, 1, "and an expired key runs nothing");
  });

  it("`none` admits nobody: no lease, no process, no home", async () => {
    const a = tenantAt(0x111), b = tenantAt(0x121);
    await store.put(a, grant(address(0x112)));
    await store.put(b, grant(address(0x122)));
    process.env.MERRYMEN_FLEET_ROLLOUT = "none";
    await reconcile();
    await reconcile();
    assert.deepEqual(leaseAsks, []);
    assert.deepEqual(spawned, []);
    assert.equal(existsSync(childHome(a)), false, "no settings, anchor, ledger or holder files were written");
    assert.equal(existsSync(childHome(b)), false);
    assert.ok(await store.get(a) && await store.get(b), "both grants stay stored: held is not removed");
    assert.deepEqual(rolloutCountsForTest(), { trade: 0, "exits-only": 0, observe: 0, held: 2, expired: 0, absent: 0 });
  });

  it("still has its owner's kill carried out, by the order ferry and by reconcile, as under FLEET_HALT", async () => {
    const ferried = tenantAt(0x1f7), reconciled = tenantAt(0x1f9);
    const ferriedAccount = address(0x1f8), reconciledAccount = address(0x1fa);
    for (const [tenant, account] of [[ferried, ferriedAccount], [reconciled, reconciledAccount]] as const) {
      await store.put(tenant, grant(account));
      const home = childHome(tenant);
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "merrymen.db"), "original-book-not-opened", { mode: 0o600 });
      writeFileSync(path.join(home, "settings.json"), "{}", { mode: 0o600 });
    }
    process.env.MERRYMEN_FLEET_ROLLOUT = "none";
    // The order ferry's three-second clock (honourPendingKills)...
    writeKillRequest(childHome(ferried), grant(ferriedAccount), nowSec());
    await honourPendingKills();
    assert.equal(await store.get(ferried), null, "the ferry removes a held tenant's revoked grant within seconds");
    assert.deepEqual(confirmed, [ferried], "and the owner is told");
    // ...and reconcile's own pass, which must not leave it to the ferry.
    writeKillRequest(childHome(reconciled), grant(reconciledAccount), nowSec());
    await reconcile();
    await settle();
    assert.equal(await store.get(reconciled), null, "reconcile carries it out too");
    assert.deepEqual(confirmed, [ferried, reconciled]);
    for (const tenant of [ferried, reconciled]) {
      assert.equal(existsSync(path.join(childHome(tenant), "settings.json")), false, "a revoked tenant is removed, and its cached access cleared");
      assert.equal(existsSync(path.join(childHome(tenant), "merrymen.db")), true, "with its original book kept");
    }
    assert.deepEqual(leaseAsks, [], "a kill takes no lease");
    assert.deepEqual(spawned, []);
    // Admitting them later arms nothing: the grants are gone.
    process.env.MERRYMEN_FLEET_ROLLOUT = `${ferried}:trade,${reconciled}:trade`;
    await reconcile();
    assert.deepEqual(spawned, []);
  });

  it("a named tenant missing from the roster is counted, so a typo is visible", async () => {
    const a = tenantAt(0x131), b = tenantAt(0x133);
    await store.put(a, grant(address(0x132)));
    await store.put(b, grant(address(0x134)));
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:trade,${b}:trade,${address(0x999)}:trade`;
    // And one the rollout admits but the accounting hold names: held, not trading.
    process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = b;
    try {
      await reconcile();
    } finally {
      delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
    }
    assert.deepEqual(rolloutCountsForTest(), { trade: 1, "exits-only": 0, observe: 0, held: 1, expired: 0, absent: 1 });
    assert.equal(spawnedFor(a)[0]?.env.MERRYMEN_ADMISSION_LEVEL, "trade");
    assert.equal(spawnedFor(b).length, 0);
    // And the heartbeat row publishes those counts under the scope's name, as
    // the `fleet| rollout` line says them: never a tenant.
    const raw = new DatabaseSync(":memory:");
    setFleetHeartbeatDbForTest(wrapSqlite(raw));
    try {
      assert.equal(await writeOrchestratorHeartbeatForTest(true), true);
      const [h] = await readFleetHeartbeats(wrapSqlite(raw), nowSec() + 1);
      assert.deepEqual(h!.rollout, { scope: "3 named", levels: { trade: 1, "exits-only": 0, observe: 0, held: 1, expired: 0, absent: 1 } });
      assert.doesNotMatch(JSON.stringify(h), /0x[0-9a-f]{40}/i);
    } finally {
      setFleetHeartbeatDbForTest(null);
      raw.close();
    }
  });
});

describe("the removed-agent sweep is the fleet's, not the rollout's", () => {
  it("still cleans a truly removed tenant while the rollout admits nobody", async () => {
    const gone = tenantAt(0x141), goneWithBook = tenantAt(0x151), held = tenantAt(0x161);
    await store.put(held, grant(address(0x162)));
    for (const tenant of [gone, goneWithBook, held]) {
      mkdirSync(childHome(tenant), { recursive: true });
      writeFileSync(path.join(childHome(tenant), "settings.json"), "{}");
      writeFileSync(path.join(childHome(tenant), "telegram.json"), "{}");
    }
    writeFileSync(path.join(childHome(goneWithBook), "merrymen.db"), "original-book");
    process.env.MERRYMEN_FLEET_ROLLOUT = "none";
    await reconcile();
    assert.equal(existsSync(childHome(gone)), false, "a removed tenant with no book is wiped");
    assert.equal(existsSync(path.join(childHome(goneWithBook), "settings.json")), false, "a removed tenant's cached access is cleared");
    assert.equal(existsSync(path.join(childHome(goneWithBook), "merrymen.db")), true, "and its original book retained");
    assert.equal(existsSync(path.join(childHome(held), "settings.json")), true, "a held tenant is wanted, not removed");
    assert.deepEqual(leaseAsks, []);
  });

  it("a removed tenant still running goes to the kill switch, not the rollout's stand-down", async () => {
    const child = tenantAt(0x1fd), held = tenantAt(0x1ff), heldAccount = address(0x200);
    await store.put(child, grant(address(0x1fe)));
    process.env.MERRYMEN_FLEET_ROLLOUT = `${child}:trade`;
    await reconcile();
    assert.equal(spawnedFor(child).length, 1);
    await store.put(held, grant(heldAccount));
    const hold = new FakeProc({}, true);
    await adoptHolderForTest(held, heldAccount, hold as unknown as ChildProcess);
    // Both grants deleted, and a scope that names neither: removed, which the
    // rollout would otherwise also read as held.
    await store.remove(child);
    await store.remove(held);
    process.env.MERRYMEN_FLEET_ROLLOUT = "none";
    said.length = 0;
    await reconcile();
    await settle();
    assert.equal(spawnedFor(child)[0]!.gone, true);
    assert.deepEqual(hold.signals.slice(0, 1), ["SIGTERM"]);
    assert.ok(said.some((l) => l.includes(`${child} grant removed — standing it down`)), said.join("\n"));
    assert.ok(said.some((l) => l.includes(`${held} grant removed — standing its hold down`)), said.join("\n"));
  });
});

describe("one hold predicate, at every path that starts a process", () => {
  it("narrowing the rollout stands down only that tenant's running child", async () => {
    const a = tenantAt(0x171), b = tenantAt(0x181);
    await store.put(a, grant(address(0x172)));
    await store.put(b, grant(address(0x182)));
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:trade,${b}:trade`;
    await reconcile();
    assert.equal(spawned.length, 2);
    process.env.MERRYMEN_FLEET_ROLLOUT = `${b}:trade`;
    leaseAsks.length = 0;
    await reconcile();
    await settle();
    assert.equal(spawnedFor(a)[0]!.gone, true);
    assert.equal(spawnedFor(b)[0]!.gone, false);
    await reconcile();
    assert.equal(spawnedFor(a).length, 1, "and it is not started again");
    assert.ok(!leaseAsks.includes(a));
    assert.ok(await store.get(a), "its grant stays stored");
  });

  it("a child that exits while out of the rollout schedules no restart", async (context) => {
    const a = tenantAt(0x191);
    await store.put(a, grant(address(0x192)));
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:trade`;
    await reconcile();
    assert.equal(spawned.length, 1);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    process.env.MERRYMEN_FLEET_ROLLOUT = "none";
    spawned[0]!.die(1);
    context.mock.timers.tick(60_000);
    await settle();
    assert.ok(!said.some((l) => l.includes(`${a} rallying again`)), `no restart is scheduled:\n${said.join("\n")}`);
    assert.equal(spawned.length, 1);
  });

  it("a restart scheduled while admitted cannot start the tenant once the rollout no longer does", async (context) => {
    const a = tenantAt(0x1a1);
    await store.put(a, grant(address(0x1a2)));
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:trade`;
    await reconcile();
    assert.equal(spawned.length, 1);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    spawned[0]!.die(1);
    await settle();
    assert.ok(said.some((l) => l.includes(`${a} rallying again`)), "the restart was scheduled while admitted");
    process.env.MERRYMEN_FLEET_ROLLOUT = "none";
    // Past spawnChild's first gate, its first await is the stored grant's read,
    // reached synchronously from the timer's callback: a read here means the
    // spawn went on to prepare a key and settings it was never going to use.
    const reads: string[] = [];
    store.get = async function (this: typeof store, tenant: `0x${string}`) {
      reads.push(tenant.toLowerCase());
      return Object.getPrototypeOf(this).get.call(this, tenant);
    };
    try {
      context.mock.timers.tick(60_000);
      await settle();
    } finally {
      delete (store as { get?: unknown }).get;
    }
    assert.equal(spawned.length, 1, "the timer reaches spawnChild and starts nothing");
    assert.ok(!reads.includes(a), "it stopped at the first gate, before reading the grant to write it into the home");
    await reconcile();
    assert.equal(spawned.length, 1);
  });

  it("narrowing during spawn preparation blocks the holder path", async () => {
    const a = tenantAt(0x1b1);
    await store.put(a, grant(address(0x1b2)));
    await getSettingsStore().put(a, { paperTradingEnabled: true, telegramEnabled: false } as never);
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:trade`;
    setPaperRestoreForTest(async () => {
      process.env.MERRYMEN_FLEET_ROLLOUT = "none";
      return { ok: false, reason: "paper fills are newer than the recoverable valuation" };
    });
    await reconcile();
    assert.equal(spawned.length, 0, "a failed restore cannot start a holder for a tenant the rollout no longer admits");
    assert.equal(isHeldForTest(a), false, "nor record one");
    assert.ok(!said.some((l) => l.includes(`${a}: MERRYMEN_FLEET_ROLLOUT does not admit this tenant — not holding`)),
      "spawnHolder's own first gate refused, before restoring the bot's link");
  });

  it("a hold the rollout stops admitting mid-pass is not handed back (holdMayLeave)", async () => {
    const a = tenantAt(0x1f5), account = address(0x1f6);
    await store.put(a, grant(account));
    await getSettingsStore().put(a, { paperTradingEnabled: false, telegramEnabled: false } as never);
    const hold = new FakeProc({}, true);
    await adoptHolderForTest(a, account, hold as unknown as ChildProcess);
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:trade`;
    // The scope narrows while the pass reads the held tenant's settings, after
    // its stand-down was decided and before its handover is: only holdMayLeave
    // is left to ask.
    const real = getSettingsStore();
    const narrowing = Object.create(real) as typeof real;
    narrowing.get = async (t) => {
      if (t.toLowerCase() === a) process.env.MERRYMEN_FLEET_ROLLOUT = "none";
      return real.get(t);
    };
    useSettingsStoreForTest(narrowing);
    try {
      await reconcile();
      await settle();
    } finally {
      useSettingsStoreForTest(real);
    }
    assert.deepEqual(hold.signals, [], "its hold process is not stopped for a handover that would refuse");
    assert.equal(isHeldForTest(a), true, "it stays held, so its bot is still answered");
    assert.equal(spawnedFor(a).length, 0);
  });

  it("a successful restore still cannot start a worker once the rollout narrowed during preparation", async () => {
    const a = tenantAt(0x1c1);
    await store.put(a, grant(address(0x1c2)));
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:trade`;
    setPaperRestoreForTest(async () => {
      process.env.MERRYMEN_FLEET_ROLLOUT = "none";
      return { ok: true, line: "restored after the scope narrowed" };
    });
    await reconcile();
    assert.equal(spawned.length, 0, "the last check before the fork sees the rollout");
    assert.ok(said.some((l) => l.includes("MERRYMEN_FLEET_ROLLOUT does not admit this tenant — not spawning")));
  });

  it("a held tenant's hold process is stood down and never retried or handed back; an admitted one is", async () => {
    const a = tenantAt(0x1d1), b = tenantAt(0x1e1);
    const aAccount = address(0x1d2), bAccount = address(0x1e2);
    await store.put(a, grant(aAccount));
    await store.put(b, grant(bAccount));
    // Practice switched off: the gate that held them no longer would, so the
    // pass hands each back to trading, if holdMayLeave lets it.
    await getSettingsStore().put(a, { paperTradingEnabled: false, telegramEnabled: false } as never);
    await getSettingsStore().put(b, { paperTradingEnabled: false, telegramEnabled: false } as never);
    const aHold = new FakeProc({}, true), bHold = new FakeProc({}, true);
    await adoptHolderForTest(a, aAccount, aHold as unknown as ChildProcess);
    await adoptHolderForTest(b, bAccount, bHold as unknown as ChildProcess);
    let restores = 0;
    setPaperRestoreForTest(async () => { restores++; return { ok: true, line: null }; });
    process.env.MERRYMEN_FLEET_ROLLOUT = `${b}:trade`;
    leaseAsks.length = 0;
    await reconcile();
    await settle();
    await reconcile();
    await settle();
    assert.deepEqual(aHold.signals.slice(0, 1), ["SIGTERM"], "the held tenant's hold process is stood down");
    assert.equal(isHeldForTest(a), false, "and forgotten once it has exited");
    assert.equal(spawnedFor(a).length, 0, "never handed back to trading");
    assert.ok(!leaseAsks.includes(a));
    assert.equal(bHold.gone, true, "the admitted tenant's hold process is stopped for the handover");
    assert.equal(spawnedFor(b).length, 1, "and the admitted tenant handed back to trading");
    assert.equal(spawnedFor(b)[0]!.env.MERRYMEN_ADMISSION_LEVEL, "trade");
    assert.equal(restores, 1, "only the admitted tenant's book was restored, by its own spawn");
  });
});

describe("childEnv", () => {
  it("always sets the tenant's own level, over anything the orchestrator's env carried, and strips the rollout", () => {
    const a = address(0x1f1), b = address(0x1f2);
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:trade`;
    process.env.MERRYMEN_ADMISSION_LEVEL = "exits-only";
    try {
      assert.equal(childEnv(a).MERRYMEN_ADMISSION_LEVEL, "trade", "never inherited from the operator");
      assert.equal(childEnv(a).MERRYMEN_FLEET_ROLLOUT, undefined);
      assert.equal(childEnv(b).MERRYMEN_ADMISSION_LEVEL, "observe", "held never reaches a child; observe is the floor");
      process.env.MERRYMEN_FLEET_ROLLOUT = "all";
      assert.equal(childEnv(b).MERRYMEN_ADMISSION_LEVEL, "trade");
      // A staged level reaches its child as itself, for the worker's gate to
      // obey — and still not from the operator's own, now at neither.
      process.env.MERRYMEN_ADMISSION_LEVEL = "trade";
      process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:exits-only,${b}:observe`;
      assert.equal(childEnv(a).MERRYMEN_ADMISSION_LEVEL, "exits-only");
      assert.equal(childEnv(b).MERRYMEN_ADMISSION_LEVEL, "observe");
      assert.equal(childEnv(a).MERRYMEN_FLEET_ROLLOUT, undefined);
    } finally {
      delete process.env.MERRYMEN_ADMISSION_LEVEL;
    }
  });
});

describe("startup", () => {
  /**
   * Each case also sets the failure-only reporter and leaves DATABASE_URL
   * unset, so a refusal that did not happen falls through to the reporter's
   * own refusal (a different message) instead of into the main loop.
   *
   * ON RAILWAY THE DEPLOY GUARD SPEAKS FIRST (assertHostedFleetStart,
   * deploy-guard-checks.ts): an orchestrator that is not the fleet's one
   * service, on a required persistent home, in the guarded image, exits 78
   * before the rollout is read — and process.exit would end this whole file.
   * So a case that puts this process on Railway also configures it as the
   * fleet service, correctly. The guard is not loosened, and it is asked
   * first, so a guard that changes fails here by name rather than by exit.
   * What such a case proves is the order the deploy runs in: a fleet the
   * guard lets through still refuses an unset rollout. Each marker on its own
   * is fleet-rollout.test.ts's.
   */
  const boot = async (rollout: string | undefined, extra: Record<string, string> = {}) => {
    const saved = { ...process.env };
    if (rollout === undefined) delete process.env.MERRYMEN_FLEET_ROLLOUT;
    else process.env.MERRYMEN_FLEET_ROLLOUT = rollout;
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
      const refusals = hostedOrchestratorRefusals(process.env);
      assert.deepEqual(refusals, [], `the deploy guard would exit this process before the rollout is read: ${refusals.join("; ")}`);
      await runOrchestrator();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  };

  it("refuses a malformed value before either entry path", async () => {
    for (const value of ["halt", "", "NONE", `${address(1)}:paper`, `${address(1)}:trade,`]) {
      assert.match((await boot(value))!, /MERRYMEN_FLEET_ROLLOUT .*refusing to start rather than guess/, value);
    }
  });

  it("accepts observe and exits-only, now that the worker's admission gate obeys them", async () => {
    // Past the rollout, to the next refusal in line: the failure-only reporter
    // starts no tenant, so a value that names some is refused there — which
    // is only reached once the value itself has been read and accepted.
    for (const level of ["observe", "exits-only"]) {
      assert.match((await boot(`${address(1)}:${level}`))!, /names tenants to start, and MERRYMEN_FLEET_RECOVERY_REPORT_ONLY=1 starts none/, level);
    }
  });

  it("still refuses a level outside the grammar, whatever its spelling", async () => {
    for (const level of ["held", "Observe", "exits_only", "paper"]) {
      assert.match((await boot(`${address(1)}:${level}`))!, /MERRYMEN_FLEET_ROLLOUT entry 1 is not none, all or 0x<40 hex>:observe\|exits-only\|trade/, level);
    }
  });

  it("refuses an unset value on Railway, and a required persistent home counts as Railway", async () => {
    assert.match((await boot(undefined, { RAILWAY_ENVIRONMENT: "production" }))!, /must name its scope/);
    assert.match((await boot(undefined, { RAILWAY_SERVICE_ID: "svc" }))!, /must name its scope/);
    assert.match((await boot(undefined, { MERRYMEN_PERSISTENT_HOME_REQUIRED: "1" }))!, /must name its scope/);
  });

  it("refuses named tenants beside the failure-only reporter", async () => {
    assert.match((await boot(`${address(1)}:trade`))!, /names tenants to start, and MERRYMEN_FLEET_RECOVERY_REPORT_ONLY=1 starts none/);
  });

  it("lets `none` and `all` reach the reporter, whose own prerequisites then decide", async () => {
    for (const value of ["none", "all"]) {
      assert.match((await boot(value, { RAILWAY_ENVIRONMENT: "production" }))!, /report-only prerequisites/, value);
    }
  });
});

describe("the fleet-wide writers", () => {
  it("each asks whether the whole fleet is admitted before it writes for every tenant", () => {
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    const body = (sig: string) => {
      const at = src.indexOf(sig);
      assert.ok(at >= 0, sig);
      return src.slice(at, src.indexOf("\n}\n", at));
    };
    assert.match(body("function startHistoryRepair("), /if \(!rolloutAdmitsWholeFleet\(\)\) return;/);
    const backfill = body("async function runHolderClaimsBackfill(");
    const gate = backfill.indexOf("if (!rolloutAdmitsWholeFleet()) return;");
    assert.ok(gate > 0 && gate < backfill.indexOf("acquireTenantLease(HOLDER_BACKFILL_LEASE)"), "before it takes its lease");
    assert.match(body("export async function runOrchestrator("), /if \(rolloutAdmitsWholeFleet\(\)\) \(mcpBackground \?\?= makeMcpBackground\(/);
  });
});
