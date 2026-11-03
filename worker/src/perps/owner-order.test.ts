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
 *   its words        an exit that did not run, or that nobody heard back from,
 *                    is said as an exit — never as a Spot fill, never "check
 *                    your trades", and for Close all with what it paused.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_PERPS, isPerpExitPurpose, ownerPerpMarket, perpExitExpiredLine, perpExitNeverRanLine, perpExitUnansweredLine, readPerpExitOrder,
} from "./owner-order";

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

/**
 * AN EXIT THAT DID NOT RUN, IN AN EXIT'S WORDS. The paths that answer an order
 * nobody ran (the drain's claim, the worker's own check, the orchestrator's
 * sweep) said a Spot fill's sentence for a Close: "I will not fill it into a
 * different market", and for one nobody heard back from, "whether it filled …
 * Check your trades" — a page that never shows a perpetual's close — with
 * nothing about the pause a Close all writes before it closes anything.
 */
describe("an exit's own sentences where it did not run", () => {
  const SPOT_WORDS = /fill|trades/i;

  it("are null for anything that is not an exit, so a Spot order keeps its own sentence word for word", () => {
    for (const args of [undefined, {}, { side: "buy", symbol: "TSLA", usdgAmount: 5 }, { side: "sell", symbol: "BTC-PERP", usdgAmount: 0 }, { side: "buy", symbol: "MERRYMEN", usdgAmount: 30, purpose: "energy" }]) {
      assert.equal(perpExitExpiredLine(args, "30s"), null, JSON.stringify(args));
      assert.equal(perpExitNeverRanLine(args), null, JSON.stringify(args));
      assert.equal(perpExitUnansweredLine(args), null, JSON.stringify(args));
    }
  });

  it("EXPIRED: names the exit and its lateness, says nothing was sent or closed — and for Close all, that nothing was paused", () => {
    assert.equal(perpExitExpiredLine(close, "30s"),
      "expired — I picked up this close of BTC-PERP 30s after its window closed, so it did not run: nothing was sent and no practice position was closed. Ask again if you still want it.");
    assert.equal(perpExitExpiredLine(flatten, "9 min"),
      "expired — I picked up this Close all 9 min after its window closed, so it did not run: nothing was sent, no practice position was closed and nothing was paused. Ask again if you still want it.");
    assert.doesNotMatch(perpExitExpiredLine(close, "30s")!, SPOT_WORDS);
  });

  it("NEVER RAN: the sweep's sentence for an exit nobody picked up", () => {
    assert.equal(perpExitNeverRanLine(close),
      "never ran — this close of BTC-PERP sat in my queue past its window without being picked up, so nothing was sent and no practice position was closed. Ask again if you still want it.");
    assert.equal(perpExitNeverRanLine({ ...flatten, book: "paper" }),
      "never ran — this Close all sat in my queue past its window without being picked up, so nothing was sent, no practice position was closed and nothing was paused. Ask again if you still want it.");
  });

  it("UNANSWERED: claims nothing either way, points at the Perps positions, and for Close all says new positions may be paused until a reset", () => {
    const one = perpExitUnansweredLine(close)!;
    const all = perpExitUnansweredLine(flatten)!;
    assert.equal(one, "I never heard back from my worker about this close of BTC-PERP, so I cannot tell you whether the practice position was closed — it may have been. Check your Perps positions before asking again.");
    assert.equal(all, "I never heard back from my worker about this Close all, so I cannot tell you how far it got: some practice positions may have closed, and new practice positions may be paused until you reset the practice book. Check your Perps positions before asking again.");
    for (const line of [one, all]) {
      assert.doesNotMatch(line, SPOT_WORDS, "no fill, no trades page: a perpetual's fills are never trades rows");
      assert.doesNotMatch(line, /never ran|will not fill|nothing was sent|did not/i, "it does not claim to know nothing went out");
    }
  });

  it("names a market only when it has an exit's shape: these args may have crossed a file anything can write", () => {
    for (const symbol of ["BTC-PERP; rm -rf", "<b>x</b>", 7, undefined]) {
      const args = { ...close, symbol };
      assert.match(perpExitExpiredLine(args, "1s")!, /^expired — I picked up this close 1s after/, String(symbol));
      assert.match(perpExitNeverRanLine(args)!, /^never ran — this close sat in my queue/, String(symbol));
      assert.match(perpExitUnansweredLine(args)!, /about this close, so/, String(symbol));
    }
    assert.match(perpExitNeverRanLine({ ...close, symbol: " eth-perp " })!, /this close of ETH-PERP/);
  });
});
