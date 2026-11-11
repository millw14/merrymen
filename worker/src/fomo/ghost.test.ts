import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GHOST_FLAT_USD_MICRO,
  ghostPnlMicro,
  ghostSummaryLines,
  parseGhostSizeUsd,
  resolveGhostSize,
  summarizeGhost,
} from "./ghost.js";

describe("ghost sizing", () => {
  it("flat is always $100", () => {
    assert.equal(resolveGhostSize({ mode: "flat", customUsdMicro: 0 }, null), GHOST_FLAT_USD_MICRO);
    assert.equal(resolveGhostSize({ mode: "flat", customUsdMicro: 0 }, 50_000_000), GHOST_FLAT_USD_MICRO);
  });
  it("scout-cut is ten percent of the scout budget", () => {
    assert.equal(resolveGhostSize({ mode: "scout-cut", customUsdMicro: 0 }, 1_000_000_000), 100_000_000);
  });
  it("scout-cut with no budget sizes nothing, never zero", () => {
    assert.equal(resolveGhostSize({ mode: "scout-cut", customUsdMicro: 0 }, null), null);
    assert.equal(resolveGhostSize({ mode: "scout-cut", customUsdMicro: 0 }, 0), null);
    assert.equal(resolveGhostSize({ mode: "scout-cut", customUsdMicro: 0 }, 5_000_000), null);
  });
  it("custom is capped at the scout budget", () => {
    assert.equal(resolveGhostSize({ mode: "custom", customUsdMicro: 500_000_000 }, 200_000_000), 200_000_000);
    assert.equal(resolveGhostSize({ mode: "custom", customUsdMicro: 500_000_000 }, null), 500_000_000);
    assert.equal(resolveGhostSize({ mode: "custom", customUsdMicro: 0 }, 200_000_000), null);
  });
});

describe("ghost pnl", () => {
  it("a double on $100 is +$100", () => {
    assert.equal(ghostPnlMicro(100_000_000, 1, 2), 100_000_000);
  });
  it("a halving is −$50", () => {
    assert.equal(ghostPnlMicro(100_000_000, 2, 1), -50_000_000);
  });
  it("missing prices settle nothing, never zero", () => {
    assert.equal(ghostPnlMicro(100_000_000, 1, null), null);
    assert.equal(ghostPnlMicro(100_000_000, 0, 2), null);
  });
});

describe("ghost summary", () => {
  it("says the sample size every time", () => {
    const s = summarizeGhost([
      { eventKey: "a", traderUserId: "t", handle: "@t", sizeUsdMicro: 100_000_000, entryPriceUsd: 1, h1PnlMicro: 10_000_000, h24PnlMicro: null },
      { eventKey: "b", traderUserId: "t", handle: "@t", sizeUsdMicro: 100_000_000, entryPriceUsd: 1, h1PnlMicro: null, h24PnlMicro: null },
    ]);
    assert.equal(s.positions, 2);
    assert.equal(s.settledH1, 1);
    assert.equal(s.pnlH1Micro, 10_000_000);
    const lines = ghostSummaryLines(s, 200_000_000);
    assert.match(lines.join("\n"), /2 positions/);
    assert.match(lines.join("\n"), /over 1 settled/);
  });
  it("empty ledger points at /ghost on", () => {
    const lines = ghostSummaryLines(summarizeGhost([]), 0);
    assert.match(lines[0] ?? "", /\/ghost on/);
  });
});

describe("ghost size parsing", () => {
  it("takes 100, $100 and 100usd", () => {
    assert.equal(parseGhostSizeUsd("100"), 100_000_000);
    assert.equal(parseGhostSizeUsd("$100"), 100_000_000);
    assert.equal(parseGhostSizeUsd("100usd"), 100_000_000);
    assert.equal(parseGhostSizeUsd(50), 50_000_000);
  });
  it("refuses dust and fortunes", () => {
    assert.equal(parseGhostSizeUsd("0"), null);
    assert.equal(parseGhostSizeUsd("0.001"), null);
    assert.equal(parseGhostSizeUsd("99999999"), null);
    assert.equal(parseGhostSizeUsd("abc"), null);
  });
});
