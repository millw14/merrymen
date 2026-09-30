import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPerps, readPerpsText } from "./perps";
import type { PerpsReport } from "../../../packages/core/src/perps";
const NOW = 1_800_000_000_000;
const report: PerpsReport = { v: 1, mode: "paper", blocker: null, venueReadAt: NOW, protectAt: NOW, accountIndex: null,
  positions: [{ market: "BTC-PERP", side: "long", baseAmount: "0.001", entryPrice: "90000", markPrice: null, leverage: 2, marginMicro: "45000000", liqPrice: null, unrealizedMicro: null, stopTrigger: null, fundingMicro: "-12500" }],
  openNotionalMicro: "90000000", collateralMicro: "20000000", inTransitMicro: "0", minLiqDistanceBps: null, stopsMissing: 1, incident: false };
describe("Telegram perps report", () => {
  it("renders paper, held positions and missing marks without inventing zeros", () => {
    const text = formatPerps(report, NOW);
    for (const word of ["paper practice", "BTC-PERP", "long", "45.00 USDG", "mark not read", "liquidation not read", "funding −0.01 USDG", "no stop seen"]) assert.ok(text.includes(word), word);
    assert.doesNotMatch(text, /No open positions/);
  });
  it("unread, stale and incident are explicit", async () => {
    assert.match(await readPerpsText(async () => { throw new Error("unread"); }), /could not be read/);
    assert.match(formatPerps({ ...report, venueReadAt: null, positions: [] }, NOW), /current book is unknown/);
    assert.doesNotMatch(formatPerps({ ...report, venueReadAt: null, positions: [] }, NOW), /No open positions/);
    assert.match(formatPerps({ ...report, venueReadAt: NOW - 16 * 60_000 }, NOW), /older reading/);
    assert.match(formatPerps({ ...report, incident: true }, NOW), /key rotation/);
  });
  it("a failed read with its retained timestamp never reports an empty book", () => {
    // buildPerpsReport(view=null) retains lastVenueReadAtMs, nulls the venue
    // figures and counts held rows even when their market cannot be rendered.
    const text = formatPerps({ ...report, mode: "live", blocker: "perps-venue-unreachable",
      venueReadAt: NOW - 60_000, positions: [], collateralMicro: null,
      openNotionalMicro: null, inTransitMicro: null, stopsMissing: 1 }, NOW);
    assert.match(text, /current book is unknown/);
    assert.match(text, /1 recorded position\(s\) could not be listed/);
    assert.doesNotMatch(text, /No open positions/);
  });
  it("counts unlisted holdings without counting the listed unprotected position twice", () => {
    const text = formatPerps({ ...report, mode: "live", stopsMissing: 2 }, NOW);
    assert.match(text, /1 recorded position\(s\) could not be listed/);
    assert.doesNotMatch(text, /2 recorded position/);
    const foreignOnly = formatPerps({ ...report, mode: "live", positions: [], stopsMissing: 1, incident: true }, NOW);
    assert.match(foreignOnly, /1 recorded position\(s\) could not be listed/);
    assert.doesNotMatch(foreignOnly, /No open positions/);
    const empty = formatPerps({ ...report, positions: [], stopsMissing: 0, collateralMicro: "0", openNotionalMicro: "0" }, NOW);
    assert.match(empty, /No open positions at that reading/);
    assert.doesNotMatch(empty, /could not be listed|current book is unknown/);
  });
  it("only offers dashboard Resume for an owner halt, never an operator halt", () => {
    const halted = { ...report, blocker: "perps-entries-halted" as const };
    assert.match(formatPerps({ ...halted, entriesHalted: true }, NOW), /Resume them on the dashboard/);
    const operator = formatPerps({ ...halted, entriesHalted: false }, NOW);
    assert.match(operator, /New perpetual positions are paused/);
    assert.doesNotMatch(operator, /Resume them on the dashboard/);
  });
});
