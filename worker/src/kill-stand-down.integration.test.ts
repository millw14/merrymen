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
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, describe, it } from "node:test";
import type { Db } from "./db";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-kill-stand-down-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
// The file store and no lease server: no Postgres in this test.
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");

const { reconcile, childHome, adoptLeasedChildForTest } = await import("./orchestrator");
const { applyLedgerSchema } = await import("./store");
const { wrapSqlite } = await import("./db");
const { MIRROR_STATE_DDL, mirrorTenant, openChildLedger } = await import("./ledger-mirror");
const { STAND_DOWN_EVENT } = await import("./stand-down");

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

  it("a slow shared database: the lease and the home are held until the write lands", async () => {
    // A timeout could stop the waiting, not the write. Released early, the
    // lease could pass to a new child whose snapshots the late write would
    // then overwrite. So nothing is let go while a write is in flight.
    const shared = await sharedLedger();
    const child = await childLedger();
    lastRows(child);
    child.close();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    const slow: Db = {
      prepare: (sql) => shared.db.prepare(sql),
      exec: (sql) => shared.db.exec(sql),
      tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
        reached();
        return gate.then(() => shared.db.tx(fn));
      },
    };
    let released = false;
    const proc = fakeChild();
    adoptLeasedChildForTest({ tenant: TENANT, smartAccount: ACCOUNT, proc, shared: slow, onLeaseRelease: () => (released = true) });

    const pass = reconcile();
    await atGate;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(proc.signals[0], "SIGTERM", "the child is already stopped");
    assert.equal(released, false, "the lease is held while the write is in flight");
    assert.equal(existsSync(home()), true, "and so is the home");

    open();
    await pass;
    assert.equal(released, true);
    assert.equal(existsSync(home()), false);
    assert.equal(count(shared.raw, `SELECT COUNT(*) AS n FROM events WHERE message = 'the last thing the child said'`), 1);
    assert.equal(status(shared.raw), "killed");
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
