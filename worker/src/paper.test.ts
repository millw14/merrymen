import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPaperIntent, paperEquityUsdg, type PaperBook, type PaperPosition } from "./paper";
import type { TradeIntent } from "./policy";
import { applyFill, ZERO_BASIS } from "./basis";

const USDG = "0x0000000000000000000000000000000000000001" as `0x${string}`;
const QQQ = "0x0000000000000000000000000000000000000002" as `0x${string}`;
const ROUTER = "0x0000000000000000000000000000000000000003" as `0x${string}`;

const priceUsdOf = (t: `0x${string}`) => (t === QQQ ? { priceUsd: 500, stale: false } : null);
const symbolOf = (t: `0x${string}`) => (t === QQQ ? "QQQ" : null);
const OPTS = { priceUsdOf, symbolOf, usdgAddress: USDG, slippageBps: 100, notionalUsdg: 100 };

const buy = (n: number): TradeIntent => ({
  kind: "swap", target: ROUTER, sellToken: USDG, buyToken: QQQ, sellAmountRaw: 0n, notionalUsdg: 0n,
});
const book = (): PaperBook => ({ cashUsdg: 1000, vaultUsdg: 0, hwmUsdg: 0 });

describe("paper fills — the loop with zero funds", () => {
  it("a priced memecoin round trip realizes the same gain or loss as its cash ledger", () => {
    for (const exitPrice of [0.012, 0.008]) {
      const bought = applyPaperIntent(buy(10), book(), [], {
        ...OPTS, notionalUsdg: 10, symbolOf: () => "MEME",
        priceUsdOf: () => ({ priceUsd: 0.01, stale: false }),
      });
      assert.equal(bought.ok, true);
      const purchase = applyFill(ZERO_BASIS, {
        side: "buy", qtyRaw: BigInt(Math.round(bought.fill!.rawShares * 1e18)), cashUsdg: 10_000_000n,
      });
      const sold = applyPaperIntent({ ...buy(100), sellToken: QQQ, buyToken: USDG } as TradeIntent, bought.book, bought.positions, {
        ...OPTS, notionalUsdg: 100, symbolOf: () => "MEME",
        priceUsdOf: () => ({ priceUsd: exitPrice, stale: false }),
      });
      assert.equal(sold.ok, true);
      const sale = applyFill(purchase.basis, {
        side: "sell", qtyRaw: BigInt(Math.round(sold.fill!.rawShares * 1e18)),
        cashUsdg: BigInt(Math.round(sold.fill!.cashUsdg * 1e6)),
      });
      assert.equal(sale.basisUnknown, false);
      assert.equal(sale.basis.qtyRaw, 0n);
      assert.equal(sold.positions.length, 0);
      assert.equal(Math.round((sold.book.cashUsdg - book().cashUsdg) * 1e6), Number(sale.realizedUsdg));
      assert.equal(sale.realizedUsdg > 0n, exitPrice > 0.01);
    }
  });
  it("buys at the live price with slippage friction, debits cash", () => {
    const r = applyPaperIntent(buy(100), book(), [], { ...OPTS, notionalUsdg: 100 });
    assert.equal(r.ok, true);
    assert.equal(r.book.cashUsdg, 900);
    // 100 USDG × (1 − 1%) at $500 = 0.198 shares
    assert.ok(Math.abs(r.positions[0]!.shares - 0.198) < 1e-9);
    assert.match(r.receipt!, /QQQ @ \$500\.00/);
  });

  it("sells back down to zero and never goes short", () => {
    const held: PaperPosition[] = [{ symbol: "QQQ", token: QQQ, shares: 0.1 }];
    const sell: TradeIntent = { kind: "swap", target: ROUTER, sellToken: QQQ, buyToken: USDG, sellAmountRaw: 0n, notionalUsdg: 0n };
    // ask to sell 100 USDG worth (0.2 shares) but only 0.1 held → clamps
    const r = applyPaperIntent(sell, book(), held, { ...OPTS, notionalUsdg: 100 });
    assert.equal(r.ok, true);
    assert.equal(r.positions.length, 0); // fully closed, dust filtered
    // proceeds = 0.1 × 500 × 0.99 = 49.5
    assert.ok(Math.abs(r.book.cashUsdg - 1049.5) < 1e-6);
  });

  it("refuses a fill with no live price instead of inventing one", () => {
    const noFeed: TradeIntent = { kind: "swap", target: ROUTER, sellToken: USDG, buyToken: ROUTER, sellAmountRaw: 0n, notionalUsdg: 0n };
    const r = applyPaperIntent(noFeed, book(), [], { ...OPTS, notionalUsdg: 10 });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /no live price/);
  });

  it("refuses to spend cash it doesn't have", () => {
    const r = applyPaperIntent(buy(2000), book(), [], { ...OPTS, notionalUsdg: 2000 });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /cash short/);
  });

  it("vault round-trip conserves the book", () => {
    const dep: TradeIntent = { kind: "vault-deposit", target: ROUTER, amountUsdg: 0n };
    const wd: TradeIntent = { kind: "vault-withdraw", target: ROUTER, amountUsdg: 0n };
    const a = applyPaperIntent(dep, book(), [], { ...OPTS, notionalUsdg: 300 });
    assert.deepEqual([a.book.cashUsdg, a.book.vaultUsdg], [700, 300]);
    const b = applyPaperIntent(wd, a.book, [], { ...OPTS, notionalUsdg: 300 });
    assert.deepEqual([b.book.cashUsdg, b.book.vaultUsdg], [1000, 0]);
  });

  it("marks equity to market at live prices", () => {
    const eq = paperEquityUsdg({ cashUsdg: 500, vaultUsdg: 100, hwmUsdg: 0 }, [{ symbol: "QQQ", token: QQQ, shares: 0.2 }], priceUsdOf);
    assert.equal(eq, 700); // 500 + 100 + 0.2×500
  });
});

/**
 * ERC-8056 splits in the paper book.
 *
 * A Stock Token never rebases: a corporate action moves uiMultiplier() and the
 * reference price moves inversely, so value is unchanged. The paper book used to
 * store plain UI shares and skip the multiplier entirely, which meant a 2-for-1
 * split halved paper equity — and paper equity feeds the drawdown breaker, so it
 * would retire an agent over an event that cost nobody a cent.
 */
describe("paper fills — ERC-8056 splits", () => {
  const px = (p: number) => (t: `0x${string}`) => (t === QQQ ? { priceUsd: p, stale: false } : null);
  const mul = (m: number | null) => () => m;

  it("a 2-for-1 split leaves paper equity unchanged", () => {
    // Buy 100 USDG of QQQ at $500, unsplit.
    const bought = applyPaperIntent(buy(100), book(), [], {
      ...OPTS, notionalUsdg: 100, priceUsdOf: px(500), multiplierOf: mul(1),
    });
    assert.equal(bought.ok, true);

    const before = paperEquityUsdg(bought.book, bought.positions, px(500), mul(1));
    // The split: multiplier doubles, price halves. Nothing else happens.
    const after = paperEquityUsdg(bought.book, bought.positions, px(250), mul(2));
    assert.ok(
      Math.abs(before - after) < 1e-6,
      `a split must be value-neutral, got ${before} → ${after}`,
    );
  });

  it("without the multiplier, the same split would look like a 50% loss", () => {
    // This is the OLD behaviour, kept as a test so the regression is visible
    // rather than theoretical: omit multiplierOf and the price halving is
    // uncompensated.
    const bought = applyPaperIntent(buy(100), book(), [], {
      ...OPTS, notionalUsdg: 100, priceUsdOf: px(500), multiplierOf: mul(1),
    });
    const held = paperEquityUsdg(bought.book, bought.positions, px(500));
    const naive = paperEquityUsdg(bought.book, bought.positions, px(250));
    const posValue = held - bought.book.cashUsdg;
    assert.ok(posValue > 0, "sanity: the position is worth something");
    assert.ok(Math.abs(held - naive - posValue / 2) < 1e-6, "the naive read loses half the position");
  });

  it("stores split-invariant shares, so a buy after a split records half as many", () => {
    // Post-split the price is halved, so 100 USDG buys twice the TRADEABLE
    // shares — but the stored, multiplier-normalised count is the same as if it
    // had been bought pre-split, which is what makes valuation stable.
    const pre = applyPaperIntent(buy(100), book(), [], {
      ...OPTS, notionalUsdg: 100, priceUsdOf: px(500), multiplierOf: mul(1),
    });
    const post = applyPaperIntent(buy(100), book(), [], {
      ...OPTS, notionalUsdg: 100, priceUsdOf: px(250), multiplierOf: mul(2),
    });
    assert.ok(
      Math.abs(pre.positions[0]!.shares - post.positions[0]!.shares) < 1e-9,
      "the same cash at the same real value stores the same invariant quantity",
    );
    // The receipt speaks in tradeable shares, which DID double.
    assert.match(pre.receipt!, /\+0\.1980 QQQ/);
    assert.match(post.receipt!, /\+0\.3960 QQQ/);
  });

  it("sells the right quantity after a split and closes cleanly", () => {
    // 0.198 invariant shares at multiplier 2 = 0.396 tradeable, worth
    // 0.396 × $250 = $99. Selling "100 USDG worth" must clamp to the holding
    // and leave nothing behind.
    const held: PaperPosition[] = [{ symbol: "QQQ", token: QQQ, shares: 0.198 }];
    const sell: TradeIntent = {
      kind: "swap", target: ROUTER, sellToken: QQQ, buyToken: USDG, sellAmountRaw: 0n, notionalUsdg: 0n,
    };
    const r = applyPaperIntent(sell, book(), held, {
      ...OPTS, notionalUsdg: 100, priceUsdOf: px(250), multiplierOf: mul(2),
    });
    assert.equal(r.ok, true);
    assert.equal(r.positions.length, 0, "position fully closed, no dust left behind");
    // proceeds = 0.396 × 250 × 0.99 = 98.01
    assert.ok(Math.abs(r.book.cashUsdg - (1000 + 98.01)) < 1e-6, `got ${r.book.cashUsdg}`);
    assert.equal(r.fill!.shares.toFixed(4), "0.3960", "the fill reports tradeable shares");
    assert.equal(r.fill!.rawShares.toFixed(4), "0.1980", "basis closes the actual invariant quantity");
  });

  it("refuses the fill when the multiplier can't be read, rather than assuming 1.0", () => {
    const r = applyPaperIntent(buy(100), book(), [], {
      ...OPTS, notionalUsdg: 100, priceUsdOf: px(500), multiplierOf: mul(null),
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /multiplier/);
    assert.equal(r.book.cashUsdg, 1000, "a refused fill moves no cash");
  });

  it("treats a nonsensical multiplier as unreadable", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = applyPaperIntent(buy(100), book(), [], {
        ...OPTS, notionalUsdg: 100, priceUsdOf: px(500), multiplierOf: mul(bad),
      });
      assert.equal(r.ok, false, `multiplier ${bad} must be refused`);
    }
  });
});

describe("the energy buy is never simulated", () => {
  it("applyPaperIntent refuses kind energy-buy and leaves the book exactly as it was", () => {
    // SECOND LINE OF DEFENCE. processIntentLocked refuses an energy buy with
    // `energy-needs-live` before the paper fork is ever reached — a practice
    // book has no reserve to fill, and simulating one would put a purchase on
    // the tape that no chain ever saw. If that refusal were ever lost, this
    // is what stands behind it.
    const b = book();
    const held: PaperPosition[] = [{ symbol: "QQQ", token: QQQ, shares: 0.1 }];
    const energy: TradeIntent = {
      kind: "energy-buy",
      target: ROUTER,
      sellToken: USDG,
      buyToken: QQQ,
      sellAmountRaw: 10_000_000n,
      notionalUsdg: 10_000_000n,
    };
    const r = applyPaperIntent(energy, b, held, { ...OPTS, notionalUsdg: 10 });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /unsupported paper intent energy-buy/);
    assert.deepEqual(r.book, book());
    assert.deepEqual(r.positions, held);
    assert.equal(r.fill, undefined);
  });
});
