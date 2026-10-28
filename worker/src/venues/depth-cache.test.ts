import assert from "node:assert/strict";
import test from "node:test";
import type { StockToken } from "../../../packages/core/src/index";
import { createDepthReader, nearestLevel, type TokenDepth } from "./depth-cache";

const tok = (symbol: string): StockToken => ({
  symbol,
  name: symbol,
  address: `0x${symbol.toLowerCase().padEnd(40, "0")}` as `0x${string}`,
  chainlinkFeed: null,
  kind: "stock",
});

const TOKENS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map(tok);
const ALL = TOKENS.map((t) => t.symbol);

function harness(over: { ttlSec?: number; budget?: number; fail?: Set<string>; empty?: Set<string> } = {}) {
  let clockSec = 1_000_000;
  const calls: string[] = [];
  const reader = createDepthReader({
    client: {} as never,
    tokens: () => TOKENS,
    cash: "0x0000000000000000000000000000000000000001",
    cashDecimals: 6,
    ttlSec: over.ttlSec ?? 300,
    maxRefreshPerTick: over.budget ?? 4,
    now: () => clockSec * 1000,
    readOne: async (token, atSec): Promise<TokenDepth | null> => {
      calls.push(token.symbol);
      if (over.fail?.has(token.symbol)) throw new Error(`boom ${token.symbol}`);
      if (over.empty?.has(token.symbol)) return null;
      return {
        symbol: token.symbol,
        buyUsdg: 1000,
        sellUsdg: 900,
        supportUsd: 10,
        resistanceUsd: 12,
        partial: false,
        readAtSec: atSec,
      };
    },
  });
  return {
    reader,
    calls,
    advance: (sec: number) => {
      clockSec += sec;
    },
    drain: () => calls.splice(0, calls.length),
  };
}

test("a cold cache refreshes only up to the budget, and converges over ticks", () => {
  return (async () => {
    const h = harness({ budget: 2 });
    const first = await h.reader.read(ALL);
    assert.equal(h.drain().length, 2, "one tick spends only its budget");
    assert.equal(first.size, 2, "and returns only what it has");

    await h.reader.read(ALL);
    await h.reader.read(ALL);
    const third = await h.reader.read(ALL);
    // 6 tokens, 2 per tick — four ticks is enough to cover all of them.
    assert.equal(third.size, 6, "the whole set converges without ever bursting");
  })();
});

test("fresh entries are served from cache and cost nothing", () => {
  return (async () => {
    const h = harness({ budget: 10 });
    await h.reader.read(ALL);
    assert.equal(h.drain().length, 6, "first pass reads every token");

    h.advance(60); // well inside the 300s TTL
    const again = await h.reader.read(ALL);
    assert.equal(h.drain().length, 0, "nothing is re-read while fresh");
    assert.equal(again.size, 6, "but everything is still served");
  })();
});

test("an entry past its TTL is refreshed, and not before", () => {
  return (async () => {
    const h = harness({ budget: 10, ttlSec: 300 });
    await h.reader.read(ALL);
    h.drain();

    h.advance(299);
    await h.reader.read(ALL);
    assert.equal(h.drain().length, 0, "299s is still fresh");

    h.advance(1);
    await h.reader.read(ALL);
    assert.equal(h.drain().length, 6, "300s is not");
  })();
});

test("refresh order is oldest-first, so nothing starves", () => {
  return (async () => {
    const h = harness({ budget: 2, ttlSec: 100 });
    await h.reader.read(ALL); // AAA, BBB read at t0
    const firstTwo = h.drain();
    assert.deepEqual(firstTwo, ["AAA", "BBB"]);

    h.advance(10);
    await h.reader.read(ALL);
    assert.deepEqual(h.drain(), ["CCC", "DDD"], "the never-read come before the merely old");

    h.advance(10);
    await h.reader.read(ALL);
    assert.deepEqual(h.drain(), ["EEE", "FFF"]);

    // Now everything is read; once TTL passes, the OLDEST pair goes first.
    h.advance(200);
    await h.reader.read(ALL);
    assert.deepEqual(h.drain(), ["AAA", "BBB"], "and then it rotates by age");
  })();
});

test("a throwing read is swallowed — depth is colour, never load-bearing", () => {
  return (async () => {
    const h = harness({ budget: 10, fail: new Set(["CCC"]) });
    const out = await h.reader.read(ALL);
    // THE POINT: the tick must not care. Before this feature the strategist
    // proposed without depth; a failed read must return it to exactly that state
    // rather than taking the loop down with it.
    assert.equal(out.has("CCC"), false, "the failed token is simply absent");
    assert.equal(out.size, 5, "and every other token still made it");
  })();
});

test("a token with no mappable pool is absent rather than zero", () => {
  return (async () => {
    const h = harness({ budget: 10, empty: new Set(["DDD"]) });
    const out = await h.reader.read(ALL);
    assert.equal(out.has("DDD"), false);
    // Zero depth would read as "you cannot trade this", which is a claim. Absent
    // reads as "not known", which is the truth.
    assert.equal(out.get("AAA")?.buyUsdg, 1000);
  })();
});

test("an empty or failed read waits out the TTL, so it cannot starve the rest", () => {
  return (async () => {
    // Production, 2026-10-13: memecoins with no USDG pool came back null, left
    // no trace, sorted first again, and were searched every tick — a factory
    // call per fee tier each, forever, while the tokens that DO have a depth
    // map never got a turn. Budget 2, two dead tokens first in the list.
    const h = harness({ budget: 2, empty: new Set(["AAA"]), fail: new Set(["BBB"]) });
    await h.reader.read(ALL);
    assert.deepEqual(h.drain(), ["AAA", "BBB"], "the cold start asks the first two, as before");

    await h.reader.read(ALL);
    assert.deepEqual(h.drain(), ["CCC", "DDD"], "the next tick moves ON instead of asking them again");
    await h.reader.read(ALL);
    assert.deepEqual(h.drain(), ["EEE", "FFF"]);

    await h.reader.read(ALL);
    assert.deepEqual(h.drain(), [], "and nobody is re-asked inside the TTL, answered or not");

    h.advance(300);
    await h.reader.read(ALL);
    assert.deepEqual(h.drain(), ["AAA", "BBB"], "past the TTL the unanswered are asked again, oldest first");
  })();
});

test("a previously-good entry survives a later failure", () => {
  return (async () => {
    const fail = new Set<string>();
    let clockSec = 1_000_000;
    const reader = createDepthReader({
      client: {} as never,
      tokens: () => TOKENS,
      cash: "0x0000000000000000000000000000000000000001",
      cashDecimals: 6,
      ttlSec: 100,
      maxRefreshPerTick: 10,
      now: () => clockSec * 1000,
      readOne: async (token, atSec) => {
        if (fail.has(token.symbol)) throw new Error("boom");
        return {
          symbol: token.symbol,
          buyUsdg: 1000,
          sellUsdg: 900,
          supportUsd: 10,
          resistanceUsd: 12,
          partial: false,
          readAtSec: atSec,
        };
      },
    });

    await reader.read(["AAA"]);
    fail.add("AAA");
    clockSec += 200; // force a refresh that will now throw
    const out = await reader.read(["AAA"]);
    // A transient RPC hiccup and a genuinely drained pool are indistinguishable
    // from here. Keeping the last known shape is the less disruptive guess, and
    // readAtSec still says how old it is so a consumer can judge.
    assert.equal(out.get("AAA")?.buyUsdg, 1000, "the last good reading is retained");
    assert.equal(out.get("AAA")?.readAtSec, 1_000_000, "and it still reports when it was taken");
  })();
});

test("only requested symbols are read or returned", () => {
  return (async () => {
    const h = harness({ budget: 10 });
    const out = await h.reader.read(["AAA", "BBB"]);
    assert.deepEqual(h.drain().sort(), ["AAA", "BBB"], "unrequested tokens cost no RPC");
    assert.deepEqual([...out.keys()].sort(), ["AAA", "BBB"]);
  })();
});

test("an unknown symbol is ignored rather than throwing", () => {
  return (async () => {
    const h = harness({ budget: 10 });
    const out = await h.reader.read(["AAA", "NOPE"]);
    assert.equal(out.has("NOPE"), false);
    assert.equal(out.has("AAA"), true);
  })();
});

test("reset clears the cache so the next read is cold", () => {
  return (async () => {
    const h = harness({ budget: 10 });
    await h.reader.read(ALL);
    h.drain();
    h.reader.reset();
    await h.reader.read(ALL);
    assert.equal(h.drain().length, 6, "everything is re-read after a reset");
  })();
});

test("the reported level is where the shelf ENDS, not where it starts", () => {
  // THE BUG THIS PINS, caught by looking at live output rather than at code.
  // The nearest cluster nearly always abuts spot, so reporting its facing edge
  // returned spot for BOTH sides — NVDA came back support 217.40 / resistance
  // 217.40 against spot 217.22. Right arithmetic, useless answer.
  const spot8 = 21_722_000_000n;
  const depth = {
    zones: [
      { side: "support" as const, priceLow8: 20_854_000_000n, priceHigh8: spot8, cashRaw: 1n, shareBps: 4700, distanceBps: 0 },
      { side: "resistance" as const, priceLow8: spot8, priceHigh8: 22_659_000_000n, cashRaw: 1n, shareBps: 7100, distanceBps: 0 },
      { side: "support" as const, priceLow8: 19_000_000_000n, priceHigh8: 19_400_000_000n, cashRaw: 1n, shareBps: 300, distanceBps: 1100 },
    ],
  } as unknown as import("./depth").PoolDepth;

  assert.equal(nearestLevel(depth, "support"), 208.54, "the bottom of the shelf, not its top");
  assert.equal(nearestLevel(depth, "resistance"), 226.59, "the top of the shelf, not its bottom");
  assert.notEqual(
    nearestLevel(depth, "support"),
    nearestLevel(depth, "resistance"),
    "the two sides must not collapse onto spot",
  );
});

test("nearestLevel picks the CLOSEST shelf, and returns null when a side is empty", () => {
  const onlySupport = {
    zones: [
      { side: "support" as const, priceLow8: 19_000_000_000n, priceHigh8: 19_400_000_000n, cashRaw: 1n, shareBps: 300, distanceBps: 1100 },
      { side: "support" as const, priceLow8: 20_854_000_000n, priceHigh8: 21_722_000_000n, cashRaw: 1n, shareBps: 4700, distanceBps: 50 },
    ],
  } as unknown as import("./depth").PoolDepth;
  assert.equal(nearestLevel(onlySupport, "support"), 208.54, "distance decides, not size or order");
  assert.equal(nearestLevel(onlySupport, "resistance"), null, "an empty side is null, never 0");
});
