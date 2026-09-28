/**
 * applyLedgerSchema AGAINST A SECOND PROCESS CREATING THE SAME NEW TABLE.
 *
 * Postgres's CREATE TABLE IF NOT EXISTS is not atomic against a concurrent
 * one: the loser fails on the catalog's own unique index (23505,
 * pg_type_typname_nsp_index), sees the relation appear mid-statement
 * (42P07), or finds its row type already made (42710). And the schema is
 * ONE multi-statement batch, which Postgres runs as one implicit transaction
 * — so the loser's whole batch rolled back and applyLedgerSchema threw before
 * a single ALTER ran.
 *
 * Measured, not supposed: three processes booting the new code at once over a
 * Postgres built by the previous release (pg-upgrade.postgres.test.ts), six
 * runs out of six, two losers each — on `energy_days`, the table this release
 * adds. The mirror skips that pass; startHistoryRepair, which runs once per
 * process, never runs at all.
 *
 * The race means the table now exists, so the batch is simply run again. Any
 * other failure is still thrown, and a batch that keeps losing gives up.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";

/** A real sqlite Db whose schema batch fails `failures` times with `code` first. */
function racing(code: string, failures: number): { db: Db; batches: () => number } {
  const real = wrapSqlite(new DatabaseSync(":memory:"));
  let batches = 0;
  let left = failures;
  const db: Db = {
    prepare: (sql) => real.prepare(sql),
    tx: (fn) => real.tx(fn),
    async exec(sql) {
      if (sql.includes("CREATE TABLE IF NOT EXISTS energy_days")) {
        batches += 1;
        if (left > 0) {
          left -= 1;
          throw Object.assign(new Error('duplicate key value violates unique constraint "pg_type_typname_nsp_index"'), { code });
        }
      }
      return real.exec(sql);
    },
  };
  return { db, batches: () => batches };
}

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const cols = (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()) as { name: string }[];
  return cols.some((c) => c.name === column);
}

describe("applyLedgerSchema — a racing creator is not a failure", () => {
  for (const code of ["23505", "42P07", "42710"]) {
    it(`${code} on the schema batch: runs it again, and every ALTER still lands`, async () => {
      const { db, batches } = racing(code, 1);
      await applyLedgerSchema(db);
      assert.equal(batches(), 2, "the batch ran again after the lost race");
      assert.ok(await hasColumn(db, "equity", "flows_held"), "the ALTERs after the batch ran");
      assert.ok(await hasColumn(db, "agents", "energy"));
    });
  }

  it("anything else is still thrown — a real schema error is never swallowed", async () => {
    const { db, batches } = racing("42601", 1);
    await assert.rejects(applyLedgerSchema(db), /pg_type_typname_nsp_index/);
    assert.equal(batches(), 1);
  });

  it("a batch that keeps losing gives up rather than spinning", async () => {
    const { db, batches } = racing("23505", 10);
    await assert.rejects(applyLedgerSchema(db), (e: unknown) => (e as { code?: string }).code === "23505");
    assert.equal(batches(), 3);
  });
});
