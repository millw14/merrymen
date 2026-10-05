/**
 * THE ROLLOUT, THROUGH THE REAL reconcile() (fleet-rollout.ts).
 *
 * A tenant MERRYMEN_FLEET_ROLLOUT does not admit is held: the supervisor
 * leases nothing for it, starts nothing for it, carries out none of its
 * pending kills and retires none of its expired keys, so its home stays as the
 * incident left it. It stays in the roster, so the removed-agent sweep still
 * tells "not admitted" from "removed". And the hold is one predicate
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
  reconcile, rolloutCountsForTest, runOrchestrator, setKillConfirmForTest, setLeaseAcquireForTest, setPaperRestoreForTest,
  setRetirementMemoryStoreForTest, setSpawnForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore, useSettingsStoreForTest } = await import("./settings-store");
const { killRequested, writeKillRequest } = await import("./kill-request");
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

describe("a tenant the rollout does not admit", () => {
  it("is never leased, spawned, killed, retired or reported, and its home is byte-identical over three passes", async () => {
    const admitted = tenantAt(0x101), out = tenantAt(0x201), expired = tenantAt(0x301);
    const outAccount = address(0x202), expiredAccount = address(0x302);
    await store.put(admitted, grant(address(0x102)));
    await store.put(out, grant(outAccount));
    await store.put(expired, grant(expiredAccount, nowSec() - 60));
    // What the incident left in the two held homes: a book nobody may open,
    // the bot's files, a signing-key copy, and for one of them a /kill its
    // owner sent that has not been carried out.
    for (const [tenant, account] of [[out, outAccount], [expired, expiredAccount]] as const) {
      const home = childHome(tenant);
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "merrymen.db"), "original-book-not-opened", { mode: 0o600 });
      writeFileSync(path.join(home, "settings.json"), JSON.stringify({ paperTradingEnabled: true }), { mode: 0o600 });
      writeFileSync(path.join(home, "telegram.json"), "{}", { mode: 0o600 });
      writeFileSync(path.join(home, "heartbeat.json"), JSON.stringify({ at: nowSec() - 86_400 }), { mode: 0o600 });
      writeFileSync(path.join(home, "grant.json"), JSON.stringify(await store.get(tenant)), { mode: 0o600 });
      if (tenant === out) writeKillRequest(home, grant(account), nowSec());
    }
    assert.equal(killRequested(childHome(out)), true);
    // A shared store, so the paused-source report runs at all: it would take
    // a lease for every cold tenant it looks at.
    const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw);
    await applyLedgerSchema(shared);
    await shared.exec(MIRROR_STATE_DDL);
    setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
    try {
      process.env.MERRYMEN_FLEET_ROLLOUT = `${admitted}:observe`;
      const before = { out: snapshot(childHome(out)), expired: snapshot(childHome(expired)) };
      for (let pass = 0; pass < 3; pass++) {
        await reconcile();
        await honourPendingKills(); // the order ferry's clock, as well as reconcile's
        await settle();
      }
      assert.deepEqual(snapshot(childHome(out)), before.out, "the held home is exactly as the incident left it");
      assert.deepEqual(snapshot(childHome(expired)), before.expired, "and so is the expired one, signing-key copy and all");
      assert.ok(!leaseAsks.includes(out) && !leaseAsks.includes(expired), `no lease asked for a held tenant: ${leaseAsks.join(", ")}`);
      assert.ok(leaseAsks.includes(admitted), "the admitted tenant was leased");
      assert.equal(hasLeaseForTest(out), false);
      assert.equal(hasLeaseForTest(expired), false);
      assert.deepEqual(spawned.map((p) => p.env.MERRYMEN_HOME), [childHome(admitted)], "only the admitted tenant runs");
      assert.ok(await store.get(out), "its pending kill was not carried out");
      assert.equal(killRequested(childHome(out)), true, "and is still pending for the pass that admits it");
      assert.deepEqual(confirmed, []);
      assert.equal(isRetiringExpiredForTest(expired), false, "its expiry is not retired");
      assert.deepEqual(rolloutCountsForTest(), { trade: 0, "exits-only": 0, observe: 1, held: 2, absent: 0 });

      // THE LEVEL, AND ONLY THE LEVEL, REACHES THE CHILD.
      const env = spawned[0]!.env;
      assert.equal(env.MERRYMEN_ADMISSION_LEVEL, "observe");
      assert.equal(env.MERRYMEN_FLEET_ROLLOUT, undefined, "the rollout names other tenants; a child never sees it");

      // ADMISSION CARRIES OUT WHAT WAS WAITING, which also shows the homes
      // above were ones these passes would have changed had they been admitted.
      process.env.MERRYMEN_FLEET_ROLLOUT = `${admitted}:observe,${out}:trade,${expired}:trade`;
      await reconcile();
      await settle();
      assert.equal(await store.get(out), null, "the kill is carried out before anything could spawn");
      assert.deepEqual(confirmed, [out]);
      assert.equal(spawnedFor(out).length, 0, "and nothing was spawned for the killed grant");
      assert.equal(existsSync(path.join(childHome(out), "settings.json")), false, "its removal clears the cached access");
      assert.equal(existsSync(path.join(childHome(out), "merrymen.db")), true, "and keeps the original book");
      assert.equal(existsSync(path.join(childHome(expired), "grant.json")), false, "the expired key's copy is scrubbed once admitted");
      assert.equal(spawnedFor(expired).length, 0, "an expired key still runs nothing");
    } finally {
      setRetirementMemoryStoreForTest(null);
      raw.close();
    }
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
    assert.deepEqual(rolloutCountsForTest(), { trade: 0, "exits-only": 0, observe: 0, held: 2, absent: 0 });
  });

  it("a named tenant missing from the roster is counted, so a typo is visible", async () => {
    const a = tenantAt(0x131);
    await store.put(a, grant(address(0x132)));
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:exits-only,${address(0x999)}:trade`;
    await reconcile();
    assert.deepEqual(rolloutCountsForTest(), { trade: 0, "exits-only": 1, observe: 0, held: 0, absent: 1 });
    assert.equal(spawnedFor(a)[0]?.env.MERRYMEN_ADMISSION_LEVEL, "exits-only");
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
    process.env.MERRYMEN_FLEET_ROLLOUT = `${a}:exits-only`;
    process.env.MERRYMEN_ADMISSION_LEVEL = "trade";
    try {
      assert.equal(childEnv(a).MERRYMEN_ADMISSION_LEVEL, "exits-only", "never inherited from the operator");
      assert.equal(childEnv(a).MERRYMEN_FLEET_ROLLOUT, undefined);
      assert.equal(childEnv(b).MERRYMEN_ADMISSION_LEVEL, "observe", "held never reaches a child; observe is the floor");
      process.env.MERRYMEN_FLEET_ROLLOUT = "all";
      assert.equal(childEnv(b).MERRYMEN_ADMISSION_LEVEL, "trade");
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
   */
  const boot = async (rollout: string | undefined, extra: Record<string, string> = {}) => {
    const saved = { ...process.env };
    if (rollout === undefined) delete process.env.MERRYMEN_FLEET_ROLLOUT;
    else process.env.MERRYMEN_FLEET_ROLLOUT = rollout;
    process.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY = "1";
    Object.assign(process.env, extra);
    try {
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

  it("refuses an unset value on Railway, and a required persistent home counts as Railway", async () => {
    assert.match((await boot(undefined, { RAILWAY_ENVIRONMENT: "production" }))!, /must name its scope/);
    assert.match((await boot(undefined, { RAILWAY_SERVICE_ID: "svc" }))!, /must name its scope/);
    assert.match((await boot(undefined, { MERRYMEN_PERSISTENT_HOME_REQUIRED: "1" }))!, /must name its scope/);
  });

  it("refuses named tenants beside the failure-only reporter", async () => {
    assert.match((await boot(`${address(1)}:observe`))!, /names tenants to start, and MERRYMEN_FLEET_RECOVERY_REPORT_ONLY=1 starts none/);
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
