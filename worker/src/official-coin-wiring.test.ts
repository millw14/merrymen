/**
 * AN OFFICIAL LISTING, FROM THE REGISTRY TO THE LEG.
 *
 * The listing constant is tested in packages/core; this is about the wiring,
 * which is where the interesting failures live. Each test below corresponds to a
 * way the feature could be "on" and still do nothing, or be on and do something
 * nobody asked for.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { legsForUniverse, watchTokensFor } from "./strategies/registry";
import { officialCoinTokens, officialCoinsFor, robinhoodChain, STOCK_TOKENS } from "../../packages/core/src/index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OFFICIAL = officialCoinsFor(robinhoodChain.id);
const COIN = OFFICIAL[0]!;
const BASKET = ["AAPL", "GOOGL", "TSLA"];
const CUSTOM: { symbol: string; address: `0x${string}`; decimals: number }[] = [];

describe("official coins reach the watch set", () => {
  it("appears with NO settings change, in a default equity basket", () => {
    // This is the whole point: SirSendIt's owner holds AAPL/GOOGL/TSLA and added
    // nothing. Before this, the curve fallback had no leg to fall back to.
    const watched = watchTokensFor(BASKET, CUSTOM, OFFICIAL);
    const found = watched.find((t) => t.address.toLowerCase() === COIN.address.toLowerCase());
    assert.ok(found, "an official listing must be watched without the owner adding it");
    assert.equal(found.symbol, COIN.symbol);
  });

  it("carries kind memecoin and a null feed, which is what routes it to curve pricing", () => {
    // index.ts builds its curve-pricing set as
    //   watchTokens.filter(t => t.chainlinkFeed === null && t.kind === "memecoin")
    // so BOTH fields are load-bearing. A listing registered as a stock would be
    // watched and never priced.
    const found = watchTokensFor(BASKET, CUSTOM, OFFICIAL).find(
      (t) => t.address.toLowerCase() === COIN.address.toLowerCase(),
    )!;
    assert.equal(found.kind, "memecoin");
    assert.equal(found.chainlinkFeed, null);
    assert.equal(found.decimals, COIN.decimals);
  });

  it("is absent entirely when the owner opts out — not watched-but-untradable", () => {
    // Watched-but-untradable is the exact state that made an agent look broken
    // while behaving correctly, so opting out removes the listing rather than
    // demoting it.
    const watched = watchTokensFor(BASKET, CUSTOM, []);
    assert.ok(!watched.some((t) => t.address.toLowerCase() === COIN.address.toLowerCase()));
  });

  it("never displaces a registry token", () => {
    const watched = watchTokensFor(BASKET, CUSTOM, OFFICIAL);
    for (const sym of BASKET) {
      const t = watched.find((w) => w.symbol === sym)!;
      const registry = STOCK_TOKENS.find((s) => s.symbol === sym)!;
      assert.equal(t.address, registry.address, `${sym} must keep its verified registry address`);
      assert.equal(t.chainlinkFeed, registry.chainlinkFeed, `${sym} must keep its feed`);
    }
  });

  it("cannot be shadowed by a custom token on symbol or on address", () => {
    // A settings entry that captured an official symbol would let a typo'd or
    // hostile address take over a listing the platform vouched for, while the
    // basket kept naming it as if nothing had changed.
    const hostile = [
      { symbol: COIN.symbol, address: ("0x" + "b".repeat(40)) as `0x${string}`, decimals: 6 },
      { symbol: "OTHERNAME", address: COIN.address, decimals: 6 },
    ];
    const watched = watchTokensFor(BASKET, hostile, OFFICIAL);
    const bySymbol = watched.filter((t) => t.symbol === COIN.symbol);
    assert.equal(bySymbol.length, 1, "one entry may hold a symbol");
    assert.equal(bySymbol[0]!.address.toLowerCase(), COIN.address.toLowerCase(), "the verified address wins");
    assert.ok(
      !watched.some((t) => t.symbol === "OTHERNAME"),
      "a second name for the same address must not be watched twice",
    );
  });

  it("still lets an unrelated custom token through", () => {
    const mine = [{ symbol: "MYCOIN", address: ("0x" + "c".repeat(40)) as `0x${string}`, decimals: 9 }];
    const watched = watchTokensFor(BASKET, mine, OFFICIAL);
    assert.ok(watched.some((t) => t.symbol === "MYCOIN" && t.decimals === 9));
    assert.ok(watched.some((t) => t.symbol === COIN.symbol));
  });
});

describe("official coins become legs", () => {
  const universe = watchTokensFor(BASKET, CUSTOM, OFFICIAL);
  const always = OFFICIAL.map((o) => o.symbol);

  it("is a leg although the owner's basket never names it", () => {
    const legs = legsForUniverse(BASKET, universe, always);
    assert.ok(legs.some((l) => l.symbol === COIN.symbol), "a listing must be tradable, not merely visible");
  });

  it("is NOT a leg when no official symbols are passed", () => {
    // The `alwaysSymbols` argument is the entire opt-in at this layer; without
    // it the ordinary basket rule must still hold exactly as before.
    const legs = legsForUniverse(BASKET, universe, []);
    assert.ok(!legs.some((l) => l.symbol === COIN.symbol));
    assert.equal(legs.length, BASKET.length);
  });

  it("appears ONCE when the basket also names it, not twice", () => {
    // Two entries for one symbol would halve every other leg's weight and
    // silently double the coin's target allocation.
    const legs = legsForUniverse([...BASKET, COIN.symbol], universe, always);
    assert.equal(legs.filter((l) => l.symbol === COIN.symbol).length, 1);
    assert.equal(legs.length, BASKET.length + OFFICIAL.length);
  });

  it("splits weight evenly and leaves the equity legs intact", () => {
    const legs = legsForUniverse(BASKET, universe, always);
    const expected = Math.floor(10_000 / (BASKET.length + OFFICIAL.length));
    for (const l of legs) assert.equal(l.weightBps, expected);
    for (const sym of BASKET) assert.ok(legs.some((l) => l.symbol === sym), `${sym} must survive`);
  });

  it("resolves the leg to the verified address", () => {
    const leg = legsForUniverse(BASKET, universe, always).find((l) => l.symbol === COIN.symbol)!;
    assert.equal(leg.token.toLowerCase(), COIN.address.toLowerCase());
  });

  it("ignores an official symbol that is not in the universe", () => {
    // Opting out removes the listing from the watch set; the leg resolver must
    // then find nothing rather than inventing a leg with no token behind it.
    const legs = legsForUniverse(BASKET, watchTokensFor(BASKET, CUSTOM, []), always);
    assert.ok(!legs.some((l) => l.symbol === COIN.symbol));
  });
});

describe("an official listing carries its own provenance", () => {
  /**
   * Source-position tests must read CODE, not prose.
   *
   * The first version of the ordering test below compared raw offsets and
   * failed against correct code, because the explanatory comment above the call
   * mentions `discovered_pools` before the call itself appears. Comments are
   * stripped here so these assertions cannot be moved by rewording a comment —
   * in either direction, which is the half that would have been dangerous.
   */
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const STORE = stripComments(readFileSync(path.join(__dirname, "store.ts"), "utf8"));
  const bodyOf = (decl: string) => {
    const at = STORE.indexOf(decl);
    assert.ok(at > -1, `${decl} must exist`);
    const fn = STORE.slice(at);
    return fn.slice(0, fn.indexOf("\n}"));
  };

  it("curveFor answers from the listing BEFORE touching discovered_pools", () => {
    // discovered_pools is wiped on every redeploy in hosted mode and pruned to
    // the 5,000 newest rows against ~475 launches an hour, so a listed coin
    // would lose its own provenance within hours — unpriceable and unsellable.
    const body = bodyOf("export async function curveFor");
    const official = body.indexOf("officialCoinCurve");
    const table = body.indexOf("discovered_pools");
    assert.ok(official > -1, "curveFor must consult the listing");
    assert.ok(table > -1, "curveFor must still read the table");
    assert.ok(official < table, "the pinned record must be consulted first, not as a fallback");
  });

  it("knownCurves unions the official curves, so policy does not refuse the exit", () => {
    // The curve-provenance rule is the only thing vouching for a curve token. A
    // listed coin whose curve the launch scan never saw would be refused — the
    // SELL included, which is the no-exit trap.
    assert.match(
      bodyOf("export async function knownCurves"),
      /officialCoinsFor/,
      "official curves must join the provenance set",
    );
  });

  it("knownCurves still returns null on a failed read, never a partial list", () => {
    // `null` means "could not tell" and makes the caller pass undefined. A list
    // holding only the official curves would be a PARTIAL answer, which silently
    // refuses exactly the positions it dropped.
    const body = bodyOf("export async function knownCurves");
    const catchAt = body.indexOf("catch");
    assert.ok(catchAt > -1, "knownCurves must still catch");
    assert.match(body.slice(catchAt), /return null/, "a failed read must stay null");
    assert.ok(
      body.indexOf("officialCoinsFor") < catchAt,
      "the union must happen on the SUCCESS path only",
    );
  });
});

describe("the two basket filters agree", () => {
  /**
   * THE BUG THIS EXISTS TO PREVENT, because it nearly shipped.
   *
   * There are TWO independent basket filters. `legsForUniverse` decides what a
   * strategy may name; `curveLegsNow` decides what the curve venue will build.
   * Widening one and not the other makes an official coin a leg every strategy
   * can propose and the curve venue silently refuses — and since the curve venue
   * is the ONLY route to a listed coin (it has no pool before graduation), that
   * is the entire feature failing on a shut equity market while every component
   * reports success.
   *
   * Read from source because `curveLegsNow` is a closure over worker state that
   * a unit test cannot construct. What can be pinned is that its selection set
   * is built from the official symbols as well as the basket.
   */
  const INDEX = readFileSync(path.join(__dirname, "index.ts"), "utf8");

  it("curveLegsNow selects official symbols as well as the basket", () => {
    const at = INDEX.indexOf("function curveLegsNow");
    assert.ok(at > -1, "curveLegsNow must exist");
    // Bounded by the loop that consumes the set, NOT by a closing brace:
    // `curveLegsNow`'s return type is a multi-line object literal, so the first
    // `\n  }` after the declaration closes the TYPE and cuts the body off before
    // the selection is built. The loop is the thing the set feeds, so it is both
    // a correct boundary and one that cannot drift away from what is measured.
    const end = INDEX.indexOf("for (const [symbol, leg] of lastCurveLegs)", at);
    assert.ok(end > at, "curveLegsNow must still iterate lastCurveLegs");
    const body = INDEX.slice(at, end);
    const sel = /const selected = new Set\(([^;]*)\);/.exec(body);
    assert.ok(sel, "curveLegsNow must build a selection set");
    assert.match(sel[1]!, /cfg\.basketSymbols/, "the owner's basket must still select");
    assert.match(sel[1]!, /officialCoins\(\)/, "official listings must select too, or the curve venue refuses them");
  });

  it("buildStrategy threads alwaysSymbols from the same source", () => {
    // The other half of the pair. If this one regressed instead, a listed coin
    // would be buildable by the curve venue and never proposed by anything.
    assert.match(INDEX, /alwaysSymbols:\s*officialCoinsIn\(c\)\.map/, "legs must carry the official symbols");
  });
});

describe("the signer seals what the worker watches", () => {
  it("hands the signer the same addresses the worker will watch", () => {
    // The two lists are built by different functions in different packages. If
    // they disagreed, the owner would get refusals naming a coin they never
    // chose and cannot remove.
    const watched = watchTokensFor(BASKET, CUSTOM, OFFICIAL)
      .filter((t) => t.kind === "memecoin")
      .map((t) => t.address.toLowerCase())
      .sort();
    const sealed = officialCoinTokens(robinhoodChain.id)
      .map((t) => t.address.toLowerCase())
      .sort();
    assert.deepEqual(watched, sealed);
  });
});
