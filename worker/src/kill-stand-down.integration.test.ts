/**
 * THE KILL SWITCH CARRIES A CHILD'S LAST ROWS UP BEFORE IT DELETES THEM.
 *
 * What it used to do: reconcile()'s kill-switch branch sent SIGTERM and
 * deleted the child's home in the same breath. The home holds the child's
 * private sqlite ledger, and mirrorLedgers() runs AFTER reconcile() on every
 * pass. So whatever the child wrote since the previous pass's mirror was
 * destroyed unseen. That includes a hosted Telegram /kill's own record of the
 * kill. A web kill (DELETE /api/grants) was never recorded anywhere, because
 * the child is stood down before any tick notices its grant is gone. The
 * web's inactivity diagnosis then told the owner "No trading permission has
 * been signed yet" about an agent they had just killed.
 *
 * Driven through the real reconcile() over a real file-backed grant store
 * (empty, so the adopted child is not wanted: its grant is gone). The child
 * ledger and the shared ledger both carry the real schema (applyLedgerSchema),
 * and the child ledger is in WAL mode like a live worker's.
 *
 * MERRYMEN_HOME is per process (node --test forks per file), so it never
 * leaks into another test file.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import type { StoredGrant } from "../../packages/core/src/index";
import type { Db } from "./db";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-kill-stand-down-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
// The file store and no lease server: no Postgres in this test.
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");

const { reconcile, childHome, adoptLeasedChildForTest, setSpawnForTest, setSharedLedgerForTest } = await import("./orchestrator");
const { applyLedgerSchema } = await import("./store");
const { wrapSqlite } = await import("./db");
const { MIRROR_STATE_DDL, mirrorTenant, openChildLedger } = await import("./ledger-mirror");
const { STAND_DOWN_EVENT } = await import("./stand-down");
const { getGrantStore } = await import("./grant-store");
const { killHosted } = await import("./kill-request");
const { loadGrantFile } = await import("./grant");
const { homePaths, merrymenHome } = await import("./home");

after(() => {
  rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const TENANT = "0x00000000000000000000000000000000000000a1" as const;
// Checksummed, as a grant carries it. The shared readers compare lowercased.
const ACCOUNT = "0x00000000000000000000000000000000000000C3" as const;
const nowSec = () => Math.floor(Date.now() / 1000);
const home = () => childHome(TENANT);

/** The worker's own kill lines, as index.ts and telegram/service.ts write them. */
const CHILD_KILL = "KILL SWITCH — grant discarded, session key destroyed; trading halted";
const CHAT_KILL = "Telegram: KILL by chat 424242";

async function sharedLedger(): Promise<{ db: Db; raw: DatabaseSync }> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.exec(MIRROR_STATE_DDL);
  return { db, raw };
}

/** A child ledger with an armed agent, as the worker leaves it after arming. */
async function childLedger(): Promise<DatabaseSync> {
  mkdirSync(home(), { recursive: true });
  const raw = new DatabaseSync(path.join(home(), "merrymen.db"));
  raw.exec("PRAGMA journal_mode = WAL;");
  await applyLedgerSchema(wrapSqlite(raw));
  const t = nowSec();
  raw
    .prepare(
      `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status)
       VALUES (?, 'Robin', '0x00000000000000000000000000000000000000b2', '0x00000000000000000000000000000000000000d4', 4663, '{}', ?, ?, 'armed')`,
    )
    .run(ACCOUNT, t - 3600, t + 7 * 86_400);
  return raw;
}

const event = (raw: DatabaseSync, message: string, level = "warn") =>
  raw.prepare(`INSERT INTO events (agent_id, level, message) VALUES (?, ?, ?)`).run(ACCOUNT, level, message);

/** The mirror pass that ran before the kill: everything up to here is already shared. */
async function previousMirrorPass(shared: Db) {
  const h = openChildLedger(home());
  assert.ok(h, "the child ledger is on disk");
  try {
    const r = await mirrorTenant({ tenant: TENANT, child: h.db, shared });
    assert.equal(r.failed, undefined, JSON.stringify(r.failed));
  } finally {
    h.close();
  }
}

/** Rows the child wrote after that pass: the ones the old kill switch destroyed. */
function lastRows(raw: DatabaseSync) {
  raw
    .prepare(
      `INSERT INTO trades (agent_id, kind, target, amount_usdg, status, decision_id, fill_side) VALUES (?, 'swap', 'router', 5, 'paper', 'late-decision', 'buy')`,
    )
    .run(ACCOUNT);
  raw
    .prepare(`INSERT INTO decisions (id, agent_id, source, symbol, action, size_usdg, reason) VALUES ('late-decision', ?, 'strategy:momentum', 'NVDA', 'buy', 5, 'the last call it made')`)
    .run(ACCOUNT);
  event(raw, "the last thing the child said", "ok");
}

/**
 * A running worker, reduced to what the stand-down does to it. It exits on
 * the first signal, after `onSignal` has looked at the shared ledger.
 */
function fakeChild(onSignal: () => void = () => {}) {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    signals: [] as string[],
    kill(signal?: NodeJS.Signals | number) {
      proc.signals.push(String(signal));
      if (proc.signalCode === null) {
        onSignal();
        proc.signalCode = "SIGTERM";
        setImmediate(() => proc.emit("exit", null, "SIGTERM"));
      }
      return true;
    },
  });
  return proc;
}

const count = (raw: DatabaseSync, sql: string, ...params: (string | number)[]) =>
  Number((raw.prepare(sql).get(...params) as { n: number }).n);
const killEvents = (raw: DatabaseSync) =>
  (raw.prepare(`SELECT message FROM events WHERE lower(agent_id) = lower(?) AND message LIKE 'KILL SWITCH%' ORDER BY id`).all(ACCOUNT) as { message: string }[]).map(
    (r) => r.message,
  );
const status = (raw: DatabaseSync) =>
  (raw.prepare(`SELECT status FROM agents WHERE lower(smart_account) = lower(?)`).get(ACCOUNT) as { status: string } | undefined)?.status;

beforeEach(async () => {
  // The grant store holds nothing for TENANT, so a reconcile stands down any
  // child a failed test left counted as running. Each test starts clean.
  await reconcile();
  rmSync(home(), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the kill switch stands a child down", () => {
  it("THE BUG: a web kill carries the child's last pass up, records the kill, THEN deletes the home", async () => {
    const shared = await sharedLedger();
    const child = await childLedger();
    event(child, "armed and trading", "ok");
    await previousMirrorPass(shared.db);
    lastRows(child);
    child.close(); // the worker process owns this handle; it dies with the SIGTERM

    let lastRowAtSignal = -1;
    const proc = fakeChild(() => {
      lastRowAtSignal = count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = 'the last thing the child said'`);
    });
    adoptLeasedChildForTest({ tenant: TENANT, smartAccount: ACCOUNT, proc, shared: shared.db });

    await reconcile();

    assert.equal(proc.signals[0], "SIGTERM", "the child was stood down");
    assert.equal(lastRowAtSignal, 0, "SIGTERM went out before any database work: stopping never waits on the mirror");

    // The last pass arrived, once, and nothing mirrored earlier was copied again.
    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = 'the last thing the child said'`), 1);
    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM trades WHERE decision_id = 'late-decision'`), 1);
    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM decisions WHERE id = 'late-decision'`), 1);
    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = 'armed and trading'`), 1);

    // The child never saw its grant go, so the orchestrator records the kill.
    assert.equal(status(shared.raw), "killed");
    assert.deepEqual(killEvents(shared.raw), [STAND_DOWN_EVENT]);

    assert.equal(existsSync(home()), false, "and only then was the home deleted");
  });

  it("a Telegram kill: the child's own kill events arrive, and the kill is not recorded twice", async () => {
    const shared = await sharedLedger();
    const child = await childLedger();
    await previousMirrorPass(shared.db);
    // What a child that got as far as its next syncGrant leaves behind.
    event(child, CHAT_KILL);
    event(child, CHILD_KILL);
    child.prepare(`UPDATE agents SET status = 'killed' WHERE smart_account = ?`).run(ACCOUNT);
    child.close();

    adoptLeasedChildForTest({ tenant: TENANT, smartAccount: ACCOUNT, proc: fakeChild(), shared: shared.db });
    await reconcile();

    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = ?`, CHAT_KILL), 1);
    assert.deepEqual(killEvents(shared.raw), [CHILD_KILL], "the child's KILL SWITCH line, and no second one beside it");
    assert.equal(status(shared.raw), "killed");
    assert.equal(existsSync(home()), false);
  });

  it("a Telegram kill stood down before the child's next tick: the chat line arrives and the orchestrator adds the KILL SWITCH", async () => {
    const shared = await sharedLedger();
    const child = await childLedger();
    await previousMirrorPass(shared.db);
    event(child, CHAT_KILL);
    child.close();

    adoptLeasedChildForTest({ tenant: TENANT, smartAccount: ACCOUNT, proc: fakeChild(), shared: shared.db });
    await reconcile();

    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = ?`, CHAT_KILL), 1);
    assert.deepEqual(killEvents(shared.raw), [STAND_DOWN_EVENT]);
    assert.equal(status(shared.raw), "killed");
  });

  it("a KILL SWITCH from an earlier run does not stand in for this one", async () => {
    const shared = await sharedLedger();
    // A kill before this child was spawned: the owner killed, then re-signed.
    shared.raw
      .prepare(`INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', ?, ?)`)
      .run(ACCOUNT, CHILD_KILL, nowSec() - 86_400);
    const child = await childLedger();
    await previousMirrorPass(shared.db);
    child.close();

    adoptLeasedChildForTest({ tenant: TENANT, smartAccount: ACCOUNT, proc: fakeChild(), shared: shared.db });
    await reconcile();

    assert.deepEqual(killEvents(shared.raw), [CHILD_KILL, STAND_DOWN_EVENT]);
  });

  it("a shared database that fails never keeps the child running or its home on disk", async () => {
    const child = await childLedger();
    lastRows(child);
    child.close();
    const down = (): never => {
      throw new Error("database unavailable");
    };
    const broken: Db = { prepare: down, exec: async () => down(), tx: async () => down() };

    const proc = fakeChild();
    adoptLeasedChildForTest({ tenant: TENANT, smartAccount: ACCOUNT, proc, shared: broken });
    await reconcile();

    assert.equal(proc.signals[0], "SIGTERM");
    assert.equal(existsSync(home()), false);
  });

  it("with no shared database at all the stand-down is what it always was", async () => {
    const child = await childLedger();
    child.close();
    const proc = fakeChild();
    adoptLeasedChildForTest({ tenant: TENANT, smartAccount: ACCOUNT, proc, shared: null });
    await reconcile();

    assert.equal(proc.signals[0], "SIGTERM");
    assert.equal(existsSync(home()), false);
  });
});

/**
 * THE KILL SWITCH REACHES A TENANT WITH NO CHILD RUNNING.
 *
 * What it used to do: the kill-switch branch walked `children` only. A child
 * that had crashed is out of `children` while it waits on its restart (1 to
 * 30 s), and for five minutes once the restart policy gives up. Killed in
 * that window, the tenant was skipped. Its lease was released, and nothing
 * else happened: its home stayed on disk until the container went, grant.json
 * and the session key in it included. Its last rows were never mirrored and
 * the kill was never recorded. A crash-looping agent is exactly the one an
 * owner kills.
 *
 * Spawned through the real reconcile() and spawnChild, with only the worker
 * process swapped for a fake (setSpawnForTest). Its crash runs the real exit
 * handler, which schedules the real restart. setTimeout is mocked from the
 * crash on, so a test decides when that restart comes due.
 */
describe("the kill switch stands down a tenant with no child running", () => {
  const store = getGrantStore();
  const grantFile = () => path.join(home(), "grant.json");
  // Captured before any test mocks setTimeout.
  const realSetTimeout = setTimeout;

  const grantAt = (grantedAt: number): StoredGrant =>
    ({
      smartAccount: ACCOUNT,
      owner: "0x00000000000000000000000000000000000000b2",
      sessionKeyAddress: "0x00000000000000000000000000000000000000d4",
      serialized: `eyJ-a-zerodev-blob-${grantedAt}`,
      chainId: 4663,
      grantedAt,
      expiresAt: grantedAt + 7 * 86_400,
      caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
      grantFeatures: ["tradeable-v2"],
      grantTokens: [],
      demoSessionPrivateKey: ("0x" + "cd".repeat(32)) as `0x${string}`,
    }) as unknown as StoredGrant;

  /** A worker process as spawnChild sees one. `crash` exits it on its own, as a failing worker does. */
  function fakeWorker() {
    const proc = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: null,
      stderr: null,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(_signal?: NodeJS.Signals | number) {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.signalCode = "SIGTERM";
          setImmediate(() => proc.emit("exit", null, "SIGTERM"));
        }
        return true;
      },
      crash(code = 1) {
        proc.exitCode = code;
        proc.emit("exit", code, null);
      },
    });
    return proc;
  }

  /** Every worker spawnChild started, oldest first. */
  const spawned: ReturnType<typeof fakeWorker>[] = [];
  setSpawnForTest(() => {
    const w = fakeWorker();
    spawned.push(w);
    return w as unknown as ChildProcess;
  });

  /** Resolves once `done()` holds, or after `ms` of real time. */
  async function eventually(done: () => boolean, ms = 500): Promise<void> {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await new Promise((r) => realSetTimeout(r, 5));
  }

  /** The child's hosted /kill, called as index.ts calls it, with the child's own MERRYMEN_HOME. */
  function childKill() {
    process.env.MERRYMEN_HOME = home();
    try {
      return killHosted(merrymenHome(), homePaths.grant(), loadGrantFile()!, nowSec());
    } finally {
      process.env.MERRYMEN_HOME = FLEET;
    }
  }

  /** A stored grant, and the child reconcile spawns for it. */
  async function armed(): Promise<{ db: Db; raw: DatabaseSync }> {
    const shared = await sharedLedger();
    setSharedLedgerForTest(shared.db);
    await store.put(TENANT, grantAt(nowSec() - 3600));
    await reconcile();
    assert.equal(spawned.length, 1, "armed");
    assert.ok(existsSync(grantFile()), "spawnChild handed the child its key");
    return shared;
  }

  afterEach(async () => {
    // Real timers first: the clean-up stand-down waits on them.
    mock.timers.reset();
    setSharedLedgerForTest(null);
    await store.remove(TENANT);
    await reconcile();
    spawned.length = 0;
  });

  it("THE BUG: killed between a crash and its restart, its last rows go up, the kill is recorded, and the key leaves the disk", async () => {
    const shared = await armed();
    // An earlier grant's kill: the owner killed, then signed the grant that is running now.
    shared.raw
      .prepare(`INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', ?, ?)`)
      .run(ACCOUNT, CHILD_KILL, nowSec() - 86_400);
    const child = await childLedger();
    event(child, "armed and trading", "ok");
    await previousMirrorPass(shared.db);
    lastRows(child);
    child.close();

    mock.timers.enable({ apis: ["setTimeout"] });
    spawned[0]!.crash(1); // out of `children`, its restart scheduled
    await store.remove(TENANT); // DELETE /api/grants, before the restart comes due
    await reconcile();

    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = 'the last thing the child said'`), 1);
    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM trades WHERE decision_id = 'late-decision'`), 1);
    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM decisions WHERE id = 'late-decision'`), 1);
    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = 'armed and trading'`), 1);
    assert.equal(status(shared.raw), "killed");
    assert.deepEqual(killEvents(shared.raw), [CHILD_KILL, STAND_DOWN_EVENT], "the earlier grant's kill does not stand in for this one");
    assert.equal(existsSync(home()), false, "the home is gone, grant.json with it");

    // The owner re-signs, and the killed run's restart comes due before the
    // next pass. Nothing arms until a reconcile takes the lease again.
    await store.put(TENANT, grantAt(nowSec()));
    mock.timers.tick(60_000);
    await eventually(() => spawned.length > 1);
    assert.equal(spawned.length, 1, "the old restart did not arm the new grant");

    await reconcile();
    assert.equal(spawned.length, 2, "the next pass arms it");
    assert.equal(existsSync(path.join(home(), "merrymen.db")), false, "in a fresh home");
  });

  it("killed in the give-up cool-off: stood down the same way, and a re-sign arms at once", async () => {
    const shared = await armed();
    const child = await childLedger();
    await previousMirrorPass(shared.db);
    lastRows(child);
    child.close();

    // Eight restarts that each die at once, then a ninth crash: the policy
    // (MAX_RESTARTS) gives up for five minutes.
    mock.timers.enable({ apis: ["setTimeout"] });
    for (let n = 1; n <= 8; n++) {
      spawned.at(-1)!.crash(1);
      mock.timers.tick(30_000);
      await eventually(() => spawned.length === n + 1);
      assert.equal(spawned.length, n + 1, `restart ${n}`);
    }
    spawned.at(-1)!.crash(1);
    await reconcile();
    assert.equal(spawned.length, 9, "given up: reconcile leaves it alone");

    await store.remove(TENANT);
    await reconcile();

    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = 'the last thing the child said'`), 1);
    assert.equal(status(shared.raw), "killed");
    assert.deepEqual(killEvents(shared.raw), [STAND_DOWN_EVENT]);
    assert.equal(existsSync(home()), false);

    await store.put(TENANT, grantAt(nowSec()));
    await reconcile();
    assert.equal(spawned.length, 10, "a re-sign arms on the next pass, not after the killed grant's cool-off");
  });

  it("a Telegram /kill, then a crash before it was carried out: the request names the account, and the child's own KILL SWITCH is not doubled", async () => {
    const shared = await armed();
    const child = await childLedger();
    await previousMirrorPass(shared.db);
    assert.equal(childKill().revocation, "queued");
    assert.equal(existsSync(grantFile()), false, "the child deleted its grant.json");
    // What the child wrote before it died: the chat line, then its next tick's kill.
    event(child, CHAT_KILL);
    event(child, CHILD_KILL);
    child.prepare(`UPDATE agents SET status = 'killed' WHERE smart_account = ?`).run(ACCOUNT);
    child.close();

    mock.timers.enable({ apis: ["setTimeout"] });
    spawned[0]!.crash(1);
    await reconcile();

    assert.equal(await store.get(TENANT), null, "the request was carried out");
    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = ?`, CHAT_KILL), 1);
    assert.deepEqual(killEvents(shared.raw), [CHILD_KILL]);
    assert.equal(status(shared.raw), "killed");
    assert.equal(existsSync(home()), false, "the request went with the home");

    mock.timers.tick(60_000);
    await eventually(() => spawned.length > 1);
    assert.equal(spawned.length, 1);
  });

  it("a Telegram /kill, then a crash before the child's next tick: the kill is recorded against the account its request names", async () => {
    const shared = await armed();
    const child = await childLedger();
    await previousMirrorPass(shared.db);
    childKill();
    event(child, CHAT_KILL);
    child.close();

    mock.timers.enable({ apis: ["setTimeout"] });
    spawned[0]!.crash(1);
    await reconcile();

    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = ?`, CHAT_KILL), 1);
    assert.deepEqual(killEvents(shared.raw), [STAND_DOWN_EVENT], "grant.json was gone, so only the request could name the account");
    assert.equal(status(shared.raw), "killed");
    assert.equal(existsSync(home()), false);
  });

  it("a restart that comes due mid-stand-down, after a re-sign, does not arm into the home being deleted", async () => {
    const shared = await armed();
    mock.timers.enable({ apis: ["setTimeout"] });
    spawned[0]!.crash(1);
    await store.remove(TENANT);

    // The owner re-signs while the kill is being recorded, and the restart
    // comes due right then. The lease is still held, so only `standingDown`
    // stands between that restart and a child armed in a doomed home.
    let raced = false;
    setSharedLedgerForTest({
      prepare: (sql) => shared.db.prepare(sql),
      exec: (sql) => shared.db.exec(sql),
      tx: async (fn) => {
        if (!raced) {
          raced = true;
          await store.put(TENANT, grantAt(nowSec()));
          // Past the 2 s restart, short of the stand-down's 15 s ceiling on recording.
          mock.timers.tick(5_000);
          await eventually(() => spawned.length > 1);
        }
        return shared.db.tx(fn);
      },
    });
    await reconcile();

    assert.ok(raced, "the stand-down recorded the kill");
    assert.equal(spawned.length, 1, "the restart was refused");
    assert.equal(existsSync(home()), false);
    assert.deepEqual(killEvents(shared.raw), [STAND_DOWN_EVENT]);

    await reconcile();
    assert.equal(spawned.length, 2, "the re-signed grant arms on the next pass");
  });

  it("the killed run's restart does not land on the re-signed run", async () => {
    // Killed while running: the stood-down child's own exit schedules a
    // restart like any other exit. The owner re-signs, the new run crashes,
    // and both restarts come due together.
    await armed();
    mock.timers.enable({ apis: ["setTimeout"] });
    await store.remove(TENANT);
    await reconcile();
    assert.equal(existsSync(home()), false, "stood down");
    await store.put(TENANT, grantAt(nowSec()));
    await reconcile();
    assert.equal(spawned.length, 2, "the re-signed grant armed");

    spawned[1]!.crash(1);
    mock.timers.tick(5_000);
    await eventually(() => spawned.length > 3);
    assert.equal(spawned.length, 3, "one restart, the new run's own, and no second child beside it");
  });

  it("nor does a restart left pending by a crash before the kill", async () => {
    await armed();
    mock.timers.enable({ apis: ["setTimeout"] });
    spawned[0]!.crash(1);
    await store.remove(TENANT);
    await reconcile();
    await store.put(TENANT, grantAt(nowSec()));
    await reconcile();
    assert.equal(spawned.length, 2, "the re-signed grant armed");

    spawned[1]!.crash(1);
    mock.timers.tick(5_000);
    await eventually(() => spawned.length > 3);
    assert.equal(spawned.length, 3, "one restart, the new run's own, and no second child beside it");
  });

  it("killed while running on its last restart: its exit starts no cool-off, and a re-sign arms at once", async () => {
    await armed();
    mock.timers.enable({ apis: ["setTimeout"] });
    for (let n = 1; n <= 8; n++) {
      spawned.at(-1)!.crash(1);
      mock.timers.tick(30_000);
      await eventually(() => spawned.length === n + 1);
    }
    assert.equal(spawned.length, 9, "the ninth run is up: one more quick death and the policy gives up");

    await store.remove(TENANT);
    await reconcile(); // its SIGTERM is that death
    await store.put(TENANT, grantAt(nowSec()));
    await reconcile();
    assert.equal(spawned.length, 10, "the re-sign armed on the next pass");
  });

  it("a home this replica holds no lease for, as a fleet halt leaves it: the kill is recorded and the key deleted, but the copy is not mirrored", async () => {
    // Another replica may have run the tenant since this copy was written.
    // `positions` and `cost_basis` mirror as snapshots, so a stale copy would
    // overwrite the live rows.
    const shared = await sharedLedger();
    setSharedLedgerForTest(shared.db);
    const child = await childLedger();
    await previousMirrorPass(shared.db);
    lastRows(child);
    child.close();
    writeFileSync(grantFile(), JSON.stringify(grantAt(nowSec() - 3600), null, 2));

    await reconcile(); // the store holds nothing for TENANT

    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = 'the last thing the child said'`), 0);
    assert.equal(status(shared.raw), "killed");
    assert.deepEqual(killEvents(shared.raw), [STAND_DOWN_EVENT]);
    assert.equal(existsSync(home()), false);
    assert.equal(spawned.length, 0);
  });
});
