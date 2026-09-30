/**
 * A SPENT TRADE COUNT IS A REASON TO GO QUIET, NOT TO KEEP ASKING.
 *
 * The snapshot carried the day's MONEY headroom and nothing about the day's
 * trade COUNT. So once `maxOpsPerDay` was reached, steady-basket saw plenty of
 * budget and proposed the same legs every tick, and checkPolicy refused every
 * one with `ops-cap`. Paper fills are instant, so a paper agent reached its
 * count early and spent the rest of the day posting "tried to buy TSLA · past
 * today's number of trades" on the public feed, once a tick.
 *
 * What these tests hold:
 *
 *   - a KNOWN zero proposes nothing the ops rule would refuse, and says why
 *     once, through the idle channel;
 *   - an UNREAD count (absent or null) changes nothing, because a count nobody
 *     read is not a zero;
 *   - EXITS still go out. policy.ts exempts a sell into cash from the ops rule
 *     ("a rate limit must not become a lock on the doors"), so a strategy that
 *     withheld its sells here would be stricter than the wall.
 *
 * The last block runs every proposal through the real checkPolicy with the
 * count at its ceiling, so the gate is tested against the rule it anticipates
 * rather than against a copy of it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPolicy, type AgentLimits, type TradeIntent } from "../policy";
import { evenKeelTick, type EvenKeelConfig } from "./even-keel";
import { makeDipHunter } from "./dip-hunter";
import { renderWhy } from "./reasons";
import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import { opsHeadroomOf, takeTick, type Snapshot, type Tick } from "./types";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const QQQ = "0x4444444444444444444444444444444444444444" as const;
const NVDA = "0x5555555555555555555555555555555555555555" as const;
const TSLA = "0x6666666666666666666666666666666666666666" as const;

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

const buys = (t: Tick) => t.intents.filter((i) => i.kind === "swap" && i.sellToken === USDG);

describe("steady-basket reads the trade count, not just the money", () => {
  it("A KNOWN ZERO PROPOSES NO BUY, however much budget and cash there is", () => {
    const t = steadyBasketTick(basket(), snap({ opsHeadroom: 0 }));
    assert.deepEqual(buys(t), [], "a buy the ops rule will certainly refuse must not be proposed");
  });

  it("and no vault move either, because a deposit and a withdrawal each spend a trade", () => {
    // 900 cash above a 50 floor would otherwise be parked; the ops rule refuses
    // a deposit exactly as it refuses a buy.
    const flush = steadyBasketTick(basket(), snap({ opsHeadroom: 0 }));
    assert.equal(flush.intents.some((i) => i.kind === "vault-deposit"), false);
    // Short of one buy with cash in the vault: the unpark would be refused too,
    // and it is the one proposal that returns before any other check.
    const short = steadyBasketTick(basket(), snap({ opsHeadroom: 0, cashUsdg: 1_000_000n, vaultUsdg: 400_000_000n }));
    assert.equal(short.intents.some((i) => i.kind === "vault-withdraw"), false);
    assert.equal(short.idle?.code, "ops-spent", "and the count, not the cash, is what it names");
  });

  it("AND SAYS WHY, through the idle channel the tick already dedupes", () => {
    const t = steadyBasketTick(basket(), snap({ opsHeadroom: 0 }));
    assert.equal(t.idle?.code, "ops-spent");
    const owner = renderWhy(t.idle!);
    assert.match(owner, /nothing bought/);
    assert.match(owner, /re-sign/, "the owner is the one person who can raise it");
    assert.doesNotMatch(renderWhy(t.idle!, "public"), /re-sign|\/grant/, "a stranger cannot act on it");
  });

  it("a spent MONEY budget keeps its own sentence when both are spent", () => {
    // Both are true; the money sentence is the one that already existed, and
    // swapping it for another true sentence would be churn in front of owners.
    const t = steadyBasketTick(basket(), snap({ opsHeadroom: 0, spendHeadroomUsdg: 0n }));
    assert.equal(t.idle?.code, "budget-spent");
  });

  it("AN UNREAD COUNT IS NOT ZERO — absent and null both leave the basket alone", () => {
    const before = steadyBasketTick(basket(), snap());
    assert.equal(buys(before).length, 3, "the fixture buys all three legs with nothing gating it");
    assert.deepEqual(steadyBasketTick(basket(), snap({ opsHeadroom: null })), before);
    assert.deepEqual(steadyBasketTick(basket(), snap({ opsHeadroom: 5 })), before);
  });

  it("A TAKE-PROFIT STILL GOES OUT, because the wall exempts an exit from the count", () => {
    const t = steadyBasketTick(
      basket({ takeProfitBps: 1_000 }),
      snap({
        opsHeadroom: 0,
        holdings: new Map([
          ["NVDA", { token: NVDA, rawBalance: 10n ** 18n, valueUsdg: 30_000_000n, priceStale: false, costUsdg: 20_000_000n }],
        ]),
      }),
    );
    const sells = t.intents.filter((i) => i.kind === "swap" && i.buyToken === USDG);
    assert.equal(sells.length, 1, "a book that has spent its count must still be able to take a profit");
    assert.deepEqual(buys(t), []);
    assert.equal(t.idle?.code, "ops-spent", "and the missing buys are still explained");
  });
});

describe("even-keel reads it too", () => {
  const legs = [
    { symbol: "QQQ", token: QQQ },
    { symbol: "NVDA", token: NVDA },
    { symbol: "TSLA", token: TSLA },
  ];
  const cfg: EvenKeelConfig = {
    legs,
    swapRouter: ROUTER,
    usdg: USDG,
    maxTradeUsdg: 1_000_000_000n,
    bandBps: 500,
    seedBudgetUsdg: 30_000_000n,
  };
  const held = (qqq: bigint, nvda: bigint, tsla: bigint): Snapshot["holdings"] =>
    new Map([
      ["QQQ", { token: QQQ, rawBalance: qqq, valueUsdg: qqq, priceStale: false }],
      ["NVDA", { token: NVDA, rawBalance: nvda, valueUsdg: nvda, priceStale: false }],
      ["TSLA", { token: TSLA, rawBalance: tsla, valueUsdg: tsla, priceStale: false }],
    ]);

  it("THE SEED IS WITHHELD at a known zero, and the reason is the count", () => {
    const t = evenKeelTick(cfg, snap({ opsHeadroom: 0 }));
    assert.deepEqual(t.intents, []);
    assert.equal(t.idle?.code, "ops-spent");
  });

  it("the seed is unchanged when the count was not read", () => {
    assert.equal(evenKeelTick(cfg, snap()).intents.length, 3);
    assert.equal(evenKeelTick(cfg, snap({ opsHeadroom: null })).intents.length, 3);
  });

  it("A TOP-UP IS WITHHELD but a TRIM still goes out", () => {
    // QQQ far over, TSLA far under, NVDA on the line: one trim, one top-up.
    const book = held(200_000_000n, 110_000_000n, 20_000_000n);
    const open = evenKeelTick(cfg, snap({ holdings: book }));
    assert.equal(open.intents.length, 2, "the fixture trims one leg and tops up another");
    const t = evenKeelTick(cfg, snap({ holdings: book, opsHeadroom: 0 }));
    assert.equal(t.intents.length, 1);
    assert.equal((t.intents[0] as { sellToken: string }).sellToken, QQQ, "the exit survives");
    assert.equal(t.why[0]?.code, "keel-trim");
  });

  it("and a tick whose only move was a top-up says why it made none", () => {
    // Only TSLA is off the line, and it is under. With the count spent there
    // is nothing to do, and silence would read exactly like a balanced book.
    const t = evenKeelTick(cfg, snap({ holdings: held(100_000_000n, 100_000_000n, 90_000_000n), opsHeadroom: 0 }));
    assert.deepEqual(t.intents, []);
    assert.equal(t.idle?.code, "ops-spent");
  });

  it("a balanced book stays quiet — the count is not news when nothing wanted it", () => {
    const t = evenKeelTick(cfg, snap({ holdings: held(100_000_000n, 100_000_000n, 100_000_000n), opsHeadroom: 0 }));
    assert.deepEqual(t.intents, []);
    assert.equal(t.idle, undefined);
  });
});

describe("dip-hunter reads it too", () => {
  const cfg = {
    legs: [{ symbol: "NVDA", token: NVDA }],
    swapRouter: ROUTER,
    usdg: USDG,
    buyPerTickUsdg: 10_000_000n,
    minDipBps: 100,
  };
  const priced = (price8: bigint): Snapshot["prices"] =>
    new Map([["NVDA", { price8, stale: false } as never]]);

  it("A DIP IS NOT BOUGHT at a known zero, and the reason is the count", async () => {
    const d = makeDipHunter(cfg);
    await d.tick(snap({ prices: priced(100_00000000n) }));
    const t = takeTick(await d.tick(snap({ prices: priced(90_00000000n), opsHeadroom: 0 })));
    assert.deepEqual(t.intents, []);
    assert.equal(t.idle?.code, "ops-spent");
  });

  it("and it keeps watching while it waits — the rolling high still moves", async () => {
    // Returning before the price loop would freeze the high for as long as the
    // count stays spent, and the first dip after it frees would be measured
    // against a stale peak. So the high set during the quiet stretch is the one
    // the next dip is judged from.
    const d = makeDipHunter(cfg);
    await d.tick(snap({ prices: priced(100_00000000n) }));
    await d.tick(snap({ prices: priced(200_00000000n), opsHeadroom: 0 }));
    const t = takeTick(await d.tick(snap({ prices: priced(150_00000000n) })));
    assert.equal(t.intents.length, 1);
    assert.equal(t.why[0]?.code === "dip" && t.why[0].dipBps, 2_500, "25% off the 200 high, not 50% over the 100 one");
  });

  it("an unread count changes nothing", async () => {
    const d = makeDipHunter(cfg);
    await d.tick(snap({ prices: priced(100_00000000n) }));
    const t = takeTick(await d.tick(snap({ prices: priced(90_00000000n), opsHeadroom: null })));
    assert.equal(t.intents.length, 1);
  });
});

describe("the gate agrees with the rule it anticipates", () => {
  // The real wall, at the ceiling of its count. Anything the strategies still
  // propose with a known zero must not be something this refuses on `ops-cap`.
  const MAX_OPS = 24;
  const limits: AgentLimits = {
    perTradeUsdg: 1_000_000_000_000n,
    dailyUsdg: 1_000_000_000_000n,
    allowedTargets: [ROUTER, VAULT, USDG],
    allowedAssets: [USDG, QQQ, NVDA, TSLA],
    cashToken: USDG,
    maxDrawdownBps: 10_000,
    expiresAt: 2_000_000_000,
    maxOpsPerDay: MAX_OPS,
  };
  const atCeiling = {
    spentTodayUsdg: 0n,
    opsToday: MAX_OPS,
    highWaterMarkUsdg: 0n,
    equityUsdg: 0n,
    nowSec: 1_800_000_000,
  };
  const opsRefused = (intents: TradeIntent[]) =>
    intents.filter((i) => {
      const v = checkPolicy(i, limits, atCeiling);
      return !v.ok && v.rule === "ops-cap";
    });

  it("nothing any of the three proposes at a known zero is refused for the count", async () => {
    const book = new Map([
      ["QQQ", { token: QQQ, rawBalance: 10n ** 18n, valueUsdg: 300_000_000n, priceStale: false, costUsdg: 100_000_000n }],
      ["NVDA", { token: NVDA, rawBalance: 10n ** 18n, valueUsdg: 100_000_000n, priceStale: false }],
      ["TSLA", { token: TSLA, rawBalance: 10n ** 18n, valueUsdg: 30_000_000n, priceStale: false }],
    ]);
    const s = snap({ opsHeadroom: 0, holdings: book, vaultUsdg: 400_000_000n });
    const proposed = [
      ...steadyBasketTick(basket({ takeProfitBps: 1_000 }), s).intents,
      ...steadyBasketTick(basket(), { ...s, cashUsdg: 1_000_000n }).intents,
      ...evenKeelTick(
        { legs: basket().legs, swapRouter: ROUTER, usdg: USDG, maxTradeUsdg: 10n ** 12n, bandBps: 500, seedBudgetUsdg: 30_000_000n },
        s,
      ).intents,
    ];
    assert.ok(proposed.length > 0, "the exits are still proposed, so the check below has something to check");
    assert.deepEqual(opsRefused(proposed), []);
  });

  it("THE SNAPSHOT'S FIGURE IS ZERO ON EXACTLY THE COUNTS THE WALL REFUSES AT", () => {
    // The worker fills `opsHeadroom` with opsHeadroomOf(maxOpsPerDay, opsToday),
    // the same two numbers checkPolicy compares. Off by one in either direction
    // is a tick of refusals, or a tick the strategy went quiet for nothing.
    const buy: TradeIntent = { kind: "swap", target: ROUTER, sellToken: USDG, buyToken: NVDA, sellAmountRaw: 1_000_000n, notionalUsdg: 1_000_000n };
    for (let n = 0; n <= MAX_OPS + 3; n += 1) {
      const v = checkPolicy(buy, limits, { ...atCeiling, opsToday: n });
      const wallRefuses = !v.ok && v.rule === "ops-cap";
      assert.equal(opsHeadroomOf(MAX_OPS, n) === 0, wallRefuses, `at ${n} of ${MAX_OPS}`);
    }
  });

  it("and a ceiling nobody can read is null, never zero", () => {
    assert.equal(opsHeadroomOf(Number.NaN, 3), null);
    assert.equal(opsHeadroomOf(undefined as unknown as number, 3), null);
    assert.equal(opsHeadroomOf(24, Number.NaN), null);
    assert.equal(opsHeadroomOf(24, 30), 0, "past the ceiling clamps to zero rather than going negative");
  });

  it("and the same snapshot with the count UNREAD proposes what the wall then refuses", () => {
    // The control. Without it the test above could pass because the fixture
    // never proposed a buy at all.
    const refused = opsRefused(steadyBasketTick(basket(), snap()).intents);
    assert.ok(refused.length > 0);
  });
});
