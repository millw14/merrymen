import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evenKeelTick, type EvenKeelConfig } from "./even-keel";
import { makeDipHunter, type DipHunterConfig } from "./dip-hunter";
import type { Holding, Snapshot } from "./types";

const AAPL = "0xaaaa000000000000000000000000000000000000" as const;
const MSFT = "0xbbbb000000000000000000000000000000000000" as const;
const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;

const U = (n: number) => BigInt(Math.round(n * 1e6)); // USDG 6dp
const P = (n: number) => BigInt(Math.round(n * 1e8)); // Chainlink 8dp

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    cashUsdg: U(100),
    vaultUsdg: 0n,
    holdings: new Map<string, Holding>(),
    prices: new Map([
      ["AAPL", { price8: P(100), stale: false }],
      ["MSFT", { price8: P(100), stale: false }],
    ]),
    pausedTokens: new Set<string>(),
    staleFeeds: new Set<string>(),
    sequencerUp: true,
    ...over,
  };
}

describe("even-keel (rebalancer)", () => {
  const cfg: EvenKeelConfig = {
    legs: [
      { symbol: "AAPL", token: AAPL },
      { symbol: "MSFT", token: MSFT },
    ],
    swapRouter: ROUTER,
    usdg: USDG,
    maxTradeUsdg: U(25),
    bandBps: 500,
    seedBudgetUsdg: U(50),
  };

  it("cold start: lays down an equal-weight entry from cash", () => {
    const out = evenKeelTick(cfg, snap());
    assert.equal(out.length, 2);
    assert.ok(out.every((i) => i.kind === "swap" && i.sellToken === USDG));
    assert.deepEqual(
      out.map((i) => (i.kind === "swap" ? i.buyToken : null)).sort(),
      [AAPL, MSFT].sort(),
    );
  });

  it("trims the winner and tops up the laggard toward equal weight", () => {
    const holdings = new Map<string, Holding>([
      ["AAPL", { token: AAPL, rawBalance: 10n ** 18n, valueUsdg: U(80), priceStale: false }],
      ["MSFT", { token: MSFT, rawBalance: 10n ** 18n, valueUsdg: U(20), priceStale: false }],
    ]);
    const out = evenKeelTick(cfg, snap({ holdings, cashUsdg: U(50) }));
    const sell = out.find((i) => i.kind === "swap" && i.sellToken === AAPL);
    const buy = out.find((i) => i.kind === "swap" && i.buyToken === MSFT);
    assert.ok(sell, "should trim overweight AAPL");
    assert.ok(buy, "should top up underweight MSFT");
  });

  it("stays flat when the sequencer is down", () => {
    assert.deepEqual(evenKeelTick(cfg, snap({ sequencerUp: false })), []);
  });
});

describe("dip-hunter", () => {
  const cfg: DipHunterConfig = {
    legs: [
      { symbol: "AAPL", token: AAPL },
      { symbol: "MSFT", token: MSFT },
    ],
    swapRouter: ROUTER,
    usdg: USDG,
    buyPerTickUsdg: U(25),
    minDipBps: 150,
  };

  it("no dip on the first sighting → no trade; then buys the deepest dip", async () => {
    const s = makeDipHunter(cfg);
    // First tick establishes the rolling highs at 100/100 — nothing is down yet.
    assert.deepEqual(await s.tick(snap()), []);
    // AAPL falls 5% below its high; MSFT flat → concentrate the budget on AAPL.
    const out = await s.tick(
      snap({
        prices: new Map([
          ["AAPL", { price8: P(95), stale: false }],
          ["MSFT", { price8: P(100), stale: false }],
        ]),
      }),
    );
    assert.equal(out.length, 1);
    assert.ok(out[0]!.kind === "swap" && out[0]!.buyToken === AAPL && out[0]!.notionalUsdg === U(25));
  });

  it("holds when cash can't cover a buy", async () => {
    const s = makeDipHunter(cfg);
    assert.deepEqual(await s.tick(snap({ cashUsdg: U(1) })), []);
  });
});
