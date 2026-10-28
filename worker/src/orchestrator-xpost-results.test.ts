import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { grossGainPct, grossSaleOutcome, readSaleCard, readSaleResults } from "./orchestrator-xpost-results";

const ACCOUNT = `0x${"a".repeat(40)}`;
const OTHER = `0x${"b".repeat(40)}`;
const TOKEN = `0x${"c".repeat(40)}`;
const CASH = `0x${"d".repeat(40)}`;
const NOW = 1_800_000_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

async function fixture() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await db.exec(`
    CREATE TABLE agents (smart_account TEXT, chain_id INTEGER, epoch INTEGER);
    CREATE TABLE decisions (id TEXT, agent_id TEXT, action TEXT, source TEXT, symbol TEXT, display_name TEXT);
    CREATE TABLE trades (id INTEGER PRIMARY KEY, agent_id TEXT, epoch INTEGER, decision_id TEXT, kind TEXT,
      status TEXT, basis_source TEXT, fill_side TEXT, fill_qty_raw TEXT, fill_symbol TEXT,
      buy_token TEXT, sell_token TEXT, user_op_hash TEXT, tx_hash TEXT, created_at INTEGER,
      realized_pnl_usdg REAL, fill_cash_usdg REAL);
  `);
  await db.prepare("INSERT INTO agents VALUES (?,4663,1)").run(ACCOUNT);
  await db.prepare("INSERT INTO decisions VALUES ('sale',?,'sell','brain','PEPE','Pepe')").run(ACCOUNT);
  await db.prepare("INSERT INTO trades VALUES (1,?,1,NULL,'swap','landed','receipt','buy','100','PEPE',?,?,?, ?,?,NULL,10)").run(ACCOUNT, TOKEN, CASH, hash(1), hash(11), NOW - 1_000);
  await db.prepare("INSERT INTO trades VALUES (2,?,1,'sale','swap','landed','receipt','sell','50','PEPE',?,?,?, ?,?,2,7)").run(ACCOUNT, CASH, TOKEN, hash(2), hash(12), NOW - 100);
  return { raw, db };
}

describe("receipt-backed sale results", () => {
  it("publishes measured gross sign only, without passing raw proceeds or cost to the writer", async () => {
    const { raw, db } = await fixture();
    try {
      const result = await readSaleResults(db, ACCOUNT, 4663, NOW);
      assert.equal(result.length, 1);
      assert.equal(result[0]?.outcome, "profit");
      assert.equal(result[0]?.paper, false);
      assert.equal(result[0]?.token, TOKEN);
      assert.equal(result[0]?.operationKey, hash(2));
      // gainPct is the derived percent code appends after the gate (sale-outcome.ts); raw proceeds and cost still never leave here.
      assert.deepEqual(Object.keys(result[0]!).sort(), ["atSec", "decisionId", "gainPct", "name", "operationKey", "outcome", "paper", "side", "symbol", "token"]);
      assert.equal(typeof result[0]!.gainPct, "number");
      await db.exec("UPDATE trades SET realized_pnl_usdg = -2, fill_cash_usdg = 3 WHERE id = 2");
      assert.equal((await readSaleResults(db, ACCOUNT, 4663, NOW))[0]?.outcome, "loss");
      await db.exec("UPDATE trades SET realized_pnl_usdg = 0, fill_cash_usdg = 5 WHERE id = 2");
      assert.equal((await readSaleResults(db, ACCOUNT, 4663, NOW))[0]?.outcome, "flat");
    } finally { raw.close(); }
  });

  it("withholds emotion for estimated, missing or unreadable basis", async () => {
    const { raw, db } = await fixture();
    try {
      await db.exec("UPDATE trades SET basis_source = 'quote' WHERE id = 1");
      assert.equal((await readSaleResults(db, ACCOUNT, 4663, NOW))[0]?.outcome, "unknown");
      await db.exec("UPDATE trades SET basis_source = 'receipt' WHERE id = 1; UPDATE trades SET realized_pnl_usdg = NULL WHERE id = 2");
      assert.equal((await readSaleResults(db, ACCOUNT, 4663, NOW))[0]?.outcome, "unknown");
      await db.exec("UPDATE trades SET realized_pnl_usdg = 2 WHERE id = 2");
      const unread: Db = { ...db, prepare: (sql) => { if (sql.includes("CROSS JOIN")) throw new Error("replay unavailable"); return db.prepare(sql); } };
      assert.equal((await readSaleResults(unread, ACCOUNT, 4663, NOW))[0]?.outcome, "unknown");
    } finally { raw.close(); }
  });

  it("isolates account, chain and decision owner, and requires live settled receipts", async () => {
    const { raw, db } = await fixture();
    try {
      assert.deepEqual(await readSaleResults(db, OTHER, 4663, NOW), []);
      assert.deepEqual(await readSaleResults(db, ACCOUNT, 1, NOW), []);
      for (const [column, value] of [["status", "submitted"], ["status", "reverted"], ["status", "paper"], ["basis_source", "quote"], ["tx_hash", ""], ["user_op_hash", ""], ["fill_qty_raw", "0"]]) {
        const saved = (await db.prepare(`SELECT ${column} AS value FROM trades WHERE id = 2`).get() as { value: string }).value;
        await db.prepare(`UPDATE trades SET ${column} = ? WHERE id = 2`).run(value);
        assert.deepEqual(await readSaleResults(db, ACCOUNT, 4663, NOW), [], `${column}=${value}`);
        await db.prepare(`UPDATE trades SET ${column} = ? WHERE id = 2`).run(saved);
      }
      await db.prepare("UPDATE decisions SET agent_id = ?").run(OTHER);
      assert.deepEqual(await readSaleResults(db, ACCOUNT, 4663, NOW), []);
    } finally { raw.close(); }
  });

  it("deduplicates operation copies, preserves receipt time and retains evidence for delayed sends", async () => {
    const { raw, db } = await fixture();
    try {
      await db.exec("INSERT INTO trades SELECT 3,agent_id,epoch,NULL,kind,status,basis_source,NULL,fill_qty_raw,fill_symbol,buy_token,sell_token,user_op_hash,tx_hash,created_at+50,realized_pnl_usdg,fill_cash_usdg FROM trades WHERE id=2");
      const result = await readSaleResults(db, ACCOUNT, 4663, NOW + 3 * 3600);
      assert.equal(result.length, 1);
      assert.equal(result[0]?.atSec, NOW - 100);
      assert.equal(result[0]?.outcome, "profit");
    } finally { raw.close(); }
  });
});

describe("the profit card of a receipt-backed sale (2026-10-13)", () => {
  it("is the sale's own figures, under its coin's name, for a measured profit on vouched cost", async () => {
    const { raw, db } = await fixture();
    try {
      // cost 5, proceeds 7, pnl 2 -> +40%.
      assert.deepEqual(await readSaleCard(db, ACCOUNT, 4663, hash(2), NOW), { symbol: "PEPE", investedUsdg: 5_000_000n, proceedsUsdg: 7_000_000n, realisedUsdg: 2_000_000n });
      assert.deepEqual(await readSaleCard(db, ACCOUNT.toUpperCase().replace("0X", "0x"), 4663, hash(2).toUpperCase().replace("0X", "0x"), NOW), { symbol: "PEPE", investedUsdg: 5_000_000n, proceedsUsdg: 7_000_000n, realisedUsdg: 2_000_000n });
    } finally { raw.close(); }
  });

  it("is never drawn for a loss, a flat or an unknown result", async () => {
    const { raw, db } = await fixture();
    try {
      for (const [pnl, cash] of [[-2, 3], [0, 5], [null, 7]] as const) {
        await db.prepare("UPDATE trades SET realized_pnl_usdg = ?, fill_cash_usdg = ? WHERE id = 2").run(pnl, cash);
        assert.equal(await readSaleCard(db, ACCOUNT, 4663, hash(2), NOW), null, `pnl=${pnl}`);
      }
      await db.exec("UPDATE trades SET realized_pnl_usdg = 2, fill_cash_usdg = 7 WHERE id = 2; UPDATE trades SET basis_source = 'quote' WHERE id = 1");
      assert.equal(await readSaleCard(db, ACCOUNT, 4663, hash(2), NOW), null, "estimated cost is not vouched");
    } finally { raw.close(); }
  });

  it("is never drawn for paper, another account, another chain, another sale, or a coin with no printable name", async () => {
    const { raw, db } = await fixture();
    try {
      assert.equal(await readSaleCard(db, OTHER, 4663, hash(2), NOW), null);
      assert.equal(await readSaleCard(db, ACCOUNT, 1, hash(2), NOW), null);
      assert.equal(await readSaleCard(db, ACCOUNT, 4663, hash(3), NOW), null);
      assert.equal(await readSaleCard(db, ACCOUNT, 4663, "row:2", NOW), null);
      await db.exec("UPDATE trades SET status = 'paper', basis_source = 'paper' WHERE id = 2");
      assert.equal(await readSaleCard(db, ACCOUNT, 4663, hash(2), NOW), null);
      await db.exec("UPDATE trades SET status = 'landed', basis_source = 'receipt', fill_symbol = NULL WHERE id = 2; UPDATE decisions SET symbol = 'T0123456789A', display_name = NULL");
      assert.equal(await readSaleCard(db, ACCOUNT, 4663, hash(2), NOW), null, "an autonomous token id is no coin name");
      await db.exec("UPDATE decisions SET display_name = 'Pepe'");
      assert.equal((await readSaleCard(db, ACCOUNT, 4663, hash(2), NOW))?.symbol, "Pepe");
    } finally { raw.close(); }
  });

  it("is null, never a throw, when the ledger cannot be read", async () => {
    const { raw, db } = await fixture();
    try {
      const broken: Db = { ...db, prepare: () => { throw new Error("ledger down"); } };
      assert.equal(await readSaleCard(broken, ACCOUNT, 4663, hash(2), NOW), null);
    } finally { raw.close(); }
  });
});

describe("gross result validation", () => {
  it("unknown numbers/cost never become flat or profitable, and small losses stay losses", () => {
    for (const row of [{ pnl: null, cash: 10 }, { pnl: 10, cash: 10 }, { pnl: NaN, cash: 10 }, { pnl: 1, cash: Infinity }, { pnl: -10, cash: -1 }]) assert.equal(grossSaleOutcome(row, true), "unknown");
    assert.equal(grossSaleOutcome({ pnl: 2, cash: 7 }, false), "unknown");
    assert.equal(grossSaleOutcome({ pnl: -0.000001, cash: 10 }, true), "loss");
  });
});

describe("the measured gain on evidenced cost (2026-10-13)", () => {
  it("is pnl over cost, and nothing where the outcome is unknown", () => {
    // cost 10, proceeds 113.4, pnl 103.4 -> +1034%
    assert.equal(Math.round(grossGainPct({ pnl: 103.4, cash: 113.4 }, true)!), 1034);
    assert.equal(grossGainPct({ pnl: -2, cash: 8 }, true), -20);
    assert.equal(grossGainPct({ pnl: 103.4, cash: 113.4 }, false), null, "cost not evidenced");
    assert.equal(grossGainPct({ pnl: null, cash: 10 }, true), null);
  });
});
