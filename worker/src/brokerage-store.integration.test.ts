/**
 * The brokerage columns and book, proven against a REAL sqlite file (a
 * throwaway MERRYMEN_HOME) — the same discipline as the decisions substrate
 * test, because a schema claim that never touched SQLite is a guess.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test
 * runs each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-brk-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, addTrade, getRealizedPnlUsdg, getSpentTodayUsdg, getOpsToday, getBasis, setBasis } =
  await import("./store");
const { homePaths } = await import("./home");
const { brokerAgentId } = await import("./venues/robinhood-id");
const { DatabaseSync } = await import("node:sqlite");

// The store keeps its handle private; raw row assertions open the SAME file.
const rawDb = () => new DatabaseSync(homePaths.db());

const AGENT = brokerAgentId("TESTACCT1");

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("brokerage columns on trades", () => {
  it("order_id and settlement_status round-trip; EVM rows leave them NULL", async () => {
    initStore();
    await addTrade({
      agent_id: AGENT,
      kind: "equity-order",
      target: "AAPL",
      amount_usdg: 100,
      status: "submitted",
      order_id: "RH-ORDER-1",
      settlement_status: "queued_for_open", // the broker's word, verbatim
    });
    await addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0x1111111111111111111111111111111111111111",
      amount_usdg: 50,
      status: "landed",
    });

    const db = rawDb();
    // node:sqlite returns null-prototype row objects; spread to plain objects
    // so deepEqual compares the DATA rather than the prototype chain.
    const rows = (
      db
        .prepare("SELECT status, order_id, settlement_status FROM trades WHERE agent_id = ? ORDER BY id")
        .all(AGENT) as { status: string; order_id: string | null; settlement_status: string | null }[]
    ).map((r) => ({ ...r }));
    db.close();
    assert.deepEqual(rows, [
      { status: "submitted", order_id: "RH-ORDER-1", settlement_status: "queued_for_open" },
      { status: "landed", order_id: null, settlement_status: null },
    ]);
  });

  it("'submitted' counts against the budget seeds — committed money is spent money", async () => {
    // The addTrade rows above: 100 submitted + 50 landed = 150 spent, 2 ops.
    // A restart that forgot the in-flight 100 would let the agent overshoot.
    assert.equal(await getSpentTodayUsdg(AGENT), 150);
    assert.equal(await getOpsToday(AGENT), 2);
  });
});

describe("the 'brokerage' basis book", () => {
  it("realized P&L maps 'brokerage' to landed rows and excludes 'submitted'", async () => {
    await addTrade({
      agent_id: AGENT,
      kind: "equity-order",
      target: "NVDA",
      amount_usdg: 40,
      status: "landed",
      order_id: "RH-ORDER-2",
      settlement_status: "filled",
      realized_pnl_usdg: 7.5,
    });
    await addTrade({
      agent_id: AGENT,
      kind: "equity-order",
      target: "NVDA",
      amount_usdg: 40,
      status: "submitted", // unfilled — has no realized anything
      order_id: "RH-ORDER-3",
      settlement_status: "queued",
      realized_pnl_usdg: 999, // must NOT be summed
    });
    assert.equal(await getRealizedPnlUsdg(AGENT, "brokerage"), 7.5);
  });

  it("the three basis books never bleed into each other", async () => {
    await setBasis(AGENT, "brokerage", "AAPL", { qtyRaw: 5n * 10n ** 17n, costUsdg: 100_000_000n });
    // The same agent+symbol in the other modes stays flat: a custodial fill can
    // never price an on-chain (or simulated) position's sell.
    assert.deepEqual(await getBasis(AGENT, "live", "AAPL"), { qtyRaw: 0n, costUsdg: 0n });
    assert.deepEqual(await getBasis(AGENT, "paper", "AAPL"), { qtyRaw: 0n, costUsdg: 0n });
    assert.deepEqual(await getBasis(AGENT, "brokerage", "AAPL"), { qtyRaw: 500_000_000_000_000_000n, costUsdg: 100_000_000n });
  });
});
