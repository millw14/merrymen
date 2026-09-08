/**
 * THE DEFAULT STRATEGY COULD ONLY EVER BUY.
 *
 * Every intent steady-basket could emit had cash on the SELL side: a USDG→token
 * swap, a USDG→token curve buy, a vault deposit, a vault withdrawal. There was
 * no code path in it that disposed of anything, so an agent on the shipped
 * default accumulated forever and never realised a gain, took a loss, or acted
 * on anything it learned. In production one funded agent bought nine times with
 * real money in eighteen minutes and still holds all six positions, because
 * nothing could sell them.
 *
 * TAKE-PROFIT ONLY, AND NO STOP-LOSS. A stop-loss on a DCA sleeve is
 * incoherent — averaging in exists to keep buying through a drawdown, so a rule
 * that sold the dip would fight the rule that buys it and the owner would pay
 * the spread both ways. Taking a profit is not in tension with accumulating; it
 * is the other half of it, and it is the half an owner means by "if it is happy
 * with its profit it sells".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderWhy } from "./reasons";
import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import type { Snapshot } from "./types";

const TSLA = "0x0000000000000000000000000000000000000001" as const;
const NVDA = "0x0000000000000000000000000000000000000002" as const;
const USDG = "0x00000000000000000000000000000000000000dd" as const;
const ROUTER = "0x00000000000000000000000000000000000000rr".replace("rr", "ff") as `0x${string}`;

const cfg = (over: Partial<SteadyBasketConfig> = {}): SteadyBasketConfig => ({
  legs: [{ symbol: "TSLA", token: TSLA, weightBps: 10_000 }],
  buyPerTickUsdg: 25_000_000n,
  idleFloorUsdg: 50_000_000n,
  swapRouter: ROUTER,
  vault: "0x00000000000000000000000000000000000000aa",
  usdg: USDG,
  ...over,
});

const held = (over: Partial<{ value: bigint; cost: bigint | null; stale: boolean; token: `0x${string}` }> = {}) =>
  new Map([
    [
      "TSLA",
      {
        token: over.token ?? TSLA,
        rawBalance: 1_000_000_000_000_000_000n,
        valueUsdg: over.value ?? 30_000_000n,
        priceStale: over.stale ?? false,
        costUsdg: over.cost === undefined ? 10_000_000n : over.cost,
      },
    ],
  ]);

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: 0n,
  vaultUsdg: 0n,
  ethWei: 10n ** 16n,
  holdings: new Map(),
  prices: new Map(),
  pausedTokens: new Set(),
  staleFeeds: new Set(),
  sequencerUp: true,
  spendHeadroomUsdg: 1_000_000_000n,
  perTradeCapUsdg: 1_000_000_000n,
  ...over,
});

describe("it can finally sell", () => {
  it("A LEG THAT TRIPLED IS SOLD, ALL OF IT, BACK INTO CASH", () => {
    // 10 USDG in, 30 USDG now: +20000 bps, past a 10000 bps (2x) rule.
    const t = steadyBasketTick(cfg({ takeProfitBps: 10_000 }), snap({ holdings: held() }));
    const sell = t.intents.find((i) => i.kind === "swap" && i.sellToken === TSLA);
    assert.ok(sell, "the whole point: an exit exists at all");
    assert.equal(sell!.kind === "swap" && sell!.buyToken, USDG, "and it goes back to cash");
    assert.equal(sell!.kind === "swap" && sell!.sellAmountRaw, 1_000_000_000_000_000_000n, "the whole position");
  });

  it("and the reason carries both numbers, so it is checkable", () => {
    const t = steadyBasketTick(cfg({ takeProfitBps: 10_000 }), snap({ holdings: held() }));
    const why = t.why.find((w) => w?.code === "take-profit")!;
    assert.ok(why);
    const said = renderWhy(why);
    assert.match(said, /TSLA is up 200% on what it cost/);
    assert.match(said, /30\.00 USDG of it against the 10\.00 paid/);
    assert.ok(said.length < 220, "must not truncate on any surface");
  });

  it("A LEG THAT HAS NOT RUN FAR ENOUGH IS LEFT ALONE", () => {
    // +20%, against a 2x rule.
    const t = steadyBasketTick(cfg({ takeProfitBps: 10_000 }), snap({ holdings: held({ value: 12_000_000n }) }));
    assert.equal(t.intents.filter((i) => i.kind === "swap" && i.sellToken === TSLA).length, 0);
  });

  it("and ONE exit per tick, so a basket that ran does not liquidate itself", () => {
    const two = new Map([
      ...held(),
      ["NVDA", { token: NVDA, rawBalance: 5n, valueUsdg: 90_000_000n, priceStale: false, costUsdg: 10_000_000n }],
    ]);
    const t = steadyBasketTick(cfg({ takeProfitBps: 10_000 }), snap({ holdings: two }));
    assert.equal(t.intents.filter((i) => i.kind === "swap").length, 1);
  });
});

describe("what it refuses to sell against", () => {
  it("A STALE PRICE IS NOT A GAIN", () => {
    // priceStale means the market for that leg is closed, so its value is last
    // session's number. Selling against it takes a profit measured at a price
    // nobody is currently making.
    const t = steadyBasketTick(cfg({ takeProfitBps: 10_000 }), snap({ holdings: held({ stale: true }) }));
    assert.equal(t.intents.length, 0);
  });

  it("AND A HOLDING WITH NO COST ON RECORD IS SKIPPED, not assumed free", () => {
    // `costUsdg: null` means the ledger has no basis for it. Reading null as
    // zero would make the entire holding look like profit and sell it — the
    // accounting bug this codebase exists downstream of, as a trade.
    const t = steadyBasketTick(cfg({ takeProfitBps: 10_000 }), snap({ holdings: held({ cost: null }) }));
    assert.equal(t.intents.length, 0);
    // And a zero cost is refused the same way rather than dividing by it.
    assert.equal(steadyBasketTick(cfg({ takeProfitBps: 10_000 }), snap({ holdings: held({ cost: 0n }) })).intents.length, 0);
  });

  it("and a paused token is not sold either", () => {
    const t = steadyBasketTick(
      cfg({ takeProfitBps: 10_000 }),
      snap({ holdings: held(), pausedTokens: new Set([TSLA.toLowerCase()]) }),
    );
    assert.equal(t.intents.length, 0);
  });
});

describe("off by default, and off means off", () => {
  it("NO THRESHOLD, NO SELL — the shipped behaviour is unchanged", () => {
    // Turning this on changes what a live agent does with somebody's money, and
    // the threshold that suits one book does not suit another. The owner turns
    // it on; nothing here turns it on for them.
    for (const tp of [undefined, 0]) {
      const t = steadyBasketTick(cfg({ takeProfitBps: tp }), snap({ holdings: held() }));
      assert.equal(t.intents.length, 0, `takeProfitBps=${tp} must sell nothing`);
    }
  });

  it("and buying is untouched when it is on", () => {
    // The exit runs first, but it does not replace the sleeve: a tick with cash
    // and no winner still does its scheduled buy.
    const t = steadyBasketTick(cfg({ takeProfitBps: 10_000 }), snap({ cashUsdg: 100_000_000n }));
    assert.ok(t.intents.some((i) => i.kind === "swap" && i.buyToken === TSLA), "the DCA leg still fires");
  });
});
