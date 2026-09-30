import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandFor, commandPayload, isComplete, modelArgsFor } from "./chat-commands";
import { readOrder } from "./order-state";
import { placeOrder, type OrderReads } from "../../../worker/src/order-gate";
import { perpsReviewLink } from "../terminal/perps-review-link";

const CLOSED: OrderReads = { paused: true, marketUnreadable: true, bookUnreadable: true, equityKnown: false, ceilingUsdg: 1 };
const close = { book: "live", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, purpose: "close-perp" };
const flatten = { ...close, symbol: "ALL-PERPS", purpose: "flatten-perps" };

describe("owner perps cards and two validation gates", () => {
  it("the model chooses neither side nor exit purpose nor amount", () => {
    for (const [id, expected] of [["close-perp", close], ["flatten-perps", flatten]] as const) {
      const c = commandFor(id)!;
      assert.deepEqual(commandPayload(c, { book: "live", symbol: "BTC-PERP", side: "buy", usdgAmount: 999, purpose: "energy" }), expected);
      assert.equal(c.weighty, true);
      assert.match(c.say({ symbol: "BTC-PERP" }), /reduce-only/);
    }
    assert.deepEqual(modelArgsFor(commandFor("close-perp")!), ["symbol", "book"]);
    assert.deepEqual(modelArgsFor(commandFor("flatten-perps")!), ["book"]);
    assert.equal(commandFor("resume-perps"), null);
  });
  it("both canonical exits reach their own route despite spot entry gates", async () => {
    for (const args of [close, flatten]) {
      assert.deepEqual(readOrder(args), { order: args });
      const calls: unknown[] = [];
      await placeOrder(args, CLOSED, async (...x) => { calls.push(x); return "ok"; });
      assert.deepEqual(calls, [["sell", args.symbol, 0, args.purpose]]);
    }
  });
  it("malformed explicit exits never reach any submitter", async () => {
    for (const args of [
      { ...close, book: undefined }, { ...close, book: "unknown" }, { ...close, side: "buy" }, { ...close, usdgAmount: 1 }, { ...close, usdgAmount: "0" },
      { ...close, usdgAmount: -1 }, { ...close, symbol: "BTC" }, { ...close, symbol: "BTC-PERP ETH-PERP" },
      { ...flatten, symbol: "BTC-PERP" }, { ...flatten, side: "buy" },
    ]) {
      assert.ok("error" in readOrder(args));
      const result = await placeOrder(args, CLOSED, async () => { throw new Error("must never send"); });
      assert.equal(result.ok, false);
    }
  });
  it("a ticker alone cannot bypass the spot gates", async () => {
    assert.ok("error" in readOrder({ ...close, purpose: undefined }));
    assert.deepEqual(await placeOrder({ side: "buy", symbol: "BTC", usdgAmount: 5 }, CLOSED, async () => { throw new Error("must not send"); }), {
      ok: false, line: "I could not read the market this tick, so I did not place it — that is a fact about my reads, not about your order. Ask again in a minute.",
    });
  });
  it("native handoff consumes only the review query and supplies no authority", () => {
    const next = perpsReviewLink("https://app.merrymen.dev/agent?perps=flatten&keep=1#chat")!;
    assert.deepEqual(next, { next: "/agent?keep=1#chat", proposal: { id: "flatten-perps", args: {} } });
    assert.equal(perpsReviewLink(next.next), null);
    assert.equal(perpsReviewLink("/agent?perps=resume"), null);
    assert.equal(perpsReviewLink("/settings?perps=flatten"), null);
    assert.deepEqual(perpsReviewLink("/agent?perps=close&market=BTC-PERP&book=live"), {
      next: "/agent", proposal: { id: "close-perp", args: { symbol: "BTC-PERP", book: "live" } },
    });
    assert.deepEqual(perpsReviewLink("/agent?perps=flatten&book=paper")?.proposal.args, { book: "paper" });
    for (const query of ["perps=close", "perps=close&market=BTC", "perps=close&market=BTC-PERP%20ETH-PERP", "perps=flatten&book=unknown"])
      assert.equal(perpsReviewLink(`/agent?${query}`), null);
    assert.equal(isComplete(commandFor("flatten-perps")!, {}), false);
    assert.equal(isComplete(commandFor("close-perp")!, { symbol: "BTC-PERP" }), false);
    assert.equal(isComplete(commandFor("close-perp")!, { symbol: "BTC-PERP", book: "paper" }), true);
  });
});
