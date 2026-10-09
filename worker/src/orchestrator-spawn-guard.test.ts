/**
 * ONE TENANT CANNOT CRASH THE SUPERVISOR.
 *
 * spawnChild prepares a worker through a dozen awaits, and the recovery reply
 * gates added at the end of that preparation are built to throw: the privacy
 * proof (recoveryReplyPrivacyAllowsFork) and the poll offset handoff
 * (handoffRecoveryReplyOffset) refuse by rejecting, and so do their reads when
 * Postgres will not answer, and the pool (makePgDb) when it cannot be built
 * at all — it opens lazily, so that is a driver that will not load, not a
 * database that is down. Nothing between them and the main loop caught it.
 * reconcile() awaits spawnChild, the main loop awaits reconcile(),
 * runOrchestrator is started with `void`, and nothing in the worker handles
 * an unhandled rejection — so one tenant's refusal exited the whole
 * orchestrator: every other tenant's worker, hold and reply with it,
 * then again on every restart, for as long as that tenant's state stayed the
 * same. The removed agent's retry at the top of reconcile() opened its pool
 * the same way.
 *
 * Each refusal must instead hold its own tenant: an [alert] naming it, no
 * worker and no hold process, its lease and home retained, and the pass
 * carried on. Driven through the real reconcile() over the file-backed grant
 * and settings stores, with the shared database a sqlite stand-in where the
 * orchestrator has a seam for it (setRetirementMemoryStoreForTest,
 * setPersonalMemoryStoreForTest) — a Postgres that is down is that stand-in
 * refusing the gates' reads — and an address nothing answers where it does
 * not. The stores are taken before DATABASE_URL is set, so they stay on files.
 *
 * MERRYMEN_HOME is per process (node --test forks per file), so this never
 * leaks into another test file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import type { TenantLease } from "./tenant-lease";

const FLEET = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-spawn-guard-")));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
const DEK = Buffer.alloc(32, 11);
process.env.MERRYMEN_STORE_DEK = DEK.toString("base64");
process.env.MERRYMEN_TICK_SECONDS = "60";

const {
  reconcile, childHome, isHeldForTest, hasLeaseForTest, setPaperRestoreForTest, setPersistentHomeVerifierForTest,
  setPersonalMemoryStoreForTest, setRetirementMemoryStoreForTest, setSpawnForTest, setTenantLeaseForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const { applyLedgerSchema } = await import("./store");
const { BOOTSTRAP_FILE } = await import("./bootstrap-state");
const { MIRROR_STATE_DDL } = await import("./ledger-mirror");
const { RECOVERY_REPLY_SCHEMA, sealRecoveryReplyState } = await import("./recovery-reply-state");

// Taken now, while DATABASE_URL is unset, so both stay on files for the whole
// file once it is set below.
const store = getGrantStore();
const settingsStore = getSettingsStore();
// A hosted deployment from here on: every recovery gate runs. Nothing answers
// at this address. Where `pg` will not load (this repo: it is runtime-only,
// installed by the image), every pool the orchestrator builds for itself
// rejects; where it loads, the pool builds and its queries fail instead.
process.env.DATABASE_URL = "postgres://spawn-guard.invalid/not-a-real-connection";
// Which of the two this run is. A specifier the type checker does not
// resolve, as db.ts's own import of the driver is not.
const PG_DRIVER = "pg";
const PG_LOADS = await import(PG_DRIVER).then(() => true, () => false);
// Not a Railway volume: the persistent-book gates stand aside, as self-hosted.
setPersistentHomeVerifierForTest(() => null);

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const grant = (account: `0x${string}`, n: number): StoredGrant =>
  ({
    smartAccount: account,
    owner: addr(0x5c00 + n),
    sessionKeyAddress: addr(0x5d00 + n),
    serialized: "disposable spawn-guard fixture",
    chainId: 4663,
    grantedAt: Math.floor(Date.now() / 1000) - 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
    grantFeatures: ["tradeable-v2"],
    grantTokens: [],
    demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
  }) as unknown as StoredGrant;

/** A process reduced to what the orchestrator does with one. None should start here. */
class FakeProc extends EventEmitter {
  static next = 61_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  kill(): boolean {
    setImmediate(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}
const spawned: string[] = [];
setSpawnForTest((_cmd, args) => {
  spawned.push(args.some((a) => a.endsWith("telegram-hold.ts")) ? "hold" : "worker");
  return new FakeProc() as unknown as ChildProcess;
});

/** What the orchestrator said. */
const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => {
  said.push(a.map(String).join(" "));
};

/** The shared database's stand-in, fresh for each test, with the recovery reply tables. */
function ledger(): { raw: DatabaseSync; shared: Db } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(RECOVERY_REPLY_SCHEMA);
  raw.exec(MIRROR_STATE_DDL);
  return { raw, shared: wrapSqlite(raw) };
}
const opened: DatabaseSync[] = [];
/**
 * The stand-in as the shared database is while Postgres is down, for the
 * recovery reply gates: every read of their tables rejects, as a pg query
 * does when nothing answers, with the connection in its message, as pg's
 * can carry. Everything else reaches the stand-in, so preparation gets as far
 * as the gates.
 */
const OUTAGE = "connect ECONNREFUSED postgres://merrymen:outage-secret@spawn-guard.invalid:5432/merrymen";
function down(inner: Db): Db {
  const refused = (sql: string) => /recovery_reply/.test(sql);
  const fail = () => Promise.reject(Object.assign(new Error(OUTAGE), { code: "ECONNREFUSED" }));
  return {
    prepare: (sql) => (refused(sql) ? { run: fail, get: fail, all: fail } : inner.prepare(sql)),
    exec: (sql) => (refused(sql) ? fail() : inner.exec(sql)),
    tx: (fn) => inner.tx((db) => fn(down(db))),
  };
}
function useLedger(retirement: boolean): { raw: DatabaseSync; shared: Db } {
  const l = ledger();
  opened.push(l.raw);
  // Personal memory always restores, so preparation reaches the gates below.
  setPersonalMemoryStoreForTest({ shared: l.shared, dek: DEK, dialect: "sqlite" });
  setRetirementMemoryStoreForTest(retirement ? { shared: l.shared, dek: DEK, dialect: "sqlite" } : null);
  return l;
}

let next = 0;
/** A wanted tenant, its stored settings, and the lease reconcile would have taken before its first spawn. */
async function wanted(settings: Record<string, unknown> | null) {
  const n = ++next;
  const tenant = addr(0x5a00 + n);
  const account = addr(0x5b00 + n);
  await store.put(tenant, grant(account, n));
  if (settings) await settingsStore.put(tenant, settings as never);
  const released = { n: 0 };
  const lease: TenantLease = { tenant, backend: "postgres", healthy: () => true, async release() { released.n++; } };
  setTenantLeaseForTest(tenant, lease);
  return { tenant, account, released, home: childHome(tenant) };
}
const live: `0x${string}`[] = [];
afterEach(async () => {
  for (const tenant of live.splice(0)) {
    await store.remove(tenant);
    await settingsStore.remove(tenant);
    setTenantLeaseForTest(tenant, null);
    rmSync(childHome(tenant), { recursive: true, force: true });
  }
  setPaperRestoreForTest(null);
});
after(() => {
  console.log = realLog;
  setPersistentHomeVerifierForTest(null);
  setPersonalMemoryStoreForTest(null);
  setRetirementMemoryStoreForTest(null);
  for (const raw of opened) raw.close();
  rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** The [alert] lines for this tenant, by its prefix. */
const alerts = (tenant: string) => said.filter((l) => l.startsWith(`[orchestrator] [alert] ${tenant}: `));
const PAPER_OK = async () => ({ ok: true as const, line: null });
const BOT = { telegramEnabled: true, telegramBotToken: "8801:spawn_guard_fixture" };

describe("one tenant's refusal holds that tenant, not the fleet", () => {
  it("A PRIVACY REFUSAL: a durable erasure the retained group file cannot be proved against", async () => {
    const { raw } = useLedger(true);
    setPaperRestoreForTest(PAPER_OK);
    const t = await wanted(null);
    live.push(t.tenant);
    // A group forget journaled while the tenant was stopped, and a group file
    // in its home with a second name: the proof will not vouch for a file it
    // cannot be sure is the only copy, and refuses by throwing.
    const op = { id: "00000000-0000-4000-8000-0000000000a1", atMs: 1000, kind: "group" as const, chatId: -11 };
    const row = sealRecoveryReplyState(t.tenant, { version: 1, privacy: [op], turns: [] }, DEK);
    raw.prepare("INSERT INTO tenant_recovery_reply_state VALUES(?,?,?,1000)").run(t.tenant, row.sealed, row.bytes);
    mkdirSync(t.home, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(t.home, "tg-groups.json"), JSON.stringify({ version: 1, rooms: {} }), { mode: 0o600 });
    linkSync(path.join(t.home, "tg-groups.json"), path.join(t.home, "tg-groups.second-name"));

    await assert.doesNotReject(reconcile(), "the refusal does not reject through reconcile");
    assert.equal(spawned.length, 0, "no worker starts over memory the proof could not clear");
    assert.ok(alerts(t.tenant).some((l) => /privacy/.test(l)), said.join("\n"));
    assert.equal(hasLeaseForTest(t.tenant), true, "the tenant stays held by this replica");
    assert.ok(existsSync(path.join(t.home, "tg-groups.json")), "and its retained memory stays for recovery");
    await assert.doesNotReject(reconcile(), "and the next pass holds it again");
    assert.equal(spawned.length, 0);
  });

  it("A HANDOFF REFUSAL: the bot's recovery offset names another tenant", async () => {
    const { raw } = useLedger(true);
    setPaperRestoreForTest(PAPER_OK);
    const t = await wanted(BOT);
    live.push(t.tenant);
    // The recovery listener's high-water mark for this bot names someone
    // else's account, so the handoff cannot vouch for it and refuses.
    raw.prepare("INSERT INTO recovery_reply_offsets VALUES(?,?,?,?,?,200,101,100,1000)")
      .run("8801", addr(0x5eee), addr(0x5fff), 4663, "a".repeat(16));

    await assert.doesNotReject(reconcile(), "the refusal does not reject through reconcile");
    assert.equal(spawned.length, 0, "no worker polls a bot whose offset could not be handed over");
    assert.ok(alerts(t.tenant).some((l) => /offset/.test(l)), said.join("\n"));
    // Which check it was, by its fixed code: here the listener's row.
    assert.ok(alerts(t.tenant).some((l) => /offset not handed over \(Error HANDOFF_ROW\)/.test(l)), said.join("\n"));
    assert.equal(hasLeaseForTest(t.tenant), true, "the tenant stays held by this replica");
    assert.equal(t.released.n, 0);
    await assert.doesNotReject(reconcile(), "and the next pass holds it again");
    assert.equal(spawned.length, 0);
    // A refusal like this one stands until someone repairs the row: said once
    // for its cause, not on every fifteen-second pass.
    assert.equal(alerts(t.tenant).filter((l) => /offset/.test(l)).length, 1, said.join("\n"));
  });

  it("A HANDOFF REFUSAL WHILE HOLDING: no hold process answers a bot whose offset could not be handed over", async () => {
    const { raw } = useLedger(true);
    // A practice book that will not restore is held (spawnHolder), and its
    // hold process would poll the same bot, so the same handoff runs first.
    setPaperRestoreForTest(async () => ({ ok: false, reason: "paper fills are newer than the recoverable valuation" }));
    const t = await wanted({ ...BOT, paperTradingEnabled: true });
    live.push(t.tenant);
    raw.prepare("INSERT INTO recovery_reply_offsets VALUES(?,?,?,?,?,200,101,100,1000)")
      .run("8801", addr(0x5eee), addr(0x5fff), 4663, "a".repeat(16));

    await assert.doesNotReject(reconcile(), "the refusal does not reject through reconcile");
    assert.deepEqual(spawned, [], "neither a worker nor a hold process starts");
    // spawnHolder's own refusal, not spawnChild's: it is the hold that was refused.
    assert.ok(alerts(t.tenant).some((l) => /offset not handed over .*no hold process/.test(l)), said.join("\n"));
    assert.equal(isHeldForTest(t.tenant), false, "not recorded as held, so no later refresh starts a hold process without the handoff");
    assert.equal(hasLeaseForTest(t.tenant), true, "the tenant stays held by this replica");
    await assert.doesNotReject(reconcile(), "and the next pass holds it again");
    assert.deepEqual(spawned, []);
  });

  it("A POSTGRES OUTAGE: the shared database will not answer the privacy proof's read", async () => {
    // The pool is built (it opens lazily); it is the query that fails, as on
    // a deploy while Postgres is down, whether or not this run has a driver.
    const { shared } = useLedger(true);
    setRetirementMemoryStoreForTest({ shared: down(shared), dek: DEK, dialect: "sqlite" });
    setPaperRestoreForTest(PAPER_OK);
    const t = await wanted(null);
    live.push(t.tenant);

    await assert.doesNotReject(reconcile(), "the failure does not reject through reconcile");
    assert.equal(spawned.length, 0, "no worker starts without the privacy proof");
    // Held by the first gate that needs the recovery tables: the owner's
    // recorded controls (recovery-reply-arm.ts) read them before the privacy
    // proof does, and refuse alike.
    assert.ok(alerts(t.tenant).some((l) => /privacy|owner controls could not be applied/.test(l)), said.join("\n"));
    assert.ok(!alerts(t.tenant).some((l) => /spawn-guard\.invalid|outage-secret|ECONNREFUSED|postgres:/.test(l)), "and no connection detail is logged");
    assert.equal(hasLeaseForTest(t.tenant), true, "the tenant stays held by this replica");
    await assert.doesNotReject(reconcile(), "and the next pass holds it again");
    assert.equal(spawned.length, 0);
  });

  it("ANY OTHER THROW IN PREPARATION: an anchor that can be neither replaced nor removed", async () => {
    useLedger(true);
    setPaperRestoreForTest(PAPER_OK);
    const t = await wanted(null);
    live.push(t.tenant);
    // writeBootstrapForChild refuses to start the child by throwing when the
    // last spawn's anchor cannot be removed. Here it is a directory with
    // something in it. None of the gates above: the catch at the bottom of
    // spawnChild is what holds it.
    mkdirSync(path.join(t.home, BOOTSTRAP_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(t.home, BOOTSTRAP_FILE, "stuck"), "", { mode: 0o600 });

    await assert.doesNotReject(reconcile(), "the throw does not reject through reconcile");
    assert.equal(spawned.length, 0, "no worker starts over an anchor it cannot trust");
    // By its kind, so a bug that throws for every tenant can be told from this,
    // and without its text.
    assert.ok(alerts(t.tenant).some((l) => /worker preparation failed \(Error\)/.test(l)), said.join("\n"));
    assert.ok(!alerts(t.tenant).some((l) => /unsafe bootstrap anchor|refusing to start|directory/.test(l)), "said without the error's text");
    assert.equal(hasLeaseForTest(t.tenant), true, "the tenant stays held by this replica");
    await assert.doesNotReject(reconcile(), "and the next pass holds it again");
    assert.equal(spawned.length, 0);
  });

  // Last: the removed agent stays pending for the rest of this process.
  //
  // Only where the driver will not load. That is the one failure the retry's
  // own pool can meet (makePgDb opens lazily); where it loads, a Postgres
  // that will not answer fails the copy's reads instead, which
  // finalMirrorBeforeAnchor already answers with false, and the guard under
  // test is never reached.
  it("A POOL THAT CANNOT BE BUILT AT THE REMOVED AGENT'S RETRY: its lease and original book stay", {
    skip: PG_LOADS ? "the pg driver loads here, so the retry's pool builds" : false,
  }, async () => {
    useLedger(false);
    const n = ++next;
    const tenant = addr(0x5a00 + n);
    const home = childHome(tenant);
    // Its grant is gone and its home still holds the original book. The first
    // pass cannot copy it up (no database), so it is kept pending under its
    // lease, and every later pass retries that copy before anything else.
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const book = new DatabaseSync(path.join(home, "merrymen.db"));
    await applyLedgerSchema(wrapSqlite(book));
    book.close();
    setTenantLeaseForTest(tenant, { tenant, backend: "postgres", healthy: () => true, async release() {} });

    await assert.doesNotReject(reconcile(), "the first pass keeps it pending");
    await assert.doesNotReject(reconcile(), "the retry's failure does not reject through reconcile");
    await assert.doesNotReject(reconcile());
    // Said by its kind — a driver that will not load — and once, though three
    // passes met it.
    assert.deepEqual(alerts(tenant).filter((l) => /final copy deferred/.test(l)).map((l) => /\(([^)]*)\)/.exec(l)?.[1]), ["Error ERR_MODULE_NOT_FOUND"], said.join("\n"));
    assert.ok(!alerts(tenant).some((l) => /spawn-guard\.invalid|not-a-real-connection|pg/.test(l)), "and no connection detail is logged");
    assert.equal(hasLeaseForTest(tenant), true, "the lease that protects its final copy is kept");
    assert.ok(existsSync(path.join(home, "merrymen.db")), "and the original book stays");
    assert.equal(spawned.length, 0);
  });
});
