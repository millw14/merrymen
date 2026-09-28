import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "../../../../worker/src/db";
import { applyLedgerSchema } from "../../../../worker/src/store";
import { readReportSummary } from "./reports";

/**
 * THE OWNER'S REPORT DOES NOT CALL A HELD MARK'S CASH TRADING.
 *
 * A mark taken while flow inference was held (store.ts `flows_held`) can carry
 * a top-up the flows table has not booked yet. The summary measured its change
 * to the newest mark and split it by the BOOKED flows, so a 50 USDG top-up
 * arriving during a hold was reported as 50 USDG of trading.
 */
const ACCOUNT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90123";
const NOW = 1_800_000_000;
const clean = (t: string | null | undefined) => (t == null ? null : String(t));

async function ledger(): Promise<{ raw: DatabaseSync; db: Db }> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.prepare(
    `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, epoch)
     VALUES (?, 'Agent', '0x1', '0x2', 4663, '{}', 0, 4102444800, 'active', 'live', ?, 2)`,
  ).run(ACCOUNT, NOW - 30);
  return { raw, db };
}
async function mark(db: Db, at: number, cash: number, equity: number, held: number) {
  await db.prepare(
    `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, at)
     VALUES (?, '0', ?, 0, ?, ?, 2, 'live', ?, ?)`,
  ).run(ACCOUNT, cash, equity - cash, equity, held, at);
}

test("the summary's change ends on the newest measured mark and says what it left out", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, NOW - 5_000, 50, 100, 0);
    await mark(db, NOW - 4_000, 50, 110, 0);
    // An energy buy of 11 whose receipt wait timed out: held, not yet booked.
    await mark(db, NOW - 3_000, 39, 99, 1);
    await db.prepare(
      "INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, log_index, chain_id, source, at) VALUES (?, 2, 'out', 11, ?, 0, 4663, 'energy-buy', ?)",
    ).run(ACCOUNT, `0x${"e1".repeat(32)}`, NOW - 2_900);
    await mark(db, NOW - 2_000, 39, 99, 0);
    // Another op in flight, and a 50 USDG top-up only the closing look can book.
    await mark(db, NOW - 60, 89, 149, 1);

    const s = await readReportSummary(db, {
      accounts: [ACCOUNT], currentAccount: ACCOUNT, since: NOW - 86_400, until: NOW, now: NOW, permissionExpiresAt: null, settings: null,
    }, clean);
    const v = s.live.valuation;
    assert.equal(v.end?.at, NOW - 2_000);
    assert.equal(v.change_usdg, -1);
    assert.deepEqual(v.attribution, { flows_usdg: -11, unattributed_usdg: 0, trading_usdg: 10 });
    assert.ok(v.notes.some((n) => /2 live valuation\(s\) in this window were taken while flow inference was held/.test(n)), v.notes.join(" | "));
  } finally { raw.close(); }
});

test("a book valued in the window only while held reports no change, and says why", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, NOW - 90_000, 100, 100, 0);
    await mark(db, NOW - 3_000, 100, 100, 1);
    await mark(db, NOW - 60, 150, 150, 1);
    const s = await readReportSummary(db, {
      accounts: [ACCOUNT], currentAccount: ACCOUNT, since: NOW - 86_400, until: NOW, now: NOW, permissionExpiresAt: null, settings: null,
    }, clean);
    const v = s.live.valuation;
    assert.equal(v.change_usdg, null);
    assert.equal(v.attribution, null);
    assert.ok(v.notes.some((n) => /taken while flow inference was held/.test(n)), v.notes.join(" | "));
  } finally { raw.close(); }
});
