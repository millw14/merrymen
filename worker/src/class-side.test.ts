/**
 * A CLASS SELL IS NOT A PURCHASE, and the scout budget must not treat it as one.
 *
 * WHAT WAS WRONG. `scoutContextFor` decided "class buy" from
 * `kind === "curve-trade" && target === ponsClassVault`. A class SELL targets
 * the same vault, so an exit was flagged `buyUnpriceable` and policy.ts:520
 * charged its PROCEEDS against `scoutBudgetUsdg` on top of the class cost
 * already held. Under the canary preset (budget 15, 5 USDG entries) that refuses
 * any exit whose proceeds exceed `15 - heldCost`: one 5 USDG position that more
 * than doubled could never be sold, and with three positions held nothing could
 * exit at all. policy.ts stated the opposite as an invariant — "sells are
 * untouched" — and nothing had ever checked it.
 *
 * WHY THESE TESTS LOOK LIKE THIS. curve-budget.test.ts:101-110 "proves" sells
 * are safe by passing `buyUnpriceable: false` BY HAND and never asks where that
 * flag comes from — which is exactly how the bug lived beside a passing test.
 * Here the flag comes from `scoutFlagsFor`, the function `scoutContextFor`
 * actually calls, fed intents shaped exactly as the two real producers shape
 * them, and the result is pushed through the real `checkPolicy`. The old rule is
 * reproduced in-test so its refusal is demonstrated rather than described.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { classSideOf, scoutFlagsFor } from "./class-side";
import {
  checkPolicy,
  type AgentLimits,
  type AgentState,
  type ScoutContext,
  type TradeIntent,
} from "./policy";

const NOW = 1_800_000_000;
const usdg = (n: number) => BigInt(Math.round(n * 1e6));

const USDG = "0x3333333333333333333333333333333333333333" as const;
const TOKEN = "0x7777777777777777777777777777777777777777" as const;
const CURVE = "0x6666666666666666666666666666666666666666" as const;
/** The per-account PonsClassVault sealed in the grant. */
const VAULT = "0x9999999999999999999999999999999999999999" as const;
/** The PonsSelfTrade adapter — a curve venue that is NOT the vault. */
const SELF_TRADE = "0x8888888888888888888888888888888888888888" as const;

/** A class ENTRY, shaped as proposeClassEntries builds it (index.ts ~1436). */
const classBuy = (spend = usdg(5)): TradeIntent =>
  ({
    kind: "curve-trade",
    target: VAULT,
    curve: CURVE,
    assetIn: USDG,
    assetOut: TOKEN,
    amountInRaw: spend,
    minAmountOutRaw: 1n,
    notionalUsdg: spend,
  }) as TradeIntent;

/** A class EXIT, shaped as proposeClassExits builds it (index.ts ~2048). */
const classSell = (proceeds = usdg(11)): TradeIntent =>
  ({
    kind: "curve-trade",
    target: VAULT,
    curve: CURVE,
    assetIn: TOKEN,
    assetOut: USDG,
    amountInRaw: 1_000_000_000_000_000_000n,
    minAmountOutRaw: 1n,
    notionalUsdg: proceeds,
  }) as TradeIntent;

function limits(over: Partial<AgentLimits> = {}): AgentLimits {
  return {
    perTradeUsdg: usdg(100),
    dailyUsdg: usdg(1000),
    allowedTargets: [VAULT, SELF_TRADE, USDG],
    allowedAssets: [USDG, TOKEN],
    sellableAssets: [USDG, TOKEN],
    curveAdapters: [SELF_TRADE],
    ponsClassVault: VAULT,
    // The launch feed, as the tick builds it: factory-filtered curves PLUS the
    // curves of every held class position (provenanceCurves in index.ts), so a
    // position's exit always has provenance. Without it checkPolicy refuses on
    // curve-provenance before the scout rule is ever reached.
    knownCurves: [CURVE],
    maxDrawdownBps: 10_000,
    expiresAt: NOW + 86_400,
    maxOpsPerDay: 100,
    ...over,
  } as AgentLimits;
}

function state(over: Partial<AgentState> = {}): AgentState {
  return { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: 0n, equityUsdg: 0n, nowSec: NOW, ...over };
}

/**
 * THE REAL CALLER'S CONTEXT. Built the way scoutContextFor builds it — the
 * flags from `scoutFlagsFor`, the limits from the canary preset
 * (scoutEnabled true, scoutBudgetUsdg 15, scoutPerTokenUsdg default 25),
 * `existingCostUsdg` = what this token already cost, `quarantinedUsdg` = every
 * class position's cost. Nothing here is a hand-set flag.
 */
function contextFor(
  intent: TradeIntent,
  o: { heldCostUsdg: bigint; thisTokenCostUsdg: bigint; lastUnpriceable?: ReadonlySet<string> },
): ScoutContext {
  const flags = scoutFlagsFor(intent, { vault: VAULT, cash: USDG, lastUnpriceable: o.lastUnpriceable ?? new Set() });
  return {
    limits: { enabled: true, budgetUsdg: usdg(15), perTokenUsdg: usdg(25) },
    buyUnpriceable: flags.buyUnpriceable,
    existingCostUsdg: o.thisTokenCostUsdg,
    quarantinedUsdg: o.heldCostUsdg,
  };
}

/** The rule as it was — target alone. Kept so the bug is DEMONSTRATED. */
const legacyIsClassBuy = (intent: TradeIntent) =>
  intent.kind === "curve-trade" && intent.target.toLowerCase() === VAULT.toLowerCase();

describe("the side of a class trade comes from its assets", () => {
  it("a class buy spends the quote asset to acquire the token", () => {
    assert.equal(classSideOf(classBuy(), VAULT, USDG), "buy");
  });

  it("a class sell spends the token and gets the quote asset back", () => {
    assert.equal(classSideOf(classSell(), VAULT, USDG), "sell");
  });

  it("the old rule could not tell them apart — that is the bug", () => {
    assert.equal(legacyIsClassBuy(classBuy()), true);
    assert.equal(legacyIsClassBuy(classSell()), true, "a SELL was judged a buy");
  });

  it("a curve trade at the PonsSelfTrade adapter is not a class trade at all", () => {
    // PonsSelfTrade is untouched: it never targets the vault, so the class
    // classifier says nothing about it and the pre-existing behaviour holds.
    const selfTrade = { ...classBuy(), target: SELF_TRADE } as TradeIntent;
    assert.equal(classSideOf(selfTrade, VAULT, USDG), null);
    const flags = scoutFlagsFor(selfTrade, { vault: VAULT, cash: USDG, lastUnpriceable: new Set() });
    assert.equal(flags.isClassBuy, false);
    assert.equal(flags.buyUnpriceable, false);
    // ...and still budgeted when the tick could not price its token.
    const unpriced = scoutFlagsFor(selfTrade, { vault: VAULT, cash: USDG, lastUnpriceable: new Set([TOKEN]) });
    assert.equal(unpriced.buyUnpriceable, true);
  });

  it("no sealed vault means no class trade", () => {
    assert.equal(classSideOf(classBuy(), undefined, USDG), null);
  });

  it("fails CLOSED on a shape neither producer emits", () => {
    // Both sides cash, or neither: budget it as a buy rather than wave it
    // through as a sell. A malformed intent must never be the free pass.
    assert.equal(classSideOf({ ...classBuy(), assetOut: USDG } as TradeIntent, VAULT, USDG), "buy");
    assert.equal(classSideOf({ ...classBuy(), assetIn: TOKEN } as TradeIntent, VAULT, USDG), "buy");
  });
});

describe("through the real policy: a 5 USDG class BUY is budgeted", () => {
  it("is flagged unpriceable, so the scout budget is consulted", () => {
    const flags = scoutFlagsFor(classBuy(), { vault: VAULT, cash: USDG, lastUnpriceable: new Set() });
    assert.equal(flags.side, "buy");
    assert.equal(flags.isClassBuy, true);
    assert.equal(flags.buyUnpriceable, true, "a class buy is unpriceable by construction");
  });

  it("passes when it fits the budget", () => {
    // One position held (5), buying 5 more: 5 + 5 = 10 <= 15.
    const v = checkPolicy(classBuy(), limits(), state(), contextFor(classBuy(), { heldCostUsdg: usdg(5), thisTokenCostUsdg: 0n }));
    assert.equal(v.ok, true, v.ok === false ? `${v.rule}: ${v.detail}` : "");
  });

  it("is REFUSED when it would exceed the budget — the budget still binds on buys", () => {
    // Three positions held (15), buying 5 more: 15 + 5 = 20 > 15.
    const v = checkPolicy(classBuy(), limits(), state(), contextFor(classBuy(), { heldCostUsdg: usdg(15), thisTokenCostUsdg: 0n }));
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.rule, "scout-budget");
  });
});

describe("through the real policy: a class SELL is never scout-budgeted", () => {
  const SELL_11 = classSell(usdg(11));

  it("11 USDG of proceeds, budget 15, held cost 5 → NOT refused by scout budget", () => {
    const flags = scoutFlagsFor(SELL_11, { vault: VAULT, cash: USDG, lastUnpriceable: new Set([TOKEN]) });
    assert.equal(flags.side, "sell");
    assert.equal(flags.buyUnpriceable, false, "a sell acquires cash; it cannot be an unpriceable acquisition");

    const v = checkPolicy(SELL_11, limits(), state(), contextFor(SELL_11, { heldCostUsdg: usdg(5), thisTokenCostUsdg: usdg(5) }));
    assert.equal(v.ok, true, v.ok === false ? `${v.rule}: ${v.detail}` : "");
  });

  it("and under the OLD rule that exact sell WAS refused — 5 held + 11 proceeds > 15", () => {
    // The bug, reproduced: flag the sell the way the target-only rule did and
    // push it through the same policy. This is the refusal Shogun's exit hit.
    const asLegacy: ScoutContext = {
      ...contextFor(SELL_11, { heldCostUsdg: usdg(5), thisTokenCostUsdg: usdg(5) }),
      buyUnpriceable: legacyIsClassBuy(SELL_11),
    };
    const v = checkPolicy(SELL_11, limits(), state(), asLegacy);
    assert.equal(v.ok, false, "the legacy flag should have refused this sell");
    assert.equal(v.ok === false && v.rule, "scout-budget");
  });

  it("the better the trade, the more certain the old refusal — a 3x is still sellable now", () => {
    const sell15 = classSell(usdg(15));
    const v = checkPolicy(sell15, limits(), state(), contextFor(sell15, { heldCostUsdg: usdg(5), thisTokenCostUsdg: usdg(5) }));
    assert.equal(v.ok, true, v.ok === false ? `${v.rule}: ${v.detail}` : "");
  });
});

describe("three open positions: exits remain possible at the ceiling", () => {
  // The state the position ceiling produces under CANARY: 3 x 5 USDG held, so
  // quarantinedUsdg == budgetUsdg. The old rule made every exit impossible here.
  const held = usdg(15);

  it("a sell out of a full book is allowed", () => {
    const sell = classSell(usdg(11));
    const v = checkPolicy(sell, limits(), state(), contextFor(sell, { heldCostUsdg: held, thisTokenCostUsdg: usdg(5) }));
    assert.equal(v.ok, true, v.ok === false ? `${v.rule}: ${v.detail}` : "");
  });

  it("a sell of each of the three is allowed — not just the first", () => {
    for (const proceeds of [usdg(11), usdg(4), usdg(30)]) {
      const sell = classSell(proceeds);
      const v = checkPolicy(sell, limits(), state(), contextFor(sell, { heldCostUsdg: held, thisTokenCostUsdg: usdg(5) }));
      assert.equal(v.ok, true, `proceeds ${proceeds}: ${v.ok === false ? `${v.rule}: ${v.detail}` : ""}`);
    }
  });

  it("while a BUY into that full book is still refused", () => {
    const v = checkPolicy(classBuy(), limits(), state(), contextFor(classBuy(), { heldCostUsdg: held, thisTokenCostUsdg: 0n }));
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.rule, "scout-budget");
  });

  it("under the OLD rule no exit from a full book was possible", () => {
    for (const proceeds of [usdg(1), usdg(11)]) {
      const sell = classSell(proceeds);
      const asLegacy = { ...contextFor(sell, { heldCostUsdg: held, thisTokenCostUsdg: usdg(5) }), buyUnpriceable: true };
      const v = checkPolicy(sell, limits(), state(), asLegacy);
      assert.equal(v.ok, false, `legacy should refuse proceeds ${proceeds}`);
    }
  });
});

describe("exits stay subject to the real exit policy", () => {
  // Removing the scout budget from sells must not remove anything else. The
  // provenance rule is the one that vouches for a curve being a Pons curve at
  // all, and a sell is still judged by it.
  it("a sell whose curve is not in the launch feed is still refused on provenance", () => {
    const sell = classSell(usdg(11));
    const OTHER = "0x5555555555555555555555555555555555555555" as const;
    const v = checkPolicy(sell, limits({ knownCurves: [OTHER] }), state(), contextFor(sell, { heldCostUsdg: usdg(5), thisTokenCostUsdg: usdg(5) }));
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.rule, "curve-provenance");
  });

  it("a sell with no readable launch feed is still refused — unreadable is not known", () => {
    const sell = classSell(usdg(11));
    const v = checkPolicy(sell, limits({ knownCurves: undefined }), state(), contextFor(sell, { heldCostUsdg: usdg(5), thisTokenCostUsdg: usdg(5) }));
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.rule, "curve-provenance");
  });
});

describe("the wiring", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function scoutContextFor("));

  it("scoutContextFor takes its flags from class-side.ts", () => {
    assert.match(fn.slice(0, 4000), /scoutFlagsFor\(intent, \{/);
    assert.match(fn.slice(0, 4000), /cash: CASH\.USDG/);
  });

  it("the target-only derivation is gone", () => {
    // The three-line rule this replaces. If it comes back, a sell is a buy again.
    assert.ok(
      !/const isClassBuy =\s*\n\s*intent\.kind === "curve-trade" &&\s*\n\s*active\.limits\.ponsClassVault !== undefined/.test(fn),
      "isClassBuy is derived from kind + target alone again",
    );
  });

  it("the buyToken expression curve-budget.test.ts pins is still there", () => {
    // That test slices the first 2400 chars of scoutContextFor for it; the fix
    // must not have pushed it out of range.
    assert.match(fn.slice(0, 2400), /intent\.kind === "curve-trade" \? intent\.assetOut/);
  });
});
