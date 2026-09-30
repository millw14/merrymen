/**
 * EVERY SELL THE FLEET EVER MADE RECORDED `realised NOT RECORDED`.
 *
 * Both venues, both tenants, for the life of the product. The fill itself was
 * booked correctly — `fill_side = sell`, `basis_source = receipt` — and
 * `realized_pnl_usdg` sat NULL beside it. The only row in the fleet carrying a
 * realised figure was written by an operator repair tool, never by the live
 * path.
 *
 * THE CAUSE WAS ORDER, not arithmetic. `applyFill` and `bookFill` were each
 * correct in isolation: read basis → compute → write. But on the class path the
 * executor calls `reconcileClassFromChain` immediately after the sell lands, so
 * the vault reads empty, `restoreClassCostBasis` clears the position's basis as
 * stranded, and `bookFill` runs ~316 lines later against `{0n, 0n}`.
 * `applyFill` then reports `basisUnknown` — correctly, for a sell with nothing
 * on the books — and the realised figure is dropped.
 *
 * WHY NO TEST CAUGHT IT. `index.ts` has no top-level exports: `bookFill` is a
 * closure inside `main()` and the booking sequence lives inside
 * `processIntentLocked`. So every existing test either re-implements the body
 * by hand or matches the file as source text. `class-realised-pnl.test.ts`
 * passes to this day because it seeds the basis and sells in one expression,
 * never letting a reconcile run between them — it proves the arithmetic, which
 * was never what was broken.
 *
 * These tests drive the REAL sequence over a REAL sqlite store, with the
 * clearing path given its actual chance to run.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { applyFill } from "./basis";
import { PendingBasis, realisedForFill } from "./basis-order";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-pnl-order-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, getBasis, setBasis } = await import("./store");
await initStore();
after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";
const usdg = (n: number) => BigInt(Math.round(n * 1e6));

/**
 * The real booking sequence, as `bookFill` performs it: read the stored basis,
 * apply the fill, persist the new basis, and decide realised from the result.
 * Deliberately NOT a hand-seeded basis — the whole defect was what the store
 * held at the moment of the read.
 */
async function book(
  key: string,
  f: { side: "buy" | "sell"; qtyRaw: bigint; cashUsdg: bigint },
): Promise<{ realised: bigint | null; basisUnknown: boolean }> {
  const prev = await getBasis(AGENT, "live", key);
  const r = applyFill(prev, f);
  await setBasis(AGENT, "live", key, r.basis);
  return { realised: realisedForFill(f.side, r.basisUnknown, r.realizedUsdg), basisUnknown: r.basisUnknown };
}

/** What `restoreClassCostBasis` does when the chain says the position is gone. */
async function clearStranded(key: string, guard: PendingBasis, token: string): Promise<boolean> {
  if (!guard.mayClear(token)) return false;
  const left = await getBasis(AGENT, "live", key);
  if (left.qtyRaw > 0n || left.costUsdg > 0n) {
    await setBasis(AGENT, "live", key, { qtyRaw: 0n, costUsdg: 0n });
    return true;
  }
  return false;
}

describe("an ordinary swap: BUY creates the basis, SELL reads it and books realised", () => {
  it("writes realised P&L from the basis the buy created", async () => {
    const KEY = "TSLA";
    const buy = await book(KEY, { side: "buy", qtyRaw: 10n * 10n ** 18n, cashUsdg: usdg(100) });
    assert.equal(buy.realised, null, "a buy realises nothing");

    // The buy must actually be on the books — the read is the thing that broke.
    const held = await getBasis(AGENT, "live", KEY);
    assert.equal(held.qtyRaw, 10n * 10n ** 18n);
    assert.equal(held.costUsdg, usdg(100));

    const sell = await book(KEY, { side: "sell", qtyRaw: 10n * 10n ** 18n, cashUsdg: usdg(88) });
    assert.equal(sell.basisUnknown, false);
    assert.equal(sell.realised, usdg(-12), "88 out against 100 in is a 12 USDG loss");

    // CONSUMED BY THE FILL, not by a sweep. setBasis deletes at zero.
    const after_ = await getBasis(AGENT, "live", KEY);
    assert.equal(after_.qtyRaw, 0n);
    assert.equal(after_.costUsdg, 0n);
  });

  it("AND IF A SWEEP CLEARS FIRST, the realised figure is lost — the defect", async () => {
    const KEY = "NVDA";
    await book(KEY, { side: "buy", qtyRaw: 4n * 10n ** 18n, cashUsdg: usdg(40) });

    // An unguarded clear between the landing and the booking.
    const wide = new PendingBasis();
    assert.equal(await clearStranded(KEY, wide, "0xnvda"), true, "an unguarded sweep clears it");

    const sell = await book(KEY, { side: "sell", qtyRaw: 4n * 10n ** 18n, cashUsdg: usdg(33) });
    assert.equal(sell.basisUnknown, true);
    assert.equal(sell.realised, null, "this is exactly what production recorded");
  });
});

describe("a class-vault round trip, with the reconcile that broke it", () => {
  /** Shogun's real position: 5.000000 USDG in, 1120808.001896442602470951 out. */
  const KEY = "0x5b87…6983";
  const TOKEN = "0x5b87957b9de0817994175faa089697d85f176983";
  const QTY = 1120808001896442602470951n;

  it("SHOGUN'S ACTUAL ROUND TRIP — realised is written from the real ClassSell proceeds", async () => {
    const guard = new PendingBasis();
    await book(KEY, { side: "buy", qtyRaw: QTY, cashUsdg: usdg(5) });

    // The sell lands. The executor holds the basis, THEN reconciles — which is
    // the ordering the fix introduces.
    guard.hold(TOKEN);
    const cleared = await clearStranded(KEY, guard, TOKEN);
    assert.equal(cleared, false, "the reconcile must not clear a basis a fill still owes");

    // proceeds are the chain's own ClassSell.quoteOut, never the intent notional.
    const sell = await book(KEY, { side: "sell", qtyRaw: QTY, cashUsdg: 3595457n });
    guard.release(TOKEN);

    assert.equal(sell.basisUnknown, false);
    assert.equal(sell.realised, -1404543n, "5.000000 in, 3.595457 out → -1.404543");
    const after_ = await getBasis(AGENT, "live", KEY);
    assert.equal(after_.qtyRaw, 0n, "and the basis is consumed by the fill");
    assert.equal(after_.costUsdg, 0n);
  });

  it("DAVE'S ACTUAL ROUND TRIP — the same, on his own figures", async () => {
    const dKey = "0x5b87…dave";
    const dQty = 1123748892700284940866132n;
    const guard = new PendingBasis();
    await book(dKey, { side: "buy", qtyRaw: dQty, cashUsdg: usdg(5) });
    guard.hold(TOKEN);
    assert.equal(await clearStranded(dKey, guard, TOKEN), false);
    const sell = await book(dKey, { side: "sell", qtyRaw: dQty, cashUsdg: 3613002n });
    guard.release(TOKEN);
    assert.equal(sell.realised, -1386998n, "5.000000 in, 3.613002 out → -1.386998");
  });

  it("THE OLD ORDER REPRODUCED — clear first, and realised is gone", async () => {
    // The bug as it shipped: nothing holds the basis, the reconcile clears it,
    // and the fill that follows has nothing to measure against.
    const oKey = "0x5b87…old";
    const wide = new PendingBasis();
    await book(oKey, { side: "buy", qtyRaw: QTY, cashUsdg: usdg(5) });
    assert.equal(await clearStranded(oKey, wide, TOKEN), true);
    const sell = await book(oKey, { side: "sell", qtyRaw: QTY, cashUsdg: 3595457n });
    assert.equal(sell.realised, null, "the production symptom, reproduced");
  });

  it("the hold is DEFERRAL, not exemption — the next pass still clears", async () => {
    // A fill that never books must not leave a basis unclearable for ever.
    const sKey = "0x5b87…stuck";
    const guard = new PendingBasis();
    await book(sKey, { side: "buy", qtyRaw: QTY, cashUsdg: usdg(5) });
    guard.hold(TOKEN);
    assert.equal(await clearStranded(sKey, guard, TOKEN), false, "held on this pass");
    guard.release(TOKEN); // the executor's `finally`, even on a throw
    assert.equal(await clearStranded(sKey, guard, TOKEN), true, "cleared on the next");
    assert.equal(guard.size, 0);
  });

  it("and the hold is scoped to ONE token, never a blanket stand-down", async () => {
    const guard = new PendingBasis();
    guard.hold(TOKEN);
    assert.equal(guard.mayClear(TOKEN), false);
    assert.equal(guard.mayClear("0x1111111111111111111111111111111111111111"), true);
    assert.equal(guard.mayClear(TOKEN.toUpperCase()), false, "address casing must not defeat it");
    assert.equal(guard.mayClear(null), true, "nothing to hold is not a hold");
  });
});

describe("realisedForFill mirrors the rule bookFill applies", () => {
  it("a buy realises nothing", () => {
    assert.equal(realisedForFill("buy", false, 500n), null);
  });
  it("an unbacked sell realises nothing — a cost we cannot defend is not zero", () => {
    assert.equal(realisedForFill("sell", true, 0n), null);
  });
  it("a backed sell realises its figure, including a loss", () => {
    assert.equal(realisedForFill("sell", false, -1404543n), -1404543n);
    assert.equal(realisedForFill("sell", false, 250n), 250n);
  });
  it("and a backed sell that broke exactly even records 0, not NULL", () => {
    // The distinction the whole column exists for: a measured zero is a
    // result, an absent figure is not.
    assert.equal(realisedForFill("sell", false, 0n), 0n);
  });
});
