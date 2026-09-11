import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gasBasisOf } from "./gas-basis";

/**
 * THE CAVEAT THAT WAS NOT TRUE OF ANYBODY.
 *
 * Three sites derived this as `usdg > 0 ? "net" : "unknown"`, which reads a ZERO
 * as an absence. On this fleet the zero is a measurement: gas is sponsored, the
 * paymaster settles with the EntryPoint, and the account never handles ETH. So
 * every sponsored agent published `gasBasis: "unknown"`, and the Brain's gate
 * turned that into "trading costs are not subtracted, so small edges are
 * overstated" — about books with no trading costs to subtract.
 *
 * It mattered because the gate COUNTS caveats and downgrades to hold at three.
 * With a hardcoded `auditPassed: false` supplying one and this supplying a
 * second, the fleet sat one real problem away from being unable to trade, on
 * two statements that were false of every agent.
 *
 * The five cases below are the five ways a book can arrive.
 */
describe("gas basis distinguishes a measured zero from an unmeasured absence", () => {
  it("no landed trades — nothing was owed, so the figure is net of gas", () => {
    // Zero subtracted is subtracted correctly. A book that has not traded has a
    // P&L that is trivially and completely net of its (nonexistent) gas.
    assert.equal(gasBasisOf({ read: true, unpricedTrades: 0 }), "net");
  });

  it("landed trades, all sponsored — gas cost this book nothing, still net", () => {
    // THE CASE THIS EXISTS FOR. Indistinguishable from the one above by the
    // numbers alone, and that is fine: both are measurements, and both are net.
    assert.equal(gasBasisOf({ read: true, unpricedTrades: 0 }), "net");
  });

  it("landed trades with priced user-paid gas — net, as it always was", () => {
    assert.equal(gasBasisOf({ read: true, unpricedTrades: 0 }), "net");
  });

  it("mixed priced and unpriced history — gross, because part is unaccounted", () => {
    // "Net of gas" is only true if EVERY trade's gas was priceable. One that was
    // not makes the figure net of SOME gas, and saying otherwise overstates it.
    assert.equal(gasBasisOf({ read: true, unpricedTrades: 1 }), "gross");
    assert.equal(gasBasisOf({ read: true, unpricedTrades: 12 }), "gross");
  });

  it("the ledger could not be read — unknown, and ONLY this is unknown", () => {
    // The whole point of carrying `read` from the reader: its catch path returns
    // the same zeros a sponsored book does, so nothing downstream could tell a
    // failure from a measurement without being told.
    assert.equal(gasBasisOf({ read: false, unpricedTrades: 0 }), "unknown");
  });

  it("an unreadable ledger reports zero of everything, and must not read as net", () => {
    // Order inside the function matters: a failed read reports no unpriced
    // trades either, so asking `unpricedTrades` first would answer "net" with
    // confidence about a book it never opened.
    assert.equal(gasBasisOf({ read: false, unpricedTrades: 0 }), "unknown");
    assert.notEqual(gasBasisOf({ read: false, unpricedTrades: 0 }), "net");
  });

  it("unreadable outranks unpriced, because we do not know there were any", () => {
    assert.equal(gasBasisOf({ read: false, unpricedTrades: 5 }), "unknown");
  });

  it("only a read failure is ever unknown", () => {
    // The property in one line: after this change, `unknown` carries exactly one
    // meaning, and a surface rendering it can say so without hedging.
    for (const unpriced of [0, 1, 99]) {
      assert.notEqual(gasBasisOf({ read: true, unpricedTrades: unpriced }), "unknown");
    }
  });
});
