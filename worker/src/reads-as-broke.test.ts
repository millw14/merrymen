import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readsAsBroke } from "./reads-as-broke";

describe("readsAsBroke — the paper-mode deadlock boundary", () => {
  it("cash 0 with NO gas is broke → paper mode (the unfunded agent, as always)", () => {
    assert.equal(readsAsBroke(0n, 0n), true);
    assert.equal(readsAsBroke(0n, null), true, "no gas read yet still counts as unfunded when cash is a READ zero");
  });

  it("cash 0 WITH gas is FUNDED → live mode, auto-convert may fire", () => {
    // THE deadlock this fixes: ~$2 of native ETH, $0 USDG. Old rule said
    // broke → paper → convert blocked → paper forever, with 1,000 fake USDG
    // minted next to a real balance.
    assert.equal(readsAsBroke(0n, 947_558_380_199_360n), false);
    assert.equal(readsAsBroke(0n, 1n), false, "even dust gas means the account is real and funded");
  });

  it("null cash is UNKNOWN — never broke, never a mode flip", () => {
    assert.equal(readsAsBroke(null, 0n), false);
    assert.equal(readsAsBroke(null, null), false);
  });

  it("real cash is never broke, whatever the gas read", () => {
    assert.equal(readsAsBroke(1_000_000n, 0n), false);
    assert.equal(readsAsBroke(1_000_000n, 947_558_380_199_360n), false);
  });
});
