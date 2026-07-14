import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPaperIntent, paperEquityUsdg, type PaperBook, type PaperPosition } from "./paper";
import type { TradeIntent } from "./policy";

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
