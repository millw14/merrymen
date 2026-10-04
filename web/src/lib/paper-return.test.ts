import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { paperRecoveryBlocked, readPaperPerformance, readPaperReturn } from "./paper-return";

test("paper return uses its recorded book, isolates epochs and live transitions", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE equity(id INTEGER, agent_id TEXT, epoch INTEGER, equity_usdg REAL, mode TEXT, at INTEGER);
      INSERT INTO equity VALUES (1,'a',1,1000,'paper',1),(2,'a',1,1100,'paper',2),
      (3,'other',1,99999,'paper',3),(4,'a',2,5000,'paper',4);`);
    assert.equal(await readPaperReturn(db, 'a', 1), 1000);
    assert.equal(await readPaperReturn(db, 'a', 2), 0);
    await db.exec("INSERT INTO equity VALUES (5,'a',1,20,'live',5)");
    assert.equal(await readPaperReturn(db, 'a', 1), null);
    await db.exec("INSERT INTO equity VALUES (6,'a',1,1000,'paper',6),(7,'a',1,800,'paper',7)");
    assert.equal(await readPaperReturn(db, 'a', 1), -2000);
    await db.exec("UPDATE equity SET equity_usdg = 0 WHERE id = 7");
    assert.equal(await readPaperReturn(db, 'a', 1), -10000);
    assert.equal(await readPaperReturn(db, 'missing', 1), null);
    // An empty live mark between paper marks is not a live period.
    await db.exec(`INSERT INTO equity VALUES (20,'z',1,1000,'paper',20),(21,'z',1,0,'live',21),
      (22,'z',1,1000,'paper',22),(23,'z',1,1050,'paper',23)`);
    assert.equal(await readPaperReturn(db, 'z', 1), 500);
    await db.exec("CREATE TABLE paper_recovery_health(agent_id TEXT,blocked INTEGER); INSERT INTO paper_recovery_health VALUES('a',1)");
    assert.equal(await readPaperReturn(db, 'a', 2), null, "a failed restore must not publish its stale flat valuation");
    await db.exec("UPDATE paper_recovery_health SET blocked=0");
    assert.equal(await readPaperReturn(db, 'a', 2), 0);
  } finally { raw.close(); }
});

test("a retained paper book keeps its baseline across live gaps, account casing and mirror insertion order", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE equity(id INTEGER, agent_id TEXT, epoch INTEGER, equity_usdg REAL, mode TEXT, at INTEGER);
      INSERT INTO equity VALUES
        (30,'0xabc',2,1000,'paper',10),(10,'0xabc',2,1100,'paper',20),
        (20,'0xabc',2,25,'live',30),(2,'0xAbC',2,1100,'paper',40),
        (100,'0xabc',2,25,'live',5),(101,'other',2,99999,'paper',50),
        (102,'0xabc',1,5000,'paper',1);`);
    for (const account of ['0xabc', '0xAbC', '0xABC']) {
      assert.deepEqual(await readPaperPerformance(db, account, 2), {
        equityUsdg: 1100, equityAt: 40, held: false, pnlUsdg: 100, pnlBps: 1000, pnlAt: 40,
      });
      assert.equal(await readPaperReturn(db, account, 2), 1000);
    }
  } finally { raw.close(); }
});

test("an explicit reset epoch starts a new paper baseline and performance retains sub-basis-point changes", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE equity(id INTEGER, agent_id TEXT, epoch INTEGER, equity_usdg REAL, mode TEXT, at INTEGER);
      INSERT INTO equity VALUES (1,'a',2,1000,'paper',1),(2,'a',2,1100,'paper',2),
        (3,'a',3,2000,'paper',3),(4,'a',3,2000.05,'paper',4);`);
    const performance = await readPaperPerformance(db, 'a', 3);
    assert.ok(performance);
    assert.equal(performance.equityUsdg, 2000.05);
    assert.ok(Math.abs(performance.pnlUsdg - 0.05) < 1e-9);
    assert.ok(Math.abs(performance.pnlBps - 0.25) < 1e-9);
    assert.equal(performance.pnlAt, 4);
    assert.equal(await readPaperReturn(db, 'a', 3), 0, "legacy display still rounds to whole basis points");
    assert.equal(await readPaperReturn(db, 'a', 2), 1000);
    await db.exec("UPDATE equity SET equity_usdg = 1999.922172 WHERE id = 4");
    const loss = await readPaperPerformance(db, 'a', 3);
    assert.ok(loss && Math.abs(loss.pnlBps - (-0.38914)) < 1e-9, "a real loss below one basis point retains its sign and precision");
    assert.equal(await readPaperReturn(db, 'a', 3), -0, "the legacy rounded display cannot represent this small loss");
    await db.exec("CREATE TABLE paper_recovery_health(agent_id TEXT,blocked INTEGER); INSERT INTO paper_recovery_health VALUES('A',1)");
    assert.equal(await paperRecoveryBlocked(db, 'a'), true);
    assert.equal(await readPaperPerformance(db, 'a', 3), null, "an epoch reset must not bypass a recovery block");
  } finally { raw.close(); }
});

test("paper equity includes the newest held valuation while P&L uses measured paper endpoints", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE equity(id INTEGER, agent_id TEXT, epoch INTEGER, equity_usdg REAL, mode TEXT, at INTEGER, flows_held INTEGER);
      INSERT INTO equity VALUES (1,'a',2,1000,'paper',1,1),(2,'a',2,1100,'paper',2,0),
        (3,'a',2,1122,'paper',3,0),(4,'a',2,1200,'paper',4,1),
        (5,'unmeasured',2,1000,'paper',5,1);`);
    assert.deepEqual(await readPaperPerformance(db, 'a', 2), {
      equityUsdg: 1200, equityAt: 4, held: true, pnlUsdg: 22, pnlBps: 200, pnlAt: 3,
    });
    assert.equal(await readPaperReturn(db, 'a', 2), 200);
    assert.equal(await readPaperPerformance(db, 'unmeasured', 2), null);
    await db.exec("INSERT INTO equity VALUES (6,'a',2,20,'live',6,0)");
    assert.equal(await readPaperPerformance(db, 'a', 2), null, "the newest book must still be paper");
  } finally { raw.close(); }
});

test("only a genuinely missing legacy health table permits paper performance", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE equity(id INTEGER, agent_id TEXT, epoch INTEGER, equity_usdg REAL, mode TEXT, at INTEGER);
      INSERT INTO equity VALUES (1,'a',2,1000,'paper',1),(2,'a',2,1100,'paper',2)`);
    assert.equal(await paperRecoveryBlocked(db, "a"), false, "SQLite legacy missing table");
    assert.equal((await readPaperPerformance(db, "a", 2))!.pnlBps, 1000);
    await db.exec("CREATE TABLE paper_recovery_health(agent_id TEXT, blocked INTEGER); INSERT INTO paper_recovery_health VALUES('a',1)");
    for (const error of [new Error("permission denied for table paper_recovery_health"), new Error("database is locked"),
      Object.assign(new Error("relation paper_recovery_health does not exist"), { code: "42P01" })]) {
      const failing: Db = { ...db, prepare(sql) {
        if (sql.includes("FROM paper_recovery_health")) throw error;
        return db.prepare(sql);
      } };
      const legacy = "code" in error && error.code === "42P01";
      assert.equal(await paperRecoveryBlocked(failing, "a"), !legacy);
      assert.equal((await readPaperPerformance(failing, "a", 2))?.pnlBps ?? null, legacy ? 1000 : null);
    }
  } finally { raw.close(); }
});
