/**
 * A READING TAKEN MID-HOLD IS NEVER TELEGRAM'S P&L.
 *
 * A tick whose flow look held (an operation the resolver may still settle was
 * in flight) writes its equity row flagged `flows_held` (store.ts). Its cash
 * can carry an owner's withdrawal the flows table has not booked yet, so /pnl,
 * /report and /brag set that reading against the flows and called the owner's
 * own money a loss until the hold ended — up to 26 hours for a dropped op. The
 * figures now end at the newest measured reading and subtract only what was
 * booked by then (held-marks.ts); "equity" still says what the book is worth
 * now, held reading and all.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-pnl-held-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore } = await import("../store");
const { readBrag, readPnl, readReport } = await import("./reads");
const { DatabaseSync } = await import("node:sqlite");
const { homePaths } = await import("../home");

const ACCT = "0x0000000000000000000000000000000000c0ffee";
/** Inside today whatever the hour the suite runs at: the report's "today" is since local midnight. */
const T = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() / 1000) + 100;

function ctx() {
  return { agentId: ACCT, name: "Held", strategy: "steady-basket", venue: "uniswap", paused: false, workerAliveSec: 5, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 };
}

function withDb(fn: (db: InstanceType<typeof DatabaseSync>) => void): void {
  const db = new DatabaseSync(homePaths.db());
  try {
    fn(db);
  } finally {
    db.close();
  }
}
function mark(at: number, equity: number, held: number, mode = "live"): void {
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, at)
         VALUES (?, '0', ?, 0, 0, ?, 2, ?, ?, ?)`,
      )
      .run(ACCT, equity, equity, mode, held, at),
  );
}
function flow(at: number, direction: "in" | "out", amount: number): void {
  withDb((db) =>
    db
      .prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, at, epoch) VALUES (?, ?, ?, 'chain-log', ?, 2)")
      .run(ACCT, direction, amount, at),
  );
}
function reset(): void {
  withDb((db) => db.exec("DELETE FROM equity; DELETE FROM flows;"));
}

before(() => {
  initStore();
  withDb((db) =>
    db
      .prepare(
        "INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, epoch) VALUES (?, 'o', 's', 4663, '{}', 0, 0, 2)",
      )
      .run(ACCT),
  );
});

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a held dip is no P&L on Telegram", () => {
  it("/pnl, /report and /brag end at the newest measured reading; equity is still the held one", () => {
    reset();
    flow(T + 5, "in", 100);
    mark(T + 10, 100, 0);
    mark(T + 20, 110, 0); // +10 of trading
    // The owner took 50 out; the tick that saw it held, and nothing is booked yet.
    mark(T + 30, 60, 1);

    const pnl = readPnl(ACCT);
    assert.match(pnl, /change: \$10\.00 \(\+10\.00%\)/, pnl);
    assert.match(pnl, /equity \$110\.00 · you put in \$100\.00/, pnl);
    assert.match(pnl, /equity now \$60\.00 — read while a deposit, withdrawal or purchase was still settling/, pnl);
    assert.doesNotMatch(pnl, /change: −\$40/, "the owner's own withdrawal is not a loss");

    const report = readReport(ctx());
    assert.match(report, /equity: <b>60\.00 USDG<\/b>/, "what the book is worth now");
    // The deposit booked before the day's first reading is already in it.
    assert.match(report, /today: 📈 \$10\.00 \(\+10\.00%\)/, report);
    assert.match(report, /all-time: 📈 \$10\.00 \(\+10\.00%\)/, report);
    assert.doesNotMatch(report, /−\$40|−\$90/, report);
    const pub = readReport(ctx(), true);
    assert.match(pub, /today: 📈 \(\+10\.00%\)/, pub);

    const brag = readBrag(ctx());
    assert.match(brag, /P&amp;L: <b>\$10\.00<\/b> \(\+10\.00%\)/, brag);
    assert.match(brag, /equity: 60\.00 USDG/, brag);
  });

  it("a withdrawal booked during the hold is not taken off the reading from before it", () => {
    reset();
    flow(T + 5, "in", 100);
    mark(T + 10, 100, 0);
    mark(T + 20, 110, 0);
    mark(T + 30, 60, 1);
    flow(T + 35, "out", 50); // the resolver books it; the next look still holds
    mark(T + 40, 60, 1);
    const pnl = readPnl(ACCT);
    // Against every flow on record it would be 110 − 50 = +60, a gain that never happened.
    assert.match(pnl, /change: \$10\.00 \(\+10\.00%\)/, pnl);
    assert.match(pnl, /you put in \$100\.00/, pnl);

    // The hold ends: the next reading is measured, and the withdrawal is in both.
    mark(T + 50, 60, 0);
    const after = readPnl(ACCT);
    assert.match(after, /change: \$10\.00 \(\+20\.00%\)/, after);
    assert.match(after, /equity \$60\.00 · you put in \$50\.00/, after);
    assert.doesNotMatch(after, /equity now/, "nothing newer than the measured reading");
    assert.match(readReport(ctx()), /today: 📈 \$10\.00/);
  });

  it("a book whose every reading so far was held has no P&L yet — and never borrows the other book's", () => {
    reset();
    flow(T + 5, "in", 100);
    mark(T + 10, 1_000, 0, "paper");
    mark(T + 20, 1_010, 0, "paper");
    mark(T + 30, 60, 1); // the first live reading, held
    const pnl = readPnl(ACCT);
    assert.match(pnl, /equity: \$60\.00/, pnl);
    assert.match(pnl, /change: not measurable yet — every reading of this book so far was taken while/, pnl);
    assert.doesNotMatch(pnl, /change: [−$]/, pnl);
    const report = readReport(ctx());
    assert.match(report, /today: not measured yet/, report);
    assert.match(report, /all-time: not measured yet/, report);
    assert.match(readBrag(ctx()), /nothing to brag about just yet/);
  });

  it("a ledger without the column held nothing: its newest reading is measured as before", () => {
    reset();
    withDb((db) => db.exec("ALTER TABLE equity DROP COLUMN flows_held"));
    flow(T + 5, "in", 100);
    withDb((db) =>
      db
        .prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at) VALUES (?, '0', 90, 0, 0, 90, 2, 'live', ?)")
        .run(ACCT, T + 10),
    );
    assert.match(readPnl(ACCT), /change: −\$10\.00 \(-10\.00%\)/);
  });
});
