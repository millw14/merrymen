import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { curveMarkedSymbols, sampledGainUsdg, type Position } from "./positions";

/**
 * A SAMPLED PRICE IS BUDGETED LIKE THE THIN CLAIM IT IS — everywhere a price
 * decides money: the scout gate, the scout running total, the peaks and the
 * fee. Each of these was a separate place a sampled coin could slip past, and
 * an adversarial review found three of them; pinned here so none comes back.
 */

const pos = (symbol: string, priceSource: Position["priceSource"], valueUsdg: bigint): Position =>
  ({ symbol, priceSource, valueUsdg, token: `0x${"0".repeat(39)}1`, rawBalance: 1n, price8: 1n, priceStale: false }) as unknown as Position;
const usd = (n: number) => BigInt(Math.round(n * 1e6));

describe("sampledGainUsdg — what peaks and the fee may not be set from", () => {
  it("is the sampled marks' gain above cost, and nothing else's", () => {
    const book = [pos("NEW", "sampled", usd(3)), pos("OLD", "pool", usd(100)), pos("CRV", "curve", usd(9))];
    assert.equal(sampledGainUsdg(book, () => usd(2.5)), usd(0.5));
  });

  it("lets a sampled loss through, so a peak can only be judged lower, never higher", () => {
    assert.equal(sampledGainUsdg([pos("NEW", "sampled", usd(1))], () => usd(2.5)), 0n);
  });

  it("counts the whole mark when its cost is unknown", () => {
    assert.equal(sampledGainUsdg([pos("NEW", "sampled", usd(3))], () => null), usd(3));
  });

  it("does not freeze the whole book's peaks the way a curve mark does", () => {
    assert.deepEqual(curveMarkedSymbols([pos("NEW", "sampled", usd(3)), pos("CRV", "curve", usd(1))]), ["CRV"]);
  });
});

const INDEX = readFileSync(`${fileURLToPath(new URL(".", import.meta.url))}index.ts`, "utf8");

describe("the tick's wiring", () => {
  it("exempts a sampled coin from the scout gate by vault custody alone, never by rail", () => {
    const at = INDEX.indexOf("function scoutUnpriceableFor(");
    const body = INDEX.slice(at, INDEX.indexOf("\n  }\n", at));
    assert.match(body, /const bounded = intent\.kind === "swap" && intent\.custody === "trencher";/);
    assert.doesNotMatch(body, /paperActive\(\)/, "a rail read here can flip before the fork");
  });

  it("offers a sampled coin as an entry only on the autonomous vault path", () => {
    assert.match(INDEX, /\.\.\.priceability\(quote, true, \{[\s\S]{0,400}?sampled: autonomous,\s*\}\)/);
  });

  it("counts a held sampled coin's cost in the scout running total, paper or live, except vault custody", () => {
    assert.match(INDEX, /const inVault = qMode === "live"\s*\? autoTrenchBalances\.has\(token\)\s*: !!autoTrench && !!active && !!grantTrencher\(active\.grant\) && !baseTokenAddress\(token\) &&\s*!!active\.limits\.knownTrencherAssets\?\.some/);
    assert.match(INDEX, /const sampledBudgeted = p\.priceSource === "sampled" && !inVault;/);
    assert.match(INDEX, /if \(p\.priceSource !== "curve" && !sampledBudgeted\) continue;/);
  });

  it("judges every peak and the fee on equity with sampled holdings held to cost", () => {
    assert.match(INDEX, /const peakEquityUsdg = equityUsdg - sampledGainUsdg\(/);
    assert.match(INDEX, /ratchet\.paperPeak\(bookRow, usdgNum\(peakEquityUsdg\)/);
    assert.match(INDEX, /ratchet\.riskPeak\(usdgNum\(peakEquityUsdg\)/);
    assert.match(INDEX, /accrueAboveHwm\(peakEquityUsdg, highWaterMarkUsdg/);
    // A held look still observes the breaker: on the same figure.
    assert.match(INDEX, /breakerObservationUsdg: heldBreakerObservationUsdg\(\{[\s\S]{0,300}?equityUsdg: peakEquityUsdg,/);
  });
});
