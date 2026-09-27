import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { readPaperReturn } from "./paper-return";

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
