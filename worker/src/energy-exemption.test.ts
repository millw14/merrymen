import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEnergyStatus } from "../../packages/core/src/index";
import {
  claimCap,
  energyExemptAccountsOf,
  energyLevel,
  energyModeForAccount,
  energyPlan,
  energyStatus,
  shouldTellOwnerSpent,
} from "./energy";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";

const ACCOUNT = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER = "0x1234567890abcdef1234567890abcdef12345679";
const NOW = Math.floor(Date.parse("2026-10-11T12:00:00Z") / 1000);
const PARTS = { account: 0n, holder: undefined };

function planFor(account: string, exempt = energyExemptAccountsOf(ACCOUNT)) {
  return energyPlan({
    mode: energyModeForAccount("enforce", account, exempt),
    level: energyLevel(PARTS, null, NOW).level,
    counters: { reviews: 100, entries: 5, toldAt: null },
    reviewsAllowed: 29,
    entriesAllowed: 2,
    nowSec: NOW,
  });
}

describe("operator energy exemption identity", () => {
  it("accepts complete comma-separated addresses case-insensitively and removes duplicates", () => {
    assert.deepEqual(energyExemptAccountsOf(` ${ACCOUNT}, 0x${ACCOUNT.slice(2).toUpperCase()},${OTHER} `), [ACCOUNT, OTHER]);
    assert.equal(energyModeForAccount("enforce", `0x${ACCOUNT.slice(2).toUpperCase()}`, energyExemptAccountsOf(ACCOUNT)), "observe");
  });

  it("an absent or invalid list exempts nobody, including invalid entries beside a valid one", () => {
    for (const raw of [undefined, "", " ", "all", "Alan", "@alan", ACCOUNT.slice(0, 14), `${ACCOUNT},`, `${ACCOUNT},all`, `${ACCOUNT},${OTHER}g`, `0x${"0".repeat(40)}`, `['${ACCOUNT}']`]) {
      assert.deepEqual(energyExemptAccountsOf(raw), [], String(raw));
      assert.equal(energyModeForAccount("enforce", ACCOUNT, energyExemptAccountsOf(raw)), "enforce", String(raw));
    }
  });

  it("matches only the whole account and never turns on a disabled or observe-only gate", () => {
    const exempt = energyExemptAccountsOf(ACCOUNT);
    for (const candidate of [OTHER, "Alan", "@alan", ACCOUNT.slice(0, 20), `${ACCOUNT}00`, ""]) {
      assert.equal(energyModeForAccount("enforce", candidate, exempt), "enforce", candidate);
    }
    assert.equal(energyModeForAccount("off", ACCOUNT, exempt), "off");
    assert.equal(energyModeForAccount("observe", ACCOUNT, exempt), "observe");
  });
});

describe("energy exemption effect", () => {
  it("opens only the named account's energy allowances without pretending it holds tokens", () => {
    const plan = planFor(ACCOUNT);
    assert.equal(plan.reviews.open, true);
    assert.equal(plan.entries.open, true);
    assert.equal(plan.enforce, false);
    assert.equal(claimCap(plan, "reviews", NOW), Number.MAX_SAFE_INTEGER, "reviews still use the durable claim path");
    assert.equal(claimCap(plan, "entries", NOW), Number.MAX_SAFE_INTEGER, "entries still use the durable claim/refund path");
    assert.equal(shouldTellOwnerSpent(plan), false);
    const report = energyStatus({ plan, parts: PARTS, hasReviewer: true, buy: "ready", estimateUsdg: null, nowSec: NOW });
    assert.equal(report.mode, "observe");
    assert.equal(report.gated, false);
    assert.equal(report.level, "low");
    assert.equal(report.agentTokens, 0);
    assert.equal(report.holderTokens, null);
    assert.equal(report.holderCounted, false);
    assert.equal(report.spent, false);
    assert.equal(report.reviews?.used, 100);
    assert.equal(report.entries?.used, 5);
    assert.deepEqual(parseEnergyStatus(JSON.stringify(report)), report);

    const neighbor = planFor(OTHER);
    assert.equal(neighbor.mode, "enforce");
    assert.equal(neighbor.reviews.open, false);
    assert.equal(neighbor.entries.open, false);
    assert.equal(shouldTellOwnerSpent(neighbor), true);
  });

  it("revocation immediately resumes enforcement against existing counts", () => {
    const before = planFor(ACCOUNT);
    const after = planFor(ACCOUNT, []);
    assert.equal(before.entries.used, after.entries.used);
    assert.equal(before.reviews.used, after.reviews.used);
    assert.equal(after.entries.open, false);
    assert.equal(after.reviews.open, false);
    assert.equal(after.enforce, true);
  });

  it("does not change the signed spending caps or asset and drawdown checks", () => {
    const router = "0x3333333333333333333333333333333333333333";
    const cash = "0x4444444444444444444444444444444444444444";
    const coin = "0x5555555555555555555555555555555555555555";
    const limits: AgentLimits = {
      perTradeUsdg: 10_000_000n,
      dailyUsdg: 50_000_000n,
      allowedTargets: [router],
      allowedAssets: [cash, coin],
      maxDrawdownBps: 1_000,
      expiresAt: NOW + 86_400,
      maxOpsPerDay: 24,
    };
    const state: AgentState = { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: 100_000_000n, equityUsdg: 100_000_000n, nowSec: NOW };
    const intent: TradeIntent = { kind: "swap", target: router, sellToken: cash, buyToken: coin, sellAmountRaw: 10_000_000n, notionalUsdg: 10_000_000n };
    assert.equal(planFor(ACCOUNT).entries.open, true);
    assert.equal(checkPolicy(intent, limits, state).ok, true);
    assert.equal(checkPolicy({ ...intent, sellAmountRaw: 11_000_000n, notionalUsdg: 11_000_000n }, limits, state).ok, false);
    assert.equal(checkPolicy(intent, limits, { ...state, spentTodayUsdg: 45_000_000n }).ok, false);
    assert.equal(checkPolicy(intent, limits, { ...state, equityUsdg: 80_000_000n }).ok, false);
    assert.equal(checkPolicy({ ...intent, buyToken: OTHER }, limits, state).ok, false);
  });
});
