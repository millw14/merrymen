/**
 * A SHUTDOWN DOES NOT LET GO OF A LEASE UNDER A KILL RECORD STILL BEING WRITTEN.
 *
 * The kill switch holds a tenant's lease until its last mirror and kill
 * record have settled (standDownKilled). Otherwise the lease could pass to a
 * new child, on this replica or another, whose snapshots the late write would
 * then overwrite. The shutdown handler used to release every lease at once and
 * exit a second later, which reopened that window through a deploy's SIGTERM.
 *
 * Its own file because stopFleet() sets the orchestrator's `stopping` flag
 * for good, and node --test forks per file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { Db } from "./db";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-kill-shutdown-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 9).toString("base64");

const { reconcile, childHome, adoptLeasedChildForTest, stopFleet } = await import("./orchestrator");
const { applyLedgerSchema } = await import("./store");
const { wrapSqlite } = await import("./db");
const { MIRROR_STATE_DDL } = await import("./ledger-mirror");

after(() => {
  rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const KILLED = "0x00000000000000000000000000000000000000a1" as const;
const OTHER = "0x00000000000000000000000000000000000000a2" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000C3" as const;
const ACCOUNT_OTHER = "0x00000000000000000000000000000000000000C4" as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeChild() {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(_signal?: NodeJS.Signals | number) {
      if (proc.signalCode === null) {
        proc.signalCode = "SIGTERM";
        setImmediate(() => proc.emit("exit", null, "SIGTERM"));
      }
      return true;
    },
  });
  return proc;
}

it("a SIGTERM mid-stand-down: no lease is released and the exit waits until the kill record has landed", async () => {
  const sharedRaw = new DatabaseSync(":memory:");
  const shared = wrapSqlite(sharedRaw);
  await applyLedgerSchema(shared);
  await shared.exec(MIRROR_STATE_DDL);

  mkdirSync(childHome(KILLED), { recursive: true });
  const child = new DatabaseSync(path.join(childHome(KILLED), "merrymen.db"));
  await applyLedgerSchema(wrapSqlite(child));
  child
    .prepare(
      `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status)
       VALUES (?, 'Robin', '0x00000000000000000000000000000000000000b2', '0x00000000000000000000000000000000000000d4', 4663, '{}', 1, 4102444800, 'armed')`,
    )
    .run(ACCOUNT);
  child.prepare(`INSERT INTO events (agent_id, level, message) VALUES (?, 'ok', 'the last thing the child said')`).run(ACCOUNT);
  child.close();

  // The shared database holds its first write open until the test says so.
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  const slow: Db = {
    prepare: (sql) => shared.prepare(sql),
    exec: (sql) => shared.exec(sql),
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      reached();
      return gate.then(() => shared.tx(fn));
    },
  };

  const order: string[] = [];
  // Neither tenant has a stored grant, so reconcile stands both down, one
  // after the other: KILLED first, held at the gate, then OTHER.
  adoptLeasedChildForTest({ tenant: KILLED, smartAccount: ACCOUNT, proc: fakeChild(), shared: slow, onLeaseRelease: () => order.push("killed: lease released") });
  adoptLeasedChildForTest({ tenant: OTHER, smartAccount: ACCOUNT_OTHER, proc: fakeChild(), shared: slow, onLeaseRelease: () => order.push("other: lease released") });

  const pass = reconcile();
  await atGate;
  stopFleet((code) => order.push(`exit ${code}`));
  await sleep(1_300); // past the one-second exit timer

  // OTHER is due to be stood down by the same pass, after KILLED. A lease
  // released here would have skipped its last mirror.
  assert.deepEqual([...order], [], "no lease is released, and there is no exit, while the pass's write is in flight");
  assert.equal(existsSync(childHome(KILLED)), true, "the home is kept while the write is in flight");

  open();
  await pass;
  for (let i = 0; i < 100 && !order.includes("exit 0"); i++) await sleep(20);
  assert.deepEqual(order, ["killed: lease released", "other: lease released", "exit 0"], "each stand-down releases its own lease, and the exit comes last");
  assert.equal(existsSync(childHome(KILLED)), false);
  assert.equal(
    (sharedRaw.prepare(`SELECT status FROM agents WHERE smart_account = ?`).get(ACCOUNT) as { status: string }).status,
    "killed",
  );
  assert.ok(sharedRaw.prepare(`SELECT 1 FROM events WHERE message = 'the last thing the child said'`).get());
});
