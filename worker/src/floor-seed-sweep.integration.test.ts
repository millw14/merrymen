/**
 * A RESTORED FLOOR GOES WHEN ITS POSITION DOES.
 *
 * The floor seed (basis-seed.ts seedPositionFloors) puts a graded stop back only
 * beside a cost the basis seed restored, because that pairing is the only thing
 * that ever removes a floor: store.ts setBasis drops it with a basis that goes
 * to zero, and the stranded sweep (index.ts) finds what the chain no longer
 * holds by walking basis rows (custody.ts strandedBasisSymbols).
 *
 * This drives that over the REAL store. Shared still shows a position the
 * account has since sold, so both seeds put it back; the first tick reads it
 * flat; and the floor must be gone before the next entry in that symbol is
 * graded, or that entry inherits the stale level — setPositionFloor never
 * overwrites. A floor restored with no basis beside it failed exactly here: the
 * sweep never saw it, and the new entry ran on the old, wider stop.
 *
 * MERRYMEN_HOME is set before the store import; node's --test runs each file in
 * its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-floor-seed-"));
process.env.MERRYMEN_HOME = HOME;

const { DatabaseSync } = await import("node:sqlite");
const { wrapSqlite } = await import("./db");
const { basisSymbols, closeStoreForTest, initStore, positionFloors, setBasis, setPositionFloor } = await import("./store");
const { strandedBasisSymbols } = await import("./custody");
const { seedPositionFloors } = await import("./basis-seed");

/** As a grant spells it: the store reads by exactly this. */
const ACCOUNT = "0xA96bF429888E1aAB4255762d17d29c53F6A0370D";

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a restored floor is swept with its basis", () => {
  it("restored → the chain reads it flat → both gone → the next entry is graded fresh", async () => {
    await initStore();
    // Shared: a wide floor from an entry the account has since sold.
    const sharedRaw = new DatabaseSync(":memory:");
    sharedRaw.exec(
      "CREATE TABLE position_floors (agent_id TEXT, mode TEXT, symbol TEXT, stop_bps INTEGER, rung TEXT," +
        " why TEXT, at INTEGER, PRIMARY KEY (agent_id, mode, symbol));",
    );
    sharedRaw
      .prepare(`INSERT INTO position_floors VALUES (?, 'live', 'PEPE', 3500, 'wide', 'old entry', 100)`)
      .run(ACCOUNT);

    // The basis seed's half, as it lands: the cost goes back into the child.
    await setBasis(ACCOUNT, "live", "PEPE", { qtyRaw: 5n, costUsdg: 50_000_000n });
    // The floor seed's, over the child's own file — the orchestrator opens it
    // the same way (seedBasisForChild).
    const childRaw = new DatabaseSync(path.join(HOME, "merrymen.db"));
    try {
      const plan = await seedPositionFloors({
        child: wrapSqlite(childRaw),
        shared: wrapSqlite(sharedRaw),
        account: ACCOUNT,
        restored: [{ mode: "live", symbol: "PEPE" }],
        mayWrite: () => null,
      });
      assert.equal(plan.rows.length, 1);
    } finally {
      childRaw.close();
    }
    assert.equal((await positionFloors(ACCOUNT, "live")).get("PEPE")?.stopBps, 3500, "back where the child reads it");

    // ── the first tick: PEPE was looked at and is not held ──────────────────
    const stranded = strandedBasisSymbols({
      basisSymbols: await basisSymbols(ACCOUNT, "live"),
      positions: [],
      unpricedByDesign: [],
      missingPrice: [],
      classHeld: [],
      classReadOk: true,
      watched: ["PEPE"],
    });
    assert.deepEqual(stranded, ["PEPE"], "the sweep finds it, because a basis sits beside the floor");
    // What index.ts does with each one.
    for (const symbol of stranded) await setBasis(ACCOUNT, "live", symbol, { qtyRaw: 0n, costUsdg: 0n });
    assert.equal((await positionFloors(ACCOUNT, "live")).size, 0, "the floor went with its basis");

    // ── a later entry in the same symbol, graded on its own ─────────────────
    await setPositionFloor(ACCOUNT, "live", "PEPE", { stopBps: 1200, rung: "tight", why: "new entry" });
    assert.deepEqual((await positionFloors(ACCOUNT, "live")).get("PEPE"), { stopBps: 1200, rung: "tight", why: "new entry" });
  });
});
