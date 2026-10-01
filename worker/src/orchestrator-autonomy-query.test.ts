/** The fleet's hourly trade funnel must query the ledger's actual timestamp. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { AUTONOMY_TRADE_FUNNEL_SQL } from "./orchestrator";

it("counts recent trades by status and rejection rule", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE trades (
      status TEXT NOT NULL,
      reject_rule TEXT,
      created_at INTEGER NOT NULL
    )`);
    const insert = db.prepare("INSERT INTO trades (status, reject_rule, created_at) VALUES (?, ?, ?)");
    insert.run("landed", null, 2000);
    insert.run("rejected", "grant-too-wide", 2001);
    insert.run("landed", null, 1000);
    const rows = db.prepare(AUTONOMY_TRADE_FUNNEL_SQL).all(1500) as {
      status: string; rule: string; n: number;
    }[];
    assert.deepEqual(rows.map((row) => ({ ...row })).sort((a, b) => a.status.localeCompare(b.status)), [
      { status: "landed", rule: "", n: 1 },
      { status: "rejected", rule: "grant-too-wide", n: 1 },
    ]);
  } finally {
    db.close();
  }
});
