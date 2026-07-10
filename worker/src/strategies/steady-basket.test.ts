import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { steadyBasketTick, type Snapshot, type SteadyBasketConfig } from "./steady-basket";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const MSFT = "0x5555555555555555555555555555555555555555" as const;

function cfg(over: Partial<SteadyBasketConfig> = {}): SteadyBasketConfig {
  return {
    legs: [
      { symbol: "AAPL", token: AAPL, weightBps: 5_000 },
      { symbol: "MSFT", token: MSFT, weightBps: 5_000 },
    ],
    buyPerTickUsdg: 20_000_000n, // 20 USDG per tick
    idleFloorUsdg: 50_000_000n, // keep 50 USDG liquid
    rialtoRouter: ROUTER,
    vault: VAULT,
    usdg: USDG,
    ...over,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    cashUsdg: 100_000_000n, // 100 USDG
    vaultUsdg: 0n,
    pausedTokens: new Set<string>(),
    staleFeeds: new Set<string>(),
    sequencerUp: true,
    ...over,
  };
}

describe("steadyBasketTick", () => {
  it("emits nothing when the sequencer is down", () => {
    assert.deepEqual(steadyBasketTick(cfg(), snap({ sequencerUp: false })), []);
  });

  it("splits the tick budget across legs by weight", () => {
    const intents = steadyBasketTick(cfg(), snap());
    const swaps = intents.filter((i) => i.kind === "swap");
    assert.equal(swaps.length, 2);
    for (const s of swaps) {
      assert.equal(s.kind === "swap" && s.sellAmountUsdg, 10_000_000n);
      assert.equal(s.target, ROUTER);
    }
  });

  it("skips paused tokens but still buys the rest", () => {
    const intents = steadyBasketTick(
      cfg(),
      snap({ pausedTokens: new Set([AAPL.toLowerCase()]) }),
    );
    const swaps = intents.filter((i) => i.kind === "swap");
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0]!.kind === "swap" && swaps[0]!.buyToken, MSFT);
  });

  it("skips legs with a stale price feed", () => {
    const intents = steadyBasketTick(cfg(), snap({ staleFeeds: new Set(["MSFT"]) }));
    const swaps = intents.filter((i) => i.kind === "swap");
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0]!.kind === "swap" && swaps[0]!.buyToken, AAPL);
  });

  it("does not buy when cash is below the tick budget", () => {
    const intents = steadyBasketTick(cfg(), snap({ cashUsdg: 19_000_000n }));
    assert.equal(intents.filter((i) => i.kind === "swap").length, 0);
  });

  it("sweeps idle cash above the floor into the vault", () => {
    // 100 cash - 20 buys = 80 idle, floor 50 → deposit 30
    const intents = steadyBasketTick(cfg(), snap());
    const deposit = intents.find((i) => i.kind === "vault-deposit");
    assert.ok(deposit);
    assert.equal(deposit.kind === "vault-deposit" && deposit.amountUsdg, 30_000_000n);
    assert.equal(deposit.target, VAULT);
  });

  it("leaves cash alone when at or below the idle floor", () => {
    const intents = steadyBasketTick(cfg(), snap({ cashUsdg: 70_000_000n }));
    // 70 - 20 = 50 idle, exactly at floor → no deposit
    assert.equal(intents.find((i) => i.kind === "vault-deposit"), undefined);
  });

  it("withdraws from the vault when cash cannot cover a buy", () => {
    const intents = steadyBasketTick(
      cfg(),
      snap({ cashUsdg: 5_000_000n, vaultUsdg: 200_000_000n }),
    );
    // Withdraw-only tick: top cash up to buyPerTick (20) + floor (50) = 70 → need 65
    assert.equal(intents.length, 1);
    const w = intents[0]!;
    assert.equal(w.kind, "vault-withdraw");
    assert.equal(w.kind === "vault-withdraw" && w.amountUsdg, 65_000_000n);
  });

  it("withdrawal is capped at the vault balance", () => {
    const intents = steadyBasketTick(
      cfg(),
      snap({ cashUsdg: 0n, vaultUsdg: 12_000_000n }),
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.kind === "vault-withdraw" && intents[0]!.amountUsdg, 12_000_000n);
  });

  it("does not withdraw when the vault is empty", () => {
    const intents = steadyBasketTick(cfg(), snap({ cashUsdg: 5_000_000n, vaultUsdg: 0n }));
    assert.deepEqual(intents, []);
  });
});
