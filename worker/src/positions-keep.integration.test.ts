/**
 * AN UNREAD HOLDING KEEPS ITS LAST ROW.
 *
 * setPositions replaces the agent's holdings and deletes every symbol not in
 * this tick's list. A held coin whose balance did not read is not in that list
 * — it is out of the tick's book until it reads (unread-held.ts) — so the
 * prune would delete it: the dashboard and Telegram would say it is gone, the
 * mirror would spread that, and a container rebuild would not re-seed its
 * basis. `keep` names those coins, and their rows stand untouched.
 *
 * Over a real sqlite ledger, as the tick writes it.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-positions-keep-"));
process.env.MERRYMEN_HOME = HOME;

const { DatabaseSync } = await import("node:sqlite");
const { closeStoreForTest, initStore, setPositions } = await import("./store");

const A = "0x8e93ba0000000000000000000000000000000001";
const B = "0x8e93ba0000000000000000000000000000000002";
const row = (symbol: string, valueUsdg: number, rawBalance = 10n ** 18n) => ({
  symbol,
  token: "0x0000000000000000000000000000000000000001",
  rawBalance,
  uiMultiplier: 10n ** 18n,
  priceUsd: 1,
  priceStale: false,
  priceSource: "chainlink",
  valueUsdg,
});

type Stored = { symbol: string; raw_balance: string; value_usdg: number; updated_at: number };
const rowsOf = (agentId: string): Stored[] => {
  const db = new DatabaseSync(path.join(HOME, "merrymen.db"));
  try {
    return db
      .prepare("SELECT symbol, raw_balance, value_usdg, updated_at FROM positions WHERE agent_id = ? ORDER BY symbol")
      .all(agentId) as Stored[];
  } finally {
    db.close();
  }
};
/** Age a row, so an overwrite would show in `updated_at` and not only in the value. */
const age = (agentId: string, symbol: string) => {
  const db = new DatabaseSync(path.join(HOME, "merrymen.db"));
  try {
    db.prepare("UPDATE positions SET updated_at = 1000 WHERE agent_id = ? AND symbol = ?").run(agentId, symbol);
  } finally {
    db.close();
  }
};

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("setPositions keeps the rows of what could not be read", () => {
  it("A KEPT SYMBOL'S ROW STANDS EXACTLY AS IT WAS — not pruned, not rewritten — while the rest is replaced", async () => {
    await initStore();
    await setPositions(A, [row("AAPL", 10), row("GATO", 25, 2_842n * 10n ** 18n)]);
    await setPositions(B, [row("TSLA", 7)]);
    age(A, "GATO");
    // GATO's balance did not read this tick, so it is not in the list — and,
    // even if a caller passed it, a kept row is not overwritten.
    await setPositions(A, [row("AAPL", 12), row("GATO", 0.01, 1n)], ["GATO"]);
    const rows = rowsOf(A);
    assert.deepEqual(rows.map((r) => r.symbol), ["AAPL", "GATO"]);
    const gato = rows.find((r) => r.symbol === "GATO")!;
    assert.equal(gato.raw_balance, (2_842n * 10n ** 18n).toString(), "its last read balance");
    assert.equal(gato.value_usdg, 25);
    assert.equal(gato.updated_at, 1000, "its age is the truth about how old it is");
    assert.equal(rows.find((r) => r.symbol === "AAPL")!.value_usdg, 12, "a read holding is replaced as before");
  });

  it("with nothing kept, the prune is exactly today's: a symbol not in the list is deleted", async () => {
    await setPositions(A, [row("AAPL", 13)]);
    assert.deepEqual(rowsOf(A).map((r) => r.symbol), ["AAPL"]);
    // And an empty list with something kept deletes everything but it.
    await setPositions(A, [row("AAPL", 13), row("GATO", 25)]);
    await setPositions(A, [], ["GATO"]);
    assert.deepEqual(rowsOf(A).map((r) => r.symbol), ["GATO"]);
  });

  it("ONE TENANT'S KEEP NEVER TOUCHES ANOTHER'S ROWS", async () => {
    assert.deepEqual(rowsOf(B).map((r) => [r.symbol, r.value_usdg]), [["TSLA", 7]]);
    await setPositions(B, [], ["GATO"]);
    assert.deepEqual(rowsOf(B), [], "B held no GATO; keeping it keeps nothing of A's");
    assert.deepEqual(rowsOf(A).map((r) => r.symbol), ["GATO"]);
  });
});
