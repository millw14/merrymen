/**
 * TWO DAYS IN THREE, THE DEFAULT STRATEGY DID NOTHING — CORRECTLY.
 *
 * All 24 Chainlink equity feeds go stale at a weekend, `steady-basket` skips
 * every leg with no reference price, and the tick returns an empty intent list.
 * That is right, and `all-legs-stale` was the honest sentence about it. It is
 * also most of what the testers meant by "no trading is being done": 24 of 34
 * agents run this strategy, and production reads `24 stale` right now.
 *
 * The owner's decision was "keep the basket, add a 24/7 fallback". So when
 * EVERY leg is shut, the agent works a coin on a market that does not close.
 *
 * WHAT MAKES THAT SAFE IS THAT IT REACHES NOTHING NEW. Everything in
 * `cfg.curve` was already chosen twice by the owner — the symbol is in their
 * basket ("trade it"), the address is in their signature ("you may") — and
 * `curveLegsNow` enforces both plus a live rail and a known curve before this
 * strategy sees a single leg. registry.ts calls that pairing "deliberately NOT
 * automatic", and it stays that way: a coin merely WATCHED is unreachable here.
 *
 * These are behavioural tests, because the tick is pure. The one source-read is
 * the call site — the thing whose absence made the strategist's curve arm inert
 * for weeks (curve-wiring.test.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import type { Snapshot } from "./types";
import type { CurveLeg } from "../strategist/proposals";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const TSLA = "0x1111111111111111111111111111111111111111" as const;
const NVDA = "0x2222222222222222222222222222222222222222" as const;
const MEME = "0x7777777777777777777777777777777777777777" as const;
const CURVE = "0x8888888888888888888888888888888888888888" as const;
const ADAPTER = "0x9999999999999999999999999999999999999999" as const;

/** A curve with room in it — reserves large enough that one tick barely moves it. */
const leg = (over: Partial<CurveLeg> = {}): CurveLeg =>
  ({
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
    ...over,
  }) as CurveLeg;

function cfg(over: Partial<SteadyBasketConfig> = {}): SteadyBasketConfig {
  return {
    legs: [
      { symbol: "TSLA", token: TSLA, weightBps: 5_000 },
      { symbol: "NVDA", token: NVDA, weightBps: 5_000 },
    ],
    buyPerTickUsdg: 10_000_000n, // 10 USDG
    idleFloorUsdg: 1_000_000_000n, // high, so the vault sweep never confuses a case
    swapRouter: "0x000000000000000000000000000000000000dEaD",
    vault: "0x000000000000000000000000000000000000bEEF",
    usdg: USDG,
    ...over,
  };
}

const curveOf = (over: Partial<CurveLeg> = {}, slippageBps = 100, maxImpactBps = 500) => ({
  legs: new Map([["PEPE", leg(over)]]),
  tokens: new Map([["PEPE", MEME as `0x${string}`]]),
  slippageBps,
  maxImpactBps,
});

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    sequencerUp: true,
    cashUsdg: 50_000_000n,
    vaultUsdg: 0n,
    staleFeeds: new Set(["TSLA", "NVDA"]),
    pausedTokens: new Set<string>(),
    spendHeadroomUsdg: 1_000_000_000n,
    holdings: new Map(),
    ...over,
  } as Snapshot;
}

/** The curve buys in a tick, typed so an assertion can read their money fields. */
const curveTrades = (t: { intents: readonly { kind: string }[] }) =>
  t.intents.filter((i) => i.kind === "curve-trade") as unknown as {
    assetOut: string;
    amountInRaw: bigint;
    minAmountOutRaw: bigint;
  }[];

describe("the fallback fires only when nothing else could have traded", () => {
  it("EVERY FEED SHUT, CASH IN HAND: it buys the coin", () => {
    const t = steadyBasketTick(cfg({ curve: curveOf() }), snap());
    const [buy] = curveTrades(t);
    assert.ok(buy, "a weekend tick with a signed curve coin must not be empty");
    assert.equal(buy.assetOut, MEME);
    assert.equal(buy.amountInRaw, 10_000_000n, "one tick's budget, not more");
    assert.ok(buy.minAmountOutRaw > 0n, "and never without a floor");
  });

  it("and says why, in the reason the feed publishes", () => {
    const t = steadyBasketTick(cfg({ curve: curveOf() }), snap());
    const why = t.why.find((w) => w?.code === "stale-fallback");
    assert.ok(why, "a trade with no reason is not publishable");
    assert.equal(why.code === "stale-fallback" && why.symbol, "PEPE");
  });

  it("A LEG THAT COULD TRADE IS NEVER DISPLACED", () => {
    // One feed live is a normal tick. The fallback exists for a market that is
    // shut, not for a market somebody would rather not trade.
    const t = steadyBasketTick(cfg({ curve: curveOf() }), snap({ staleFeeds: new Set(["NVDA"]) }));
    assert.equal(curveTrades(t).length, 0);
    assert.ok(t.intents.some((i) => i.kind === "swap"), "the live leg still buys");
  });

  it("and a tick that was short of cash stays short of cash", () => {
    // "Nothing bought because the feeds are shut" and "nothing bought because
    // there was no money" are different silences with different remedies, and
    // the fallback must not turn the second into a trade.
    const t = steadyBasketTick(cfg({ curve: curveOf() }), snap({ cashUsdg: 1_000_000n }));
    assert.equal(curveTrades(t).length, 0);
  });

  it("no curve legs at all is the old behaviour, exactly", () => {
    const t = steadyBasketTick(cfg(), snap());
    assert.deepEqual(t.intents, []);
    assert.equal(t.idle?.code, "all-legs-stale");
  });

  it("AND THE IDLE SENTENCE STOPS once the fallback actually traded", () => {
    // Reporting "nothing bought" beside a buy is the same class of wrongness as
    // reporting a trade that did not happen.
    const traded = steadyBasketTick(cfg({ curve: curveOf() }), snap());
    assert.equal(traded.idle, undefined);
    // But a fallback that declined leaves the sentence standing, because
    // nothing bought is still what happened.
    const declined = steadyBasketTick(cfg({ curve: curveOf({ quoteToken: TSLA }) }), snap());
    assert.equal(declined.idle?.code, "all-legs-stale");
  });
});

describe("what it refuses, silently, because the tick already says nothing happened", () => {
  const shut = () => snap();

  it("a curve quoted in anything but the agent's cash", () => {
    // One hop from USDG or not at all; a hop through the quote asset is not built.
    const t = steadyBasketTick(cfg({ curve: curveOf({ quoteToken: TSLA }) }), shut());
    assert.equal(curveTrades(t).length, 0);
  });

  it("A NATIVE-QUOTED CURVE, which the adapter physically cannot trade", () => {
    // The adapter is non-payable and every wall permission carries valueLimit 0.
    const t = steadyBasketTick(
      cfg({ curve: curveOf({ quoteToken: "0x0000000000000000000000000000000000000000" }) }),
      shut(),
    );
    assert.equal(curveTrades(t).length, 0);
  });

  it("a paused token", () => {
    const t = steadyBasketTick(cfg({ curve: curveOf() }), shut());
    assert.equal(curveTrades(t).length, 1, "control: it trades when not paused");
    const paused = steadyBasketTick(
      cfg({ curve: curveOf() }),
      snap({ pausedTokens: new Set([MEME.toLowerCase()]) }),
    );
    assert.equal(curveTrades(paused).length, 0);
  });

  it("A SIZE THAT MOVES THE CURVE PAST THE OWNER'S CEILING", () => {
    // The ceiling travels with the legs, from the owner's own setting. A thin
    // curve and a whole tick's budget is exactly the case it is for.
    const thin = curveOf({
      reserves: {
        quoteRaw: 20_000_000n,
        tokenRaw: 1_000_000_000_000_000_000n,
        quoteDecimals: 6,
        tokenDecimals: 18,
        graduationThresholdRaw: 5_000_000_000n,
      },
    });
    const t = steadyBasketTick(cfg({ curve: { ...thin, maxImpactBps: 100 } }), shut());
    assert.equal(curveTrades(t).length, 0, "a buy this size is refused in the producer");
  });

  it("and it never takes more than one coin in a tick", () => {
    const two = {
      legs: new Map([
        ["PEPE", leg()],
        ["WIF", leg()],
      ]),
      tokens: new Map([
        ["PEPE", MEME as `0x${string}`],
        ["WIF", "0x6666666666666666666666666666666666666666" as `0x${string}`],
      ]),
      slippageBps: 100,
      maxImpactBps: 500,
    };
    const t = steadyBasketTick(cfg({ curve: two }), shut());
    assert.equal(curveTrades(t).length, 1, "one tick's budget buys one thing");
  });
});

describe("the call site supplies it — the bug that made the last one inert", () => {
  const src = readFileSync(new URL("./registry.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

  it("THE BASKET IS HANDED curveLegsNow, PER TICK", () => {
    // curve-wiring.test.ts exists because exactly this line was missing for the
    // strategist: every layer looked wired, the production call site never
    // passed it, and every memecoin came back "not in the tradable universe".
    assert.match(src, /steadyBasketTick\(\{ \.\.\.cfg, curve: opts\.curveLegsNow\?\.\(\) \?\? null \}, snap\)/);
  });

  it("and it is called INSIDE the tick, not captured once", () => {
    // A leg carries that tick's reserves. curve-prices.ts refuses to cache them
    // for a measured reason: p99 movement is 1,546 bps over 240 seconds, so
    // last tick's reserves are a floor for a market that no longer exists.
    const at = src.indexOf("name: \"steady-basket\"");
    const call = src.indexOf("opts.curveLegsNow?.()", at);
    const arrow = src.indexOf("tick: (snap) =>", at);
    assert.ok(arrow > 0 && call > arrow, "the supplier is invoked inside the tick closure");
  });
});
