import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBacktest, type Bar } from "./backtest";
import { steadyBasketTick, type SteadyBasketConfig } from "./strategies/steady-basket";
import { weekendGapTick, type WeekendGapConfig } from "./strategies/weekend-gap";
import type { AgentLimits } from "./policy";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;

const LEGS = new Map<string, `0x${string}`>([["AAPL", AAPL]]);
const usd = (v: number) => BigInt(Math.round(v * 1e8));
const U = (v: number) => BigInt(Math.round(v * 1e6));

function limits(over: Partial<AgentLimits> = {}): AgentLimits {
  return {
    perTradeUsdg: U(50),
    dailyUsdg: U(10_000),
    allowedTargets: [ROUTER, VAULT, USDG],
    allowedAssets: [USDG, AAPL],
    maxDrawdownBps: 5_000,
    expiresAt: 10_000_000_000,
    maxOpsPerDay: 1_000,
    ...over,
  };
}

describe("runBacktest — real strategies, real policy, synthetic prices", () => {
  it("steady basket DCAs in and sweeps idle cash to the vault", async () => {
    const cfg: SteadyBasketConfig = {
      legs: [{ symbol: "AAPL", token: AAPL, weightBps: 10_000 }],
      buyPerTickUsdg: U(25),
      idleFloorUsdg: U(50),
      swapRouter: ROUTER,
      vault: VAULT,
      usdg: USDG,
    };
    const bars: Bar[] = Array.from({ length: 5 }, (_, i) => ({
      tSec: 1000 + i * 60,
      prices: new Map([["AAPL", usd(200)]]),
    }));

    const r = await runBacktest(
      {
        strategy: { name: "basket", tick: (s) => steadyBasketTick(cfg, s) },
        limits: limits(),
        legs: LEGS,
        initialCashUsdg: U(200),
        executionCostBps: 0,
      },
      bars,
    );

    assert.ok(r.executed > 0, "trades executed");
    // Flat price + zero cost → equity conserved
    assert.equal(r.finalEquityUsdg, U(200));
    assert.equal(r.maxDrawdownBps, 0);
  });

  it("execution costs show up as P&L drag, honestly", async () => {
    const cfg: SteadyBasketConfig = {
      legs: [{ symbol: "AAPL", token: AAPL, weightBps: 10_000 }],
      buyPerTickUsdg: U(25),
      idleFloorUsdg: U(1_000),
      swapRouter: ROUTER,
      vault: VAULT,
      usdg: USDG,
    };
    const bars: Bar[] = Array.from({ length: 3 }, (_, i) => ({
      tSec: 1000 + i * 60,
      prices: new Map([["AAPL", usd(200)]]),
    }));
    const r = await runBacktest(
      {
        strategy: { name: "basket", tick: (s) => steadyBasketTick(cfg, s) },
        limits: limits(),
        legs: LEGS,
        initialCashUsdg: U(100),
        executionCostBps: 100, // 1% per swap
      },
      bars,
    );
    assert.ok(r.pnlUsdg < 0n, "costs are drag");
  });

  it("weekend gap captures an up-gap: enter at close, exit at open, profit", async () => {
    const cfg: WeekendGapConfig = {
      legs: [{ symbol: "AAPL", token: AAPL, weightBps: 10_000 }],
      enterBudgetUsdg: U(100),
      swapRouter: ROUTER,
      usdg: USDG,
    };
    const closed = new Set(["AAPL"]);
    const bars: Bar[] = [
      { tSec: 0, prices: new Map([["AAPL", usd(200)]]) }, // open, flat — nothing to do
      { tSec: 60, prices: new Map([["AAPL", usd(200)]]), staleSymbols: closed }, // close → ENTER
      { tSec: 120, prices: new Map([["AAPL", usd(200)]]), staleSymbols: closed }, // holding
      { tSec: 180, prices: new Map([["AAPL", usd(210)]]) }, // reopen +5% → EXIT
      { tSec: 240, prices: new Map([["AAPL", usd(210)]]) },
    ];
    const r = await runBacktest(
      {
        strategy: { name: "gap", tick: (s) => weekendGapTick(cfg, s) },
        limits: limits({ perTradeUsdg: U(200) }),
        legs: LEGS,
        initialCashUsdg: U(150),
        executionCostBps: 0,
      },
      bars,
    );
    assert.equal(r.executed, 2); // one entry, one exit
    assert.equal(r.pnlUsdg, U(5)); // 100 USDG position × +5%
  });

  it("the policy wall binds inside the backtest too", async () => {
    const cfg: SteadyBasketConfig = {
      legs: [{ symbol: "AAPL", token: AAPL, weightBps: 10_000 }],
      buyPerTickUsdg: U(100), // above the 50 per-trade cap
      idleFloorUsdg: U(10_000),
      swapRouter: ROUTER,
      vault: VAULT,
      usdg: USDG,
    };
    const r = await runBacktest(
      {
        strategy: { name: "basket", tick: (s) => steadyBasketTick(cfg, s) },
        limits: limits(),
        legs: LEGS,
        initialCashUsdg: U(500),
      },
      [{ tSec: 0, prices: new Map([["AAPL", usd(200)]]) }],
    );
    assert.equal(r.executed, 0);
    assert.deepEqual(r.rejected, [{ rule: "per-trade-cap", count: 1 }]);
  });

  it("vault APY accrues over time", async () => {
    const noop = { name: "noop", tick: () => [] };
    // Seed vault by starting with a deposit strategy? Simpler: deposit via basket sweep.
    const cfg: SteadyBasketConfig = {
      legs: [],
      buyPerTickUsdg: U(1_000_000), // never buys
      idleFloorUsdg: 0n, // sweep everything
      swapRouter: ROUTER,
      vault: VAULT,
      usdg: USDG,
    };
    const yearBars: Bar[] = [
      { tSec: 0, prices: new Map() },
      { tSec: 365 * 86_400, prices: new Map() },
    ];
    const r = await runBacktest(
      {
        strategy: { name: "sweep", tick: (s) => steadyBasketTick(cfg, s) },
        limits: limits({ perTradeUsdg: U(10_000), dailyUsdg: U(100_000) }),
        legs: LEGS,
        initialCashUsdg: U(1_000),
        vaultApyBps: 700, // 7%
      },
      yearBars,
    );
    void noop;
    // 1000 deposited at t=0, one year at 7% simple → ~1070
    assert.equal(r.finalEquityUsdg, U(1_070));
  });
});
