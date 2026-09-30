/**
 * ONE OPERATION IS ONE ROW, WHATEVER THE SHARED LEDGER HOLDS.
 *
 * The shape under test is the one production made: a child home has no volume,
 * a redeploy rebuilds its ledger empty, the in-flight reconciler re-records
 * every successful op of the last 26 hours as a bare 'swap' stamped at the
 * restart, and the mirror copied those rows up beside the evidenced originals.
 * Every count read each such op twice, and the copies sorted first.
 *
 * Run against sqlite AND against the Postgres translation of the same SQL
 * (placeholders renumbered, dialect rewritten, bound by name), because the
 * hosted web reads Postgres and the sqlite fixture alone would pass SQL the
 * translator mangles. It cannot stand in for the Postgres planner; it does
 * catch a statement the translation breaks.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { translateQuery, wrapSqlite, type Db, type RunResult } from "../../../worker/src/db";
import { distinctTrades, readOperationCounts, tradeOpKey } from "./distinct-trades";

/** The store's SQL, run the way PgDb would send it: translated, then bound as $1..$n. */
function pgTranslated(raw: DatabaseSync): Db {
  const bind = (params: unknown[]) => Object.fromEntries(params.map((p, i) => [`$${i + 1}`, p])) as never;
  const db: Db = {
    prepare(sql: string) {
      const text = translateQuery(sql);
      return {
        run: async (...p: unknown[]) => raw.prepare(text).run(bind(p)) as RunResult,
        get: async (...p: unknown[]) => raw.prepare(text).get(bind(p)),
        all: async (...p: unknown[]) => raw.prepare(text).all(bind(p)),
      };
    },
    exec: async (sql: string) => raw.exec(sql),
    tx: async (fn) => fn(db),
  };
  return db;
}

const SCHEMA = `CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, status TEXT,
  user_op_hash TEXT, decision_id TEXT, fill_side TEXT, buy_token TEXT, gas_wei TEXT, gas_usdg REAL,
  epoch INTEGER, created_at INTEGER);`;

/**
 * One agent, epoch 2:
 *  - op 0xAA: the executor's evidenced row (1), the reconciler's bare copy at the
 *    restart with the hash lowercased as the reconciler writes it (2), and a
 *    third copy filed under another spelling of the same account (9)
 *  - op 0xbb: a copy still 'submitted' in the shared ledger (3) beside the
 *    reconciler's landed one (4)
 *  - two refusals with no hash (5, 6), which are two operations and not one
 *  - a paper fill with no hash (7)
 *  - another agent's row sharing hash 0xaa (8), which is not this agent's operation
 *  - op 0xcc: a copy linked to its decision (10) and a later one carrying the
 *    fill (11) — the fill is what P&L is read from, so it speaks for the op
 *  - op 0xdd: two landed copies with no fill; the later one (13) is linked to
 *    its decision and the earlier one (12) is not, so the decision wins
 *  - op 0xee: a revert written twice (14, 15) — one operation the wall turned back
 */
function seed(raw: DatabaseSync) {
  raw.exec(SCHEMA);
  raw.exec(`INSERT INTO trades (agent_id, kind, status, user_op_hash, decision_id, fill_side, buy_token, gas_wei, gas_usdg, epoch, created_at) VALUES
    ('0xA', 'curve-trade', 'landed', '0xAA', 'd1', 'buy', '0xCOIN', '100', 0.01, 2, 1000),
    ('0xA', 'swap', 'landed', '0xaa', NULL, NULL, NULL, NULL, NULL, 2, 5000),
    ('0xA', 'curve-trade', 'submitted', '0xbb', 'd2', NULL, '0xCOIN2', NULL, NULL, 2, 1100),
    ('0xA', 'swap', 'landed', '0xbb', NULL, NULL, NULL, NULL, NULL, 2, 5000),
    ('0xA', 'curve-trade', 'rejected', NULL, 'd3', NULL, NULL, NULL, NULL, 2, 1200),
    ('0xA', 'curve-trade', 'rejected', NULL, 'd3', NULL, NULL, NULL, NULL, 2, 1200),
    ('0xA', 'swap', 'paper', NULL, NULL, 'buy', '0xPAPER', NULL, NULL, 2, 1300),
    ('0xOTHER', 'swap', 'landed', '0xaa', NULL, NULL, NULL, NULL, NULL, 2, 1000),
    ('0xa', 'swap', 'landed', '0xAA', NULL, NULL, NULL, NULL, NULL, 2, 9000),
    ('0xA', 'swap', 'landed', '0xcc', 'd9', NULL, NULL, NULL, NULL, 2, 1400),
    ('0xA', 'swap', 'landed', '0xCC', NULL, 'sell', NULL, NULL, NULL, 2, 1500),
    ('0xA', 'swap', 'landed', '0xdd', NULL, NULL, NULL, NULL, NULL, 2, 1600),
    ('0xA', 'swap', 'landed', '0xdd', 'd10', NULL, NULL, NULL, NULL, 2, 1700),
    ('0xA', 'swap', 'reverted', '0xee', 'd11', NULL, NULL, NULL, NULL, 2, 1800),
    ('0xA', 'swap', 'reverted', '0xee', 'd11', NULL, NULL, NULL, NULL, 2, 1800);`);
}

for (const [label, open] of [
  ["sqlite", (raw: DatabaseSync) => wrapSqlite(raw)],
  ["the Postgres translation", pgTranslated],
] as const) {
  describe(`one row per operation — ${label}`, () => {
    it("keeps the copy that knows the outcome, then the evidenced one, and drops the reconciler's", async () => {
      const raw = new DatabaseSync(":memory:");
      try {
        seed(raw);
        const db = open(raw);
        const rows = (await db
          .prepare(`SELECT t.id, t.status, t.fill_side FROM ${distinctTrades("t.agent_id = ? AND t.epoch = ?")} ORDER BY t.id`)
          .all("0xA", 2)) as { id: number; status: string; fill_side: string | null }[];
        assert.deepEqual(rows.map((r) => r.id), [1, 4, 5, 6, 7, 11, 13, 14], "row 2 is row 1's operation, written again");
        assert.equal(rows[0]!.fill_side, "buy", "the evidenced row speaks for op 0xAA");
        assert.equal(rows[1]!.status, "landed", "a settled copy outranks one still marked submitted");
      } finally {
        raw.close();
      }
    });

    it("collapses copies across a case difference in the account and the hash", async () => {
      const raw = new DatabaseSync(":memory:");
      try {
        seed(raw);
        const db = open(raw);
        const rows = (await db
          .prepare(`SELECT t.id FROM ${distinctTrades("lower(t.agent_id) = lower(?)")} ORDER BY t.id`)
          .all("0xa")) as { id: number }[];
        assert.deepEqual(rows.map((r) => r.id), [1, 4, 5, 6, 7, 11, 13, 14], "rows 2 and 9 are row 1's operation");
      } finally {
        raw.close();
      }
    });

    it("counts operations, not rows", async () => {
      const raw = new DatabaseSync(":memory:");
      try {
        seed(raw);
        const db = open(raw);
        const c = await readOperationCounts(db, "0xA", 2, "landed");
        assert.equal(c.landed, 4, "0xAA, 0xbb, 0xcc and 0xdd once each — not seven landed rows");
        assert.equal(c.refused, 3, "two refusals without a hash are two operations, a revert written twice is one");
        assert.equal(c.filledPaper, 1);
        assert.equal(c.tokensTouched, 1);
        assert.equal(c.gasUsdg, 0.01);
        assert.equal(c.unpricedTrades, 0);
      } finally {
        raw.close();
      }
    });

    it("an empty hash is no hash: each such row is its own operation", async () => {
      // The mirror already reads "" as no hash. As a key it made every such row
      // of an account one operation, so all but one of them disappeared.
      const raw = new DatabaseSync(":memory:");
      try {
        seed(raw);
        raw.exec(`INSERT INTO trades (agent_id, kind, status, user_op_hash, epoch, created_at) VALUES
          ('0xA', 'swap', 'rejected', '', 2, 1900), ('0xA', 'swap', 'rejected', '', 2, 1910);`);
        const db = open(raw);
        const rows = (await db
          .prepare(`SELECT t.id FROM ${distinctTrades("t.agent_id = ? AND t.epoch = ?")} WHERE t.user_op_hash = '' ORDER BY t.id`)
          .all("0xA", 2)) as { id: number }[];
        assert.deepEqual(rows.map((r) => r.id), [16, 17]);
        assert.equal((await readOperationCounts(db, "0xA", 2, "landed")).refused, 5, "three before, and these two");
      } finally {
        raw.close();
      }
    });

    it("rows with no hash pass through beside the ranked ones, each once", async () => {
      const raw = new DatabaseSync(":memory:");
      try {
        seed(raw);
        const db = open(raw);
        const rows = (await db
          .prepare(`SELECT t.id, t.op_rank FROM ${distinctTrades("t.agent_id = ?")} WHERE t.user_op_hash IS NULL ORDER BY t.id`)
          .all("0xA")) as { id: number; op_rank: number }[];
        assert.deepEqual(rows.map((r) => r.id), [5, 6, 7]);
        assert.ok(rows.every((r) => Number(r.op_rank) === 1));
      } finally {
        raw.close();
      }
    });

    it("the key never lets an unhashed row collide with another", async () => {
      const raw = new DatabaseSync(":memory:");
      try {
        seed(raw);
        const db = open(raw);
        const keys = (await db
          .prepare(`SELECT ${tradeOpKey("t")} AS k FROM trades t WHERE t.status = 'rejected' ORDER BY t.id`)
          .all()) as { k: string }[];
        assert.equal(new Set(keys.map((r) => r.k)).size, 2);
      } finally {
        raw.close();
      }
    });
  });
}

describe("a ledger without the table", () => {
  it("throws rather than reporting zero operations", async () => {
    const raw = new DatabaseSync(":memory:");
    try {
      await assert.rejects(readOperationCounts(wrapSqlite(raw), "0xA", 2, "landed"));
    } finally {
      raw.close();
    }
  });
});
