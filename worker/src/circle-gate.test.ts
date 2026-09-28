/**
 * BELOW THE CIRCLE TIER, A CIRCLE STRATEGY DOES NOTHING OF ITS OWN — AND THE
 * CLASS EXITS STILL RUN.
 *
 * The gate used to `return` from the tick ahead of the class route's exits, so
 * an owner who fell below 100,000 $MERRYMEN with a class position open had an
 * agent that could close nothing. The first fix let the strategy tick and
 * passed on its "exits" — which, for even-keel, are the trims of a rebalance
 * whose top-ups were dropped: every tick sold the book further into cash, the
 * whole of it once a leg was empty. So the strategy is not asked at all below
 * the tier, and only the class exits run. The multi-tick book below runs the
 * real even-keel through the real gate; the wiring in main(), which no test can
 * boot, is pinned over index.ts with comments stripped — prose about the gate
 * is not the gate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CIRCLE_SHORT_CLASS_GATE, circleStrategyTick } from "./circle-gate";
import { evenKeelTick, type EvenKeelConfig } from "./strategies/even-keel";
import type { Holding, Snapshot, Tick } from "./strategies/types";

const A = "0xaaaa000000000000000000000000000000000000" as const;
const B = "0xbbbb000000000000000000000000000000000000" as const;
const C = "0xcccc000000000000000000000000000000000000" as const;
const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const U = (n: number) => BigInt(Math.round(n * 1e6));
const P = (n: number) => BigInt(Math.round(n * 1e8));
const LEGS = [
  { symbol: "A", token: A },
  { symbol: "B", token: B },
  { symbol: "C", token: C },
] as const;

/** The reviewer's case: a 5 USDG-a-tick even-keel on three legs. */
const KEEL: EvenKeelConfig = {
  legs: LEGS.map((l) => ({ ...l })),
  swapRouter: ROUTER,
  usdg: USDG,
  maxTradeUsdg: U(5),
  bandBps: 500,
  seedBudgetUsdg: U(5),
};

/** A book at a flat price of 1 USDG a unit, as a snapshot even-keel reads. */
function snapOf(book: { cash: bigint; legs: Record<string, bigint> }): Snapshot {
  const holdings = new Map<string, Holding>();
  for (const l of LEGS) {
    const v = book.legs[l.symbol] ?? 0n;
    if (v > 0n) holdings.set(l.symbol, { token: l.token, rawBalance: v * 10n ** 12n, valueUsdg: v, priceStale: false });
  }
  return {
    cashUsdg: book.cash,
    vaultUsdg: 0n,
    holdings,
    prices: new Map(LEGS.map((l) => [l.symbol, { price8: P(1), stale: false, source: "chainlink" as const }])),
    pausedTokens: new Set<string>(),
    staleFeeds: new Set<string>(),
    sequencerUp: true,
    spendHeadroomUsdg: U(1_000_000),
    perTradeCapUsdg: U(1_000_000),
  };
}

/**
 * Run `ticks` windows of the real even-keel through the real gate, filling
 * every swap it proposes at the flat price. Returns the book and how many
 * times the strategy was asked and how many swaps went out.
 */
async function runBook(circleShort: boolean, start: Record<string, number>, ticks: number) {
  const book = { cash: U(10), legs: Object.fromEntries(Object.entries(start).map(([k, v]) => [k, U(v)])) as Record<string, bigint> };
  let asked = 0;
  let swaps = 0;
  for (let t = 0; t < ticks; t++) {
    const tick = await circleStrategyTick(circleShort, async () => {
      asked++;
      return evenKeelTick(KEEL, snapOf(book));
    });
    for (const i of tick.intents) {
      if (i.kind !== "swap") continue;
      swaps++;
      const sold = LEGS.find((l) => l.token === i.sellToken);
      const bought = LEGS.find((l) => l.token === i.buyToken);
      if (sold) {
        book.legs[sold.symbol] = (book.legs[sold.symbol] ?? 0n) - i.notionalUsdg;
        book.cash += i.notionalUsdg;
      } else if (bought) {
        book.legs[bought.symbol] = (book.legs[bought.symbol] ?? 0n) + i.notionalUsdg;
        book.cash -= i.notionalUsdg;
      }
    }
  }
  return { book, asked, swaps };
}

describe("a Circle strategy below the tier", () => {
  it("AN EVEN-KEEL BOOK WITH AN EMPTY LEG IS NOT SOLD DOWN — 400 windows short, and nothing moves", async () => {
    // A100 B100 C0: the book the one-sided pass sold to cash in 114 ticks.
    const short = await runBook(true, { A: 100, B: 100, C: 0 }, 400);
    assert.equal(short.asked, 0, "below the tier the strategy is not even asked");
    assert.equal(short.swaps, 0);
    assert.deepEqual(short.book, { cash: U(10), legs: { A: U(100), B: U(100), C: U(0) } }, "its basket is left as it is");
  });

  it("and a drifted book is not trimmed either — no rebalancing in either direction", async () => {
    const short = await runBook(true, { A: 120, B: 100, C: 80 }, 50);
    assert.equal(short.swaps, 0);
    assert.deepEqual(short.book.legs, { A: U(120), B: U(100), C: U(80) });
  });

  it("control: AT the tier the same book is rebalanced, not liquidated — the gate is why nothing moved above", async () => {
    const full = await runBook(false, { A: 100, B: 100, C: 0 }, 400);
    assert.equal(full.asked, 400);
    assert.ok(full.swaps > 0, "the fixture does trade when the strategy runs");
    // Both halves ran: A and B trimmed, C topped up, and it settles at even
    // weight (about 51.7 / 51.7 / 50) rather than at zero.
    const { A: a = 0n, B: b = 0n, C: c = 0n } = full.book.legs;
    assert.ok(c >= U(45), "the empty leg is topped up");
    assert.ok(a >= U(45) && b >= U(45), "the full legs are trimmed to even weight, not sold out");
    assert.equal(full.book.cash + a + b + c, U(210), "every fill at the flat price — nothing lost, only moved");
  });

  it("the cold-start seed is new work, so nothing goes out", async () => {
    const seed = evenKeelTick(KEEL, snapOf({ cash: U(50), legs: {} }));
    assert.ok(seed.intents.length > 0, "premise: at the tier it would seed");
    assert.deepEqual(await circleStrategyTick(true, async () => seed), { intents: [], why: [] });
  });

  it("A LOCKED STRATEGY'S IDLE REASON IS DROPPED — the Circle is why, not the feeds", async () => {
    const snap = { ...snapOf({ cash: U(50), legs: { A: 10n } }), staleFeeds: new Set(["A", "B", "C"]) };
    const stale = evenKeelTick(KEEL, snap);
    assert.equal(stale.idle?.code, "all-legs-stale");
    assert.equal((await circleStrategyTick(true, async () => stale)).idle, undefined);
  });

  it("at the tier the strategy's own tick is passed through untouched, reasons and idle included", async () => {
    const tick: Tick = {
      intents: [{ kind: "swap", target: ROUTER, sellToken: USDG, buyToken: B, sellAmountRaw: 1n, notionalUsdg: 1n }],
      why: [{ code: "keel-top", symbol: "B", underRaw: 1n, capped: false }],
    };
    assert.equal(await circleStrategyTick(false, async () => tick), tick);
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
  const tick = CODE.indexOf("await circleStrategyTick(circleShort, async () => takeTick(await strategy.tick(snap)))");
  const exits = CODE.indexOf("const exits = await proposeClassExits();");

  it("THE GATE CAN NO LONGER END THE TICK before the class exits", () => {
    assert.ok(gate > 0 && tick > gate && exits > tick, "gate, then the (gated) strategy tick, then the class exits");
    assert.doesNotMatch(CODE.slice(gate, exits), /\breturn\b/, "nothing between the Circle gate and the class exits may return");
  });

  it("BELOW THE TIER THE STRATEGY IS NOT TICKED AT ALL — never a one-sided pass over its exits", () => {
    assert.match(
      CODE,
      /const \{ intents: proposed, why: proposedWhy, idle \}: Tick = brainOrderAccepted\s*\?\s*\{ intents: \[\], why: \[\] \}\s*:\s*await circleStrategyTick\(circleShort, async \(\) => takeTick\(await strategy\.tick\(snap\)\)\);/,
    );
    assert.equal(CODE.split("strategy.tick(snap)").length - 1, 1, "the strategy is ticked in one place, through the gate");
    assert.doesNotMatch(CODE, /circleExitsOnly/, "the trims-only filter is gone");
  });

  it("THE CLASS EXITS ASK NOTHING OF THE TIER; the class entries are closed below it", () => {
    const loop = CODE.slice(exits, CODE.indexOf("const entries: Tick", exits));
    assert.doesNotMatch(loop, /circleShort|holderTier|bonusStrategies/);
    assert.match(CODE, /const classGate = circleShort \? CIRCLE_SHORT_CLASS_GATE : await idleAndClassGate\(\{/);
    assert.match(CODE, /const entries: Tick = await classGate\.entries\(async \(\) => await proposeClassEntries\(\)\);/);
  });

  it("the owner is still told once per change", () => {
    const block = CODE.slice(gate, tick);
    assert.match(block, /if \(circleShort\) \{\s*if \(!circleBlockedNoted\) \{\s*circleBlockedNoted = true;/);
    assert.match(block, /\} else \{\s*circleBlockedNoted = false;\s*\}/);
  });
});
