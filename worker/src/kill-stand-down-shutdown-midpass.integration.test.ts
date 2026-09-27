/**
 * A SIGTERM WHILE A RECONCILE PASS IS STILL ON ITS WAY TO THE KILL SWITCH.
 *
 * reconcile() checks `stopping` once, on entry, then awaits the grant store,
 * the lease server and the settings files before it reaches the kill-switch
 * branch. The shutdown handler used to release every lease that was not yet
 * mid-stand-down. A tenant the pass was about to stand down therefore lost its
 * lease first, and its stand-down, finding no lease, skipped the last mirror
 * and deleted the home with the rows in it.
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

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-kill-midpass-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 11).toString("base64");

const { reconcile, childHome, adoptLeasedChildForTest, stopFleet } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { applyLedgerSchema } = await import("./store");
const { wrapSqlite } = await import("./db");
const { MIRROR_STATE_DDL } = await import("./ledger-mirror");

after(() => {
  rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const TENANT = "0x00000000000000000000000000000000000000a1" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000C3" as const;
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

it("the pass's stand-down keeps its lease, so its last mirror still runs, and the exit waits for it", async () => {
  const sharedRaw = new DatabaseSync(":memory:");
  const shared = wrapSqlite(sharedRaw);
  await applyLedgerSchema(shared);
  await shared.exec(MIRROR_STATE_DDL);

  mkdirSync(childHome(TENANT), { recursive: true });
  const child = new DatabaseSync(path.join(childHome(TENANT), "merrymen.db"));
  await applyLedgerSchema(wrapSqlite(child));
  child
    .prepare(
      `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status)
       VALUES (?, 'Robin', '0x00000000000000000000000000000000000000b2', '0x00000000000000000000000000000000000000d4', 4663, '{}', 1, 4102444800, 'armed')`,
    )
    .run(ACCOUNT);
  child.prepare(`INSERT INTO events (agent_id, level, message) VALUES (?, 'ok', 'the last thing the child said')`).run(ACCOUNT);
  child.close();

  // Hold the pass inside its first await, reading the grant store: past its
  // `stopping` check, and before the kill branch has registered anything.
  const store = getGrantStore();
  const listTenants = store.listTenants.bind(store);
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  store.listTenants = async () => {
    reached();
    await gate;
    return listTenants();
  };

  const order: string[] = [];
  adoptLeasedChildForTest({ tenant: TENANT, smartAccount: ACCOUNT, proc: fakeChild(), shared, onLeaseRelease: () => order.push("lease released") });

  try {
    const pass = reconcile();
    await atGate;
    stopFleet((code) => order.push(`exit ${code}`));
    await sleep(1_300); // past the one-second exit timer

    assert.deepEqual([...order], [], "no lease is released, and there is no exit, while the pass is in flight");

    open();
    await pass;
    for (let i = 0; i < 100 && !order.includes("exit 0"); i++) await sleep(20);
  } finally {
    store.listTenants = listTenants;
  }

  assert.deepEqual(order, ["lease released", "exit 0"]);
  assert.ok(sharedRaw.prepare(`SELECT 1 FROM events WHERE message = 'the last thing the child said'`).get(), "the last mirror ran");
  assert.equal((sharedRaw.prepare(`SELECT status FROM agents WHERE smart_account = ?`).get(ACCOUNT) as { status: string }).status, "killed");
  assert.equal(existsSync(childHome(TENANT)), false);
});
