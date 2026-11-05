/**
 * A HELD COIN WHOSE BALANCE DID NOT READ IS ABSENT, NOT SOLD.
 *
 * The tick now keeps running while one held coin's balance row fails, and that
 * coin leaves the snapshot's `holdings` whole — its size is unknown. Every
 * strategy that reads absence had to be told the difference:
 *
 *   - ENTRIES ARE WITHHELD, the way a tripped breaker withholds them
 *     (entryBrake): the wall refuses every non-exit while a holding is unread
 *     (policy.ts holding-unread), so a buy proposed now is a refusal a tick —
 *     for days, for a coin whose balanceOf reverts — and a paid review behind
 *     it for the Trencher;
 *   - EVEN-KEEL STANDS DOWN WHOLE while one of its legs is unread: it reads an
 *     absent leg as zero and would trim every other leg toward it, and trims
 *     are exits the wall lets through;
 *   - EXITS OF EVERYTHING ELSE STILL GO.
 *
 * Proposals are run through the real checkPolicy with the coin unread, so the
 * brake is tested against the rule it anticipates rather than a copy of it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "../policy";
import { heldUnreadOf } from "../unread-held";
import { classEntryGate } from "../class-entry-gate";
import { makeDipHunter } from "./dip-hunter";
import { evenKeelTick, type EvenKeelConfig } from "./even-keel";
import { publishesIdle, renderWhy } from "./reasons";
import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import { makeTrencher, TRENCHER_DEFAULTS, type Candidate, type OpenPosition } from "./trencher";
import { drawdownOf, entryBrake, takeTick, type Holding, type Snapshot, type Tick } from "./types";
import { weekendGapTick } from "./weekend-gap";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const QQQ = "0x4444444444444444444444444444444444444444" as const;
const NVDA = "0x5555555555555555555555555555555555555555" as const;
const TSLA = "0x6666666666666666666666666666666666666666" as const;
const GATO = "0x436b01e41314d4b010edd24cf7c997a7d111c0ab" as const;
const CATE = "0x00000000000000000000000000000000000000c1" as const;

const TRIPPED = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 875_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });
/** GATO is held and its balance did not read: absent from `holdings`, named here. */
const UNREAD = new Set(["GATO"]);

const legs = [
  { symbol: "QQQ", token: QQQ, weightBps: 3333 },
  { symbol: "NVDA", token: NVDA, weightBps: 3333 },
  { symbol: "TSLA", token: TSLA, weightBps: 3333 },
];
const basket = (over: Partial<SteadyBasketConfig> = {}): SteadyBasketConfig => ({
  legs,
  buyPerTickUsdg: 25_000_000n,
  idleFloorUsdg: 50_000_000n,
  swapRouter: ROUTER,
  vault: VAULT,
  usdg: USDG,
  ...over,
});
const keel = (over: Partial<EvenKeelConfig> = {}): EvenKeelConfig => ({
  legs,
  swapRouter: ROUTER,
  usdg: USDG,
  maxTradeUsdg: 10n ** 12n,
  bandBps: 500,
  seedBudgetUsdg: 30_000_000n,
  ...over,
});
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: 900_000_000n,
  vaultUsdg: 0n,
  holdings: new Map(),
  prices: new Map(),
  pausedTokens: new Set(),
  staleFeeds: new Set(),
  sequencerUp: true,
  spendHeadroomUsdg: 1_000_000_000_000n,
  perTradeCapUsdg: 1_000_000_000_000n,
  ...over,
});
const h = (token: `0x${string}`, valueUsdg: bigint, costUsdg?: bigint): Holding => ({
  token,
  rawBalance: 10n ** 18n,
  valueUsdg,
  priceStale: false,
  ...(costUsdg === undefined ? {} : { costUsdg }),
});
const buysOf = (t: Tick) => t.intents.filter((i) => i.kind === "swap" && i.sellToken === USDG);
const sellsOf = (t: Tick) => t.intents.filter((i) => i.kind === "swap" && i.buyToken === USDG);

/** The real wall, with GATO unread and equity unknown — as the tick hands it over. */
const limits: AgentLimits = {
  perTradeUsdg: 1_000_000_000_000n,
  dailyUsdg: 1_000_000_000_000n,
  allowedTargets: [ROUTER, VAULT, USDG],
  allowedAssets: [USDG, QQQ, NVDA, TSLA, GATO, CATE],
  cashToken: USDG,
  maxDrawdownBps: 1_000,
  expiresAt: 2_000_000_000,
  maxOpsPerDay: 1_000,
};
const blind: AgentState = {
  spentTodayUsdg: 0n,
  opsToday: 0,
  highWaterMarkUsdg: 1_000_000_000n,
  equityUsdg: 500_000_000n,
  equityKnown: false,
  heldUnread: heldUnreadOf(["GATO"], [{ symbol: "GATO", address: GATO }]),
  nowSec: 1_800_000_000,
};
const refusedFor = (intents: TradeIntent[]) =>
  intents.filter((i) => {
    const v = checkPolicy(i, limits, blind);
    return !v.ok && v.rule === "holding-unread";
  });

describe("entryBrake — the breaker first, else an unread holding", () => {
  it("an unread holding withholds entries, by count", () => {
    assert.deepEqual(entryBrake(snap({ unreadHeld: UNREAD })), { code: "holding-unread", holdings: 1 });
    assert.deepEqual(entryBrake(snap({ unreadHeld: new Set(["GATO", "DELTA"]), drawdown: null })), { code: "holding-unread", holdings: 2 });
  });

  it("A TRIPPED BREAKER IS STILL NAMED FIRST — the more fundamental fact", () => {
    assert.equal(entryBrake(snap({ unreadHeld: UNREAD, drawdown: TRIPPED }))?.code, "breaker-tripped");
  });

  it("neither, absent or empty, brakes nothing", () => {
    assert.equal(entryBrake(snap()), undefined);
    assert.equal(entryBrake(snap({ unreadHeld: new Set() })), undefined);
  });

  it("the owner hears it as a read gap with selling unaffected; the public never does", () => {
    const w = { code: "holding-unread", holdings: 1 } as const;
    const s = renderWhy(w);
    assert.match(s, /^nothing bought/);
    assert.match(s, /can't read the balance of one coin/);
    assert.match(s, /Other sells are never refused by this; a rebalancing basket waits/);
    assert.ok(s.length < 220, `over the /why truncation point: ${s.length}`);
    assert.equal(publishesIdle(w), false, "account state, like the breaker");
  });
});

describe("EVEN-KEEL: a leg it cannot read is not a leg at zero", () => {
  // QQQ worth 50 and in band against itself; TSLA held but its balance unread.
  const book = new Map([
    ["QQQ", h(QQQ, 50_000_000n)],
    ["NVDA", h(NVDA, 50_000_000n)],
  ]);

  it("THE HAZARD, with nothing telling it: the absent leg reads as zero and the readable legs are trimmed toward it", () => {
    const t = evenKeelTick(keel(), snap({ holdings: book, cashUsdg: 0n }));
    assert.ok(sellsOf(t).length > 0, "the control: absence read as zero trims the legs that did read");
  });

  it("TOLD THE LEG IS UNREAD, IT STANDS DOWN WHOLE — no trim and no top-up, and it says why", () => {
    const t = evenKeelTick(keel(), snap({ holdings: book, cashUsdg: 0n, unreadHeld: new Set(["TSLA"]) }));
    assert.deepEqual(t.intents, []);
    assert.equal(t.idle?.code, "holding-unread");
  });

  it("an unread coin that is NOT a leg leaves the rebalance as it was, and withholds only the buys", () => {
    const skewed = new Map([
      ["QQQ", h(QQQ, 300_000_000n)],
      ["NVDA", h(NVDA, 100_000_000n)],
      ["TSLA", h(TSLA, 30_000_000n)],
    ]);
    const before = evenKeelTick(keel(), snap({ holdings: skewed }));
    assert.ok(buysOf(before).length > 0 && sellsOf(before).length > 0, "the control trims and tops up");
    const t = evenKeelTick(keel(), snap({ holdings: skewed, unreadHeld: UNREAD }));
    assert.deepEqual(sellsOf(t), sellsOf(before), "the trims are exits, and still go");
    assert.deepEqual(buysOf(t), [], "the top-ups would be refused");
  });
});

describe("the builtins withhold entries and keep their exits", () => {
  it("STEADY-BASKET: no buy and no park, and the reason; the take-profit still goes", () => {
    const t = steadyBasketTick(basket(), snap({ unreadHeld: UNREAD }));
    assert.deepEqual(buysOf(t), []);
    assert.equal(t.intents.some((i) => i.kind === "vault-deposit"), false);
    assert.equal(t.idle?.code, "holding-unread");
    const tp = steadyBasketTick(
      basket({ takeProfitBps: 1_000 }),
      snap({ unreadHeld: UNREAD, holdings: new Map([["NVDA", h(NVDA, 30_000_000n, 20_000_000n)]]) }),
    );
    assert.equal(sellsOf(tp).length, 1);
    assert.ok(buysOf(steadyBasketTick(basket(), snap())).length > 0, "the control buys");
  });

  it("DIP-HUNTER: a dip while a holding is unread is not bought, and says why", async () => {
    const cfg = { legs: [{ symbol: "NVDA", token: NVDA }], swapRouter: ROUTER, usdg: USDG, buyPerTickUsdg: 25_000_000n, minDipBps: 100 };
    const priced = (price8: bigint) => new Map([["NVDA", { price8, stale: false, updatedAt: 1, source: "chainlink" as const }]]);
    const d = makeDipHunter(cfg);
    await d.tick(snap({ prices: priced(100_00000000n) }));
    const t = takeTick(await d.tick(snap({ prices: priced(90_00000000n), unreadHeld: UNREAD })));
    assert.deepEqual(t.intents, []);
    assert.equal(t.idle?.code, "holding-unread");
  });

  it("WEEKEND-GAP: the unread leg is NOT re-entered at the close — absent is not 'not held'", () => {
    const gap = { legs: [{ symbol: "GATO", token: GATO, weightBps: 10_000 }], enterBudgetUsdg: 20_000_000n, swapRouter: ROUTER, usdg: USDG };
    const control = weekendGapTick(gap, snap({ staleFeeds: new Set(["GATO"]) }));
    assert.equal(buysOf(control).length, 1, "the control enters an absent leg at the close");
    const t = weekendGapTick(gap, snap({ staleFeeds: new Set(["GATO"]), unreadHeld: UNREAD }));
    assert.deepEqual(t.intents, []);
    assert.equal(t.idle?.code, "holding-unread");
  });

  it("THE CLASS ROUTE: no entries, and the reason when something would have bought", () => {
    assert.deepEqual(classEntryGate({ snap: snap({ unreadHeld: UNREAD }), routeLooks: true, idle: undefined }), {
      propose: false,
      idle: { code: "holding-unread", holdings: 1 },
    });
    assert.equal(classEntryGate({ snap: snap(), routeLooks: true, idle: undefined }).propose, true, "the control proposes");
  });
});

describe("THE TRENCHER: exits first, then no entry is even asked about", () => {
  const candidate = (): Candidate => ({
    symbol: "CATE",
    token: CATE,
    decimals: 18,
    priceable: true,
    liquidityUsd: 120_000,
    fdvUsd: 800_000,
    ageSec: 45 * 60,
    price8: 100_000n,
  });
  const position = (over: Partial<OpenPosition> = {}): OpenPosition => ({
    symbol: "HELD",
    token: "0x00000000000000000000000000000000000000d2",
    entryPrice8: 100_000n,
    entryLiquidityUsd: 100_000,
    entrySec: Math.floor(Date.now() / 1000) - 60,
    costUsdg: 5_000_000n,
    qtyRaw: 10n ** 18n,
    ...over,
  });
  const trencher = (o: { open?: OpenPosition[]; unpriceable?: string[]; listed?: { n: number }; asked?: string[] } = {}) =>
    makeTrencher({
      cfg: TRENCHER_DEFAULTS,
      swapRouter: ROUTER,
      usdgToken: USDG,
      brainRequired: true,
      brainOrder: (symbol, _token, _price8, held) => {
        o.asked?.push(`${symbol}:${held ? "held" : "entry"}`);
        return held ? null : { side: "buy", usdgAmount: 5, decisionId: "d1" };
      },
      candidates: () => {
        if (o.listed) o.listed.n += 1;
        return [candidate()];
      },
      open: () => o.open ?? [],
      liquidityOf: () => null,
      unpriceable: () => new Set(o.unpriceable ?? []),
    });

  it("NO ENTRY, AND THE CANDIDATES ARE NOT EVEN READ — no review is paid for", async () => {
    const listed = { n: 0 };
    const asked: string[] = [];
    const t = takeTick(await trencher({ listed, asked }).tick(snap({ unreadHeld: UNREAD })));
    assert.deepEqual(buysOf(t), []);
    assert.equal(listed.n, 0);
    assert.deepEqual(asked, []);
    assert.equal(t.idle?.code, "holding-unread");
  });

  it("A READABLE POSITION THAT MUST BE LEFT IS STILL SOLD — the exit never waits on another coin's read", async () => {
    // HELD is unpriceable (the ledger knows its size), so shouldExit's first branch sells it.
    const t = takeTick(await trencher({ open: [position()], unpriceable: ["HELD"] }).tick(snap({ unreadHeld: UNREAD })));
    assert.equal(sellsOf(t).length, 1);
  });

  it("THE UNREAD COIN ITSELF IS NOT SOLD: absent from holdings and never in `unpriceable`, so no ledger-sized sell", async () => {
    const t = takeTick(await trencher({ open: [position({ symbol: "GATO", token: GATO })] }).tick(snap({ unreadHeld: UNREAD })));
    assert.deepEqual(sellsOf(t), []);
  });
});

describe("nothing a builtin proposes while a holding is unread is something the wall refuses for it", () => {
  it("EVERY BUILTIN, WITH GATO UNREAD", async () => {
    const book = new Map([
      ["QQQ", h(QQQ, 300_000_000n, 100_000_000n)],
      ["NVDA", h(NVDA, 100_000_000n)],
      ["TSLA", h(TSLA, 30_000_000n)],
    ]);
    const s = snap({ holdings: book, vaultUsdg: 400_000_000n, unreadHeld: UNREAD });
    const proposed = [
      ...steadyBasketTick(basket({ takeProfitBps: 1_000 }), s).intents,
      ...steadyBasketTick(basket(), { ...s, cashUsdg: 1_000_000n }).intents,
      ...evenKeelTick(keel(), s).intents,
      ...weekendGapTick({ legs, enterBudgetUsdg: 20_000_000n, swapRouter: ROUTER, usdg: USDG }, { ...s, staleFeeds: new Set(["NVDA"]) }).intents,
    ];
    assert.ok(proposed.length > 0, "the exits are still proposed, so the check below has something to check");
    assert.deepEqual(refusedFor(proposed), []);
  });

  it("THE CONTROL: the same books, told nothing, propose what the wall then refuses", () => {
    assert.ok(refusedFor(steadyBasketTick(basket(), snap()).intents).length > 0);
  });
});
