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
});
