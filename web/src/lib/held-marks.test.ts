import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { heldSql, isHeld, measuredMarks, netFlowsUpTo, readMeasuredMark } from "./held-marks";

/**
 * The one rule every flow-relative figure reads a mark by: a mark taken while
 * flow inference was held (store.ts `flows_held`) is no performance input, the
 * book is the newest mark's all the same, and a ledger without the column held
 * nothing.
 */

test("the book is the NEWEST mark's even when that mark is held, so a held first live tick never hands the figures the practice book", () => {
  const rows = [
    { mode: "paper", held: 0, v: 1_000 },
    { mode: "paper", held: null, v: 1_001 },
    { mode: "live", held: 1, v: 50 },
  ];
  assert.deepEqual(measuredMarks(rows), [], "the live book has no measured mark yet — not the paper one's");
  assert.deepEqual(measuredMarks([...rows, { mode: "live", held: 0, v: 51 }]).map((r) => r.v), [51]);
  // A newest mark with no mode predates the question and keeps every row.
  assert.deepEqual(measuredMarks([{ mode: "live", held: 0, v: 1 }, { mode: null, held: 1, v: 2 }, { mode: null, held: 0, v: 3 }]).map((r) => r.v), [1, 3]);
});

test("held reads the way either backend hands it back", () => {
  for (const v of [1, "1", 2n]) assert.equal(isHeld(v), true, String(v));
  for (const v of [0, "0", null, undefined]) assert.equal(isHeld(v), false, String(v));
});

test("the flows a mark carries are the ones booked at or before it", () => {
  const flows = [{ at: 10, signed: 100 }, { at: 20, signed: -10 }, { at: 30, signed: 50 }];
  assert.equal(netFlowsUpTo(flows, 9), null, "nothing on record yet is null, never 0");
  assert.equal(netFlowsUpTo(flows, 10), 100);
  assert.equal(netFlowsUpTo(flows, 29), 90);
  assert.equal(netFlowsUpTo(flows, 1e12), 140);
});

async function ledger(withColumn: boolean) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await db.exec(`CREATE TABLE equity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, equity_usdg REAL, at INTEGER,
    epoch INTEGER DEFAULT 1, mode TEXT${withColumn ? ", flows_held INTEGER" : ""})`);
  return { raw, db };
}

test("the newest measured mark: of the newest mark's book, one epoch, never a held one", async () => {
  const { raw, db } = await ledger(true);
  try {
    const put = (at: number, equity: number, mode: string | null, held: number | null, epoch = 2, agent = "a") =>
      db.prepare("INSERT INTO equity (agent_id, equity_usdg, at, epoch, mode, flows_held) VALUES (?, ?, ?, ?, ?, ?)").run(agent, equity, at, epoch, mode, held);
    assert.equal(await readMeasuredMark(db, "a", 2), null, "no marks at all");
    await put(10, 100, "live", null);
    await put(20, 110, "live", 0);
    await put(30, 90, "live", 1);
    await put(40, 80, "live", 1);
    await put(50, 999, "live", 0, 3); // another epoch
    await put(60, 999, "live", 0, 2, "b"); // another agent
    assert.deepEqual(await readMeasuredMark(db, "a", 2), { equity: 110, at: 20 });
    // No epoch clause reads the agent whole (a pre-epoch ledger), same rule.
    assert.deepEqual(await readMeasuredMark(db, "a", null), { equity: 999, at: 50 });
    // A book switch whose new book is held so far has no measured mark.
    await put(70, 1_000, "paper", 1);
    assert.equal(await readMeasuredMark(db, "a", 2), null, "the paper book's only mark is held; the live marks are not its");
  } finally { raw.close(); }
});

test("a ledger without the column held nothing, and its reads still work", async () => {
  const { raw, db } = await ledger(false);
  try {
    const held = await heldSql(db);
    assert.equal(held.flag(), "0");
    assert.equal(held.measurable("e."), "1 = 1");
    await db.prepare("INSERT INTO equity (agent_id, equity_usdg, at, epoch, mode) VALUES ('a', 100, 10, 2, 'live')").run();
    assert.deepEqual(await readMeasuredMark(db, "a", 2), { equity: 100, at: 10 });
    // The column arrives with the next migration and is seen at once: a
    // missing column is never remembered.
    await db.exec("ALTER TABLE equity ADD COLUMN flows_held INTEGER");
    assert.equal((await heldSql(db)).measurable("e."), "COALESCE(e.flows_held, 0) = 0");
    await db.prepare("INSERT INTO equity (agent_id, equity_usdg, at, epoch, mode, flows_held) VALUES ('a', 50, 20, 2, 'live', 1)").run();
    assert.deepEqual(await readMeasuredMark(db, "a", 2), { equity: 100, at: 10 });
  } finally { raw.close(); }
});
