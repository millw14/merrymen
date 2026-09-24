/**
 * A CURSOR THAT SURVIVES THE LEDGER IT POINTS INTO.
 *
 * `mirror_state.last_id` is an id in the CHILD's sqlite, stored in SHARED
 * Postgres. The child's home has no volume, so a redeploy destroys it and its
 * ids restart at 1 while the watermark still reads whatever it reached.
 *
 * The first guard asked `SELECT 1 FROM <table> WHERE id = last_id` and treated a
 * hit as proof the cursor was sound. It is not. A rebuilt child that has written
 * `last_id` rows again puts a DIFFERENT row at that id, the guard finds it, and
 * `WHERE id > last_id` then matches nothing FOREVER.
 *
 * That is not hypothetical. Shogun's autonomous ClassBuy
 * (0x4ea6dec9…, 5.000000 USDG into 0x5b87957b…) landed on chain; its
 * `class_positions` row — a SNAPSHOT table, deleted and reinserted wholesale —
 * mirrored fine and showed the entry tx, while the `trades` row carrying
 * `fill_side` and `basis_source` never arrived and the orchestrator printed
 * `trades 0` on every pass.
 *
 * THE OTHER HALF OF THE PROBLEM, which is why this is not simply "reset the
 * cursor on restart": a spurious rewind re-copies rows the destination already
 * has. `trades` carries no unique key for `ON CONFLICT DO NOTHING` to bite on,
 * and money is summed from that tape. So the guard has to tell a rebuilt child
 * from a healthy one that merely has nothing new — and the tests below pin BOTH
 * directions, because a fix that only satisfies the first is a worse bug.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite } from "./db";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";

const TRADES =
  "CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, target TEXT," +
  " sell_token TEXT, buy_token TEXT, amount_usdg REAL, user_op_hash TEXT, tx_hash TEXT, status TEXT," +
  " reject_rule TEXT, decision_id TEXT, fill_side TEXT, fill_qty_raw TEXT, fill_price_usd REAL," +
  " realized_pnl_usdg REAL, basis_source TEXT, gas_wei TEXT, sponsored_gas_wei TEXT, gas_usdg REAL," +
  " gas_units TEXT, fill_cash_usdg REAL, fill_symbol TEXT, epoch INTEGER DEFAULT 1, created_at INTEGER);";
const EVENTS =
  "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, level TEXT," +
  " message TEXT, created_at INTEGER);";
const EQUITY =
  "CREATE TABLE equity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, eth_wei TEXT, cash_usdg REAL," +
  " vault_usdg REAL, positions_usdg REAL, equity_usdg REAL, epoch INTEGER DEFAULT 1, mode TEXT, at INTEGER);";
const FLOWS =
  "CREATE TABLE flows (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, direction TEXT," +
  " amount_usdg REAL, tx_hash TEXT, block_number INTEGER, log_index INTEGER, source TEXT," +
  " epoch INTEGER DEFAULT 1, chain_id INTEGER, at INTEGER);";
const FEES =
  "CREATE TABLE fee_accruals (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, profit_usdg REAL," +
  " fee_usdg REAL, hwm_before_usdg REAL, hwm_after_usdg REAL, epoch INTEGER DEFAULT 1, at INTEGER);";
const DECISIONS =
  "CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, source TEXT, strategy TEXT, provider TEXT," +
  " model TEXT, symbol TEXT, action TEXT, size_usdg REAL, reason TEXT, dropped_rule TEXT," +
  " signals_json TEXT, hold_kind TEXT, at INTEGER);";

/** Only what this file exercises; the snapshot pass is covered elsewhere. */
const LOGS = [TRADES, EVENTS, EQUITY, FLOWS, FEES, DECISIONS].join("\n");

const AGENT = "0xagent";

const child = (trades: { at: number; tx: string; side?: string; basis?: string }[]) => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(LOGS);
  for (const t of trades) {
    raw.exec(
      `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status,
                           fill_side, basis_source, epoch, created_at)
       VALUES ('${AGENT}','curve-trade','0xvault',5.0,'0xop${t.tx}','${t.tx}','landed',
               ${t.side ? `'${t.side}'` : "NULL"}, ${t.basis ? `'${t.basis}'` : "NULL"}, 1, ${t.at})`,
    );
  }
  return wrapSqlite(raw);
};

const dest = () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(LOGS + MIRROR_STATE_DDL);
  return wrapSqlite(raw);
};

const rows = async (db: ReturnType<typeof dest>) =>
  (await db.prepare(`SELECT tx_hash, fill_side, basis_source FROM trades ORDER BY id`).all()) as {
    tx_hash: string;
    fill_side: string | null;
    basis_source: string | null;
  }[];

const cursor = async (db: ReturnType<typeof dest>) =>
  (await db
    .prepare(`SELECT last_id, last_stamp FROM mirror_state WHERE table_name = 'trades'`)
    .get()) as { last_id: number; last_stamp: number | null } | undefined;

describe("a rebuilt child whose ids restart under a high cursor", () => {
  it("THE DEFECT — a stranger at the watermark is not the row we copied", async () => {
    const shared = dest();

    // ── incarnation one: three trades, all mirrored ───────────────────────
    const first = child([
      { at: 1000, tx: "0xaaa" },
      { at: 1001, tx: "0xbbb" },
      { at: 1002, tx: "0xccc" },
    ]);
    await mirrorTenant({ tenant: "t1", child: first, shared, nowSec: 2000 });
    assert.equal((await rows(shared)).length, 3, "the first incarnation must mirror");
    assert.equal((await cursor(shared))!.last_id, 3);

    // ── the redeploy: the sqlite file is gone and ids restart at 1 ────────
    //
    // THE EXACT SHAPE THE OWNER ASKED FOR: shared cursor is a high old id (3),
    // the rebuilt child holds valid NEW rows at low ids (1, 2, 3), and the row
    // previously mirrored at id 3 has been REPLACED by a different one. The old
    // guard sees a row at id 3 and reports health.
    const rebuilt = child([
      { at: 5000, tx: "0xddd" },
      { at: 5001, tx: "0xeee" },
      { at: 5002, tx: "0x4ea6dec9", side: "buy", basis: "receipt" },
    ]);
    const report = await mirrorTenant({ tenant: "t1", child: rebuilt, shared, nowSec: 6000 });

    assert.ok(report.restarted?.trades, "the mirror must NOTICE the ledger was rebuilt");
    assert.equal(report.restarted?.trades?.was, 3);
    assert.equal(report.copied.trades, 3, "and copy the new incarnation, not zero");

    const all = await rows(shared);
    assert.equal(all.length, 6, "both incarnations are on the tape");
    const landed = all.find((r) => r.tx_hash === "0x4ea6dec9");
    assert.ok(landed, "the trade that was invisible must now be present");
    assert.equal(landed!.fill_side, "buy");
    assert.equal(landed!.basis_source, "receipt");
  });

  it("and it still catches the plain case — a child with FEWER rows than the cursor", async () => {
    const shared = dest();
    const first = child([
      { at: 1000, tx: "0xaaa" },
      { at: 1001, tx: "0xbbb" },
      { at: 1002, tx: "0xccc" },
    ]);
    await mirrorTenant({ tenant: "t1", child: first, shared, nowSec: 2000 });

    const rebuilt = child([{ at: 5000, tx: "0xddd" }]);
    const report = await mirrorTenant({ tenant: "t1", child: rebuilt, shared, nowSec: 6000 });
    assert.ok(report.restarted?.trades, "no row at the watermark at all");
    assert.equal(report.copied.trades, 1);
  });
});

describe("AND A HEALTHY CHILD IS LEFT ALONE — the half that matters more", () => {
  /**
   * A spurious rewind re-copies rows the destination already holds. `trades`
   * has no unique key on the shared side, so those land as duplicates on a tape
   * that P&L is summed from. The repo has already shipped an incident where one
   * opening balance sat in Postgres three times.
   */
  it("a quiet child copies nothing and does NOT rewind", async () => {
    const shared = dest();
    const c = child([
      { at: 1000, tx: "0xaaa" },
      { at: 1001, tx: "0xbbb" },
    ]);
    await mirrorTenant({ tenant: "t1", child: c, shared, nowSec: 2000 });
    assert.equal((await rows(shared)).length, 2);

    // Same ledger, nothing new. Three more passes.
    for (const t of [2100, 2200, 2300]) {
      const report = await mirrorTenant({ tenant: "t1", child: c, shared, nowSec: t });
      assert.equal(report.restarted?.trades, undefined, "a quiet table is not a rebuilt one");
      assert.equal(report.copied.trades, 0, "and it honestly reports zero");
    }
    assert.equal((await rows(shared)).length, 2, "NOTHING may be duplicated");
  });

  it("AN IN-PLACE UPDATE IS NOT A REBUILD — the trap a content hash would fall into", async () => {
    // A live trade is written `submitted` and UPDATED when it lands: status,
    // tx_hash and every fill column are rewritten on the same id. A witness
    // built over mutable columns would read that as a new row at a known id and
    // duplicate the tape on every settlement.
    const shared = dest();
    const raw = new DatabaseSync(":memory:");
    raw.exec(LOGS);
    raw.exec(
      `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, epoch, created_at)
       VALUES ('${AGENT}','curve-trade','0xvault',5.0,'0xop1','submitted',1,1000)`,
    );
    const c = wrapSqlite(raw);
    await mirrorTenant({ tenant: "t1", child: c, shared, nowSec: 2000 });
    assert.equal((await rows(shared)).length, 1);

    // It lands. Same id, same created_at, everything else different.
    raw.exec(
      `UPDATE trades SET status = 'landed', tx_hash = '0xreal', fill_side = 'buy',
                         basis_source = 'receipt', realized_pnl_usdg = -1.77 WHERE id = 1`,
    );
    const report = await mirrorTenant({ tenant: "t1", child: c, shared, nowSec: 2100 });
    assert.equal(report.restarted?.trades, undefined, "a settlement is not a rebuild");
    assert.equal((await rows(shared)).length, 1, "and must not duplicate the row");
  });

  it("a child that grows normally keeps its cursor across many passes", async () => {
    const shared = dest();
    const raw = new DatabaseSync(":memory:");
    raw.exec(LOGS);
    const c = wrapSqlite(raw);
    for (let i = 1; i <= 4; i++) {
      raw.exec(
        `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, epoch, created_at)
         VALUES ('${AGENT}','swap','0xt',${i},'0xop${i}','0xtx${i}','landed',1,${1000 + i})`,
      );
      const report = await mirrorTenant({ tenant: "t1", child: c, shared, nowSec: 2000 + i });
      assert.equal(report.restarted?.trades, undefined, `pass ${i} must not rewind`);
      assert.equal(report.copied.trades, 1);
    }
    assert.equal((await rows(shared)).length, 4, "one row per trade, no more");
  });
});

describe("the witness itself", () => {
  it("is recorded beside the watermark, so later passes need no destination query", async () => {
    const shared = dest();
    const c = child([
      { at: 1000, tx: "0xaaa" },
      { at: 1234, tx: "0xbbb" },
    ]);
    await mirrorTenant({ tenant: "t1", child: c, shared, nowSec: 2000 });
    const mark = await cursor(shared);
    assert.equal(mark!.last_id, 2);
    assert.equal(mark!.last_stamp, 1234, "the stamp of the last row copied");
  });

  /**
   * THE MIGRATION CASE, and it is Shogun's exact situation: a cursor that
   * already exists, with no witness, pointing into a ledger that was ALREADY
   * rebuilt beneath it before this code shipped.
   */
  it("RECOVERS A CURSOR THAT WAS ALREADY STRANDED BEFORE THE WITNESS EXISTED", async () => {
    const shared = dest();
    // A cursor from the old world: last_id set, last_stamp NULL, and the
    // destination holds the rows of an incarnation that is gone.
    await shared
      .prepare(`INSERT INTO trades (agent_id, kind, tx_hash, status, created_at) VALUES (?,?,?,?,?)`)
      .run(AGENT, "swap", "0xold", "landed", 1000);
    await shared
      .prepare(
        `INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?,?,?,?,?)`,
      )
      .run("t1", "trades", 1, null, 0);

    const rebuilt = child([{ at: 5002, tx: "0x4ea6dec9", side: "buy", basis: "receipt" }]);
    const report = await mirrorTenant({ tenant: "t1", child: rebuilt, shared, nowSec: 6000 });

    assert.ok(report.restarted?.trades, "the stranded cursor must be recognised");
    assert.equal(report.copied.trades, 1);
    const landed = (await rows(shared)).find((r) => r.tx_hash === "0x4ea6dec9");
    assert.ok(landed, "the stranded trade reaches the shared ledger");
    assert.equal(landed!.fill_side, "buy");
    assert.equal(landed!.basis_source, "receipt");
  });

  it("but a witness-less cursor over a HEALTHY child is adopted, not reseeded", async () => {
    // The other side of the migration, and the one that would duplicate the
    // fleet's tape if it were got wrong. The destination already holds the row
    // the cursor points at, so the cursor describes THIS ledger.
    const shared = dest();
    const c = child([
      { at: 1000, tx: "0xaaa" },
      { at: 1001, tx: "0xbbb" },
    ]);
    // Mirror normally, then blank the witness to model a pre-migration cursor.
    await mirrorTenant({ tenant: "t1", child: c, shared, nowSec: 2000 });
    await shared.prepare(`UPDATE mirror_state SET last_stamp = NULL`).run();

    const report = await mirrorTenant({ tenant: "t1", child: c, shared, nowSec: 2100 });
    assert.equal(report.restarted?.trades, undefined, "a healthy cursor must NOT be reseeded");
    assert.equal(report.copied.trades, 0);
    assert.equal((await rows(shared)).length, 2, "nothing duplicated");
    assert.equal((await cursor(shared))!.last_stamp, 1001, "and the witness is adopted for next time");
  });
});

/**
 * THE PROBE READS ITS ANSWER OUT OF THE DESTINATION, so it is only sound for a
 * table nothing ever deletes there.
 *
 * `accounting-repair.ts:267` deletes shared `flows` rows. If a repair had
 * quarantined the row sitting at a tenant's watermark, the probe would answer
 * NO and rewind a perfectly healthy cursor — and while flows carrying a tx hash
 * dedupe on `flows_chain_identity`, the inferred and epoch-carry rows have no
 * identity at all. That rewind would duplicate exactly the rows contributions
 * are summed from, and contributions set the high-water mark.
 */
describe("the probe is restricted to tables with no delete path", () => {
  it("does NOT rewind flows just because the destination is missing that row", async () => {
    const shared = dest();
    const raw = new DatabaseSync(":memory:");
    raw.exec(LOGS);
    raw.exec(
      `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
       VALUES ('${AGENT}','in',80.0,'0xdead',555,4,'chain-log',1,4663,110)`,
    );
    const c = wrapSqlite(raw);
    await mirrorTenant({ tenant: "t1", child: c, shared, nowSec: 2000 });
    assert.equal(
      Number(((await shared.prepare(`SELECT COUNT(*) AS n FROM flows`).get()) as { n: number }).n),
      1,
    );

    // A repair removes it from the shared side, and the witness is blanked to
    // model a cursor from before this column existed.
    await shared.prepare(`DELETE FROM flows`).run();
    await shared.prepare(`UPDATE mirror_state SET last_stamp = NULL WHERE table_name = 'flows'`).run();

    const report = await mirrorTenant({ tenant: "t1", child: c, shared, nowSec: 2100 });
    assert.equal(report.restarted?.flows, undefined, "a deleted destination row is not a rebuilt child");
    assert.equal(report.copied.flows, 0, "and nothing is re-copied");
  });

  it("but trades — which nothing deletes — is still reconciled", async () => {
    // The distinction is the point: the same missing-row evidence means
    // different things for the two tables, and only one of them can be read as
    // a rebuild.
    const shared = dest();
    await shared
      .prepare(
        `INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?,?,?,?,?)`,
      )
      .run("t1", "trades", 1, null, 0);
    const rebuilt = child([{ at: 5002, tx: "0x4ea6dec9", side: "buy", basis: "receipt" }]);
    const report = await mirrorTenant({ tenant: "t1", child: rebuilt, shared, nowSec: 6000 });
    assert.ok(report.restarted?.trades, "trades must still recover a stranded cursor");
    assert.equal(report.copied.trades, 1);
  });
});
