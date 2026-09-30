/**
 * WHAT THE TRENCHER TELLS AN OWNER WHEN IT PASSES ON A TOKEN.
 *
 * The bug these are written against: every refusal to open said "can't be
 * priced — the pool guards refused it", for four different reasons, two of
 * which were not a guard and one of which was not a refusal to price at all.
 * In production that sentence appeared for a token whose pool was measured at
 * $11,926 against a $25,000 floor, and for a token no pricer could find a
 * venue for — the exact pair `shouldEnter`'s own header says the owner must be
 * able to tell apart.
 *
 * So the tests below are about two properties, and neither is about wording:
 *
 *   1. THE GATE DID NOT MOVE. `priceable` is now derived from the cause rather
 *      than computed beside it, and that refactor must be provably behaviour-
 *      preserving on live-money code. The oracle is the original expression,
 *      written out literally, swept over every quote shape.
 *
 *   2. DIFFERENT FACTS READ DIFFERENTLY. Any two causes that mean different
 *      things must produce different sentences, and none may describe a token
 *      that WAS priced as one that could not be.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { PriceQuote } from "../../../packages/core/src/index";
import {
  NOT_WATCHED,
  TRENCHER_DEFAULTS,
  priceability,
  shouldEnter,
  unpriceableCause,
  type Candidate,
  type UnpriceableCause,
} from "./trencher";

type Source = PriceQuote["source"];
type Quote = { stale: boolean; price8: bigint; source: Source };

/**
 * Every `PriceQuote.source`, BOUND TO THE UNION rather than copied from it.
 *
 * A bare `as const` list here claimed to cover the union and covered only
 * whatever someone last typed — so a sixth source would sail through the sweep
 * AND through `unpriceableCause`'s classifier, and every quote from a new
 * venue would be described to the owner as a stock feed. The two halves of
 * that guarantee are the `satisfies` below (this list omits nothing) and the
 * `never` in the classifier's default arm (that list omits nothing either).
 */
const SOURCES = ["chainlink", "pool", "broker", "curve", "v4"] as const satisfies readonly Source[];

/** Fails to compile if a source exists that `SOURCES` does not name. */
const _EVERY_SOURCE_LISTED: (typeof SOURCES)[number] extends Source
  ? Source extends (typeof SOURCES)[number]
    ? true
    : never
  : never = true;
void _EVERY_SOURCE_LISTED;

/** Every shape a quote can arrive in, including absent. */
const QUOTES: (Quote | undefined)[] = [undefined];
for (const source of SOURCES) {
  for (const stale of [false, true]) {
    for (const price8 of [0n, -1n, 1n, 100_000_000n]) QUOTES.push({ stale, price8, source });
  }
}

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  symbol: "CATE",
  token: "0x00000000000000000000000000000000000000c1",
  decimals: 18,
  priceable: true,
  liquidityUsd: 120_000,
  fdvUsd: 800_000,
  ageSec: 45 * 60,
  price8: 100_000n,
  ...over,
});

const whyOf = (unpriceable: UnpriceableCause): string => {
  const v = shouldEnter(candidate({ priceable: false, unpriceable }), TRENCHER_DEFAULTS, 1_800_000_000);
  assert.equal(v.enter, false, "a candidate with a cause must still be refused");
  return v.enter === false ? v.why : "";
};

/**
 * Every member, BOUND TO THE UNION — a hand-copied list is how a new member
 * gets shipped with no sentence checked against it, which is the same mistake
 * `SOURCES` above had to be rescued from.
 */
const ALL_CAUSES = [
  "no-quote",
  "stale-price",
  "zero-price",
  "curve-priced",
  "v4-priced",
  "feed-priced",
  "unknown-source",
  "not-watched",
] as const satisfies readonly UnpriceableCause[];

/** Fails to compile if a cause exists that `ALL_CAUSES` does not name. */
const _EVERY_CAUSE_LISTED: UnpriceableCause extends (typeof ALL_CAUSES)[number] ? true : never = true;
void _EVERY_CAUSE_LISTED;

/**
 * Causes no quote can produce, each for its own stated reason. Anything else
 * that stops being reachable is a bug, not an entry here.
 */
const NOT_FROM_A_QUOTE = new Set<UnpriceableCause>([
  // A fact about the watch set, set at the call site (see NOT_WATCHED).
  "not-watched",
  // Unreachable BY CONSTRUCTION in a well-typed build: the classifier's `never`
  // makes a new PriceQuote source a compile error, so this arm only ever runs
  // if someone defeats that. It still needs a true sentence for that day.
  "unknown-source",
]);

describe("the gate did not move", () => {
  it("matches the original expression for every quote shape, at both sites", () => {
    // THE ORACLE, copied from the two call sites as they stood before the
    // cause existed. If someone later changes `unpriceableCause`'s ordering or
    // its short-circuits, this is what notices.
    const siteA = (q: Quote | undefined) => !!q && !q.stale && q.price8 > 0n && q.source === "pool";
    const siteB = (q: Quote | undefined) => !!q && !q.stale && q.price8 > 0n;

    for (const q of QUOTES) {
      const shown = JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
      assert.equal(unpriceableCause(q, true) === null, siteA(q), `site A disagrees for ${shown}`);
      assert.equal(unpriceableCause(q, false) === null, siteB(q), `site B disagrees for ${shown}`);
    }
  });

  it("sweeps a quote shape that actually exercises each clause", () => {
    // Guards the sweep itself: a QUOTES list that happened to contain only
    // priceable quotes would make the equivalence above vacuously true.
    assert.ok(QUOTES.some((q) => q === undefined), "absence must be covered");
    assert.ok(QUOTES.some((q) => q?.stale), "a stale quote must be covered");
    assert.ok(QUOTES.some((q) => q && q.price8 <= 0n), "a non-positive price must be covered");
    assert.ok(QUOTES.some((q) => q && !q.stale && q.price8 > 0n && q.source === "pool"), "a passing quote must be covered");
    for (const source of SOURCES) {
      assert.ok(QUOTES.some((q) => q?.source === source && !q.stale && q.price8 > 0n), `${source} must be covered`);
    }
  });
});

describe("the verdict and its reason are built together", () => {
  it("never produces either illegal state, for any quote", () => {
    // priceable WITH a cause hides a reason nothing reads; unpriceable WITHOUT
    // one makes the note say "nobody recorded why" about a tick that knew.
    // Neither is a type error, so it is asserted instead.
    for (const q of QUOTES) {
      for (const requirePool of [true, false]) {
        const p = priceability(q, requirePool);
        assert.equal("unpriceable" in p && p.unpriceable !== undefined, !p.priceable, JSON.stringify(p));
      }
    }
    assert.equal(NOT_WATCHED.priceable, false);
    assert.equal(NOT_WATCHED.unpriceable, "not-watched");
  });

  it("carries the RIGHT cause, not merely some cause", () => {
    // `priceability` is the function both build sites call; `unpriceableCause`
    // is not called by either. Asserting only that a cause is PRESENT let a
    // hard-coded `unpriceable: "no-quote"` pass the whole file — one fixed
    // sentence for every fact, which is the bug this change exists to remove,
    // reintroduced through the only function production runs.
    for (const q of QUOTES) {
      for (const requirePool of [true, false]) {
        const shown = `${JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))} pool=${requirePool}`;
        assert.equal(priceability(q, requirePool).unpriceable, unpriceableCause(q, requirePool) ?? undefined, shown);
      }
    }
  });

  it("agrees with the bare cause function it is built on", () => {
    for (const q of QUOTES) {
      for (const requirePool of [true, false]) {
        assert.equal(priceability(q, requirePool).priceable, unpriceableCause(q, requirePool) === null);
      }
    }
  });
});

describe("a cause names what actually happened", () => {
  it("reports the FIRST thing wrong, not the last", () => {
    // The equivalence proof cannot see this: a zero-priced curve quote is
    // unpriceable either way, so reordering the checks keeps the boolean and
    // silently changes the sentence to one that is false. The owner would be
    // told the token is on a bonding curve when the real fact is that its
    // price read as zero.
    assert.equal(unpriceableCause({ stale: false, price8: 0n, source: "curve" }, true), "zero-price");
    assert.equal(unpriceableCause({ stale: true, price8: 0n, source: "v4" }, true), "stale-price");
    assert.equal(unpriceableCause(undefined, true), "no-quote");
  });

  it("names the same fact on the site that does NOT require a pool", () => {
    // Site B's policy differs only in whether a non-pool SOURCE disqualifies.
    // Every other cause must still be identified, and without this the whole
    // false branch was pinned on null-ness alone: an early-out returning a
    // blanket "no-quote" for site B is boolean-identical and would have told
    // an owner nobody answered about a quote that was measured at zero.
    assert.equal(unpriceableCause(undefined, false), "no-quote");
    assert.equal(unpriceableCause({ stale: true, price8: 100n, source: "pool" }, false), "stale-price");
    assert.equal(unpriceableCause({ stale: false, price8: 0n, source: "pool" }, false), "zero-price");
    // ...and a non-pool source is NOT a refusal here, which is the difference.
    assert.equal(unpriceableCause({ stale: false, price8: 100n, source: "v4" }, false), null);
  });

  it("gives every cause its own sentence", () => {
    const seen = new Map<string, UnpriceableCause>();
    for (const cause of ALL_CAUSES) {
      const why = whyOf(cause);
      const clash = seen.get(why);
      assert.equal(clash, undefined, `"${cause}" and "${clash}" read identically: ${why}`);
      seen.set(why, cause);
    }
  });

  it("NEVER renders absence and a measured zero the same way", () => {
    // The rule this repo applies to depth, applied to a price. "Nobody
    // answered" and "the answer was zero" send an owner to different places.
    assert.notEqual(whyOf("no-quote"), whyOf("zero-price"));
  });

  it("does not claim a token that WAS priced could not be priced", () => {
    // A v4 or curve mark is a real price the agent declines to OPEN on. Any
    // wording that denies the price exists is the original bug in new clothes,
    // so this matches the CLAIM rather than one phrasing of it.
    const DENIES_A_PRICE = /can't be priced|couldn't be priced|no price|unpriceable|no venue|not priced/i;
    for (const cause of ["curve-priced", "v4-priced", "feed-priced"] as const) {
      assert.doesNotMatch(whyOf(cause), DENIES_A_PRICE, `"${cause}" must not deny a price it has`);
    }
  });

  it("does not blame a guard that never ran", () => {
    // The old sentence blamed "the pool guards" for all four causes. Only a
    // measured guard refusal may ever say so, and none of these is one.
    for (const cause of ALL_CAUSES) {
      assert.doesNotMatch(whyOf(cause), /pool guards/, `"${cause}" must not name a guard`);
    }
  });

  it("names every axis the watch-set check actually tests", () => {
    // `sameToken` is a conjunction of kind, SYMBOL and address, and the symbol
    // is the conjunct that fails on the ordinary path — discovery records a
    // token under its on-chain `symbol()` casing, the owner is told to add it
    // and types it differently. A sentence naming only the address is false
    // exactly when the owner can check it and find a token sitting there.
    const why = whyOf("not-watched");
    assert.match(why, /symbol/, "must name the symbol — it is the conjunct that usually fails");
    assert.match(why, /address/, "must name the address too — both are tested");
  });

  it("says so plainly when nobody recorded a cause", () => {
    // `unpriceable` is optional, so an older caller still refuses — but it must
    // not be able to borrow an explanation it never had.
    const v = shouldEnter(candidate({ priceable: false }), TRENCHER_DEFAULTS, 1_800_000_000);
    assert.equal(v.enter, false);
    assert.match(v.enter === false ? v.why : "", /nobody recorded why/);
  });
});

describe("what each site can and cannot say", () => {
  it("requiring a pool source is what refuses a v4 or curve mark", () => {
    // `requirePoolSource` is the whole policy in one flag. With it, a mark that
    // no oracle checked cannot authorise a buy; without it, anything that
    // produced a number does. Both build sites now pass `true` — see the entry
    // policy test below for why — so `false` survives only as the shape of the
    // question, and this pins what each answer means.
    for (const source of ["curve", "v4", "chainlink", "broker"] as const) {
      const q = { stale: false, price8: 100_000_000n, source };
      assert.equal(unpriceableCause(q, false), null, `valuation accepts a ${source} quote`);
      assert.notEqual(unpriceableCause(q, true), null, `entry must refuse a ${source} quote`);
    }
  });

  it("refuses a source it does not recognise instead of calling it a stock feed", () => {
    // The cast is the point. A sixth `PriceQuote.source` is a COMPILE error at
    // the classifier's `never`, and that is the real guard — but a compile
    // guard cannot be exercised by a test, and the arm behind it is what runs
    // if anyone ever defeats it. So this forces a value through the way a new
    // venue's quote would arrive and pins what the owner is told: not "a stock
    // feed", which is the original bug's exact sentence in a new branch.
    const rogue = { stale: false, price8: 100_000_000n, source: "someNewDex" as Source };
    assert.equal(unpriceableCause(rogue, true), "unknown-source");
    assert.notEqual(unpriceableCause(rogue, true), "feed-priced");
    assert.doesNotMatch(whyOf("unknown-source"), /stock feed/);
    // ...and it must still be a refusal, not a silent pass.
    assert.equal(priceability(rogue, true).priceable, false);
  });

  it("names WHICH kind of price it declined to open on", () => {
    const q = (source: Source) => ({ stale: false, price8: 100_000_000n, source });
    assert.equal(unpriceableCause(q("curve"), true), "curve-priced");
    assert.equal(unpriceableCause(q("v4"), true), "v4-priced");
    assert.equal(unpriceableCause(q("chainlink"), true), "feed-priced");
    assert.equal(unpriceableCause(q("broker"), true), "feed-priced");
  });

  it("every cause the function can return has a sentence, and vice versa", () => {
    // A member nothing can produce would be unfalsifiable text in the owner's
    // event stream. `not-watched` is the one exception and is set at the call
    // site, not here, so it is asserted separately below.
    const produced = new Set<UnpriceableCause>();
    for (const q of QUOTES) {
      for (const requirePool of [true, false]) {
        const c = unpriceableCause(q, requirePool);
        if (c) produced.add(c);
      }
    }
    for (const cause of ALL_CAUSES) {
      if (NOT_FROM_A_QUOTE.has(cause)) continue;
      assert.ok(produced.has(cause), `"${cause}" is declared but nothing can produce it`);
    }
    for (const cause of produced) {
      assert.ok((ALL_CAUSES as readonly UnpriceableCause[]).includes(cause), `"${cause}" is produced but untested`);
      assert.ok(!NOT_FROM_A_QUOTE.has(cause), `"${cause}" is exempted as unreachable but a quote produced it`);
    }
  });

  it("never reports 'not-watched' from the quote alone", () => {
    // It is a fact about the watch set, not about a price, so the pure
    // function must not be able to guess it.
    for (const q of QUOTES) {
      for (const requirePool of [true, false]) {
        assert.notEqual(unpriceableCause(q, requirePool), "not-watched");
      }
    }
  });
});

describe("both build sites ask for the verdict rather than recomputing it", () => {
  /**
   * A SOURCE ASSERTION, AND HONEST ABOUT WHAT THAT BUYS. `trenchCandidates`
   * lives inside the tick's closure in index.ts and cannot be called from a
   * test, so this pins the WIRING only: it proves the old inline expression is
   * gone and the helper is what both sites spread. It cannot prove the sites
   * run, which is what the behaviour tests above are for.
   */
  const INDEX = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");

  it("assigns `priceable` nowhere — every value comes from the helper", () => {
    // Stronger than banning the one old expression: ANY literal assignment is
    // a second author of this field, which is how the boolean and the sentence
    // came to disagree. `unpriceable`/`buyUnpriceable` are different fields, so
    // the pattern requires a boundary before it.
    const literal = INDEX.match(/(?<![A-Za-z])priceable:/g) ?? [];
    assert.deepEqual(literal, [], "`priceable` is being assigned directly again somewhere in index.ts");
  });

  it("requires pool-grade evidence at EVERY entry build site", () => {
    // THE ENTRY POLICY, IN ONE ASSERTION. Both sites build candidates that can
    // become a buy, so both must ask the spending question rather than the
    // valuation one — `lastUnpriceable` states the rule at length and the
    // legacy site used to contradict it. A site that asks `false` here would
    // let a v4 or curve mark, which no oracle checked, authorise a buy.
    const entry = INDEX.match(/\.\.\.\(?\s*sameToken \? priceability\(quote, (\w+)\)|\.\.\.priceability\(quote, (\w+)\)/g) ?? [];
    assert.ok(entry.length >= 2, `expected both build sites, found ${entry.length}`);
    assert.deepEqual(
      INDEX.match(/priceability\(quote, false\)/g),
      null,
      "no entry build site may accept a non-pool mark as entry-grade",
    );
  });

  it("still names an unwatched token rather than calling it unpriced", () => {
    assert.match(INDEX, /sameToken \? priceability\(quote, true\) : NOT_WATCHED/);
  });
});

describe("the sentence survives the surfaces that carry it", () => {
  it("fits inside the event slice once the note's prefix is added", () => {
    // `trencher: passing on <symbol> — <why>` lands in an event, and Telegram
    // slices one at 160 characters. A refusal cut in half loses the half that
    // says what happened. Symbols are at most 16 chars (sanitizeSymbol) or 12
    // for an autonomous token (trencher-discovery), so budget the longest.
    const prefix = `trencher: passing on ${"X".repeat(16)} — `.length;
    for (const cause of ALL_CAUSES) {
      const total = prefix + whyOf(cause).length;
      assert.ok(total <= 160, `"${cause}" makes a ${total}-char note`);
    }
  });

  it("carries no figure that changes between ticks", () => {
    // The reason prose from the pricers embeds a live pool balance and a
    // divergence percentage, which is why index.ts keys its sibling warn on
    // the refusal KIND instead. This note has no dedupe at all, so a digit
    // here would write a distinct row every tick, forever.
    // A Uniswap version is part of a venue's NAME and is fixed forever, so it
    // is dropped before the check rather than being allowed to weaken it: an
    // interpolated depth, price or percentage still fails.
    for (const cause of ALL_CAUSES) {
      assert.doesNotMatch(whyOf(cause).replace(/\bv[234]\b/g, "v"), /\d/, `"${cause}" embeds a figure`);
    }
  });
});
