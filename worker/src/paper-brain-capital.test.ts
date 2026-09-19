import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "./db";
import { paperBrainCapital } from "./paper-brain-capital";

test("paper Brain capital uses an evidenced cash-only opening and refuses incomplete fills", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE equity(id INTEGER PRIMARY KEY, agent_id TEXT, epoch INTEGER, mode TEXT, at INTEGER, cash_usdg REAL, vault_usdg REAL, positions_usdg REAL, equity_usdg REAL);
    CREATE TABLE trades(agent_id TEXT, epoch INTEGER, status TEXT, kind TEXT, created_at INTEGER, fill_qty_raw TEXT, fill_cash_usdg REAL, fill_side TEXT);
    INSERT INTO equity VALUES(1,'alice',1,'live',1,20,0,0,20);
    INSERT INTO equity VALUES(2,'alice',1,'paper',2,1000,0,0,1000);
    INSERT INTO equity VALUES(3,'alice',1,'paper',3,995,0,6,1001);`);
  try {
    assert.equal(await paperBrainCapital(wrapSqlite(db), "alice", 1), 1000e6);
    assert.equal(await paperBrainCapital(wrapSqlite(db), "bob", 1), null);
    db.exec("INSERT INTO trades VALUES('alice',1,'paper','swap',3,NULL,NULL,NULL)");
    assert.equal(await paperBrainCapital(wrapSqlite(db), "alice", 1), null);
    db.exec("UPDATE trades SET fill_qty_raw='500000000000000000000',fill_cash_usdg=5,fill_side='buy'");
    assert.equal(await paperBrainCapital(wrapSqlite(db), "alice", 1), 1000e6);
    db.exec("INSERT INTO equity VALUES(4,'alice',1,'live',4,20,0,0,20); INSERT INTO equity VALUES(5,'alice',1,'paper',5,995,0,6,1001)");
    assert.equal(await paperBrainCapital(wrapSqlite(db), "alice", 1), null, "cannot guess a new period's starting capital from a held position");
  } finally { db.close(); }
});
