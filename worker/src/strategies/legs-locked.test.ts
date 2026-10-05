/**
 * A LEG THE SIGNED KEY CANNOT SELL BACK IS SKIPPED, NOT REFUSED EVERY TICK.
 *
 * Before the snapshot carried entry gates (entry-gates.ts), every builtin
 * proposed such a leg, checkPolicy refused it with `no-exit`, and the next tick
 * proposed it again — for the life of the grant. These pin what each builtin
 * does with the hint now:
 *
 *   - the locked leg's BUY is never proposed, and every other leg is unchanged;
 *   - an EXIT is never gated — a take-profit, a trim, a gap exit still go;
 *   - when nothing else could have bought, the tick says `legs-locked`, once,
 *     behind the breaker and the count and (for the basket) behind a closed
 *     market, whose 24/7 fallback is untouched;
 *   - an absent hint changes nothing at all.
 *
 * Behavioural, because every tick here is pure.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { entryGatesOf } from "../entry-gates";
import { makeDipHunter } from "./dip-hunter";
import { evenKeelTick, type EvenKeelConfig } from "./even-keel";
import { renderWhy } from "./reasons";
import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import type { Snapshot, Tick } from "./types";
import { weekendGapTick, type WeekendGapConfig } from "./weekend-gap";
import type { CurveLeg } from "../strategist/proposals";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const QQQ = "0x4444444444444444444444444444444444444444" as const;
const NVDA = "0x5555555555555555555555555555555555555555" as const;
const MEME = "0x6666666666666666666666666666666666666666" as const;
const PEPE = "0x7777777777777777777777777777777777777777" as const;
const CURVE = "0x8888888888888888888888888888888888888888" as const;
const ADAPTER = "0x9999999999999999999999999999999999999999" as const;

/** Every leg is watched; MEME is the one the signature does not cover. */
const gates = (sellable: string[] = [USDG, QQQ, NVDA, PEPE]) =>
  entryGatesOf({ allowedAssets: [USDG, QQQ, NVDA, MEME, PEPE], sellableAssets: sellable });
const NONE_SELLABLE = gates([USDG]);

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: 100_000_000n,
  vaultUsdg: 0n,
  holdings: new Map(),
  prices: new Map(),
  pausedTokens: new Set(),
  staleFeeds: new Set(),
  sequencerUp: true,
  spendHeadroomUsdg: 1_000_000_000_000n,
  perTradeCapUsdg: 1_000_000_000_000n,
  entryGates: gates(),
  ...over,
});

const buys = (t: Tick) => t.intents.filter((i) => i.kind === "swap" && i.sellToken === USDG);
const bought = (t: Tick) => buys(t).map((i) => (i.kind === "swap" ? i.buyToken : null));

describe("steady-basket", () => {
  const cfg = (over: Partial<SteadyBasketConfig> = {}): SteadyBasketConfig => ({
    legs: [
      { symbol: "QQQ", token: QQQ, weightBps: 3_333 },
      { symbol: "NVDA", token: NVDA, weightBps: 3_333 },
      { symbol: "MEME", token: MEME, weightBps: 3_334 },
    ],
    buyPerTickUsdg: 25_000_000n,
    idleFloorUsdg: 1_000_000_000n,
    swapRouter: ROUTER,
    vault: VAULT,
    usdg: USDG,
    ...over,
  });
  // One curve leg, PEPE, with room enough that one tick's buy clears the
  // impact ceiling — so the only thing that can stop the fallback is the gate.
  const curve = () => ({
    legs: new Map([["PEPE", leg()]]),
    tokens: new Map([["PEPE", PEPE as `0x${string}`]]),
    slippageBps: 100,
    maxImpactBps: 10_000,
  });

  it("SKIPS THE LOCKED LEG and buys every other one, saying nothing about idling", () => {
    const t = steadyBasketTick(cfg(), snap());
    assert.deepEqual(bought(t), [QQQ, NVDA]);
    assert.equal(t.idle, undefined, "a tick that bought is not idle");
  });

  it("the unlocked legs are sized exactly as before — the gate only removes", () => {
    const withGate = steadyBasketTick(cfg(), snap());
    const without = steadyBasketTick(cfg(), snap({ entryGates: undefined }));
    assert.deepEqual(withGate.intents, without.intents.filter((i) => !(i.kind === "swap" && i.buyToken === MEME)));
  });

  it("an absent hint changes nothing: all three legs, as before the gate existed", () => {
    assert.deepEqual(bought(steadyBasketTick(cfg(), snap({ entryGates: undefined }))), [QQQ, NVDA, MEME]);
    assert.deepEqual(bought(steadyBasketTick(cfg(), snap({ entryGates: null }))), [QQQ, NVDA, MEME]);
  });

  it("EVERY NON-STALE LEG LOCKED — no buy, and legs-locked says why", () => {
    const t = steadyBasketTick(cfg(), snap({ staleFeeds: new Set(["QQQ"]), entryGates: gates([USDG, QQQ]) }));
    assert.equal(buys(t).length, 0);
    assert.deepEqual(t.idle, { code: "legs-locked", legs: 3, locked: 2 });
    assert.match(renderWhy(t.idle!), /can't sell back 2 of the 3 legs/);
  });

  it("counts the basket, not the tick: a locked leg that is also stale is still locked", () => {
    const t = steadyBasketTick(cfg(), snap({ staleFeeds: new Set(["QQQ"]), entryGates: NONE_SELLABLE }));
    assert.deepEqual(t.idle, { code: "legs-locked", legs: 3, locked: 3 });
  });

  it("SHUT IS UNCHANGED — a closed market is all-legs-stale whatever is locked, and the fallback still fires", () => {
    const allStale = new Set(["QQQ", "NVDA", "MEME"]);
    const t = steadyBasketTick(cfg(), snap({ staleFeeds: allStale, entryGates: NONE_SELLABLE }));
    assert.equal(t.idle?.code, "all-legs-stale");

    // MEME is locked AND stale: still counted as stale, so the fallback fires.
    const fell = steadyBasketTick(cfg({ curve: curve() }), snap({ staleFeeds: allStale, entryGates: gates() }));
    assert.equal(fell.intents.filter((i) => i.kind === "curve-trade").length, 1, "the 24/7 fallback is untouched");
  });

  it("pickCurveBuy asks the curve gate: a curve token outside the signed grant is never the fallback", () => {
    const allStale = new Set(["QQQ", "NVDA", "MEME"]);
    const t = steadyBasketTick(cfg({ curve: curve() }), snap({ staleFeeds: allStale, entryGates: gates([USDG, QQQ, NVDA]) }));
    assert.equal(t.intents.filter((i) => i.kind === "curve-trade").length, 0);
    assert.equal(t.idle?.code, "all-legs-stale", "and the tick still says the true thing");
  });

  it("legs-locked is AHEAD of under-one-buy — more cash would not buy a locked leg", () => {
    const t = steadyBasketTick(cfg(), snap({ cashUsdg: 5_000_000n, entryGates: NONE_SELLABLE }));
    assert.equal(t.idle?.code, "legs-locked");
  });

  it("and BEHIND the breaker and the count, which forbid every buy anyway", () => {
    const braked = steadyBasketTick(cfg(), snap({ entryGates: NONE_SELLABLE, drawdown: { bps: 2_000, limitBps: 1_000 } }));
    assert.equal(braked.idle?.code, "breaker-tripped");
    const counted = steadyBasketTick(cfg(), snap({ entryGates: NONE_SELLABLE, opsHeadroom: 0 }));
    assert.equal(counted.idle?.code, "ops-spent");
  });

  it("AN EXIT IS NEVER GATED — the take-profit on a locked leg is still proposed", () => {
    const holdings = new Map([
      ["MEME", { token: MEME, rawBalance: 10n ** 18n, valueUsdg: 30_000_000n, priceStale: false, costUsdg: 10_000_000n }],
    ]);
    const t = steadyBasketTick(cfg({ takeProfitBps: 5_000 }), snap({ holdings, entryGates: NONE_SELLABLE }));
    const sell = t.intents.find((i) => i.kind === "swap" && i.sellToken === MEME);
    assert.ok(sell, "the gate is asked about buys only");
  });
});

describe("even-keel", () => {
  const cfg: EvenKeelConfig = {
    legs: [
      { symbol: "QQQ", token: QQQ },
      { symbol: "NVDA", token: NVDA },
      { symbol: "MEME", token: MEME },
    ],
    swapRouter: ROUTER,
    usdg: USDG,
    maxTradeUsdg: 20_000_000n,
    bandBps: 500,
    seedBudgetUsdg: 30_000_000n,
  };
  const hold = (values: Record<string, bigint>) =>
    new Map(
      Object.entries(values).map(([symbol, valueUsdg]) => [
        symbol,
        { token: cfg.legs.find((l) => l.symbol === symbol)!.token, rawBalance: valueUsdg * 10n ** 12n, valueUsdg, priceStale: false },
      ]),
    );

  it("SEEDS ONLY THE LEGS IT CAN OWN, and splits the seed across them", () => {
    const t = evenKeelTick(cfg, snap());
    assert.deepEqual(bought(t), [QQQ, NVDA]);
    assert.deepEqual(
      t.intents.map((i) => (i.kind === "swap" ? i.sellAmountRaw : 0n)),
      [15_000_000n, 15_000_000n],
      "the book is two legs, not three with one forever empty",
    );
  });

  it("NO CHURN: a seeded book of the legs it can own is balanced, so nothing is trimmed", () => {
    const t = evenKeelTick(cfg, snap({ holdings: hold({ QQQ: 15_000_000n, NVDA: 15_000_000n }) }));
    assert.equal(t.intents.length, 0, "a locked leg at zero must not make the others read as overweight");
  });

  it("a HELD locked leg stays in the book: its trim is proposed, its top-up is not", () => {
    const over = evenKeelTick(cfg, snap({ holdings: hold({ QQQ: 10_000_000n, NVDA: 10_000_000n, MEME: 40_000_000n }) }));
    assert.ok(over.intents.some((i) => i.kind === "swap" && i.sellToken === MEME), "the exit is never gated");
    // Above the target it is weighed like any leg, so the cash its trim frees
    // goes to the legs the key can still buy.
    assert.deepEqual(bought(over), [QQQ, NVDA], "and the legs it can own are topped up toward the same target");
    const under = evenKeelTick(cfg, snap({ holdings: hold({ QQQ: 20_000_000n, NVDA: 20_000_000n, MEME: 2_000_000n }) }));
    assert.ok(!under.intents.some((i) => i.kind === "swap" && i.buyToken === MEME), "its top-up is the refused buy");
  });

  it("NO CHURN FROM DUST: a held locked leg BELOW target is not weighed, so the legs it can own are not trimmed", () => {
    // The reviewer's case: two 50 USDG legs beside 1 USDG of a leg the key
    // cannot buy. Weighed, it made the target 33.67 and trimmed both legs
    // toward it, every tick, down to 2.9 each in eight ticks.
    const dust = evenKeelTick(cfg, snap({ holdings: hold({ QQQ: 50_000_000n, NVDA: 50_000_000n, MEME: 1_000_000n }) }));
    assert.deepEqual(dust.intents, [], "a balanced book of the legs it can own is left alone");
    assert.equal(dust.idle, undefined, "and that is a healthy quiet tick, not an idle one");
    const under = evenKeelTick(cfg, snap({ holdings: hold({ QQQ: 20_000_000n, NVDA: 20_000_000n, MEME: 2_000_000n }) }));
    assert.deepEqual(under.intents, [], "the same at any size below the target");
  });

  it("dropping one locked leg can drop the next: the target settles on what can still move", () => {
    // NVDA is locked too here. 60 + 35 + 5: the first target (33.33) drops
    // MEME, the second (47.5) drops NVDA, and QQQ alone sits at its own target.
    const twoLocked = gates([USDG, QQQ, PEPE]);
    const t = evenKeelTick(cfg, snap({ entryGates: twoLocked, holdings: hold({ QQQ: 60_000_000n, NVDA: 35_000_000n, MEME: 5_000_000n }) }));
    assert.deepEqual(t.intents, [], "nothing is trimmed toward legs that can never be bought back up");
  });

  it("EVERY TRADABLE LEG LOCKED BUT SOME HELD — nothing trimmed toward the smaller, and legs-locked says why", () => {
    const t = evenKeelTick(cfg, snap({ entryGates: NONE_SELLABLE, holdings: hold({ QQQ: 50_000_000n, NVDA: 10_000_000n }) }));
    assert.deepEqual(t.intents, []);
    assert.deepEqual(t.idle, { code: "legs-locked", legs: 3, locked: 3 });
    const braked = evenKeelTick(
      cfg,
      snap({ entryGates: NONE_SELLABLE, holdings: hold({ QQQ: 50_000_000n, NVDA: 10_000_000n }), drawdown: { bps: 2_000, limitBps: 1_000 } }),
    );
    assert.equal(braked.idle?.code, "breaker-tripped", "behind the breaker");
  });

  it("EVERY TRADABLE LEG LOCKED AND NONE HELD — legs-locked, once, and nothing proposed", () => {
    const t = evenKeelTick(cfg, snap({ entryGates: NONE_SELLABLE }));
    assert.equal(t.intents.length, 0);
    assert.deepEqual(t.idle, { code: "legs-locked", legs: 3, locked: 3 });
  });

  it("behind the breaker, as everywhere else", () => {
    const t = evenKeelTick(cfg, snap({ entryGates: NONE_SELLABLE, drawdown: { bps: 2_000, limitBps: 1_000 } }));
    assert.equal(t.idle?.code, "breaker-tripped");
  });

  it("an absent hint seeds all three, as before", () => {
    assert.deepEqual(bought(evenKeelTick(cfg, snap({ entryGates: undefined }))), [QQQ, NVDA, MEME]);
  });
});

describe("dip-hunter", () => {
  const legs = [
    { symbol: "QQQ", token: QQQ },
    { symbol: "MEME", token: MEME },
  ];
  const hunter = () =>
    makeDipHunter({ legs, swapRouter: ROUTER, usdg: USDG, buyPerTickUsdg: 10_000_000n, minDipBps: 150 });
  const prices = (qqq: bigint, meme: bigint) =>
    new Map([
      ["QQQ", { price8: qqq, stale: false }],
      ["MEME", { price8: meme, stale: false }],
    ]) as unknown as Snapshot["prices"];

  it("A LOCKED LEG IS NEVER THE PICK, even with the deeper dip — the next deepest is", async () => {
    const s = hunter();
    await s.tick(snap({ prices: prices(100_00000000n, 100_00000000n) }));
    const t = (await s.tick(snap({ prices: prices(97_00000000n, 50_00000000n) }))) as Tick;
    assert.deepEqual(bought(t), [QQQ]);
    // And the sentence counts only what it chose among, so "the deepest of the
    // N I priced" is never a claim to have beaten a dip it could not buy.
    assert.equal(t.why[0]?.code === "dip" && t.why[0].priced, 1);
  });

  it("A LOCKED LEG KEEPS ITS ROLLING HIGH, so a re-sign measures against the real peak", async () => {
    const s = hunter();
    await s.tick(snap({ prices: prices(100_00000000n, 100_00000000n), entryGates: NONE_SELLABLE }));
    await s.tick(snap({ prices: prices(100_00000000n, 200_00000000n), entryGates: NONE_SELLABLE }));
    // Re-signed: MEME is now buyable, and 180 is 10% off the 200 high it saw while locked.
    const resigned = gates([USDG, QQQ, NVDA, MEME]);
    const t = (await s.tick(snap({ prices: prices(100_00000000n, 180_00000000n), entryGates: resigned }))) as Tick;
    assert.deepEqual(bought(t), [MEME]);
    assert.equal(t.why[0]?.code === "dip" && t.why[0].dipBps, 1_000);
  });

  it("EVERY PRICED LEG LOCKED — legs-locked, not a silence that reads as 'no dip'", async () => {
    const s = hunter();
    const t = (await s.tick(snap({ prices: prices(100_00000000n, 100_00000000n), entryGates: NONE_SELLABLE }))) as Tick;
    assert.deepEqual(t.idle, { code: "legs-locked", legs: 2, locked: 2 });
  });

  it("behind the count and the breaker", async () => {
    const s = hunter();
    const counted = (await s.tick(snap({ prices: prices(1n, 1n), entryGates: NONE_SELLABLE, opsHeadroom: 0 }))) as Tick;
    assert.equal(counted.idle?.code, "ops-spent");
  });
});

describe("weekend-gap", () => {
  const cfg: WeekendGapConfig = {
    legs: [
      { symbol: "QQQ", token: QQQ, weightBps: 5_000 },
      { symbol: "MEME", token: MEME, weightBps: 5_000 },
    ],
    enterBudgetUsdg: 20_000_000n,
    swapRouter: ROUTER,
    usdg: USDG,
  };
  const closed = new Set(["QQQ", "MEME"]);

  it("enters at the close on every leg but the locked one", () => {
    assert.deepEqual(bought(weekendGapTick(cfg, snap({ staleFeeds: closed }))), [QQQ]);
  });

  it("EVERY ENTRY LOCKED — legs-locked", () => {
    const t = weekendGapTick(cfg, snap({ staleFeeds: closed, entryGates: NONE_SELLABLE }));
    assert.equal(t.intents.length, 0);
    assert.deepEqual(t.idle, { code: "legs-locked", legs: 2, locked: 2 });
  });

  it("THE EXIT AT THE OPEN IS NEVER GATED", () => {
    const holdings = new Map([["MEME", { token: MEME, rawBalance: 10n ** 18n, valueUsdg: 9_000_000n, priceStale: false }]]);
    const t = weekendGapTick(cfg, snap({ holdings, entryGates: NONE_SELLABLE }));
    assert.ok(t.intents.some((i) => i.kind === "swap" && i.sellToken === MEME));
    assert.equal(t.idle, undefined);
  });

  it("the breaker still speaks first", () => {
    const t = weekendGapTick(cfg, snap({ staleFeeds: closed, entryGates: NONE_SELLABLE, drawdown: { bps: 2_000, limitBps: 1_000 } }));
    assert.equal(t.idle?.code, "breaker-tripped");
  });
});

/** A curve with room in it — reserves large enough that one tick barely moves it. */
function leg(): CurveLeg {
  return {
    curve: CURVE,
    quoteToken: USDG,
    adapter: ADAPTER,
    reserves: {
      quoteRaw: 400_000_000n,
      tokenRaw: 4_000_000_000_000_000_000_000n,
      quoteDecimals: 6,
      tokenDecimals: 18,
      graduationThresholdRaw: 5_000_000_000n,
    },
  } as CurveLeg;
}
