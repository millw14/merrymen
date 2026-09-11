/**
 * THE BUG WAS THAT NOBODY SUPPLIED IT.
 *
 * `curveLegsNow` was declared in StrategyBuildOpts, forwarded by registry.ts,
 * and consumed by strategy.ts. Every layer looked wired. The production call
 * site never passed it, so `universe.curveLegs` was always undefined, the curve
 * arm of proposalsToIntents was unreachable, and every memecoin the model named
 * came back "not in the tradable universe" — while the same worker wired all of
 * the same data into the chat command an owner types by hand.
 *
 * A test that exercised the strategist would have passed. A test that read the
 * types would have passed. The only thing that catches this is asserting the
 * CALL SITE, which is what this file does — the same lesson wiring.test.ts was
 * written for after three dead wires shipped in one change.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const INDEX = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
/** Comments stripped — this file explains at length what it refuses to do. */
const CODE = INDEX.replace(/\/\*[\s\S]*?\*\//g, " ")
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

/** The body of curveLegsNow, where every safety condition lives. */
const FILTER = (() => {
  const start = CODE.indexOf("function curveLegsNow()");
  assert.ok(start > 0, "curveLegsNow must exist in index.ts");
  return CODE.slice(start, CODE.indexOf("function makeStrategy(", start));
})();

describe("the call site supplies it", () => {
  it("THE PRODUCTION STRATEGY FACTORY PASSES curveLegsNow", () => {
    // The whole bug, in one assertion.
    const build = CODE.slice(CODE.indexOf("return buildStrategy(c.strategy, {"));
    assert.match(build.slice(0, 400), /curveLegsNow,/, "buildStrategy must be handed the supplier");
  });

  it("and the model is told about it — the merge is above the driver call", () => {
    // Supplying it is inert if buildSignals runs on the unmerged universe:
    // tradableSymbols and prices are both derived from universe.legs, so a
    // curve symbol merged afterwards is never offered to the model at all.
    const strategy = readFileSync(new URL("./strategist/strategy.ts", import.meta.url), "utf8");
    const merge = strategy.indexOf("const universeNow");
    const signals = strategy.indexOf("buildSignals(snap, universeNow");
    assert.ok(merge > 0 && signals > merge);
  });
});

describe("the reserves come from the pass that already read them", () => {
  it("no second read is introduced", () => {
    // curve-prices.ts forbids caching reserves: measured p99 movement is 1,546
    // bps over 240s, so two reads in one tick are two different markets — and
    // a slippage floor derived from the wrong one is a floor for a market that
    // no longer exists. The pricing pass already pays for these.
    assert.match(CODE, /lastCurveLegs = curveRes\.legs;/, "the legs must come from the pricing result");
    // TWO READS ARE ALLOWED, AND NEITHER IS A RE-READ. The rule this guard
    // enforces is "never read a curve the pricing pass already read", which it
    // used to express as a count of one. The count stopped matching the rule
    // when the class exit arrived:
    //
    //   1. the owner-typed chat command, which runs outside the tick.
    //   2. proposeClassExits. A CLASS token is never in `watchTokens` — that is
    //      the definition of the class — so `lastCurveLegs`, which is built
    //      from watchTokens, never contains its curve. The pricing pass does
    //      not pay for it, there is nothing to reuse, and without this read
    //      there is no slippage floor and therefore no exit at all.
    //
    // Raising the number is only legitimate alongside that argument. A read of
    // a WATCHED token's curve would still be the bug, and the assertion below
    // keeps the class read where its justification holds.
    assert.equal(
      (CODE.match(/await readCurveReserves\(/g) ?? []).length,
      2,
      "a re-read of a curve the pricing pass already priced would be two different markets",
    );
    const exitAt = CODE.indexOf("async function proposeClassExits");
    const exitEnd = CODE.indexOf("\n  function curveLegsNow", exitAt);
    assert.ok(exitAt > -1 && exitEnd > exitAt, "proposeClassExits must exist to justify the second read");
    assert.match(
      CODE.slice(exitAt, exitEnd),
      /await readCurveReserves\(/,
      "the second read must be the class exit's, which has no priced leg to reuse",
    );
  });

  it("the cache is replaced wholesale, never merged", () => {
    // A token that stopped pricing this tick must not leave a stale leg behind
    // for the strategist to size against.
    assert.ok(!/lastCurveLegs\.set\(/.test(CODE), "entries must not be added one by one");
  });
});

describe("the filter cannot offer what the wall will refuse", () => {
  it("NOT ON THE PAPER RAIL — paper cannot simulate a curve trade", () => {
    // paper.ts refuses every non-swap intent, so offering these on that rail
    // produces "unsupported paper intent curve-trade" at an owner who did
    // nothing wrong.
    assert.match(FILTER, /if \(paperActive\(\)\) return null;/);
  });

  it("not without a live Pons adapter", () => {
    assert.match(FILTER, /active\.ponsAdapterLive/);
    assert.match(FILTER, /grantPonsAdapter\(active\.grant\)/);
  });

  it("THE COVERED SET COMES FROM THE GRANT, NEVER FROM SETTINGS", () => {
    // The load-bearing one. A token added in /settings is watched and priced
    // but NOT covered by the signature: buying it opens a position this key
    // cannot close. checkPolicy refuses it anyway — this stops the model
    // wasting an action slot, and stops it proposing in public something that
    // was never possible.
    assert.match(FILTER, /active\.limits\.sellableAssets/, "the grant's list, resolved by limitsFromGrant");
    assert.ok(
      !/cfg\.customTokens/.test(FILTER) && !/watchTokensFor\(/.test(FILTER),
      "settings must not decide what may be traded",
    );
    // And every leg is checked against it, not just the first.
    assert.match(FILTER, /if \(!token \|\| !sellable\.has\(token\.toLowerCase\(\)\)\) continue;/);
  });

  it("an empty covered set offers nothing at all", () => {
    // A grant with no sellable assets is not a grant that trades everything.
    assert.match(FILTER, /if \(sellable\.size === 0\) return null;/);
  });

  it("offers nothing rather than an empty map", () => {
    // `curveLegs: new Map()` and `curveLegs: undefined` reach proposals.ts the
    // same way, but only one of them is honest about there being no venue.
    assert.match(FILTER, /if \(legs\.size === 0\) return null;/);
  });

  it("the slippage floor is the owner's own setting", () => {
    assert.match(FILTER, /slippageBps: cfg\.slippageBps/);
  });
});

describe("a tick that did not price curves offers none", () => {
  it("THE CACHE IS CLEARED AT THE TOP OF EVERY PRICING PASS", () => {
    // The assignment sits inside `if (noPool.length)`, which is the right place
    // to FILL it and the wrong place to be its only writer. A tick with no
    // feedless tokens — the owner removed their memecoins, or every one found a
    // pool — would leave last tick's reserves standing, and curveLegsNow would
    // hand the strategist a slippage floor for a market that had already moved.
    // Measured p99 movement is 1,546 bps over 240 seconds.
    //
    // Missing legs cost a skipped window. Stale legs cost a bad fill.
    const pass = CODE.slice(CODE.indexOf("async function mergePoolPrices("));
    const clear = pass.indexOf("lastCurveLegs = new Map()");
    const earlyReturn = pass.indexOf("if (!feedless.length)");
    const fill = pass.indexOf("lastCurveLegs = curveRes.legs");
    assert.ok(clear > 0, "the pass must clear the cache");
    assert.ok(clear < earlyReturn, "…before any early return, or the empty case keeps stale legs");
    assert.ok(fill > clear, "…and fill it afterwards");
  });
});

describe("what an adversarial review caught", () => {
  it("SETTINGS IS 'KNOW ABOUT THIS', THE BASKET IS 'TRADE IT'", () => {
    // registry.ts states this invariant for every other leg: "deliberately NOT
    // automatic — a token added to be tracked must not start being bought on
    // its own." The first version of curveLegsNow filtered on the grant alone.
    //
    // The grant does not enforce it. Every signing site seals grantTokens from
    // the WHOLE custom-token list with no per-token opt-in, so after any
    // re-sign the grant covers everything watched — and the filter degenerated
    // to the watch set, making the curve venue's universe strictly wider than
    // every other arm's. Three independent reviewers failed to refute it.
    //
    // PINNED AS A PROPERTY, NOT AS A LITERAL. This asserted the exact text
    // `new Set(cfg.basketSymbols)`, which pinned the right invariant through its
    // syntax — and syntax could not distinguish the two ways the set can widen.
    // One is the bug: degenerating to the WATCH SET, so a token the owner added
    // only to track starts being bought. The other is the platform's own coin
    // list, which reaches an owner the way the default basket does and is
    // declinable in one setting. The first must stay impossible; the second is
    // deliberate. So the three clauses below say that directly.
    const sel = /const selected = new Set\(([^;]*)\);/.exec(FILTER);
    assert.ok(sel, "curveLegsNow must build a selection set");
    const source = sel[1]!;
    // 1. The owner's own choice still selects.
    assert.match(source, /cfg\.basketSymbols/, "the basket must still decide what the owner trades");
    // 2. THE ORIGINAL BUG STAYS DEAD. The watch set must never be the source —
    //    that is precisely the degeneration three reviewers failed to refute.
    assert.ok(
      !/watchTokens/.test(source),
      "the selection must never be built from the watch set — 'know about this' is not 'trade this'",
    );
    assert.ok(
      !/customTokens/.test(source),
      "a token added in settings must not select itself into the curve venue",
    );
    assert.match(FILTER, /if \(!selected\.has\(symbol\)\) continue;/);
    // Both filters, not one: the basket says what the owner chose to trade, the
    // grant says what the signature covers. Neither implies the other.
    assert.match(FILTER, /active\.limits\.sellableAssets/);
  });

  it("THE MODEL IS ACTUALLY TOLD A CURVE SYMBOL IS TRADABLE", () => {
    // Supplying curveLegsNow was still inert without this. `tradableSymbols`
    // and the price list were built from `universe.legs` alone, and curve legs
    // live in a separate map — so the converter could finally build a curve
    // trade and nothing ever asked for one.
    const strategy = readFileSync(new URL("./strategist/strategy.ts", import.meta.url), "utf8");
    assert.match(strategy, /const tradable = new Set\(\[\.\.\.universe\.legs\.keys\(\), \.\.\.\(universe\.curveTokens\?\.keys\(\) \?\? \[\]\)\]\)/);
    assert.match(strategy, /tradableSymbols: \[\.\.\.tradable\]/);
    assert.match(strategy, /\.filter\(\(\[symbol\]\) => tradable\.has\(symbol\)\)/, "its price must reach the prompt too");
  });

  it("but the two maps stay separate where a trade is BUILT", () => {
    // proposalsToIntents checks curveLegs before legs, and a curve token placed
    // in `legs` would be routed to the swap router — an operation against a
    // pool that does not exist. The union is for what the model may SAY.
    const strategy = readFileSync(new URL("./strategist/strategy.ts", import.meta.url), "utf8");
    const merge = strategy.slice(strategy.indexOf("const universeNow"), strategy.indexOf("const signals ="));
    assert.ok(!/legs: new Map\(\[\.\.\./.test(merge), "curve tokens must never be folded into universe.legs");
    assert.match(merge, /curveLegs: curve\.legs/);
  });
});

describe("the autonomous curve path has an impact ceiling", () => {
  it("A BUY THAT MOVES THE CURVE TOO FAR IS REFUSED IN THE PRODUCER", () => {
    // Both swap branches call judgeImpact, and the owner-typed chat producer
    // checks curveBuyImpactBps against the same ceiling. The autonomous curve
    // path had neither — free while nobody supplied curve legs, a gap the
    // moment somebody did. Checked in the producer because that is where the
    // reserves are; the executor holds only an intent, and reading them again
    // would be a second read of a market that has already moved.
    const src = readFileSync(new URL("./strategist/proposals.ts", import.meta.url), "utf8");
    assert.match(src, /curveBuyImpactBps\(curveLeg\.reserves, amountInRaw\)/);
    assert.match(src, /impact > universe\.maxImpactBps/);
  });

  it("but an EXIT is never refused for being expensive", () => {
    // Refusing a sell because leaving costs too much locks an agent into the
    // position it most needs to close — the same reason the drawdown breaker
    // exempts exits.
    const src = readFileSync(new URL("./strategist/proposals.ts", import.meta.url), "utf8");
    assert.match(src, /if \(isBuy && universe\.maxImpactBps !== undefined\)/);
  });

  it("the ceiling travels with the legs, from the owner's own setting", () => {
    assert.match(FILTER, /maxImpactBps: cfg\.maxImpactBps/);
    const strategy = readFileSync(new URL("./strategist/strategy.ts", import.meta.url), "utf8");
    assert.match(strategy, /maxImpactBps: curve\.maxImpactBps/);
  });
});
