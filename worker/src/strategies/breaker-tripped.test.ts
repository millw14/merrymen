/**
 * A TRIPPED DRAWDOWN BREAKER IS A REASON TO STOP ASKING, NOT TO KEEP BUYING.
 *
 * Seen on the live feed on 2026-09-23: a Trencher whose breaker was tripped
 * published thirty refused buys in fifteen minutes, "the drawdown breaker was
 * tripped", each in fresh model words so none of them collapsed — thirty of
 * the feed's forty trade slots, and a paid Brain review behind every one. The
 * wall was right every time. The strategy had no way to know it would be.
 *
 * The snapshot now carries the account's drawdown as the wall measures it, and
 * every builtin strategy reads it the way it reads the day's trade count:
 *
 *   - MEASURED AT OR PAST THE LIMIT, nothing that buys is proposed, and the
 *     owner is told once, through the idle channel;
 *   - UNREAD (absent, null, equity unknown, no peak yet) changes nothing — a
 *     drawdown nobody measured is not a tripped breaker;
 *   - EXITS STILL GO. The breaker is a brake on taking risk, never a lock on
 *     the doors; policy.ts exempts money coming home, so a strategy that held
 *     its sells here would be stricter than the wall.
 *
 * Proposals are run through the real checkPolicy at the same drawdown, so the
 * gate is tested against the rule it anticipates rather than a copy of it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "../policy";
import { makeDipHunter } from "./dip-hunter";
import { evenKeelTick, type EvenKeelConfig } from "./even-keel";
import { publishesIdle, renderWhy, type Why } from "./reasons";
import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import { makeTrencher, TRENCHER_DEFAULTS, type Candidate, type OpenPosition } from "./trencher";
import { breakerIdle, breakerTripped, drawdownOf, takeTick, type Snapshot, type Tick } from "./types";
import { weekendGapTick } from "./weekend-gap";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const QQQ = "0x4444444444444444444444444444444444444444" as const;
const NVDA = "0x5555555555555555555555555555555555555555" as const;
const TSLA = "0x6666666666666666666666666666666666666666" as const;
const CATE = "0x00000000000000000000000000000000000000c1" as const;

/** 12.5% below the peak against a 10% limit: tripped, by the wall's own arithmetic. */
const TRIPPED = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 875_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });
/** 2% below it: measured, and nowhere near. */
const CLEAR = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 980_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });

const basket = (over: Partial<SteadyBasketConfig> = {}): SteadyBasketConfig => ({
  legs: [
    { symbol: "QQQ", token: QQQ, weightBps: 3333 },
    { symbol: "NVDA", token: NVDA, weightBps: 3333 },
    { symbol: "TSLA", token: TSLA, weightBps: 3333 },
  ],
  buyPerTickUsdg: 25_000_000n,
  idleFloorUsdg: 50_000_000n,
  swapRouter: ROUTER,
  vault: VAULT,
  usdg: USDG,
  ...over,
});

const keel = (over: Partial<EvenKeelConfig> = {}): EvenKeelConfig => ({
  legs: basket().legs,
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

const buysOf = (t: Tick) => t.intents.filter((i) => i.kind === "swap" && i.sellToken === USDG);
const sellsOf = (t: Tick) => t.intents.filter((i) => i.kind === "swap" && i.buyToken === USDG);

/** The real wall, with a 10% limit, standing at the TRIPPED drawdown. */
const limits: AgentLimits = {
  perTradeUsdg: 1_000_000_000_000n,
  dailyUsdg: 1_000_000_000_000n,
  allowedTargets: [ROUTER, VAULT, USDG],
  allowedAssets: [USDG, QQQ, NVDA, TSLA, CATE],
  cashToken: USDG,
  maxDrawdownBps: 1_000,
  expiresAt: 2_000_000_000,
  maxOpsPerDay: 1_000,
};
const atTripped: AgentState = {
  spentTodayUsdg: 0n,
  opsToday: 0,
  highWaterMarkUsdg: 1_000_000_000n,
  equityUsdg: 875_000_000n,
  equityKnown: true,
  nowSec: 1_800_000_000,
};
const breakerRefused = (intents: TradeIntent[]) =>
  intents.filter((i) => {
    const v = checkPolicy(i, limits, atTripped);
    return !v.ok && v.rule === "drawdown-breaker";
  });

describe("the snapshot measures the drawdown the way the wall does", () => {
  it("TRIPPED ON EXACTLY THE BOOKS THE WALL REFUSES A BUY FOR, AND ON NO OTHER", () => {
    // Off in either direction is a tick of refusals, or a strategy gone quiet
    // for a breaker nobody tripped.
    const buy: TradeIntent = { kind: "swap", target: ROUTER, sellToken: USDG, buyToken: NVDA, sellAmountRaw: 1_000_000n, notionalUsdg: 1_000_000n };
    for (const peak of [0n, 1n, 999_999n, 1_000_000_000n]) {
      for (const equity of [0n, 1n, 500_000_000n, 899_999_999n, 900_000_000n, 900_000_001n, 1_000_000_000n, 2_000_000_000n]) {
        for (const known of [true, false]) {
          for (const max of [0, 1, 1_000, 10_000]) {
            const v = checkPolicy(buy, { ...limits, maxDrawdownBps: max }, { ...atTripped, highWaterMarkUsdg: peak, equityUsdg: equity, equityKnown: known });
            const wallRefuses = !v.ok && v.rule === "drawdown-breaker";
            const d = drawdownOf({ peakUsdg: peak, equityUsdg: equity, equityKnown: known, maxDrawdownBps: max });
            assert.equal(breakerTripped(snap({ drawdown: d })), wallRefuses, `peak ${peak} equity ${equity} known ${known} max ${max}`);
          }
        }
      }
    }
  });

  it("AN UNREAD DRAWDOWN IS NULL, never a tripped breaker and never zero", () => {
    assert.equal(drawdownOf({ peakUsdg: 1_000n, equityUsdg: 1n, equityKnown: false, maxDrawdownBps: 1_000 }), null, "a partial total is not a loss");
    assert.equal(drawdownOf({ peakUsdg: 0n, equityUsdg: 1n, equityKnown: true, maxDrawdownBps: 1_000 }), null, "no peak yet");
    assert.equal(drawdownOf({ peakUsdg: 1_000n, equityUsdg: 1n, equityKnown: true, maxDrawdownBps: Number.NaN }), null, "a limit nobody read");
    for (const d of [undefined, null]) assert.equal(breakerTripped(snap({ drawdown: d })), false);
    assert.deepEqual(TRIPPED, { bps: 1_250, limitBps: 1_000 });
  });
});

describe("steady-basket stops buying and keeps selling", () => {
  it("A TRIPPED BREAKER PROPOSES NO BUY, NO PARK AND NO CURVE BUY — and says why", () => {
    const t = steadyBasketTick(basket(), snap({ drawdown: TRIPPED }));
    assert.deepEqual(buysOf(t), []);
    assert.equal(t.intents.some((i) => i.kind === "vault-deposit"), false, "a deposit is not an exit, and the wall refuses it");
    assert.equal(t.intents.some((i) => i.kind === "curve-trade"), false);
    assert.equal(t.idle?.code, "breaker-tripped");
  });

  it("A TAKE-PROFIT STILL GOES OUT — getting out is exactly what the breaker must never block", () => {
    const t = steadyBasketTick(
      basket({ takeProfitBps: 1_000 }),
      snap({
        drawdown: TRIPPED,
        holdings: new Map([["NVDA", { token: NVDA, rawBalance: 10n ** 18n, valueUsdg: 30_000_000n, priceStale: false, costUsdg: 20_000_000n }]]),
      }),
    );
    assert.equal(sellsOf(t).length, 1);
  });

  it("the unpark still goes too — it brings money home, and the wall never refuses that", () => {
    const t = steadyBasketTick(basket(), snap({ drawdown: TRIPPED, cashUsdg: 1_000_000n, vaultUsdg: 400_000_000n }));
    assert.equal(t.intents.some((i) => i.kind === "vault-withdraw"), true);
  });

  it("A CLEAR OR UNREAD DRAWDOWN LEAVES THE BASKET EXACTLY AS IT WAS", () => {
    const before = steadyBasketTick(basket(), snap());
    assert.equal(buysOf(before).length, 3, "the control: this fixture buys with nothing gating it");
    assert.deepEqual(steadyBasketTick(basket(), snap({ drawdown: null })), before);
    assert.deepEqual(steadyBasketTick(basket(), snap({ drawdown: CLEAR })), before);
  });
});

describe("even-keel stops topping up and keeps trimming", () => {
  it("NO SEED on an empty book, and the reason", () => {
    const t = evenKeelTick(keel(), snap({ drawdown: TRIPPED }));
    assert.deepEqual(t.intents, []);
    assert.equal(t.idle?.code, "breaker-tripped");
    assert.ok(buysOf(evenKeelTick(keel(), snap())).length > 0, "the control seeds");
  });

  it("NO TOP-UP, but the overweight leg is still trimmed", () => {
    const book = new Map([
      ["QQQ", { token: QQQ, rawBalance: 10n ** 18n, valueUsdg: 300_000_000n, priceStale: false }],
      ["NVDA", { token: NVDA, rawBalance: 10n ** 18n, valueUsdg: 100_000_000n, priceStale: false }],
      ["TSLA", { token: TSLA, rawBalance: 10n ** 18n, valueUsdg: 30_000_000n, priceStale: false }],
    ]);
    const tripped = evenKeelTick(keel(), snap({ drawdown: TRIPPED, holdings: book }));
    assert.deepEqual(buysOf(tripped), []);
    assert.ok(sellsOf(tripped).length > 0, "the trim is an exit");
    const clear = evenKeelTick(keel(), snap({ drawdown: CLEAR, holdings: book }));
    assert.ok(buysOf(clear).length > 0, "the control tops the underweight leg up");
  });
});

describe("dip-hunter goes quiet and keeps watching", () => {
  const cfg = {
    legs: [{ symbol: "NVDA", token: NVDA }],
    swapRouter: ROUTER,
    usdg: USDG,
    buyPerTickUsdg: 25_000_000n,
    minDipBps: 100,
  };
  const priced = (price8: bigint) => new Map([["NVDA", { price8, stale: false, updatedAt: 1, source: "chainlink" as const }]]);

  it("A DIP WHILE TRIPPED IS NOT BOUGHT, and the owner hears why", async () => {
    const d = makeDipHunter(cfg);
    await d.tick(snap({ prices: priced(100_00000000n) }));
    const t = takeTick(await d.tick(snap({ prices: priced(90_00000000n), drawdown: TRIPPED })));
    assert.deepEqual(t.intents, []);
    assert.equal(t.idle?.code, "breaker-tripped");
  });

  it("and the rolling high still moves while it waits", async () => {
    const d = makeDipHunter(cfg);
    await d.tick(snap({ prices: priced(100_00000000n) }));
    await d.tick(snap({ prices: priced(200_00000000n), drawdown: TRIPPED }));
    const t = takeTick(await d.tick(snap({ prices: priced(150_00000000n) })));
    assert.equal(t.intents.length, 1);
    assert.equal(t.why[0]?.code === "dip" && t.why[0].dipBps, 2_500, "judged from the high it saw while tripped");
  });
});

describe("weekend-gap does not enter, and still exits at the open", () => {
  const gap = { legs: [{ symbol: "NVDA", token: NVDA, weightBps: 10_000 }], enterBudgetUsdg: 20_000_000n, swapRouter: ROUTER, usdg: USDG };

  it("NO ENTRY AT THE CLOSE while tripped, and the reason", () => {
    const t = weekendGapTick(gap, snap({ staleFeeds: new Set(["NVDA"]), drawdown: TRIPPED }));
    assert.deepEqual(t.intents, []);
    assert.equal(t.idle?.code, "breaker-tripped");
    assert.equal(buysOf(weekendGapTick(gap, snap({ staleFeeds: new Set(["NVDA"]) }))).length, 1, "the control enters");
  });

  it("THE EXIT AT THE OPEN STILL GOES", () => {
    const held = new Map([["NVDA", { token: NVDA, rawBalance: 10n ** 18n, valueUsdg: 21_000_000n, priceStale: false }]]);
    const t = weekendGapTick(gap, snap({ holdings: held, drawdown: TRIPPED }));
    assert.equal(sellsOf(t).length, 1);
    assert.equal(t.idle, undefined, "nothing was withheld, so there is nothing to explain");
  });
});

describe("the Trencher reviews exits only — and pays for no entry review", () => {
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
  const trencher = (over: { open?: OpenPosition[]; asked?: string[]; listed?: { n: number } } = {}) =>
    makeTrencher({
      cfg: TRENCHER_DEFAULTS,
      swapRouter: ROUTER,
      usdgToken: USDG,
      brainRequired: true,
      brainOrder: (symbol, _token, _price8, held) => {
        over.asked?.push(`${symbol}:${held ? "held" : "entry"}`);
        return held ? null : { side: "buy", usdgAmount: 5, decisionId: "d1" };
      },
      candidates: () => {
        if (over.listed) over.listed.n += 1;
        return [candidate()];
      },
      open: () => over.open ?? [],
      liquidityOf: () => null,
      unpriceable: () => new Set(over.open?.map((p) => p.symbol) ?? []),
    });

  it("NO ENTRY IS PROPOSED — and no entry is even asked about, so no review is paid for", async () => {
    const asked: string[] = [];
    const listed = { n: 0 };
    const t = takeTick(await trencher({ asked, listed }).tick(snap({ drawdown: TRIPPED })));
    assert.deepEqual(buysOf(t), []);
    assert.deepEqual(asked, [], "the Brain is not asked about an entry the wall would refuse");
    assert.equal(listed.n, 0, "candidates are not even read");
    assert.equal(t.idle?.code, "breaker-tripped");
  });

  it("THE CONTROL: clear, the same Trencher asks and enters", async () => {
    const asked: string[] = [];
    const t = takeTick(await trencher({ asked }).tick(snap({ drawdown: CLEAR })));
    assert.equal(buysOf(t).length, 1);
    assert.deepEqual(asked, ["CATE:entry"]);
  });

  it("A HELD POSITION IS STILL LEFT when it has to be — the exit never waits on the breaker", async () => {
    const t = takeTick(await trencher({ open: [position()] }).tick(snap({ drawdown: TRIPPED })));
    assert.equal(sellsOf(t).length, 1, "an unpriceable holding is sold, breaker or not");
    assert.equal(t.idle, undefined, "a tick that did something has nothing idle to say");
  });
});

describe("nothing proposed while tripped is something the wall refuses for it", () => {
  it("EVERY BUILTIN, AT THE TRIPPED DRAWDOWN", async () => {
    const book = new Map([
      ["QQQ", { token: QQQ, rawBalance: 10n ** 18n, valueUsdg: 300_000_000n, priceStale: false, costUsdg: 100_000_000n }],
      ["NVDA", { token: NVDA, rawBalance: 10n ** 18n, valueUsdg: 100_000_000n, priceStale: false }],
      ["TSLA", { token: TSLA, rawBalance: 10n ** 18n, valueUsdg: 30_000_000n, priceStale: false }],
    ]);
    const s = snap({ drawdown: TRIPPED, holdings: book, vaultUsdg: 400_000_000n });
    const proposed = [
      ...steadyBasketTick(basket({ takeProfitBps: 1_000 }), s).intents,
      ...steadyBasketTick(basket(), { ...s, cashUsdg: 1_000_000n }).intents,
      ...evenKeelTick(keel(), s).intents,
      ...weekendGapTick({ legs: basket().legs, enterBudgetUsdg: 20_000_000n, swapRouter: ROUTER, usdg: USDG }, { ...s, staleFeeds: new Set(["NVDA"]) }).intents,
    ];
    assert.ok(proposed.length > 0, "the exits are still proposed, so the check below has something to check");
    assert.deepEqual(breakerRefused(proposed), []);
  });

  it("THE CONTROL: the same books with the drawdown unread propose what the wall then refuses", () => {
    assert.ok(breakerRefused(steadyBasketTick(basket(), snap()).intents).length > 0);
  });
});

describe("what the owner is told, and what the public is not", () => {
  const w: Why = { code: "breaker-tripped", limitBps: 1_000 };

  it("THE OWNER HEARS THE LIMIT AND THAT SELLING IS UNAFFECTED", () => {
    const s = renderWhy(w);
    assert.match(s, /^nothing bought/);
    assert.match(s, /at least 10% below its peak/);
    assert.match(s, /\/grant/, "the owner is the one person who can widen it");
    assert.match(s, /Selling is never blocked/);
    assert.ok(s.length < 220, `over the /why truncation point: ${s.length}`);
  });

  it("TOLD ONCE, NOT ONCE A TICK — the sentence does not move with the book", () => {
    // The idle channel speaks when its sentence CHANGES. A tripped breaker can
    // last all day while equity drifts every tick; a sentence carrying the
    // drawdown would be a fresh event on every one of them.
    const at = (equityUsdg: bigint) =>
      breakerIdle({ drawdown: drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg, equityKnown: true, maxDrawdownBps: 1_000 }) });
    const a = at(875_000_000n);
    const b = at(861_300_000n);
    assert.ok(a && b);
    assert.equal(renderWhy(a), renderWhy(b));
    assert.equal(at(990_000_000n), undefined, "and nothing at all once it has recovered");
  });

  it("AND IT NEVER BECOMES A PUBLIC POST — account state leaves the public feed", () => {
    // The refusal it replaces is dropped from the public feed as account-wide;
    // the idle view saying the same thing must not walk it back in.
    assert.equal(publishesIdle(w), false);
    assert.doesNotMatch(renderWhy(w, "public"), /\/grant|re-sign/);
    for (const other of [{ code: "ops-spent" }, { code: "budget-spent", capRaw: 25_000_000n }] as Why[]) {
      assert.equal(publishesIdle(other), true, `${other.code} still publishes, as it did`);
    }
  });
});
