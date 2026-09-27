/**
 * BELOW THE CIRCLE TIER, THE EXITS STILL RUN.
 *
 * The gate used to `return` from the tick ahead of the strategy's own sells
 * and ahead of the class route's exits, so an owner who fell below 100,000
 * $MERRYMEN with positions open had an agent that could close nothing. The
 * filter is run here with a real Circle strategy and the breaker's real exit
 * test; the wiring in main(), which no test can boot, is pinned over index.ts
 * with comments stripped — prose about the gate is not the gate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CIRCLE_SHORT_CLASS_GATE, circleExitsOnly } from "./circle-gate";
import { isExitIntent, type TradeIntent } from "./policy";
import { evenKeelTick, type EvenKeelConfig } from "./strategies/even-keel";
import type { Holding, Snapshot, Tick } from "./strategies/types";

const AAPL = "0xaaaa000000000000000000000000000000000000" as const;
const MSFT = "0xbbbb000000000000000000000000000000000000" as const;
const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const U = (n: number) => BigInt(Math.round(n * 1e6));
const P = (n: number) => BigInt(Math.round(n * 1e8));

const LIMITS = { cashToken: USDG };
const exit = (i: TradeIntent) => isExitIntent(i, LIMITS);

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: U(50),
  vaultUsdg: 0n,
  holdings: new Map<string, Holding>(),
  prices: new Map([
    ["AAPL", { price8: P(100), stale: false, source: "chainlink" as const }],
    ["MSFT", { price8: P(100), stale: false, source: "chainlink" as const }],
  ]),
  pausedTokens: new Set<string>(),
  staleFeeds: new Set<string>(),
  sequencerUp: true,
  spendHeadroomUsdg: U(1_000_000),
  perTradeCapUsdg: U(1_000_000),
  ...over,
});

const KEEL: EvenKeelConfig = {
  legs: [
    { symbol: "AAPL", token: AAPL },
    { symbol: "MSFT", token: MSFT },
  ],
  swapRouter: ROUTER,
  usdg: USDG,
  maxTradeUsdg: U(25),
  bandBps: 500,
  seedBudgetUsdg: U(50),
};

describe("a Circle strategy below the tier", () => {
  it("EVEN-KEEL'S TRIM STILL GOES OUT; its top-up does not", () => {
    const holdings = new Map<string, Holding>([
      ["AAPL", { token: AAPL, rawBalance: 10n ** 18n, valueUsdg: U(80), priceStale: false }],
      ["MSFT", { token: MSFT, rawBalance: 10n ** 18n, valueUsdg: U(20), priceStale: false }],
    ]);
    const full = evenKeelTick(KEEL, snap({ holdings }));
    assert.equal(full.intents.length, 2, "the fixture must produce both a trim and a top-up");

    const short = circleExitsOnly(full, exit);
    assert.equal(short.intents.length, 1);
    const out = short.intents[0]!;
    assert.ok(out.kind === "swap" && out.sellToken === AAPL && out.buyToken === USDG, "the sell into cash");
    assert.equal(short.why.length, 1);
    assert.equal(short.why[0]?.code, "keel-trim", "and its own reason stays paired with it");
  });

  it("the cold-start seed is new work, so nothing goes out", () => {
    const seed = evenKeelTick(KEEL, snap());
    assert.ok(seed.intents.length > 0);
    assert.deepEqual(circleExitsOnly(seed, exit), { intents: [], why: [] });
  });

  it("REASONS STAY PAIRED when the buy comes first, and a vault deposit is not an exit", () => {
    const buy: TradeIntent = { kind: "swap", target: ROUTER, sellToken: USDG, buyToken: MSFT, sellAmountRaw: 1n, notionalUsdg: 1n };
    const sell: TradeIntent = { kind: "swap", target: ROUTER, sellToken: AAPL, buyToken: USDG, sellAmountRaw: 1n, notionalUsdg: 1n };
    const park: TradeIntent = { kind: "vault-deposit", target: ROUTER, amountUsdg: 1n };
    const pull: TradeIntent = { kind: "vault-withdraw", target: ROUTER, amountUsdg: 1n };
    const tick: Tick = {
      intents: [buy, sell, park, pull],
      why: [
        { code: "keel-top", symbol: "MSFT", underRaw: 1n, capped: false },
        { code: "keel-trim", symbol: "AAPL", overRaw: 1n },
        null,
        null,
      ],
    };
    const short = circleExitsOnly(tick, exit);
    assert.deepEqual(short.intents, [sell, pull]);
    assert.deepEqual(short.why, [tick.why[1], null]);
  });

  it("A LOCKED STRATEGY'S IDLE REASON IS DROPPED — the Circle is why, not the feeds", () => {
    const stale = evenKeelTick(KEEL, snap({ staleFeeds: new Set(["AAPL", "MSFT"]) }));
    assert.equal(stale.idle?.code, "all-legs-stale");
    assert.equal(circleExitsOnly(stale, exit).idle, undefined);
  });

  it("the class route proposes no entries, and is not even asked", async () => {
    let asked = 0;
    const t = await CIRCLE_SHORT_CLASS_GATE.entries(async () => {
      asked++;
      return { intents: [{ kind: "vault-withdraw", target: ROUTER, amountUsdg: 1n }], why: [null] };
    });
    assert.deepEqual(t, { intents: [], why: [] });
    assert.equal(asked, 0);
  });
});

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const CODE = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));

describe("the tick's wiring below the tier", () => {
  const gate = CODE.indexOf("const circleShort = isCircleStrategy(strategy.name) && !holderTier.bonusStrategies;");
  const tick = CODE.indexOf("takeTick(await strategy.tick(snap))");
  const exits = CODE.indexOf("const exits = await proposeClassExits();");

  it("THE GATE CAN NO LONGER END THE TICK before the strategy's exits or the class exits", () => {
    assert.ok(gate > 0 && tick > gate && exits > tick, "gate, then the strategy tick, then the class exits");
    assert.doesNotMatch(CODE.slice(gate, exits), /\breturn\b/, "nothing between the Circle gate and the class exits may return");
  });

  it("the strategy ticks whatever the tier, and below it only its exits go on", () => {
    assert.match(CODE, /const ticked: Tick = brainOrderAccepted \? \{ intents: \[\], why: \[\] \} : takeTick\(await strategy\.tick\(snap\)\);/);
    assert.match(
      CODE,
      /const \{ intents: proposed, why: proposedWhy, idle \} = circleShort\s*\?\s*circleExitsOnly\(ticked, \(intent\) => isExitIntent\(intent, exitLimits\)\)\s*:\s*ticked;/,
    );
    assert.match(CODE, /const exitLimits = active\.limits;/, "the breaker's own limits, not a second copy of the exit test");
  });

  it("THE CLASS EXITS ASK NOTHING OF THE TIER; the class entries are closed below it", () => {
    const loop = CODE.slice(exits, CODE.indexOf("const entries: Tick", exits));
    assert.doesNotMatch(loop, /circleShort|holderTier|bonusStrategies/);
    assert.match(CODE, /const classGate = circleShort \? CIRCLE_SHORT_CLASS_GATE : await idleAndClassGate\(\{/);
    assert.match(CODE, /const entries: Tick = await classGate\.entries\(async \(\) => await proposeClassEntries\(\)\);/);
  });

  it("the owner is still told once per change", () => {
    const block = CODE.slice(gate, CODE.indexOf("const ticked: Tick", gate));
    assert.match(block, /if \(circleShort\) \{\s*if \(!circleBlockedNoted\) \{\s*circleBlockedNoted = true;/);
    assert.match(block, /\} else \{\s*circleBlockedNoted = false;\s*\}/);
  });
});
