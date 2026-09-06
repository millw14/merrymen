/**
 * THE VENUE THAT SKIPPED EVERY BUDGET.
 *
 * `scoutContextFor` returned undefined for anything that was not a swap, and
 * the scout block in policy.ts sat inside `if (intent.kind === "swap")`. So a
 * curve trade — a buy into a bonding-curve memecoin, the least priceable asset
 * class on this chain — passed the wall without the scout budget ever being
 * consulted.
 *
 * That was survivable only because the sole producer of a curve trade was an
 * owner typing one into chat: a person spending their own money, deliberately,
 * one at a time. The moment the strategist can emit one, the same gap is an
 * autonomous, unbudgeted buy path.
 *
 * And nothing else covers it. The drawdown breaker cannot: a curve mark is
 * barred from ratcheting the high-water mark, so the breaker measures that book
 * from a lower reference. The scout budget is the only wall an unpriceable
 * asset has, and both defaults — `scoutEnabled: false`, `scoutBudgetUsdg: 0` —
 * mean it refuses by default, which is the state every agent is in today.
 *
 * The per-action ceiling had the same hole for the same reason: it sat below
 * the curve branch's `continue`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  checkPolicy,
  type AgentLimits,
  type AgentState,
  type ScoutContext,
  type TradeIntent,
} from "./policy";

const NOW = 1_800_000_000;

const USDG = "0x3333333333333333333333333333333333333333" as const;
const MEME = "0x7777777777777777777777777777777777777777" as const;
const ADAPTER = "0x8888888888888888888888888888888888888888" as const;

/** The default state of every agent: the scout is off and its budget is zero. */
const shutScout: ScoutContext = {
  limits: { enabled: false, budgetUsdg: 0n, perTokenUsdg: 0n },
  buyUnpriceable: true,
  existingCostUsdg: 0n,
  quarantinedUsdg: 0n,
};

const curveBuy = (over: Partial<Extract<TradeIntent, { kind: "curve-trade" }>> = {}) =>
  ({
    kind: "curve-trade",
    target: ADAPTER,
    curve: ADAPTER,
    assetIn: USDG,
    assetOut: MEME,
    amountInRaw: 5_000_000n,
    minOutRaw: 1n,
    notionalUsdg: 5_000_000n,
    ...over,
  }) as TradeIntent;

function limits(over: Partial<AgentLimits> = {}): AgentLimits {
  return {
    perTradeUsdg: 100_000_000n,
    dailyUsdg: 1_000_000_000n,
    allowedTargets: [ADAPTER, USDG],
    allowedAssets: [USDG, MEME],
    sellableAssets: [USDG, MEME],
    curveAdapters: [ADAPTER],
    maxDrawdownBps: 10_000,
    expiresAt: NOW + 86_400,
    maxOpsPerDay: 100,
    ...over,
  } as AgentLimits;
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

describe("the scout budget covers the curve venue", () => {
  it("AN UNPRICEABLE CURVE BUY IS REFUSED WHEN THE SCOUT IS SHUT", () => {
    const v = checkPolicy(curveBuy(), limits(), state(), shutScout);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.rule, "scout-budget");
  });

  it("a priceable curve buy is untouched by it", () => {
    const v = checkPolicy(curveBuy(), limits(), state(), { ...shutScout, buyUnpriceable: false });
    assert.equal(v.ok, true, "only an unpriceable ACQUISITION is budgeted");
  });

  it("SELLING OUT OF ONE IS NEVER BLOCKED", () => {
    // Getting out of a position nobody can price must always be attemptable —
    // the caller only ever reports `buyUnpriceable` about the asset being
    // acquired, so a sell carries a false and never reaches the rule.
    const v = checkPolicy(curveBuy({ assetIn: MEME, assetOut: USDG }), limits(), state(), {
      ...shutScout,
      buyUnpriceable: false,
    });
    assert.equal(v.ok, true);
  });
});

describe("the wiring that made both holes", () => {
  it("scoutContextFor answers for a curve trade, not only a swap", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("async function scoutContextFor("));
    assert.ok(
      !/if \(intent\.kind !== "swap"/.test(fn.slice(0, 2400)),
      "the early return on non-swap is what skipped the budget",
    );
    assert.match(fn.slice(0, 2400), /intent\.kind === "curve-trade" \? intent\.assetOut/);
  });

  it("THE SCOUT BLOCK IS NOT NESTED INSIDE THE SWAP BRANCH", () => {
    // The pin that stops a future venue inheriting the same hole: the block
    // must sit at the top level of checkPolicy, not inside a kind branch.
    const src = readFileSync(new URL("./policy.ts", import.meta.url), "utf8");
    const swapAt = src.indexOf('if (intent.kind === "swap") {');
    const scoutAt = src.indexOf("if (scout?.buyUnpriceable");
    const transferAt = src.indexOf('if (intent.kind === "transfer") {');
    assert.ok(swapAt > 0 && scoutAt > 0 && transferAt > 0);
    assert.ok(scoutAt > swapAt, "it still comes after the swap-specific rules");
    assert.ok(scoutAt < transferAt, "and before the next kind branch");
    // Indented at the top level — two spaces, not four.
    assert.match(src.slice(scoutAt - 3, scoutAt), /\n {2}$/, "the block must not be nested");
  });

  it("the per-action ceiling covers both venues too", () => {
    // It used to sit below the curve branch's `continue`, so the one venue with
    // no on-chain amount condition also had no off-chain ceiling.
    const src = readFileSync(new URL("./strategist/proposals.ts", import.meta.url), "utf8");
    const fn = src.slice(
      src.indexOf("export function proposalsToIntents("),
      src.indexOf("export function proposalsToEquityIntents("),
    );
    const ceiling = fn.indexOf("size > universe.maxPerActionUsdg");
    const curve = fn.indexOf("const curveLeg = universe.curveLegs?.get(p.symbol)");
    assert.ok(ceiling > 0 && curve > 0);
    assert.ok(ceiling < curve, "the ceiling must be checked before the curve branch can `continue` past it");
  });
});
