/**
 * AN OWNER'S PERPETUAL EXIT, AT BOTH GATES: the web's, before the row is
 * written, and the worker's, before anything is built — reading it with the
 * one parser (worker/src/perps/owner-order.ts) so they cannot disagree.
 *
 * Adapted from the perps branch (112dbeb6) for main: the gates are
 * readPerpsWalletOrder (the Perps wallet's queue takes exits and nothing else)
 * and the worker's walletOrderRefusal and placeOrder. The branch's chat cards
 * (chat-commands close-perp and flatten-perps) and its review link
 * (terminal/perps-review-link.ts) are the desk's, and land with it (PR 3);
 * their cases are not here yet. The branch's `book: "live"` is refused in this
 * build: there is no real-money position to close.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { namesPerpExit, PERPS_WALLET_EXITS_ONLY, readOrder, readPerpsWalletOrder } from "./order-state";
import { orderRoute, placeOrder, walletOrderRefusal, type OrderReads } from "../../../worker/src/order-gate";

/** A tick that could read nothing, with the owner paused and a one-dollar ceiling: every Spot gate closed. */
const CLOSED: OrderReads = { paused: true, marketUnreadable: true, bookUnreadable: true, equityKnown: false, ceilingUsdg: 1 };
const close = { book: "paper", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, purpose: "close-perp" } as const;
const flatten = { side: "sell", symbol: "ALL-PERPS", usdgAmount: 0, purpose: "flatten-perps" } as const;

describe("owner perps exits and the two validation gates", () => {
  it("both canonical exits pass the web's gate as themselves, and reach their own route past every Spot gate", async () => {
    for (const args of [close, flatten, { ...flatten, book: "paper" }]) {
      assert.deepEqual(readPerpsWalletOrder(args), { order: args });
      assert.equal(walletOrderRefusal("perps", orderRoute(args)), null, "a Perps worker takes it");
      const calls: unknown[] = [];
      await placeOrder(args, CLOSED, async (...x) => {
        calls.push(x);
        return "ok";
      });
      assert.deepEqual(calls, [["sell", args.symbol, 0, args.purpose]]);
    }
  });

  it("malformed explicit exits never reach any submitter, at either gate", async () => {
    for (const args of [
      { ...close, book: undefined }, { ...close, book: "unknown" }, { ...close, book: "live" }, { ...close, side: "buy" }, { ...close, usdgAmount: 1 },
      { ...close, usdgAmount: "0" }, { ...close, usdgAmount: -1 }, { ...close, symbol: "BTC" }, { ...close, symbol: "BTC-PERP ETH-PERP" },
      { ...flatten, symbol: "BTC-PERP" }, { ...flatten, side: "buy" }, { ...flatten, book: "live" },
    ]) {
      assert.ok("error" in readPerpsWalletOrder(args), JSON.stringify(args));
      const result = await placeOrder(args, CLOSED, async () => {
        throw new Error("must never send");
      });
      assert.equal(result.ok, false, JSON.stringify(args));
    }
  });

  it("a ticker alone is no exit: the Perps wallet refuses it, and the worker's Spot gates still hold it", async () => {
    assert.deepEqual(readPerpsWalletOrder({ ...close, purpose: undefined }), { error: PERPS_WALLET_EXITS_ONLY });
    assert.ok("error" in readOrder({ ...close, purpose: undefined }), "and the Spot reader cannot look the symbol up");
    assert.deepEqual(await placeOrder({ side: "buy", symbol: "BTC", usdgAmount: 5 }, CLOSED, async () => { throw new Error("must not send"); }), {
      ok: false, line: "I could not read the market this tick, so I did not place it — that is a fact about my reads, not about your order. Ask again in a minute.",
    });
  });

  it("EACH WALLET'S GATES REFUSE THE OTHER'S ORDERS: the Perps wallet takes only exits, the Spot wallet never takes one", () => {
    for (const spot of [{ side: "buy", symbol: "TSLA", usdgAmount: 5 }, { side: "buy", symbol: "MERRYMEN", usdgAmount: 30, purpose: "energy" }]) {
      assert.deepEqual(readPerpsWalletOrder(spot), { error: PERPS_WALLET_EXITS_ONLY });
      assert.ok(walletOrderRefusal("perps", orderRoute(spot)), "and the Perps worker refuses it again");
      assert.equal(namesPerpExit(spot), false);
    }
    for (const exit of [close, flatten]) {
      assert.equal(namesPerpExit(exit), true, "the Spot route refuses it before readOrder");
      assert.match(walletOrderRefusal("spot", orderRoute(exit)) ?? "", /Spot wallet holds no perpetual positions/);
    }
    for (const notOne of [null, undefined, "close-perp", [close], { purpose: "Close-Perp" }]) assert.equal(namesPerpExit(notOne), false, JSON.stringify(notOne));
  });

  it("a body that is not an object is refused before a field is read", () => {
    for (const body of [null, undefined, "close-perp", 7, [close]]) {
      assert.deepEqual(readPerpsWalletOrder(body), { error: "That is not an order. Nothing was queued." }, JSON.stringify(body));
    }
  });
});
