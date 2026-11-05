/**
 * THE UNREAD-BALANCE GUARD, DRIVEN THROUGH THE LOOKUP THE TICK ACTUALLY PASSES.
 *
 * When a watched token's balance row fails, the coin counts as held if the
 * books say we hold it (custody.ts unreadHeldOnRecord), and a lookup that fails
 * counts as "we hold it". A held one makes the book incomplete and refuses
 * every new buy (unread-held.ts; policy.ts holding-unread); it no longer holds
 * the whole tick, which switched off every exit. The fail-closed half is only
 * real if the lookup can fail: store.ts getBasis catches every query error and
 * answers zero, so with getBasis as the callback a database error read as
 * "nothing on record", the held token dropped out of the book as if sold, and
 * the tick could publish equity without it.
 *
 * So this runs `openBasisQty` — the tick's own callback — over a real sqlite
 * ledger: an open row, a missing row, and a query that genuinely fails.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-unread-basis-"));
process.env.MERRYMEN_HOME = HOME;

const { DatabaseSync } = await import("node:sqlite");
const { closeStoreForTest, getBasis, initStore, openBasisQty, setBasis } = await import("./store");
const { unreadHeldOnRecord } = await import("./custody");

const ACCOUNT = "0x8e93ba0000000000000000000000000000000001";
/** The tick's callback, character for character (pinned below against index.ts). */
const tickLookup = (symbol: string) => openBasisQty(ACCOUNT, "live", symbol);

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the unread-balance guard over a real ledger", () => {
  it("an open basis counts as held; a missing one does not", async () => {
    await initStore();
    await setBasis(ACCOUNT, "live", "GATO", { qtyRaw: 2_842n * 10n ** 18n, costUsdg: 2_500_000n });
    assert.deepEqual(await unreadHeldOnRecord(["GATO", "NEVERHELD"], tickLookup), ["GATO"]);
  });

  it("a FAILED QUERY counts as held, where getBasis would have answered zero", async () => {
    // A real failure, not a stub: the table is dropped under the store's open
    // file, so the store's own prepare throws "no such table".
    const raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
    try {
      raw.exec("DROP TABLE cost_basis");
    } finally {
      raw.close();
    }
    // The reason the callback had to change: getBasis swallows it.
    assert.deepEqual(await getBasis(ACCOUNT, "live", "GATO"), { qtyRaw: 0n, costUsdg: 0n });
    await assert.rejects(openBasisQty(ACCOUNT, "live", "GATO"));
    // And the guard, given the throwing lookup, fails closed on every symbol.
    assert.deepEqual(await unreadHeldOnRecord(["GATO", "NEVERHELD"], tickLookup), ["GATO", "NEVERHELD"]);
  });

  it("the tick passes exactly this lookup", () => {
    const SRC = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(SRC, /unreadHeldOnRecord\(unreadPositions, \(symbol\) => openBasisQty\(agentId, "live", symbol\)\)/);
  });
});
