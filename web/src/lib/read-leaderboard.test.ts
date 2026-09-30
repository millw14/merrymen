import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { readLeaderboard } from "./read-leaderboard";

test("board includes paper and idle agents without ranking simulated returns, and deduplicates re-grants", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, x_verified INTEGER, epoch INTEGER, mode TEXT, created_at INTEGER, contributions_known INTEGER);
      CREATE TABLE equity(agent_id TEXT, epoch INTEGER, equity_usdg REAL, at INTEGER, id INTEGER, mode TEXT);
      CREATE TABLE flows(agent_id TEXT, epoch INTEGER, direction TEXT, amount_usdg REAL, at INTEGER);
      CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, epoch INTEGER, status TEXT, gas_usdg REAL,
        gas_wei TEXT, user_op_hash TEXT, fill_side TEXT, buy_token TEXT);
      INSERT INTO agents VALUES ('0x111','Live',NULL,0,1,'live',4,1),('paper','Paper',NULL,0,1,'paper',3,1),('idle','Idle',NULL,0,1,'idle',2,1),('0x222','Old grant',NULL,0,1,'live',1,1),('rh:hidden','Broker',NULL,0,1,'live',1,1);
      INSERT INTO equity VALUES ('0x111',1,110,1,1,'live'),('paper',1,10000,1,2,'paper'),('paper',1,12000,2,3,'paper');
      INSERT INTO flows VALUES ('0x111',1,'in',100,1),('paper',1,'in',100,1);
      INSERT INTO trades (agent_id, epoch, status, gas_usdg) VALUES ('0x111',1,'landed',0),('paper',1,'paper',0);`);
    const identities = async () => [{tenant: '0x1' as const, slug: 'live-agent', accounts: ['0x111', '0x222'] as `0x${string}`[], createdAt: 1, updatedAt: 1}];
    const result = await readLeaderboard(fn => fn(db), identities);
    assert.deepEqual(result.agents.map(a => a.name), ['Live', 'Paper', 'Idle']);
    assert.equal(result.agents[0].pnlBps, 1000);
    assert.equal(result.agents[1].pnlBps, null);
    assert.equal(result.agents[1].paperPnlBps, 2000);
    assert.equal(result.agents[1].unrankedWhy, 'paper');
    assert.equal(result.agents[1].filledPaper, 1);
    assert.equal(result.agents[2].unrankedWhy, 'inactive');
    assert.ok(!JSON.stringify(result).includes('smart_account'));
  } finally { raw.close(); }
});

test("a redeploy's re-recorded copies of an operation count once on the board", async () => {
  // The reconciler writes every recent op again after a redeploy and the mirror
  // carried those rows up beside the originals; the board summed rows, so an
  // agent's landed count doubled on every deploy.
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, x_verified INTEGER, epoch INTEGER, mode TEXT, created_at INTEGER, contributions_known INTEGER);
      CREATE TABLE equity(agent_id TEXT, epoch INTEGER, equity_usdg REAL, at INTEGER, id INTEGER, mode TEXT);
      CREATE TABLE flows(agent_id TEXT, epoch INTEGER, direction TEXT, amount_usdg REAL, at INTEGER);
      CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, epoch INTEGER, status TEXT, gas_usdg REAL,
        gas_wei TEXT, user_op_hash TEXT, fill_side TEXT, buy_token TEXT);
      INSERT INTO agents VALUES ('0x111','Live',NULL,0,1,'live',4,1);
      INSERT INTO equity VALUES ('0x111',1,110,1,1,'live');
      INSERT INTO flows VALUES ('0x111',1,'in',100,1);
      INSERT INTO trades (agent_id, epoch, status, gas_usdg, user_op_hash, fill_side) VALUES
        ('0x111',1,'landed',0,'0xOP1','buy'), ('0x111',1,'landed',NULL,'0xop1',NULL), ('0x111',1,'landed',NULL,'0xop1',NULL),
        ('0x111',1,'landed',0,'0xop2','sell'), ('0x111',1,'rejected',NULL,NULL,NULL), ('0x111',1,'rejected',NULL,NULL,NULL);`);
    const identities = async () => [{tenant: '0x1' as const, slug: 'live-agent', accounts: ['0x111'] as `0x${string}`[], createdAt: 1, updatedAt: 1}];
    const [row] = (await readLeaderboard(fn => fn(db), identities)).agents;
    assert.equal(row.landed, 2, "two operations, whatever the tape holds");
    assert.equal(row.refused, 2, "two refusals without a hash are two, not one");
  } finally { raw.close(); }
});

test("a held mark is no return: the board ranks the newest measured mark over the flows booked by then, and draws the held mark", async () => {
  // A dropped op holds flow inference for up to 26 hours (store.ts
  // `flows_held`). Meanwhile the owner's transfer of 10 lands and is booked,
  // and a 50 USDG top-up arrives that only the look closing the hold can book.
  // The held marks read 140; ranking 140 over the 90 now on record is +55.6%
  // nobody earned. The measured mark is 100 and the 100 booked by it: flat.
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, x_verified INTEGER, epoch INTEGER, mode TEXT, created_at INTEGER, contributions_known INTEGER);
      CREATE TABLE equity(agent_id TEXT, epoch INTEGER, equity_usdg REAL, at INTEGER, id INTEGER, mode TEXT, flows_held INTEGER);
      CREATE TABLE flows(agent_id TEXT, epoch INTEGER, direction TEXT, amount_usdg REAL, at INTEGER);
      CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, epoch INTEGER, status TEXT, gas_usdg REAL,
        gas_wei TEXT, user_op_hash TEXT, fill_side TEXT, buy_token TEXT);
      INSERT INTO agents VALUES ('0x111','Held',NULL,0,2,'live',4,1);
      INSERT INTO equity VALUES ('0x111',2,100,10,1,'live',0),('0x111',2,140,20,2,'live',1),('0x111',2,140,30,3,'live',1);
      INSERT INTO flows VALUES ('0x111',2,'in',100,5),('0x111',2,'out',10,15);
      INSERT INTO trades (agent_id, epoch, status, gas_usdg) VALUES ('0x111',2,'landed',0);`);
    const identities = async () => [{ tenant: "0x1" as const, slug: "held-agent", accounts: ["0x111"] as `0x${string}`[], createdAt: 1, updatedAt: 1 }];
    const [row] = (await readLeaderboard((fn) => fn(db), identities)).agents;
    assert.equal(row.pnlBps, 0);
    // The sparkline and the list drawdown are the RAW series: no flow is
    // divided out of them, so a late booking cannot move them, and the held
    // mark is the value the book had.
    assert.deepEqual(row.curve, [100, 140, 140]);
    assert.equal(row.maxDdBps, 0);
  } finally { raw.close(); }
});
