import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { everyLandedOpSponsored } from "./gasless";

test("mixed-case sponsorship reads collapse operation copies without mixing accounts or periods", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE trades(id INTEGER PRIMARY KEY, agent_id TEXT, epoch INTEGER, kind TEXT, status TEXT,
      user_op_hash TEXT, decision_id TEXT, fill_side TEXT, created_at INTEGER, sponsored_gas_wei TEXT);
      INSERT INTO trades VALUES
        (1, '0xAbC', 2, 'swap', 'landed', '0xop1', 'decision', 'buy', 1, '1000'),
        (2, '0xABC', 2, 'swap', 'landed', '0xOP1', NULL, NULL, 100, NULL),
        (3, '0xabc', 2, 'key-install', 'landed', '0xop2', NULL, NULL, 2, '1000'),
        (4, '0xother', 2, 'swap', 'landed', '0xop1', 'other', 'buy', 3, NULL),
        (5, '0xABC', 1, 'swap', 'landed', '0xold', NULL, NULL, 4, NULL),
        (6, '0xABC', 2, 'swap', 'submitted', '0xpending', NULL, NULL, 5, NULL),
        (7, '0xABC', 2, 'swap', 'paper', NULL, NULL, 'buy', 6, NULL)`);
    for (const account of ["0xabc", "0xAbC", "0xABC"]) {
      assert.equal(await everyLandedOpSponsored(db, account, 2), true,
        "the bare recovered copy is not a self-paid operation");
    }
    await db.exec(`INSERT INTO trades VALUES
      (8, '0xaBc', 2, 'swap', 'landed', '0xpaid', NULL, 'buy', 7, NULL)`);
    for (const account of ["0xabc", "0xAbC", "0xABC"]) {
      assert.equal(await everyLandedOpSponsored(db, account, 2), false,
        "a separately landed self-paid operation under any spelling ends the claim");
    }
    await db.exec("UPDATE trades SET sponsored_gas_wei = '' WHERE id = 8");
    assert.equal(await everyLandedOpSponsored(db, "0xabc", 2), false, "empty sponsorship is no proof");
    assert.equal(await everyLandedOpSponsored(db, "0xabc", 3), false, "nothing landed makes no gasless claim");
  } finally { raw.close(); }
});

test("an unread sponsorship ledger rejects rather than returning a false empty-period claim", async () => {
  const raw = new DatabaseSync(":memory:");
  try { await assert.rejects(everyLandedOpSponsored(wrapSqlite(raw), "0xabc", 1)); }
  finally { raw.close(); }
});
