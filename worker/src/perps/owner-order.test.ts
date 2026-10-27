/**
 * AN OWNER'S PERPETUAL EXIT, AS ITS ARGUMENTS SAY IT — the one shape the web
 * route and the worker both check (owner-order.ts). What is pinned:
 *
 *   the marker       an exit is never inferred from a ticker: no purpose, no exit.
 *   fixed values     side "sell" and usdgAmount 0, never a choice.
 *   the book         a close names the practice book; Close all may omit it
 *                    (D11: an unread book is every book); "live" is refused by
 *                    name, because nothing real can be closed in this build.
 *   the symbol       one `-PERP` market for a close, ALL-PERPS for Close all.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ALL_PERPS, isPerpExitPurpose, ownerPerpMarket, readPerpExitOrder } from "./owner-order";

const close = { side: "sell", symbol: "BTC-PERP", usdgAmount: 0, purpose: "close-perp", book: "paper" };
const flatten = { side: "sell", symbol: ALL_PERPS, usdgAmount: 0, purpose: "flatten-perps" };

describe("readPerpExitOrder", () => {
  it("is null for every ordinary order — the marker decides, never a -PERP symbol", () => {
    for (const args of [
      { side: "buy", symbol: "TSLA", usdgAmount: 5 },
      { side: "sell", symbol: "BTC-PERP", usdgAmount: 0 },
      { side: "buy", symbol: "MERRYMEN", usdgAmount: 30, purpose: "energy" },
      { ...close, purpose: "Close-Perp" },
      { ...close, purpose: "close-perps" },
      {},
    ]) {
      assert.equal(readPerpExitOrder(args), null, JSON.stringify(args));
    }
  });

  it("reads a close of one practice position, the symbol canonical", () => {
    assert.deepEqual(readPerpExitOrder(close), {
      order: { purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper" },
    });
    assert.deepEqual(readPerpExitOrder({ ...close, symbol: " eth-perp " }), {
      order: { purpose: "close-perp", side: "sell", symbol: "ETH-PERP", usdgAmount: 0, book: "paper" },
    });
  });

  it("reads Close all with the practice book, and WITHOUT one — an unread book is every book (D11)", () => {
    assert.deepEqual(readPerpExitOrder({ ...flatten, book: "paper" }), {
      order: { purpose: "flatten-perps", side: "sell", symbol: "ALL-PERPS", usdgAmount: 0, book: "paper" },
    });
    const unread = readPerpExitOrder(flatten);
    assert.deepEqual(unread, { order: { purpose: "flatten-perps", side: "sell", symbol: "ALL-PERPS", usdgAmount: 0 } });
    assert.ok(unread && "order" in unread && !("book" in unread.order), "absent, not undefined: the order id and the worker read the same thing");
  });

  it("a close must name its book — only Close all may leave it out", () => {
    const { book: _book, ...noBook } = close;
    assert.match((readPerpExitOrder(noBook) as { error: string }).error, /Choose the practice perpetual book/);
  });

  it("refuses the real-money book by name: nothing real can be closed in this build", () => {
    for (const args of [{ ...close, book: "live" }, { ...flatten, book: "live" }]) {
      const out = readPerpExitOrder(args) as { error: string };
      assert.match(out.error, /Real-money perpetuals are not available in this version/);
      assert.match(out.error, /Nothing was sent/);
    }
  });

  it("refuses any other book, a buy, an amount, or a wrong symbol — each in the owner's words, nothing sent", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...close, book: "Paper" }, /Choose the practice perpetual book/],
      [{ ...flatten, book: "both" }, /Choose the practice perpetual book/],
      [{ ...close, side: "buy" }, /cannot choose a buy or an amount/],
      [{ ...close, usdgAmount: 5 }, /cannot choose a buy or an amount/],
      [{ ...close, usdgAmount: "0" }, /cannot choose a buy or an amount/],
      [{ ...flatten, side: undefined }, /cannot choose a buy or an amount/],
      [{ ...close, symbol: "ALL-PERPS" }, /Name one perpetual market/],
      [{ ...close, symbol: "BTC" }, /Name one perpetual market/],
      [{ ...close, symbol: "../BTC-PERP" }, /Name one perpetual market/],
      [{ ...flatten, symbol: "BTC-PERP" }, /Close all must name ALL-PERPS/],
    ];
    for (const [args, want] of cases) {
      const out = readPerpExitOrder(args);
      assert.ok(out && "error" in out, JSON.stringify(args));
      assert.match(out.error, want, JSON.stringify(args));
      assert.match(out.error, /Nothing was sent\.$/);
    }
  });
});

describe("small pieces", () => {
  it("ownerPerpMarket: a -PERP key or nothing", () => {
    assert.equal(ownerPerpMarket("btc-perp"), "BTC-PERP");
    for (const bad of ["BTC", "BTC-PERP-PERP", "-PERP", "", 1, null, undefined, "BTC PERP", "A".repeat(25) + "-PERP"]) {
      assert.equal(ownerPerpMarket(bad), null, String(bad));
    }
  });

  it("isPerpExitPurpose: the two exits and nothing else", () => {
    assert.equal(isPerpExitPurpose("close-perp"), true);
    assert.equal(isPerpExitPurpose("flatten-perps"), true);
    for (const p of ["energy", "trade", "resume-perps", "", null, undefined]) assert.equal(isPerpExitPurpose(p), false, String(p));
  });
});
