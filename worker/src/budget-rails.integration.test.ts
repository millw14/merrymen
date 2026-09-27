/**
 * The daily budget is TWO books, proven against a real sqlite file (a throwaway
 * MERRYMEN_HOME) — same discipline as the decisions and brokerage tests.
 *
 * These exist because of a real incident. On 2026-07-15 a paper run spent the
 * LIVE 48-op allowance: getOpsToday counted status IN ('landed','paper',
 * 'submitted'), so 48 simulated fills exhausted the cap in 21 minutes and the
 * remaining 11.7 hours of the run are 1,242 identical 'ops-cap' rejections.
 * A unit test could not have caught it — the bug was in a SQL status list.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-rails-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, addTrade, getOpsToday, getSpentTodayUsdg } = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");

const LIVE = "0xliveaccount000000000000000000000000000a";
const PAPER = "0xpaperaccount00000000000000000000000000b";
const AGED = "0xagedaccount000000000000000000000000000c";

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("paper and live budgets are separate books", () => {
  it("a paper fill does not spend the live allowance", async () => {
    initStore();
    for (let i = 0; i < 3; i++) {
      await addTrade({
        agent_id: LIVE,
        kind: "swap",
        target: "0x1111111111111111111111111111111111111111",
        amount_usdg: 10,
        status: "paper",
      });
    }

    // THE REGRESSION: before the rail split this returned 3, and 48 of these
    // would have locked a live agent out of its own budget for a day.
    assert.equal(await getOpsToday(LIVE, "live"), 0);
    assert.equal(await getSpentTodayUsdg(LIVE, "live"), 0);
  });

  it("a live fill does not spend the paper allowance", async () => {
    await addTrade({
      agent_id: PAPER,
      kind: "swap",
      target: "0x2222222222222222222222222222222222222222",
      amount_usdg: 25,
      status: "landed",
    });

    assert.equal(await getOpsToday(PAPER, "paper"), 0);
    assert.equal(await getSpentTodayUsdg(PAPER, "paper"), 0);
  });

  it("paper still counts against its OWN cap — an unbudgeted paper run proves nothing", async () => {
    // The point of paper mode is that it behaves like live. Separating the
    // books must not mean paper trades for free.
    assert.equal(await getOpsToday(LIVE, "paper"), 3);
    assert.equal(await getSpentTodayUsdg(LIVE, "paper"), 30);
  });

  it("defaults to the live rail, so an unqualified call is the conservative one", async () => {
    assert.equal(await getOpsToday(PAPER), 1);
    assert.equal(await getSpentTodayUsdg(PAPER), 25);
  });

  it("'submitted' is live money — an in-flight order still holds its slot", async () => {
    await addTrade({
      agent_id: PAPER,
      kind: "equity-order",
      target: "AAPL",
      amount_usdg: 75,
      status: "submitted",
    });
    assert.equal(await getOpsToday(PAPER, "live"), 2);
    assert.equal(await getSpentTodayUsdg(PAPER, "live"), 100);
  });

  it("rejected rows are not spend on either rail", async () => {
    await addTrade({
      agent_id: AGED,
      kind: "swap",
      target: "0x3333333333333333333333333333333333333333",
      amount_usdg: 999,
      status: "rejected",
      reject_rule: "ops-cap",
    });
    assert.equal(await getOpsToday(AGED, "live"), 0);
    assert.equal(await getOpsToday(AGED, "paper"), 0);
    assert.equal(await getSpentTodayUsdg(AGED, "live"), 0);
  });

  it("a router-migrated skip costs nothing — which is what makes recording it the fix", async () => {
    // The Rialto router-migration branch used to `return` bare from inside the
    // execution try, reaching neither release path and pinning an op in
    // inFlightOps for the life of the arm. It now writes this row instead, and
    // recordTrade's release is what unwinds the reservation.
    //
    // That only works while 'rejected' stays off both rails: if it ever became
    // spend, every skipped swap would start charging the owner's daily
    // allowance for a trade that never happened. This is the fix's guard rail,
    // not a restatement of the case above.
    await addTrade({
      agent_id: AGED,
      kind: "swap",
      target: "0x4444444444444444444444444444444444444444",
      amount_usdg: 25,
      status: "rejected",
      reject_rule: "router-migrated",
    });
    assert.equal(await getOpsToday(AGED, "live"), 0);
    assert.equal(await getOpsToday(AGED, "paper"), 0);
    assert.equal(await getSpentTodayUsdg(AGED, "live"), 0);
    assert.equal(await getSpentTodayUsdg(AGED, "paper"), 0);
  });
});

describe("the budget window actually rolls", () => {
  it("an op older than 24h stops counting — no restart required", async () => {
    await addTrade({
      agent_id: AGED,
      kind: "swap",
      target: "0x4444444444444444444444444444444444444444",
      amount_usdg: 40,
      status: "landed",
    });
    assert.equal(await getOpsToday(AGED, "live"), 1);

    // created_at is DB-stamped, so age it directly. This is what the worker's
    // per-tick re-read sees once the op falls out of the trailing window — the
    // in-memory counter used to be seeded once at arm time and only ever climb,
    // so a worker that reached the cap stayed there until it was restarted.
    const db = new DatabaseSync(homePaths.db());
    db.prepare(
      "UPDATE trades SET created_at = unixepoch() - 86_401 WHERE agent_id = ? AND status = 'landed'",
    ).run(AGED);
    db.close();

    assert.equal(await getOpsToday(AGED, "live"), 0);
    assert.equal(await getSpentTodayUsdg(AGED, "live"), 0);
  });
});

describe("a sell into cash spends nothing", () => {
  const TRADER = "0xroundtrip00000000000000000000000000000d";
  const USDG = "0xUSDGUSDGUSDGUSDGUSDGUSDGUSDGUSDGUSDGUSDG";
  const TOKEN = "0x5555555555555555555555555555555555555555";

  it("a round trip draws the budget down by the buy only", async () => {
    // Buy 5 USDG of a token, sell it back for 6. policy.ts exempts the sell
    // from the daily-cap check because it spends nothing; the settled sum used
    // to add its proceeds anyway, so this read 11 and the next buys were
    // refused with more than half the day's allowance never spent.
    await addTrade({ agent_id: TRADER, kind: "swap", target: TOKEN, sell_token: USDG, buy_token: TOKEN, amount_usdg: 5, status: "landed" });
    await addTrade({ agent_id: TRADER, kind: "swap", target: TOKEN, sell_token: TOKEN, buy_token: USDG, amount_usdg: 6, status: "landed" });
    await addTrade({ agent_id: TRADER, kind: "curve-trade", target: TOKEN, sell_token: TOKEN, buy_token: USDG.toLowerCase(), amount_usdg: 2, status: "landed" });

    assert.equal(await getSpentTodayUsdg(TRADER, "live", USDG), 5);
    // Every one of them is still an op: the ops cap is not a spend.
    assert.equal(await getOpsToday(TRADER, "live"), 3);
    // Without the cash token the old, conservative sum is unchanged.
    assert.equal(await getSpentTodayUsdg(TRADER, "live"), 13);
  });
});
