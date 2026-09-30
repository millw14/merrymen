/**
 * Fail-closed spend writes: addTrade / setAgentHwm / addFeeAccrual now REPORT
 * whether they persisted instead of swallowing the failure into a console.error.
 *
 * The report is what lets processIntent keep a money-moving fill's spend counted
 * when its ledger row does not land — a swallowed failure under-counts
 * getSpentTodayUsdg and loosens the daily cap, the unsafe direction. This proves
 * the signal at the store boundary: a good write returns true, a write that
 * throws (a NOT NULL violation on the money-moving path) returns false.
 *
 * MERRYMEN_HOME is a throwaway temp db; node's --test isolates the process.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-failclose-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, addTrade, setAgentHwm, addFeeAccrual } = await import("./store");

const A = "0x00000000000000000000000000000000000000a1";

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("spend writes report success/failure instead of swallowing", () => {
  it("addTrade returns true when a money-moving row is persisted", async () => {
    initStore();
    const ok = await addTrade({
      agent_id: A,
      kind: "swap",
      target: "0x0000000000000000000000000000000000000001",
      amount_usdg: 25,
      status: "landed",
    });
    assert.equal(ok, true);
  });

  it("addTrade returns FALSE when a money-moving write fails (target is NOT NULL)", async () => {
    // A landed row with a null target violates the NOT NULL constraint — the
    // insert throws, addTrade catches it, and now RETURNS FALSE rather than
    // pretending the fill was recorded. This is the signal processIntent needs
    // to keep the spend counted.
    const ok = await addTrade({
      agent_id: A,
      kind: "swap",
      target: null as unknown as string,
      amount_usdg: 25,
      status: "landed",
    });
    assert.equal(ok, false, "a dropped money-moving row must report false, not be swallowed");
  });

  it("setAgentHwm and addFeeAccrual report success on a good write", async () => {
    assert.equal(await setAgentHwm(A, 123.45), true);
    assert.equal(
      await addFeeAccrual(A, { profitUsdg: 10, feeUsdg: 1, hwmBeforeUsdg: 100, hwmAfterUsdg: 110 }),
      true,
    );
  });
});
