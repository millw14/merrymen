/**
 * THE PRICE A CALL WAS MADE AT REACHES THE FEED, OR THE CALL STILL DOES.
 *
 * `mark_usd` and `mcap_usd` are written with the decision row, at decision
 * time, in the same INSERT — which is the only kind of column this block may
 * carry (see the ON CONFLICT note in ledger-mirror.ts: a decision reaches the
 * shared ledger once, exactly as first written).
 *
 * The other half is the ledger that does not have them yet. The mirror reads a
 * child's sqlite READ-ONLY, so it cannot migrate one; a child ledger opened
 * before its own worker has run the ALTER would fail a SELECT that names the
 * new columns, and the decisions copy would stall — silently, since a stalled
 * table and an idle one print the same line. So the new columns are read when
 * they are there and the row is copied without them when they are not.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { wrapSqlite, type Db } from "./db";
import { MIRROR_STATE_DDL, missingMarkColumn, mirrorTenant } from "./ledger-mirror";

const DECISIONS = (marks: boolean) =>
  `CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, source TEXT, strategy TEXT, provider TEXT, model TEXT,
     symbol TEXT, action TEXT, size_usdg REAL, reason TEXT, dropped_rule TEXT, signals_json TEXT, hold_kind TEXT,
     evidence_json TEXT, provenance TEXT, display_name TEXT, ${marks ? "mark_usd REAL, mcap_usd REAL," : ""} at INTEGER);`;

function child(marks: boolean) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(DECISIONS(marks));
  if (marks) {
    raw.exec(`INSERT INTO decisions (id, agent_id, source, symbol, action, size_usdg, reason, display_name, mark_usd, mcap_usd, at)
              VALUES ('d1', '0xagent', 'brain', 'T3139F043B88', 'buy', 5, 'flow turned', 'JUGGERNAUT', 0.00042, 3100000, 9)`);
  } else {
    raw.exec(`INSERT INTO decisions (id, agent_id, source, symbol, action, size_usdg, reason, display_name, at)
              VALUES ('d1', '0xagent', 'brain', 'T3139F043B88', 'buy', 5, 'flow turned', 'JUGGERNAUT', 9)`);
  }
  return wrapSqlite(raw);
}

function shared() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(DECISIONS(true) + MIRROR_STATE_DDL);
  return wrapSqlite(raw);
}

describe("a decision's mark rides the mirror", () => {
  it("COPIES mark_usd AND mcap_usd with the row they were written in", async () => {
    const dest = shared();
    const r = await mirrorTenant({ tenant: "0xten", child: child(true), shared: dest });
    assert.equal(r.copied.decisions, 1);
    assert.equal(r.failed?.decisions, undefined);
    const got = (await dest.prepare("SELECT mark_usd, mcap_usd, display_name FROM decisions WHERE id = 'd1'").get()) as Record<string, unknown>;
    assert.equal(got.mark_usd, 0.00042);
    assert.equal(got.mcap_usd, 3100000);
    assert.equal(got.display_name, "JUGGERNAUT");
  });

  it("A CHILD LEDGER WITHOUT THE COLUMNS STILL COPIES ITS DECISIONS — with no mark, never a stall", async () => {
    const dest = shared();
    const r = await mirrorTenant({ tenant: "0xten", child: child(false), shared: dest });
    assert.equal(r.failed?.decisions, undefined, `the copy failed: ${r.failed?.decisions}`);
    assert.equal(r.copied.decisions, 1);
    const got = (await dest.prepare("SELECT mark_usd, mcap_usd, display_name FROM decisions WHERE id = 'd1'").get()) as Record<string, unknown>;
    assert.equal(got.mark_usd, null, "absent, not zero");
    assert.equal(got.mcap_usd, null);
    assert.equal(got.display_name, "JUGGERNAUT", "and everything else it had still arrives");
  });

  /**
   * THE FALLBACK IS FOR A MISSING COLUMN AND NOTHING ELSE.
   *
   * A decision reaches the shared ledger once — ON CONFLICT (id) DO NOTHING,
   * and the lookback re-read never updates — so a copy made without the marks
   * is permanent. If ANY failure of the first read fell back, one busy moment
   * on a child that HAS the columns would publish a whole batch with no mark,
   * and none of those posts could ever say "since posted" or "at $X MC".
   */
  it("A TRANSIENT READ FAILURE IS NOT A MISSING COLUMN — nothing is copied without its mark, and the next pass copies it", async () => {
    const real = child(true);
    let busy = true;
    // The same ledger, whose first SELECT naming the mark columns hits a lock.
    const flaky: Db = {
      prepare(sql: string) {
        const stmt = real.prepare(sql);
        if (!busy || !/\bmark_usd\b/.test(sql)) return stmt;
        return {
          ...stmt,
          all: async () => {
            busy = false;
            throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
          },
        };
      },
      exec: (sql) => real.exec(sql),
      tx: (fn) => real.tx(fn),
    };
    const dest = shared();
    const first = await mirrorTenant({ tenant: "0xten", child: flaky, shared: dest });
    assert.match(String(first.failed?.decisions), /database is locked/, "the pass says it failed");
    assert.equal(first.copied.decisions, undefined, "and copied nothing");
    assert.equal(await dest.prepare("SELECT id FROM decisions WHERE id = 'd1'").get(), undefined);

    const second = await mirrorTenant({ tenant: "0xten", child: flaky, shared: dest });
    assert.equal(second.failed?.decisions, undefined);
    assert.equal(second.copied.decisions, 1);
    const got = (await dest.prepare("SELECT mark_usd, mcap_usd FROM decisions WHERE id = 'd1'").get()) as Record<string, unknown>;
    assert.equal(got.mark_usd, 0.00042, "the retry carried the mark");
    assert.equal(got.mcap_usd, 3100000);
  });

  it("only THOSE columns: a ledger missing some other column is a failure, not a reason to drop the marks", async () => {
    const real = child(true);
    const broken: Db = {
      prepare(sql: string) {
        const stmt = real.prepare(sql);
        if (!/\bmark_usd\b/.test(sql)) return stmt;
        return { ...stmt, all: async () => { throw new Error("no such column: display_name"); } };
      },
      exec: (sql) => real.exec(sql),
      tx: (fn) => real.tx(fn),
    };
    const dest = shared();
    const r = await mirrorTenant({ tenant: "0xten", child: broken, shared: dest });
    assert.match(String(r.failed?.decisions), /display_name/);
    assert.equal(r.copied.decisions, undefined);
  });
});

describe("what counts as the mark columns being absent", () => {
  it("SQLite's own words, and Postgres's undefined_column — about a mark column", () => {
    assert.equal(missingMarkColumn(new Error("no such column: mark_usd")), true);
    assert.equal(missingMarkColumn(new Error("no such column: mcap_usd")), true);
    assert.equal(missingMarkColumn(Object.assign(new Error('column "mark_usd" does not exist'), { code: "42703" })), true);
  });

  it("nothing else", () => {
    assert.equal(missingMarkColumn(new Error("database is locked")), false);
    assert.equal(missingMarkColumn(new Error("no such column: display_name")), false);
    assert.equal(missingMarkColumn(new Error("no such table: decisions")), false);
    assert.equal(missingMarkColumn(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })), false);
    // Naming the column is not enough: this one is there, and something else is wrong with it.
    assert.equal(
      missingMarkColumn(Object.assign(new Error('column "mark_usd" is of type real but expression is of type text'), { code: "42804" })),
      false,
    );
    // Postgres names the column; a 42703 about another one is not ours to swallow.
    assert.equal(missingMarkColumn(Object.assign(new Error('column "provenance" does not exist'), { code: "42703" })), false);
    assert.equal(missingMarkColumn(null), false);
    assert.equal(missingMarkColumn("no such column: mark_usd"), false, "only an error object is an error");
  });
});
