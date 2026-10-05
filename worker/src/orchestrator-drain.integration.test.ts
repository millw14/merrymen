/**
 * THE SIGTERM DRAIN OVER THE REAL ORCHESTRATOR (fleet-drain.ts, drainFleet).
 *
 * Every test drives the drain a signal starts, through its test seam, over
 * real SQLite books and a real SQLite stand-in for the shared database: the
 * real live mirror, the real retirement pass, the real stand-downs. Worker and
 * hold processes are fakes that exit on the signal unless told not to, so the
 * drain's waits are the real waits on the real maps. The caps are shrunk; the
 * order is not.
 *
 * A real worker has no SIGTERM handler and ends at once on the signal. A
 * fake's `lastWrite` is NOT a graceful stop: it places a write in the home
 * after the live pass last read it and before the process is gone — the last
 * of the worker's tick — which only a final pass after the exit can carry.
 *
 * MERRYMEN_HOME is per process (node --test runs each file in its own), so
 * this never leaks into another test file. A drain is once per process, so
 * each test forgets the last one first (resetDrainForTest).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import type { TenantLease } from "./tenant-lease";
import { ensureTgGroupsSchema, publishTgGroups, restoreTgGroups } from "./tg-groups-ferry";
import { appendForget } from "./telegram/tg-groups/forget-file";
import {
  ensurePersonalMemorySchema, publishPersonalMemory, recordPersonalMemoryForget, restorePersonalMemory,
} from "./personal-memory-ferry";
import { SHUTDOWN_RECEIPT_FILE, shutdownReceiptDir, takePreviousShutdown, type DrainLimits, type ShutdownReceipt } from "./fleet-drain";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-drain-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_DRAIN_BUDGET_MS;
const dek = Buffer.alloc(32, 83);
process.env.MERRYMEN_STORE_DEK = dek.toString("base64");
const {
  adoptChildForTest, adoptHolderForTest, childHome, drainFleetForTest, finalMirrorBeforeAnchor, hasLeaseForTest,
  mirrorLedgersForTest, onDrainBeforeChildren, resetDrainForTest, setKillConfirmForTest, setLiveMirrorStoreForTest,
  setRetirementMemoryStoreForTest, setSpawningForTest, setTenantLeaseForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { writeKillRequest } = await import("./kill-request");

const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw);
await applyLedgerSchema(shared);
await shared.exec(MIRROR_STATE_DDL);
await ensureTgGroupsSchema(shared, "sqlite");
await ensurePersonalMemorySchema(shared, "sqlite");

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The caps, shrunk. The budget stays generous, so nothing here is the backstop's. */
const LIMITS: Partial<DrainLimits> = {
  hooksMs: 500, settleMs: 5_000, exitWaitMs: 300, killGraceMs: 100, pendingKillsMs: 1_000, finalPassMinMs: 0, reserveMs: 50, pollMs: 5,
};

/** One drain's outside view: what it said, and how it exited. */
let said: string[] = [];
let timeline: string[] = [];
let exits: number[] = [];
const exit = (code: number) => { timeline.push(`exit:${code}`); exits.push(code); };
const originalLog = console.log;
console.log = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };

/** Every hook any test needs, added once: a drain runs what was added before it. */
let hookRuns = 0;
let hookSawSignals: string[] | null = null;
let watched: FakeProc[] = [];
onDrainBeforeChildren("test-recorder", () => {
  hookRuns += 1;
  timeline.push("hook");
  hookSawSignals = watched.flatMap((p) => p.signals);
});

/**
 * A worker or hold process reduced to what the drain does with it: it exits,
 * asynchronously as a real one does, on SIGTERM unless it ignores SIGTERM,
 * and on SIGKILL unless it ignores that too. `lastWrite` lands just before a
 * SIGTERM exit (see the header: a write already made, not one made on the
 * way out).
 */
class FakeProc extends EventEmitter {
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  signalledAt: Record<string, number> = {};
  private gone = false;
  constructor(readonly pid: number, private readonly opts: { lastWrite?: () => void; ignoreTerm?: boolean; ignoreKill?: boolean } = {}) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    const name = String(signal ?? "SIGTERM");
    this.signals.push(name);
    this.signalledAt[name] ??= Date.now();
    timeline.push(`${name}:${this.pid}`);
    if (name === "SIGTERM" && !this.opts.ignoreTerm) {
      this.opts.lastWrite?.();
      setImmediate(() => this.die(0, null));
    }
    if (name === "SIGKILL" && !this.opts.ignoreKill) setImmediate(() => this.die(null, "SIGKILL"));
    return true;
  }
  die(code: number | null, signal: string | null): void {
    if (this.gone) return;
    this.gone = true;
    this.emit("exit", code, signal);
  }
}

function lease(tenant: `0x${string}`, released: { n: number; receiptThen?: boolean }): TenantLease {
  return {
    tenant, backend: "postgres", healthy: () => true,
    async release() {
      released.n += 1;
      timeline.push(`release:${tenant.slice(-2)}`);
      released.receiptThen = existsSync(path.join(shutdownReceiptDir(fleet), SHUTDOWN_RECEIPT_FILE));
    },
  };
}
function grant(account: `0x${string}`): StoredGrant {
  return {
    smartAccount: account, owner: address(0xd91), sessionKeyAddress: address(0xd92), serialized: "fixture-drain",
    chainId: 4663, grantedAt: nowSec() - 60, expiresAt: nowSec() + 86_400,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
    grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
  } as unknown as StoredGrant;
}
const handles: DatabaseSync[] = [];
async function agentRow(db: Db, tenant: string, account: string) {
  await db.prepare(`INSERT INTO agents (smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,status,hwm_usdg,mode)
    VALUES (?,?,?,4663,'{}',1,9999999999,'armed',120,'paper')`).run(account, tenant, address(0xd92));
}
/** A worker's book in its home, one trade in it, and the agent known to the shared side. */
async function book(tenant: `0x${string}`, account: `0x${string}`) {
  const home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  const localRaw = new DatabaseSync(path.join(home, "merrymen.db"));
  handles.push(localRaw);
  const local = wrapSqlite(localRaw);
  await applyLedgerSchema(local);
  await agentRow(local, tenant, account);
  await agentRow(shared, tenant, account);
  const trade = (id: number) => localRaw.prepare(`INSERT INTO trades (id,agent_id,kind,target,amount_usdg,status,created_at)
    VALUES (?,?,'swap','fixture',1,'rejected',?)`).run(id, account, nowSec());
  trade(1);
  return { home, trade };
}
const sharedTrades = async (account: string) =>
  Number((await shared.prepare("SELECT count(*) AS n FROM trades WHERE agent_id = ?").get(account) as { n: number }).n);
const marker = (home: string) => path.join(home, "ledger-source-blocked.json");
function receipt(): ShutdownReceipt {
  return JSON.parse(readFileSync(path.join(shutdownReceiptDir(fleet), SHUTDOWN_RECEIPT_FILE), "utf8")) as ShutdownReceipt;
}
function groups(summary: string): string {
  return JSON.stringify({
    version: 1, rooms: { "-10083": {
      chatId: -10083, title: "owner's room", status: "approved", summary,
      lines: [{ messageId: 1, fromId: 42, name: "Alice", text: "alice-private-line", atMs: Date.now() }],
    } }, llm: { day: "2026-10-05", used: 3 }, nominations: { day: "2026-10-05", n: 1, entries: 1 },
  });
}
async function storedGroups(tenant: string): Promise<string> {
  const home = mkdtempSync(path.join(fleet, "restored-"));
  assert.equal(await restoreTgGroups({ tenant, home, shared, dek, log: () => {} }), "restored");
  return readFileSync(path.join(home, "tg-groups.json"), "utf8");
}

beforeEach(() => {
  resetDrainForTest();
  said = []; timeline = []; exits = []; watched = []; hookRuns = 0; hookSawSignals = null;
  rmSync(shutdownReceiptDir(fleet), { recursive: true, force: true });
  setLiveMirrorStoreForTest(null);
  setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
});
after(() => {
  console.log = originalLog;
  setLiveMirrorStoreForTest(null);
  setRetirementMemoryStoreForTest(null);
  for (const handle of handles) handle.close();
  raw.close();
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("SIGTERM BETWEEN THE MARKER WRITE AND THE OWNERSHIP CHECK LEAVES NO ledger-source-blocked.json", async () => {
  const tenant = address(0xd11), account = address(0xd12), released = { n: 0 } as { n: number; receiptThen?: boolean };
  const { home, trade } = await book(tenant, account);
  // One more row, the last of the worker's tick, landed after the live pass
  // read its book: only a final pass after its exit can carry it.
  const proc = new FakeProc(81_001, { lastWrite: () => trade(2) });
  watched = [proc];
  adoptChildForTest(tenant, account, proc, lease(tenant, released));
  // The live mirror's copy is held open at its first statement after the
  // pending marker is on disk: exactly between the marker and the ownership
  // check that clears it.
  let reached!: () => void, open!: () => void;
  const atMarker = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (open = resolve));
  let held = false;
  const hold = async () => {
    if (!held && existsSync(marker(home))) { held = true; reached(); await gate; }
  };
  const gated: Db = {
    exec: (sql) => shared.exec(sql), tx: (fn) => shared.tx(fn),
    prepare(sql) {
      const statement = shared.prepare(sql);
      return {
        ...statement,
        async run(...args) { await hold(); return statement.run(...args); },
        async get(...args) { await hold(); return statement.get(...args); },
        async all(...args) { await hold(); return statement.all(...args); },
      };
    },
  };
  setLiveMirrorStoreForTest({ shared: gated, dek, dialect: "sqlite" });
  const pass = mirrorLedgersForTest();
  await atMarker;

  const drained = drainFleetForTest("SIGTERM", { budgetMs: 15_000, limits: LIMITS, exit });
  await sleep(100);
  assert.deepEqual(proc.signals, [], "no child is signalled while a copy is in flight");
  assert.equal(released.n, 0, "and no lease is released under it — the old stop released them here");
  assert.equal(existsSync(marker(home)), true);
  open();
  await pass;
  await drained;

  assert.equal(existsSync(marker(home)), false, "the copy finished under its lease and cleared its own marker");
  assert.equal(await sharedTrades(account), 2, "and the final pass carried the row the worker wrote last");
  assert.deepEqual(proc.signals, ["SIGTERM"], "SIGTERM only: it exited in time, and nothing sent SIGKILL");
  assert.equal(released.n, 1);
  assert.equal(released.receiptThen, true, "the receipt was durable before the lease went");
  assert.deepEqual(exits, [0]);
  const r = receipt();
  assert.equal(r.clean, true, JSON.stringify(r));
  assert.deepEqual(r.finalPass, { homes: 1, saved: 1, retained: 0, skipped: 0, outOfTime: 0 });
  assert.equal(statSync(path.join(shutdownReceiptDir(fleet), SHUTDOWN_RECEIPT_FILE)).mode & 0o777, 0o600);
  assert.equal(takePreviousShutdown(shutdownReceiptDir(fleet)).clean, true, "the next start reads this stop as clean");
});

it("A MIRROR PASS WITH ITS TENANT IN HAND IS WAITED FOR: its older memory read is never written over the final pass's", async () => {
  const tenant = address(0xd81), account = address(0xd82), released = { n: 0 };
  const { home } = await book(tenant, account);
  const owner = path.join(home, "soul", "OWNER.md");
  mkdirSync(path.dirname(owner), { recursive: true });
  writeFileSync(owner, "read by the pass in hand");
  await getGrantStore().put(tenant, grant(account));
  // A newer note, the worker's last write before it ended: only the final pass can carry it.
  const proc = new FakeProc(81_007, { lastWrite: () => writeFileSync(owner, "written last") });
  watched = [proc];
  adoptChildForTest(tenant, account, proc, lease(tenant, released));
  // The live pass held at its personal-memory write: its copy is done (no
  // tail in mirrorTails), its read of the home already taken.
  let reached!: () => void, open!: () => void;
  const atWrite = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (open = resolve));
  let held = false;
  const gated: Db = {
    exec: (sql) => shared.exec(sql), tx: (fn) => shared.tx(fn),
    prepare(sql) {
      const statement = shared.prepare(sql);
      if (!/^INSERT INTO tenant_personal_memory/.test(sql)) return statement;
      return {
        ...statement,
        async run(...args) {
          if (!held) { held = true; reached(); await gate; }
          return statement.run(...args);
        },
      };
    },
  };
  setLiveMirrorStoreForTest({ shared: gated, dek, dialect: "sqlite" });
  const pass = mirrorLedgersForTest();
  await atWrite;

  const drained = drainFleetForTest("SIGTERM", { budgetMs: 15_000, limits: LIMITS, exit });
  await sleep(100);
  assert.deepEqual(proc.signals, [], "no child is signalled while the mirror's tenant is in hand");
  open();
  await pass;
  await drained;

  assert.deepEqual(proc.signals, ["SIGTERM"]);
  const restored = mkdtempSync(path.join(fleet, "restored-personal-"));
  assert.equal(await restorePersonalMemory({ tenant, home: restored, shared, dek, log: () => {} }), "restored");
  assert.equal(readFileSync(path.join(restored, "soul", "OWNER.md"), "utf8"), "written last", "the final pass's read is the one stored last");
  assert.deepEqual(receipt().finalPass, { homes: 1, saved: 1, retained: 0, skipped: 0, outOfTime: 0 });
  assert.equal(receipt().clean, true);
  await getGrantStore().remove(tenant);
});

it("A HOLDER HOME GETS FORGET-ONLY MEMORY HANDLING, and its book is never copied", async () => {
  const tenant = address(0xd21), account = address(0xd22), home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "tg-groups.json"), groups("durable group summary"));
  await publishTgGroups({ tenant, home, shared, dek, seen: new Map(), log: () => {} });
  mkdirSync(path.join(home, "soul"));
  writeFileSync(path.join(home, "soul", "OWNER.md"), "private owner fact to forget");
  await publishPersonalMemory({ tenant, home, shared, dek, seen: new Map(), log: () => {} });
  // What the hold left in the home: not its memory, and an unrestored book.
  writeFileSync(path.join(home, "tg-groups.json"), groups("stale held memory must not win"));
  writeFileSync(path.join(home, "soul", "OWNER.md"), "stale held owner memory must not win");
  appendForget(home, { chatId: -10083, userId: 42, atMs: Date.now() });
  recordPersonalMemoryForget({ kind: "owner" }, home);
  const staleRaw = new DatabaseSync(path.join(home, "merrymen.db"));
  handles.push(staleRaw);
  await applyLedgerSchema(wrapSqlite(staleRaw));
  staleRaw.prepare(`INSERT INTO trades (id,agent_id,kind,target,amount_usdg,status,created_at)
    VALUES (1,?,'swap','fixture',1,'rejected',?)`).run(account, nowSec());
  await getGrantStore().put(tenant, grant(account));
  const proc = new FakeProc(81_002);
  watched = [proc];
  await adoptHolderForTest(tenant, account, proc as unknown as ChildProcess);

  await drainFleetForTest("SIGTERM", { budgetMs: 15_000, limits: LIMITS, exit });

  assert.deepEqual(proc.signals, ["SIGTERM"]);
  const final = await storedGroups(tenant);
  assert.ok(final.includes("durable group summary"), "the stored groups were not replaced by the hold's file");
  assert.ok(!final.includes("stale held memory must not win"));
  assert.ok(!final.includes("alice-private-line"), "and the forget typed during the hold reached the stored row");
  const personalHome = mkdtempSync(path.join(fleet, "restored-personal-"));
  assert.equal(await restorePersonalMemory({ tenant, home: personalHome, shared, dek, log: () => {} }), "restored");
  assert.equal(readFileSync(path.join(personalHome, "soul", "OWNER.md"), "utf8"), "", "the owner's forget applied, the stale notes not sealed");
  assert.equal(await sharedTrades(account), 0, "a held book is never mirrored over the shared ledger");
  assert.equal(existsSync(marker(home)), false);
  assert.deepEqual(receipt().finalPass, { homes: 1, saved: 1, retained: 0, skipped: 0, outOfTime: 0 });
  assert.deepEqual(exits, [0]);
  await getGrantStore().remove(tenant);
});

it("THE ORDER: hooks before any signal, the kill a child leaves in its home carried out after it exits, the receipt before the leases, exit last — and once", async () => {
  const tenant = address(0xd31), account = address(0xd32), released = { n: 0 } as { n: number; receiptThen?: boolean };
  const { home } = await book(tenant, account);
  await getGrantStore().put(tenant, grant(account));
  const confirmed: string[] = [];
  setKillConfirmForTest(async (t) => { confirmed.push(t); timeline.push("kill-confirmed"); });
  // The worker's /kill lands just before it ends: the request is in its home when it exits.
  const proc = new FakeProc(81_003, { lastWrite: () => writeKillRequest(home, grant(account), nowSec()) });
  watched = [proc];
  adoptChildForTest(tenant, account, proc, lease(tenant, released));

  const first = drainFleetForTest("SIGTERM", { budgetMs: 15_000, limits: LIMITS, exit });
  const again = drainFleetForTest("SIGINT", { budgetMs: 15_000, limits: LIMITS, exit });
  assert.equal(again, first, "a second signal gets the drain under way, not another");
  await first;

  assert.deepEqual(hookSawSignals, [], "the hook ran before any process was signalled");
  assert.deepEqual(timeline, ["hook", "SIGTERM:81003", "kill-confirmed", `release:${tenant.slice(-2)}`, "exit:0"]);
  assert.equal(hookRuns, 1);
  assert.deepEqual(confirmed, [tenant]);
  assert.equal(await getGrantStore().get(tenant), null, "the pending kill reached the store before the leases went");
  assert.equal(released.receiptThen, true);
  assert.equal(said.filter((l) => /stopping on SIGTERM — calling the whole fleet home/.test(l)).length, 1);
  assert.ok(said.some((l) => /SIGINT again — the fleet is already being called home/.test(l)));
  assert.equal(existsSync(marker(home)), false);
  assert.equal(receipt().signal, "SIGTERM");
});

it("A GRANT GONE DURING THE DRAIN: its ledger still goes up, its home's memory is never published over the stored row", async () => {
  const tenant = address(0xd41), account = address(0xd42), released = { n: 0 };
  const { home } = await book(tenant, account);
  writeFileSync(path.join(home, "tg-groups.json"), groups("stored before the removal"));
  await publishTgGroups({ tenant, home, shared, dek, seen: new Map(), log: () => {} });
  writeFileSync(path.join(home, "tg-groups.json"), groups("written after the owner removed the agent"));
  const proc = new FakeProc(81_004);
  watched = [proc];
  // No grant in the store: removed (DELETE /api/grants) while the worker still ran.
  adoptChildForTest(tenant, account, proc, lease(tenant, released));

  await drainFleetForTest("SIGTERM", { budgetMs: 15_000, limits: LIMITS, exit });

  assert.equal(await sharedTrades(account), 1, "the book's last rows are copied all the same");
  const stored = await storedGroups(tenant);
  assert.ok(stored.includes("stored before the removal"));
  assert.ok(!stored.includes("written after the owner removed the agent"), "no publish without the grant");
  assert.equal(receipt().clean, true);
});

it("A PROCESS THAT IGNORES SIGTERM gets SIGKILL only once the wait is over; one that outlives SIGKILL gets no final pass", async () => {
  const slow = address(0xd51), slowAccount = address(0xd52), stuck = address(0xd61), stuckAccount = address(0xd62);
  const slowBook = await book(slow, slowAccount), stuckBook = await book(stuck, stuckAccount);
  const slowProc = new FakeProc(81_005, { ignoreTerm: true });
  const stuckProc = new FakeProc(81_006, { ignoreTerm: true, ignoreKill: true });
  watched = [slowProc, stuckProc];
  slowBook.trade(2);
  adoptChildForTest(slow, slowAccount, slowProc, lease(slow, { n: 0 }));
  adoptChildForTest(stuck, stuckAccount, stuckProc, lease(stuck, { n: 0 }));

  await drainFleetForTest("SIGTERM", { budgetMs: 15_000, limits: LIMITS, exit });

  assert.deepEqual(slowProc.signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(slowProc.signalledAt.SIGKILL! - slowProc.signalledAt.SIGTERM! >= 290, "SIGKILL waited for the exit wait to end");
  assert.equal(await sharedTrades(slowAccount), 2, "killed and gone: its home still gets its final pass");
  assert.equal(await sharedTrades(stuckAccount), 0, "still running: nothing is copied from a home it may still write");
  assert.equal(existsSync(marker(stuckBook.home)), false, "and no copy was started there, so no barrier either");
  assert.ok(said.some((l) => new RegExp(`${stuck}: its process is still running after SIGKILL`).test(l)));
  const r = receipt();
  assert.equal(r.clean, false);
  assert.equal(r.stragglers, 2);
  assert.deepEqual(r.finalPass, { homes: 2, saved: 1, retained: 0, skipped: 1, outOfTime: 0 });
  assert.deepEqual(exits, [0]);
  stuckProc.die(null, "SIGKILL");
});

it("NO COPY STARTS AFTER THE DRAIN HAS SETTLED except its own final pass: a late spawn's or reconcile's copy is refused before its marker", async () => {
  const tenant = address(0xd71), account = address(0xd72);
  const { home } = await book(tenant, account);
  await drainFleetForTest("SIGTERM", { budgetMs: 15_000, limits: LIMITS, exit });
  assert.equal(hasLeaseForTest(tenant), false);
  // A spawn or a reconcile pass already under way when the signal came,
  // still holding its tenant's lease: its own ownership check would pass.
  const late: TenantLease = { tenant, backend: "postgres", healthy: () => true, async release() {} };
  setTenantLeaseForTest(tenant, late);
  try {
    assert.equal(await finalMirrorBeforeAnchor(tenant, shared, home, late), false);
    assert.equal(existsSync(marker(home)), false, "refused before the marker: nothing for the next start to trip on");
    assert.equal(await sharedTrades(account), 0, "nothing was copied");
    assert.ok(said.some((l) => /The fleet is being called home; no new ledger copy starts/.test(l)));
  } finally {
    setTenantLeaseForTest(tenant, null);
  }
  // And once the fleet is running again, the same copy goes through.
  resetDrainForTest();
  setTenantLeaseForTest(tenant, late);
  try {
    assert.equal(await finalMirrorBeforeAnchor(tenant, shared, home, late), true);
    assert.equal(await sharedTrades(account), 1);
  } finally {
    setTenantLeaseForTest(tenant, null);
  }
});

it("A SPAWN STUCK BEFORE THE STOP IS NOT WAITED FOR: the drain goes on at once, and the receipt counts it on its own line", async () => {
  const tenant = address(0xe11), account = address(0xe12), stuck = address(0xe21);
  await book(tenant, account);
  const proc = new FakeProc(81_011);
  watched = [proc];
  adoptChildForTest(tenant, account, proc, lease(tenant, { n: 0 }));
  // Claimed six minutes ago and never done: flagStuckSpawn's case, which a
  // redeploy is the remedy for. Waited for, it cost that redeploy the whole
  // settle cap (5s here) and then the rest of the budget in the late settle.
  const releasedStuck = { n: 0 };
  setTenantLeaseForTest(stuck, lease(stuck, releasedStuck));
  setSpawningForTest(stuck, 6 * 60_000);
  try {
    const t0 = Date.now();
    await drainFleetForTest("SIGTERM", { budgetMs: 15_000, limits: LIMITS, exit });
    assert.ok(Date.now() - t0 < 2_000, `neither the settle cap nor the late settle was waited out (${Date.now() - t0}ms)`);
    assert.equal(releasedStuck.n, 0, "its lease is not given up under it: the exit that ends the spawn drops it");
    const r = receipt();
    assert.equal(r.steps.find((s) => s.step === "settle")!.outcome, "done");
    assert.equal(r.steps.find((s) => s.step === "late-settle")!.outcome, "done");
    assert.deepEqual(r.finalPass, { homes: 1, saved: 1, retained: 0, skipped: 0, outOfTime: 0 }, "the running child's home still got its pass");
    assert.equal(r.stuckSpawns, 1);
    assert.equal(r.inFlightAtRelease, false, "not hidden among what was in flight");
    assert.equal(r.clean, false);
    assert.ok(said.some((l) => /1 spawn\(s\) stuck since before the stop are not waited for/.test(l)));
    assert.deepEqual(exits, [0]);
  } finally {
    setSpawningForTest(stuck, null);
    setTenantLeaseForTest(stuck, null);
  }
});

/** The shared side, held at the first statement after `home`'s pending marker is on disk: a copy between its marker and its ownership check. */
function heldAtMarker(home: string): { db: Db; atMarker: Promise<void>; open: () => void } {
  let reached!: () => void, open!: () => void;
  const atMarker = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (open = resolve));
  let held = false;
  const hold = async () => {
    if (!held && existsSync(marker(home))) { held = true; reached(); await gate; }
  };
  const db: Db = {
    exec: (sql) => shared.exec(sql), tx: (fn) => shared.tx(fn),
    prepare(sql) {
      const statement = shared.prepare(sql);
      return {
        ...statement,
        async run(...args) { await hold(); return statement.run(...args); },
        async get(...args) { await hold(); return statement.get(...args); },
        async all(...args) { await hold(); return statement.all(...args); },
      };
    },
  };
  return { db, atMarker, open };
}

/** Caps for a copy the drain cannot wait out: a short settle, and a budget that ends soon after it. */
const SHORT: { budgetMs: number; limits: Partial<DrainLimits> } = { budgetMs: 1_500, limits: { ...LIMITS, settleMs: 200, reserveMs: 300 } };

it("A COPY STILL RUNNING WHEN THE LEASES GO KEEPS ITS LEASE until the exit ends it — writer dead, then lock free — and every idle tenant's is released", async () => {
  // A spawn's final mirror (finalMirrorBeforeAnchor) hung under its marker:
  // a copy in mirrorTails, with no mirror pass in hand, so the drain knows
  // exactly which tenant it is writing for.
  const busy = address(0xe31), busyAccount = address(0xe32), idle = address(0xe41), idleAccount = address(0xe42);
  const busyBook = await book(busy, busyAccount);
  await book(idle, idleAccount);
  const releasedBusy = { n: 0 }, releasedIdle = { n: 0 };
  const busyLease = lease(busy, releasedBusy);
  setTenantLeaseForTest(busy, busyLease);
  const idleProc = new FakeProc(81_021);
  watched = [idleProc];
  adoptChildForTest(idle, idleAccount, idleProc, lease(idle, releasedIdle));
  const held = heldAtMarker(busyBook.home);
  const copy = finalMirrorBeforeAnchor(busy, held.db, busyBook.home, busyLease);
  await held.atMarker;
  try {
    await drainFleetForTest("SIGTERM", { ...SHORT, exit });

    assert.equal(releasedBusy.n, 0, "never released under the copy: another owner could copy the same rows above the same watermark");
    assert.equal(hasLeaseForTest(busy), true, "kept for the exit to drop");
    assert.equal(releasedIdle.n, 1, "the idle tenant's lease still goes at once");
    assert.ok(said.some((l) => /\[alert\] 1 lease\(s\) left to drop with this process/.test(l)));
    const r = receipt();
    assert.equal(r.inFlightAtRelease, true);
    assert.equal(r.steps.find((s) => s.step === "late-settle")!.outcome, "timeout");
    assert.deepEqual(r.finalPass, { homes: 1, saved: 1, retained: 0, skipped: 0, outOfTime: 0 });
    assert.equal(r.clean, false);
    assert.deepEqual(exits, [0]);
  } finally {
    held.open();
    await copy;
    setTenantLeaseForTest(busy, null);
  }
});

it("A MIRROR PASS STILL IN HAND WHEN THE LEASES GO: no lease is given up by hand, and the home its copy holds gets no final pass queued behind it", async () => {
  // The live pass hung on tenant A's copy. It does not say which tenant it
  // holds once its copy is done, so no lease is released at all; and A's own
  // copy is still in mirrorTails, so the drain never queues a pass behind it.
  const a = address(0xe51), aAccount = address(0xe52), b = address(0xe61), bAccount = address(0xe62);
  const aBook = await book(a, aAccount);
  await book(b, bAccount);
  const releasedA = { n: 0 }, releasedB = { n: 0 };
  const aProc = new FakeProc(81_031), bProc = new FakeProc(81_032);
  watched = [aProc, bProc];
  adoptChildForTest(a, aAccount, aProc, lease(a, releasedA));
  adoptChildForTest(b, bAccount, bProc, lease(b, releasedB));
  const held = heldAtMarker(aBook.home);
  setLiveMirrorStoreForTest({ shared: held.db, dek, dialect: "sqlite" });
  const pass = mirrorLedgersForTest();
  await held.atMarker;
  try {
    await drainFleetForTest("SIGTERM", { ...SHORT, exit });

    assert.equal(releasedA.n + releasedB.n, 0);
    assert.ok(said.some((l) => /\[alert\] 2 lease\(s\) left to drop with this process/.test(l)));
    assert.ok(said.some((l) => new RegExp(`${a}: an earlier copy is still running — no final pass queued behind it`).test(l)));
    assert.equal(await sharedTrades(aAccount), 0, "nothing of A's committed by the drain");
    assert.equal(await sharedTrades(bAccount), 1, "B, which the hung pass never reached, had its final pass");
    const r = receipt();
    assert.deepEqual(r.finalPass, { homes: 2, saved: 1, retained: 0, skipped: 1, outOfTime: 0 });
    assert.equal(r.inFlightAtRelease, true);
    assert.deepEqual(exits, [0], "and not the backstop: no pass was left waiting behind the hung copy");
  } finally {
    held.open();
    await pass;
    setTenantLeaseForTest(a, null);
    setTenantLeaseForTest(b, null);
  }
});

it("UNDER FLEET_HALT THE DRAIN COPIES NOTHING: no ledger batch, no memory row, as every other halt path", async () => {
  const tenant = address(0xe71), account = address(0xe72), released = { n: 0 };
  const { home } = await book(tenant, account);
  writeFileSync(path.join(home, "tg-groups.json"), groups("stored before the halt"));
  await publishTgGroups({ tenant, home, shared, dek, seen: new Map(), log: () => {} });
  writeFileSync(path.join(home, "tg-groups.json"), groups("written while the halt was on"));
  await getGrantStore().put(tenant, grant(account));
  const proc = new FakeProc(81_041);
  watched = [proc];
  adoptChildForTest(tenant, account, proc, lease(tenant, released));
  // Made by an operator a moment before the redeploy: honourFleetHalt has
  // not yet had its pass, so the child is still running when SIGTERM comes.
  const halt = path.join(fleet, "FLEET_HALT");
  writeFileSync(halt, "", { mode: 0o600 });
  try {
    await drainFleetForTest("SIGTERM", { budgetMs: 15_000, limits: LIMITS, exit });

    assert.deepEqual(proc.signals, ["SIGTERM"], "the fleet is still stopped");
    assert.equal(await sharedTrades(account), 0, "no ledger batch written under the halt");
    assert.equal(existsSync(marker(home)), false, "and no copy begun, so no barrier");
    const stored = await storedGroups(tenant);
    assert.ok(stored.includes("stored before the halt") && !stored.includes("written while the halt was on"), "no memory row either");
    assert.ok(said.some((l) => l.includes(`${tenant}: FLEET_HALT is present — no final pass`)));
    assert.deepEqual(receipt().finalPass, { homes: 1, saved: 0, retained: 0, skipped: 1, outOfTime: 0 });
    assert.equal(released.n, 1, "the lease still goes, as honourFleetHalt lets it go");
    assert.deepEqual(exits, [0]);
  } finally {
    rmSync(halt, { force: true });
    await getGrantStore().remove(tenant);
  }
});
