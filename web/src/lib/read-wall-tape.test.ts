/**
 * THE WALL BAND DRAWS OPERATIONS, NOT THE ROWS A REDEPLOY WROTE TWICE.
 *
 * After a redeploy the reconciler re-records every successful op of the last
 * 26 hours, stamped at the restart, and the mirror carried those copies up
 * beside the originals. The band then drew a burst of "through" at the moment
 * of the deploy — a day's fills replayed as if they had all happened at once —
 * and its headline counted each of them twice.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { readWallTape } from "./read-wall-tape";

test("a re-recorded copy is neither drawn nor counted, even when its original fell out of the window", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  const now = Math.floor(Date.now() / 1000);
  const restart = now - 600;
  try {
    await db.exec(`CREATE TABLE agents(smart_account TEXT, mode TEXT);
      CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, status TEXT, reject_rule TEXT,
        user_op_hash TEXT, fill_side TEXT, decision_id TEXT, created_at INTEGER);
      INSERT INTO agents VALUES ('0xa','live');`);
    await db
      .prepare(
        `INSERT INTO trades (agent_id, status, reject_rule, user_op_hash, fill_side, decision_id, created_at) VALUES
          ('0xa','landed',NULL,'0xOP1','buy','d1',?),
          ('0xa','landed',NULL,'0xop1',NULL,NULL,?),
          ('0xa','landed',NULL,'0xOLD','sell','d2',?),
          ('0xa','landed',NULL,'0xold',NULL,NULL,?),
          ('0xa','rejected','per-trade-cap',NULL,NULL,'d3',?),
          ('0xa','rejected','per-trade-cap',NULL,NULL,'d3',?)`,
      )
      // 0xOLD filled 25 hours ago, outside the day, and its copy landed inside it.
      .run(now - 3600, restart, now - 25 * 3600, restart, now - 1800, now - 1700);
    const tape = await readWallTape({}, (fn) => fn(db));
    assert.equal(tape.source, "sqlite");
    assert.deepEqual(tape.counts, { intents: 3, turned: 2, through: 1, flight: 0 });
    assert.equal(tape.cells.filter((c) => c.fate === "through").length, 1);
    assert.ok(
      !tape.cells.some((c) => c.fate === "through" && c.t === restart),
      "nothing is drawn at the restart: both rows there are copies",
    );
  } finally {
    raw.close();
  }
});

test("an operation filed under two spellings of one account is still drawn once", async () => {
  // The collapse keys on lower(agent_id), and the join to agents was exact. So
  // when the evidenced original was filed under '0xAbC…' and the copy under the
  // spelling the agents row holds, the collapse kept the original and the join
  // then dropped it: the operation vanished from the band altogether.
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.exec(`CREATE TABLE agents(smart_account TEXT, mode TEXT);
      CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, status TEXT, reject_rule TEXT,
        user_op_hash TEXT, fill_side TEXT, decision_id TEXT, created_at INTEGER);
      INSERT INTO agents VALUES ('0xabc','live');`);
    await db
      .prepare(
        `INSERT INTO trades (agent_id, status, reject_rule, user_op_hash, fill_side, decision_id, created_at) VALUES
          ('0xAbC','landed',NULL,'0xOP1','buy','d1',?),
          ('0xabc','landed',NULL,'0xop1',NULL,NULL,?)`,
      )
      .run(now - 3600, now - 600);
    const tape = await readWallTape({}, (fn) => fn(db));
    assert.deepEqual(tape.counts, { intents: 1, turned: 0, through: 1, flight: 0 });
    assert.equal(tape.cells.length, 1);
    assert.equal(tape.cells[0]!.t, now - 3600, "drawn when it filled, not at the copy's stamp");
  } finally {
    raw.close();
  }
});

test("a copy whose original filled days before the window is not drawn at the restart", async () => {
  // The reconciler's reach is a BLOCK count, clamped at 200,000 blocks, so its
  // wall-clock reach is whatever those blocks took — a chain that paused inside
  // them stretches it by the pause. The original here filled three days before
  // the day the band draws.
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  const now = Math.floor(Date.now() / 1000);
  const restart = now - 600;
  try {
    await db.exec(`CREATE TABLE agents(smart_account TEXT, mode TEXT);
      CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, status TEXT, reject_rule TEXT,
        user_op_hash TEXT, fill_side TEXT, decision_id TEXT, created_at INTEGER);
      INSERT INTO agents VALUES ('0xa','live');`);
    await db
      .prepare(
        `INSERT INTO trades (agent_id, status, reject_rule, user_op_hash, fill_side, decision_id, created_at) VALUES
          ('0xa','landed',NULL,'0xOLD','sell','d2',?),
          ('0xa','landed',NULL,'0xold',NULL,NULL,?)`,
      )
      .run(now - 86_400 - 3 * 86_400, restart);
    const tape = await readWallTape({}, (fn) => fn(db));
    assert.equal(tape.counts.through, 0, "the copy is not a fresh fill");
    assert.equal(tape.cells.length, 0);
  } finally {
    raw.close();
  }
});
