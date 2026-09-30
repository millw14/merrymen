import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "../../../../worker/src/db";
import { applyLedgerSchema } from "../../../../worker/src/store";
import { ledgerScope, readLatestMark, readPerformance } from "./portfolio";

/**
 * THE OWNER'S PERFORMANCE IS NOT MEASURED ON A HELD MARK.
 *
 * A mark taken while flow inference was held (store.ts `flows_held`) can carry
 * an energy buy's USDG or a top-up that the flows table has not booked yet.
 * get_performance divides flows out by the time they are booked, so over a
 * held mark its growth index dipped, its drawdown kept the dip, and its return
 * ended on a reading whose cash nobody had split into capital and result yet.
 * "Equity now" is a different question, and still reads the held mark.
 */
const ACCOUNT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90123";
const NOW = 1_800_000_000;

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
async function flow(db: Db, direction: "in" | "out", amount: number, at: number, source: string, tx: string) {
  await db.prepare(
    "INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, log_index, chain_id, source, at) VALUES (?, 2, ?, ?, ?, 0, 4663, ?, ?)",
  ).run(ACCOUNT, direction, amount, tx, source, at);
}

test("get_performance ends on the newest measured mark: a held dip is no drawdown, a held top-up no return", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, NOW - 5_000, 50, 100, 0);
    await mark(db, NOW - 4_000, 50, 110, 0);
    // An energy buy of 11 whose receipt wait timed out: the next tick holds and
    // values the book with the 11 gone and not yet booked as capital out.
    await mark(db, NOW - 3_000, 39, 99, 1);
    await flow(db, "out", 11, NOW - 2_900, "energy-buy", `0x${"e1".repeat(32)}`);
    await mark(db, NOW - 2_000, 39, 99, 0);
    // A second op in flight, and a 50 USDG top-up only the closing look can book.
    await mark(db, NOW - 60, 89, 149, 1);

    const live = (await readPerformance(db, ledgerScope([ACCOUNT], ACCOUNT, 4663), "day", NOW)).live;
    assert.equal(live.end?.at, NOW - 2_000, "the measurement ends on the newest measured mark");
    assert.equal(live.end?.equity_usdg, 99);
    assert.equal(live.net_flows_usdg, -11);
    assert.equal(live.change_excluding_flows_usdg, 10);
    assert.equal(live.return_pct, 10);
    assert.equal(live.max_drawdown_pct, 0, "the held dip to 99 is not a drawdown");
    assert.ok(!live.series.some((p) => p.at === NOW - 3_000 || p.at === NOW - 60), "no held mark is a series point");
    assert.equal(live.attribution.available, true);
    assert.ok(Math.abs(live.attribution.unattributed_usdg ?? NaN) < 1e-9, "the held cash is no baseline, so nothing is left unexplained");
    assert.ok(live.caveats.some((c) => /2 valuation\(s\) in the window were taken while flow inference was held/.test(c)), live.caveats.join(" | "));

    // "Equity now" is the held mark: a true valuation, and the newest one.
    assert.equal((await readLatestMark(db, ledgerScope([ACCOUNT], ACCOUNT, 4663), "live"))?.equity_usdg, 149);
  } finally { raw.close(); }
});

test("a book valued only while held in the window says so, rather than that it was not valued", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, NOW - 90_000, 100, 100, 0);
    await mark(db, NOW - 3_000, 100, 100, 1);
    await mark(db, NOW - 60, 150, 150, 1);
    const live = (await readPerformance(db, ledgerScope([ACCOUNT], ACCOUNT, 4663), "day", NOW)).live;
    assert.equal(live.has_valuation, true);
    assert.equal(live.valued_in_window, false);
    assert.equal(live.return_pct, null);
    assert.equal(live.change_usdg, null);
    assert.ok(live.caveats.some((c) => /taken while flow inference was held/.test(c)), live.caveats.join(" | "));
  } finally { raw.close(); }
});
