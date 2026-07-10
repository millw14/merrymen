import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { weekendGapTick, type WeekendGapConfig } from "./weekend-gap";
import type { Holding, Snapshot } from "./types";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const MSFT = "0x5555555555555555555555555555555555555555" as const;

function cfg(over: Partial<WeekendGapConfig> = {}): WeekendGapConfig {
  return {
    legs: [
      { symbol: "AAPL", token: AAPL, weightBps: 5_000 },
      { symbol: "MSFT", token: MSFT, weightBps: 5_000 },
    ],
    enterBudgetUsdg: 100_000_000n, // 100 USDG per gap window
    swapRouter: ROUTER,
    usdg: USDG,
    ...over,
  };
}

function holding(token: `0x${string}`, rawBalance: bigint, valueUsdg: bigint): Holding {
  return { token, rawBalance, valueUsdg, priceStale: true };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    cashUsdg: 200_000_000n, // 200 USDG
    vaultUsdg: 0n,
    holdings: new Map(),
    pausedTokens: new Set<string>(),
    staleFeeds: new Set<string>(),
    sequencerUp: true,
    ...over,
  };
}

const CLOSED = new Set(["AAPL", "MSFT"]); // both feeds stale = markets closed

describe("weekendGapTick", () => {
  it("emits nothing when the sequencer is down", () => {
    assert.deepEqual(
      weekendGapTick(cfg(), snap({ staleFeeds: CLOSED, sequencerUp: false })),
      [],
    );
  });

  it("market open + no holdings → flat, nothing to do", () => {
    assert.deepEqual(weekendGapTick(cfg(), snap()), []);
  });

  it("ENTERs when the market closes: buys each leg's slice of the budget", () => {
    const intents = weekendGapTick(cfg(), snap({ staleFeeds: CLOSED }));
    assert.equal(intents.length, 2);
    for (const i of intents) {
      assert.equal(i.kind, "swap");
      assert.equal(i.kind === "swap" && i.sellToken, USDG);
      assert.equal(i.kind === "swap" && i.sellAmountRaw, 50_000_000n);
      assert.equal(i.kind === "swap" && i.notionalUsdg, 50_000_000n);
    }
  });

  it("holds through the closed market — does not re-enter what it already holds", () => {
    const intents = weekendGapTick(
      cfg(),
      snap({
        staleFeeds: CLOSED,
        holdings: new Map([["AAPL", holding(AAPL, 10n ** 17n, 48_000_000n)]]),
      }),
    );
    // AAPL held → nothing; MSFT not held → enter
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.kind === "swap" && intents[0]!.buyToken, MSFT);
  });

  it("EXITs the full position when the market reopens", () => {
    const intents = weekendGapTick(
      cfg(),
      snap({
        staleFeeds: new Set(), // feeds fresh = open
        holdings: new Map([["AAPL", holding(AAPL, 123n, 48_000_000n)]]),
      }),
    );
    assert.equal(intents.length, 1);
    const s = intents[0]!;
    assert.equal(s.kind === "swap" && s.sellToken, AAPL);
    assert.equal(s.kind === "swap" && s.buyToken, USDG);
    assert.equal(s.kind === "swap" && s.sellAmountRaw, 123n); // full raw balance
    assert.equal(s.kind === "swap" && s.notionalUsdg, 48_000_000n); // policy sees value
  });

  it("mixed state: exits the reopened leg while entering the still-closed one", () => {
    const intents = weekendGapTick(
      cfg(),
      snap({
        staleFeeds: new Set(["MSFT"]), // AAPL open, MSFT closed
        holdings: new Map([["AAPL", holding(AAPL, 5n, 1_000_000n)]]),
      }),
    );
    assert.equal(intents.length, 2);
    const sell = intents.find((i) => i.kind === "swap" && i.sellToken === AAPL);
    const buy = intents.find((i) => i.kind === "swap" && i.buyToken === MSFT);
    assert.ok(sell && buy);
  });

  it("skips entry when cash cannot cover the slice", () => {
    const intents = weekendGapTick(
      cfg(),
      snap({ staleFeeds: CLOSED, cashUsdg: 49_000_000n }),
    );
    assert.deepEqual(intents, []);
  });

  it("never touches a paused token in either direction", () => {
    const closed = weekendGapTick(
      cfg(),
      snap({ staleFeeds: CLOSED, pausedTokens: new Set([AAPL.toLowerCase()]) }),
    );
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.kind === "swap" && closed[0]!.buyToken, MSFT);

    const open = weekendGapTick(
      cfg(),
      snap({
        pausedTokens: new Set([AAPL.toLowerCase()]),
        holdings: new Map([["AAPL", holding(AAPL, 5n, 1_000_000n)]]),
      }),
    );
    assert.deepEqual(open, []);
  });
});
