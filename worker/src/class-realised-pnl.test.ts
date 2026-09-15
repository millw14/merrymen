/**
 * A CLASS ROUND TRIP MUST RECORD WHAT IT MADE OR LOST.
 *
 * THE STRUCTURAL FAILURE THIS PINS. `kind: "curve-trade"` has TWO executor arms:
 * the CLASS arm, chosen when the intent's target is the sealed `PonsClassVault`,
 * and the ADAPTER arm below it. All the fill attribution — including a long
 * comment about class tokens and `short(token)` keys, written to fix exactly
 * this — lives in the ADAPTER arm, and the adapter arm is the forbidden
 * `PonsSelfTrade` path that `ponsAdapterForSigning` deliberately makes
 * unreachable. So the fix for class basis booking sat in the one branch a class
 * trade can never take.
 *
 * Every class trade this repo has ever made therefore recorded `fill_side` NULL,
 * left its cost basis untouched, and wrote a NULL `realized_pnl_usdg` that
 * `getRealizedPnlUsdg` excludes. Shogun's round trip is the proof: 5.000000 USDG
 * in, 3.226758 back, and a book that recorded neither a gain nor a loss.
 *
 * The orphan-receipt reconciler sees the same transaction and writes a `swap`
 * row for it, but resolves its symbol with `symbolOfToken` alone — `undefined`
 * for a class token by construction, since a launch token postdates the grant —
 * so it books no fill and never will. That row is execution evidence. Teaching
 * it `?? short(token)` would make both arms book the same receipt and
 * double-count it, so it is deliberately left alone and asserted below.
 *
 * REAL NUMBERS THROUGHOUT, from Shogun's own chain history.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { applyFill, type BasisRow } from "./basis";
import { decodeClassLog, CLASS_BUY_TOPIC, CLASS_SELL_TOPIC } from "./venues/class-log";

/** Shogun's position. */
const TOKEN = "0x34d73af0c4e41a727304b7049ff99ca3c953b4af";
const CURVE = "0x7d5369f126d98340d8aa88a80beeb03fc3ccff59";
const QTY = 1_006_167_866_057_921_304_348_465n;
const COST = 5_000_000n; // ClassBuy.quoteIn  — entry tx 0x3d926ce734…
const PROCEEDS = 3_226_758n; // ClassSell.quoteOut — exit tx 0xa8ed38d8aa…

const pad = (hex: string) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");
const word = (v: bigint) => v.toString(16).padStart(64, "0");

/** A real `ClassBuy` log: (quoteIn, tokensOut). */
const buyLog = {
  topics: [CLASS_BUY_TOPIC, pad(CURVE), pad(TOKEN)] as readonly string[],
  data: "0x" + word(COST) + word(QTY),
};
/** A real `ClassSell` log: (tokensIn, quoteOut) — the order is REVERSED. */
const sellLog = {
  topics: [CLASS_SELL_TOPIC, pad(CURVE), pad(TOKEN)] as readonly string[],
  data: "0x" + word(QTY) + word(PROCEEDS),
};

const ZERO: BasisRow = { qtyRaw: 0n, costUsdg: 0n };

describe("the class round trip books exactly one fill and records its result", () => {
  it("THE BUY: the vault's own event gives the basis, not the quote", () => {
    const ev = decodeClassLog(buyLog);
    assert.ok(ev, "a ClassBuy must decode");
    assert.equal(ev!.kind, "buy");
    assert.equal(ev!.token, TOKEN);
    assert.equal(ev!.quoteRaw, COST, "quoteIn is the cash leg");
    assert.equal(ev!.tokenRaw, QTY, "tokensOut is the token leg");

    const r = applyFill(ZERO, {
      side: "buy",
      qtyRaw: ev!.tokenRaw,
      cashUsdg: ev!.quoteRaw,
    });
    assert.equal(r.basis.costUsdg, 5_000_000n, "basis becomes 5.000000 USDG");
    assert.equal(r.basis.qtyRaw, QTY);
    assert.equal(r.basisUnknown, false);
  });

  it("THE SELL: applyFill consumes the basis and realises −1.773242", () => {
    const buy = decodeClassLog(buyLog)!;
    const afterBuy = applyFill(ZERO, {
      side: "buy",
      qtyRaw: buy.tokenRaw,
      cashUsdg: buy.quoteRaw,
    }).basis;

    const sell = decodeClassLog(sellLog)!;
    assert.equal(sell.kind, "sell");
    assert.equal(sell.tokenRaw, QTY, "tokensIn is the token leg");
    assert.equal(sell.quoteRaw, PROCEEDS, "quoteOut is the cash leg — 3.226758");

    const r = applyFill(afterBuy, {
      side: "sell",
      qtyRaw: sell.tokenRaw,
      cashUsdg: sell.quoteRaw,
    });

    assert.equal(r.basisUnknown, false, "a NULL realised P&L is the failure being fixed");
    assert.equal(r.costOutUsdg, 5_000_000n, "the whole cost comes out");
    assert.equal(r.realizedUsdg, -1_773_242n, "3.226758 − 5.000000 = −1.773242 USDG");
    assert.equal(r.basis.qtyRaw, 0n, "and the basis is emptied");
    assert.equal(r.basis.costUsdg, 0n);
  });

  it("THE FAILURE IT REPLACES: no basis means NO result, not a zero one", () => {
    // What actually happened. The sell met an empty basis, `applyFill` returned
    // `basisUnknown`, and `bookFill` wrote NULL rather than a figure — which is
    // correct of it. Booking the proceeds as pure profit would report a loss as
    // a gain.
    const sell = decodeClassLog(sellLog)!;
    const r = applyFill(ZERO, {
      side: "sell",
      qtyRaw: sell.tokenRaw,
      cashUsdg: sell.quoteRaw,
    });
    assert.equal(r.basisUnknown, true);
    assert.equal(r.realizedUsdg, 0n, "and the 0n here is NOT a result — bookFill writes NULL for it");
  });

  it("the buy/sell word order is not interchangeable", () => {
    // ClassBuy is (quoteIn, tokensOut); ClassSell is (tokensIn, quoteOut).
    // Reversed, a memecoin count reads as USDG and the P&L is off by 1e12.
    assert.notEqual(decodeClassLog(buyLog)!.quoteRaw, decodeClassLog(buyLog)!.tokenRaw);
    assert.equal(decodeClassLog(sellLog)!.quoteRaw, PROCEEDS);
    assert.equal(decodeClassLog(buyLog)!.quoteRaw, COST);
  });
});

describe("the executor books it, in the arm a class trade actually takes", () => {
  const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  /** The class arm: `curve-trade` whose target is the sealed vault. */
  const classArm = CODE.slice(
    CODE.indexOf("// ── IS THIS A CLASS TRADE? THE TARGET DECIDES"),
    CODE.indexOf('} else if (intent.kind === "curve-trade") {'),
  );

  it("the CLASS arm sets the fill — this is the whole defect", () => {
    assert.ok(classArm.length > 500, "the class arm must be found");
    assert.match(classArm, /fillPair = \{/, "without this, bookFill is never reached");
    assert.match(classArm, /liveFill = \{/);
    assert.match(classArm, /fillIsFromClassEvent = true;/);
  });

  it("and takes its amounts from the vault's own event, not the intent", () => {
    assert.match(classArm, /decodeClassLog\(l\)/, "the receipt's ClassBuy/ClassSell is the source");
    assert.match(classArm, /qtyRaw: ev\.tokenRaw/);
    assert.match(classArm, /cashUsdg: ev\.quoteRaw/);
    // notionalUsdg was 3.227117 where the event says 3.226758. The quote is not
    // what happened.
    assert.doesNotMatch(classArm, /cashUsdg: intent\.notionalUsdg/);
  });

  it("only this vault's logs are read — a topic is not an authorisation", () => {
    assert.match(classArm, /address\s*\?\?\s*""\)\.toLowerCase\(\) === vault\.toLowerCase\(\)/);
  });

  it("EXACTLY ONE BOOKER: the orphan reconciler still refuses class tokens", () => {
    // It resolves its symbol with `symbolOfToken` alone, which is undefined for
    // a class token, so `bookFill` is skipped there. Teaching it the
    // `?? short(token)` fallback would double-count this receipt.
    const orphan = CODE.slice(CODE.indexOf("if (orphans.length === 0) return;"));
    const head = orphan.slice(0, orphan.indexOf("await bookFill("));
    assert.match(head, /symbolOfToken\(o\.acquired\.token as `0x\$\{string\}`\)/);
    assert.doesNotMatch(head, /\?\?\s*short\(/, "the orphan row is evidence, not an accounting owner");
  });

  it("and the event wins over the receipt-delta re-derivation", () => {
    // The deltas are taken across the account AND the vault so they normally
    // agree — but they diverge exactly when something unrelated moves in the
    // same transaction, and the vault does receive unrelated reward USDG.
    assert.match(CODE, /if \(!fillIsFromClassEvent\) liveFill = measured;/);
  });
});
