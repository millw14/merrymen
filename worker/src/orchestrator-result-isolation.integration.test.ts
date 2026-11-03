import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { writeCommandResult } from "./command-files";
import { wrapSqlite } from "./db";
import { ferryForChild, ferryOrders } from "./orchestrator";

const SPOT = `0x${"11".repeat(20)}`;
const PERPS = `0x${"aB".repeat(20)}`;
const OTHER_OWNER = `0x${"33".repeat(20)}`;

// Exercise both production up-legs, including the old-schema fallback. A
// child controls the contents of its result files; their ids are not evidence
// that the named row belongs to that child's account.
for (const withReceipt of [false, true]) {
  for (const loop of ["reconcile", "short"] as const) {
    it(`${loop} ferry binds child results to their account (${withReceipt ? "with" : "without"} receipt column)`, async () => {
      const raw = new DatabaseSync(":memory:");
      const home = mkdtempSync(path.join(tmpdir(), "merrymen-result-isolation-"));
      try {
        raw.exec(`CREATE TABLE agent_commands (
          id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, args TEXT,
          created_at INTEGER NOT NULL, claimed_at INTEGER, done_at INTEGER, result TEXT
          ${withReceipt ? ", receipt TEXT" : ""})`);
        const put = raw.prepare("INSERT INTO agent_commands (id, agent_id, kind, created_at, claimed_at, done_at, result) VALUES (?, ?, 'trade', ?, ?, ?, ?)");
        const now = Date.now();
        put.run("own", PERPS, now, now, null, null);
        put.run("own-before-case-change", PERPS.toLowerCase(), now, now, null, null);
        put.run("same-owner-spot", SPOT, now, now, null, null);
        put.run("other-owner", OTHER_OWNER, now, now, null, null);
        put.run("already-answered", OTHER_OWNER, now, now, now, "confirmed original answer");
        for (const id of ["own", "own-before-case-change", "same-owner-spot", "other-owner", "already-answered"]) {
          writeCommandResult(home, { id, ok: true, line: `forged ${id}`, at: now });
        }
        const target = { home, smartAccount: PERPS, tag: `0x${"44".repeat(20)}:perps` };
        const db = wrapSqlite(raw);
        if (loop === "short") await ferryOrders(db, [target]);
        else await ferryForChild(db, target);
        const row = (id: string) => raw.prepare("SELECT done_at, result FROM agent_commands WHERE id = ?").get(id) as { done_at: number | null; result: string | null };
        assert.equal(row("own").result, "forged own", "this child's own completed command still lands");
        assert.equal(row("own-before-case-change").result, "forged own-before-case-change", "a renewed grant with different address casing retains its earlier commands");
        assert.deepEqual({ ...row("same-owner-spot") }, { done_at: null, result: null }, "a Perps child cannot answer its owner's Spot command");
        assert.deepEqual({ ...row("other-owner") }, { done_at: null, result: null }, "a child cannot answer another owner's command");
        assert.deepEqual({ ...row("already-answered") }, { done_at: now, result: "confirmed original answer" }, "a forged late result cannot rewrite another account's history");
      } finally {
        raw.close();
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
}
