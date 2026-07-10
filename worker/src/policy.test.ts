import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const EVIL = "0x9999999999999999999999999999999999999999" as const;

const NOW = 1_800_000_000;

function limits(over: Partial<AgentLimits> = {}): AgentLimits {
  return {
    perTradeUsdg: 50_000_000n, // 50 USDG
    dailyUsdg: 500_000_000n, // 500 USDG
    allowedTargets: [ROUTER, VAULT, USDG],
    allowedAssets: [USDG, AAPL],
    maxDrawdownBps: 1_000, // 10%
    expiresAt: NOW + 86_400,
    maxOpsPerDay: 48,
    ...over,
  };
}

function state(over: Partial<AgentState> = {}): AgentState {
  return {
    spentTodayUsdg: 0n,
    opsToday: 0,
    highWaterMarkUsdg: 0n,
    equityUsdg: 0n,
    nowSec: NOW,
    ...over,
  };
}

function swap(over: Partial<Extract<TradeIntent, { kind: "swap" }>> = {}): TradeIntent {
  return {
    kind: "swap",
    target: ROUTER,
    sellToken: USDG,
    buyToken: AAPL,
    sellAmountRaw: 25_000_000n,
    notionalUsdg: 25_000_000n,
    ...over,
  };
}

describe("checkPolicy", () => {
  it("approves a legal swap", () => {
    assert.deepEqual(checkPolicy(swap(), limits(), state()), { ok: true });
  });

  it("rejects after expiry, regardless of everything else", () => {
    const v = checkPolicy(swap(), limits(), state({ nowSec: NOW + 86_401 }));
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.rule, "expiry");
  });

  it("rejects a target that is not allowlisted", () => {
    const v = checkPolicy(swap({ target: EVIL }), limits(), state());
    assert.equal(!v.ok && v.rule, "target-allowlist");
  });

  it("target allowlist is case-insensitive", () => {
    const upper = ROUTER.toUpperCase().replace("0X", "0x") as `0x${string}`;
    assert.deepEqual(checkPolicy(swap({ target: upper }), limits(), state()), { ok: true });
  });

  it("rejects a swap involving a non-allowlisted asset", () => {
    const v = checkPolicy(swap({ buyToken: EVIL }), limits(), state());
    assert.equal(!v.ok && v.rule, "asset-allowlist");
  });

  it("rejects a trade above the per-trade cap", () => {
    const v = checkPolicy(swap({ sellAmountRaw: 50_000_001n, notionalUsdg: 50_000_001n }), limits(), state());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });

  it("allows a trade exactly at the per-trade cap", () => {
    assert.deepEqual(checkPolicy(swap({ sellAmountRaw: 50_000_000n, notionalUsdg: 50_000_000n }), limits(), state()), { ok: true });
  });

  it("rejects when the daily cap would be exceeded", () => {
    const v = checkPolicy(swap(), limits(), state({ spentTodayUsdg: 490_000_000n }));
    assert.equal(!v.ok && v.rule, "daily-cap");
  });

  it("counts existing spend toward the daily cap, not just this trade", () => {
    assert.deepEqual(
      checkPolicy(swap(), limits(), state({ spentTodayUsdg: 475_000_000n })),
      { ok: true },
    );
  });

  it("trips the drawdown breaker at the threshold", () => {
    // HWM 1000, equity 900 → exactly 10% drawdown → halt
    const v = checkPolicy(
      swap(),
      limits(),
      state({ highWaterMarkUsdg: 1_000_000_000n, equityUsdg: 900_000_000n }),
    );
    assert.equal(!v.ok && v.rule, "drawdown-breaker");
  });

  it("does not trip the breaker just below the threshold", () => {
    const v = checkPolicy(
      swap(),
      limits(),
      state({ highWaterMarkUsdg: 1_000_000_000n, equityUsdg: 901_000_000n }),
    );
    assert.deepEqual(v, { ok: true });
  });

  it("ignores drawdown before any high-water mark exists", () => {
    assert.deepEqual(
      checkPolicy(swap(), limits(), state({ highWaterMarkUsdg: 0n, equityUsdg: 0n })),
      { ok: true },
    );
  });

  it("rejects once the daily ops budget is spent", () => {
    const v = checkPolicy(swap(), limits(), state({ opsToday: 48 }));
    assert.equal(!v.ok && v.rule, "ops-cap");
  });

  it("vault deposits obey the same caps", () => {
    const v = checkPolicy(
      { kind: "vault-deposit", target: VAULT, amountUsdg: 50_000_001n },
      limits(),
      state(),
    );
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });

  it("vault withdrawals are exempt from spend caps (funds return to the account)", () => {
    const v = checkPolicy(
      { kind: "vault-withdraw", target: VAULT, amountUsdg: 10_000_000_000n },
      limits(),
      state({ spentTodayUsdg: 500_000_000n }),
    );
    assert.deepEqual(v, { ok: true });
  });

  it("vault withdrawals still respect expiry and the ops cap", () => {
    const intent: TradeIntent = { kind: "vault-withdraw", target: VAULT, amountUsdg: 1n };
    const expired = checkPolicy(intent, limits(), state({ nowSec: NOW + 86_401 }));
    assert.equal(!expired.ok && expired.rule, "expiry");
    const throttled = checkPolicy(intent, limits(), state({ opsToday: 48 }));
    assert.equal(!throttled.ok && throttled.rule, "ops-cap");
  });
});
