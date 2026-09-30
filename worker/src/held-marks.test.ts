import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { heldSqlSync, readMeasuredMarkSync } from "./held-marks";

/**
 * The synchronous half of the held-mark rule, for the readers that hold a
 * node:sqlite connection of their own (Telegram's). The async half and the
 * pure helpers are pinned in web/src/lib/held-marks.test.ts, which imports
 * them through the web's re-export.
 */
function ledger(withColumn: boolean): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE equity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, equity_usdg REAL, at INTEGER,
    epoch INTEGER DEFAULT 1, mode TEXT${withColumn ? ", flows_held INTEGER" : ""})`);
  return db;
}

test("sync: the newest measured mark is of the newest mark's book, one epoch, never a held one", () => {
  const db = ledger(true);
  try {
    const put = (at: number, equity: number, mode: string | null, held: number | null, epoch = 2, agent = "a") =>
      db.prepare("INSERT INTO equity (agent_id, equity_usdg, at, epoch, mode, flows_held) VALUES (?, ?, ?, ?, ?, ?)").run(agent, equity, at, epoch, mode, held);
    assert.equal(readMeasuredMarkSync(db, "a", 2), null, "no marks at all");
    put(10, 100, "live", null);
    put(20, 110, "live", 0);
    put(30, 90, "live", 1);
    put(40, 80, "live", 1);
    put(50, 999, "live", 0, 3);
    put(60, 999, "live", 0, 2, "b");
    assert.deepEqual(readMeasuredMarkSync(db, "a", 2), { equity: 110, at: 20 });
    assert.deepEqual(readMeasuredMarkSync(db, "a", null), { equity: 999, at: 50 });
    put(70, 1_000, "paper", 1);
    assert.equal(readMeasuredMarkSync(db, "a", 2), null, "the paper book's only mark is held; the live marks are not its");
  } finally {
    db.close();
  }
});

test("sync: a ledger without the column held nothing, and a column that arrives later is seen", () => {
  const db = ledger(false);
  try {
    assert.equal(heldSqlSync(db).flag(), "0");
    assert.equal(heldSqlSync(db).measurable("e."), "1 = 1");
    db.prepare("INSERT INTO equity (agent_id, equity_usdg, at, epoch, mode) VALUES ('a', 100, 10, 2, 'live')").run();
    assert.deepEqual(readMeasuredMarkSync(db, "a", 2), { equity: 100, at: 10 });
    db.exec("ALTER TABLE equity ADD COLUMN flows_held INTEGER");
    assert.equal(heldSqlSync(db).measurable("e."), "COALESCE(e.flows_held, 0) = 0");
    db.prepare("INSERT INTO equity (agent_id, equity_usdg, at, epoch, mode, flows_held) VALUES ('a', 50, 20, 2, 'live', 1)").run();
    assert.deepEqual(readMeasuredMarkSync(db, "a", 2), { equity: 100, at: 10 });
  } finally {
    db.close();
  }
});
