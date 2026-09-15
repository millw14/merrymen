/**
 * "THERE SHOULD BE AN OPTION MODE FOR STOCKS ONLY, CRYPTO ONLY, COMBO, OR MEME
 * COIN ONLY" — asked for by several owners at once, alongside "it's great to
 * toggle between stocks and crypto mode… sometimes trading stocks is better when
 * crypto bear is here", and by one whose agent kept answering about a basket of
 * equities he did not care about.
 *
 * THE DANGEROUS WAY TO BUILD THIS is to filter the watch set, and it is also the
 * obvious one. `snap.holdings` IS the watch set intersected with real balances,
 * and every mechanical exit iterates it — so a class switched off would strip
 * its held positions of stop-loss and take-profit, AND drop `equityUsdg` by
 * their whole value in one tick against a high-water mark that only ratchets up,
 * tripping the drawdown breaker. A settings dropdown that bricks a live account.
 *
 * So the mode filters what may be BOUGHT. Everything below is about keeping that
 * line: the pool is narrowed before the basket intersection, and a position you
 * already hold stays priced, valued and — most of all — sellable.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { STOCK_TOKENS, assetModeAllows, instrumentClassOf } from "../../packages/core/src/index";
import { legsForUniverse } from "./strategies/registry";

/** A real registry equity, and a coin that is not in the registry. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NVDA = STOCK_TOKENS.find((t) => t.symbol === "NVDA")!;
const CATE = {
  symbol: "CATE",
  name: "Thinking Cat",
  address: "0xcacacacacacacacacacacacacacacacacacacace" as `0x${string}`,
  chainlinkFeed: null,
  kind: "memecoin" as const,
  decimals: 18,
};

describe("the mode is decided by the address, never by the name", () => {
  it("A REGISTRY EQUITY IS A STOCK", () => {
    assert.equal(assetModeAllows("stocks", NVDA.address), true);
    assert.equal(assetModeAllows("crypto", NVDA.address), false);
  });

  it("and anything else is crypto", () => {
    assert.equal(assetModeAllows("crypto", CATE.address), true);
    assert.equal(assetModeAllows("stocks", CATE.address), false);
  });

  it("`all` passes both, which is why it is the default", () => {
    assert.equal(assetModeAllows("all", NVDA.address), true);
    assert.equal(assetModeAllows("all", CATE.address), true);
  });

  it("A COIN THAT CALLS ITSELF NVDA DOES NOT GET NVDA'S MODE", () => {
    // The reason `instrumentClassOf` is address-keyed, inherited here: "a
    // discovered token may call itself AAPL. The address is the identity, and
    // matching on the name would let a launchpad token pick its own research
    // desk." Symbol-keyed, it would pick its own asset mode too.
    const impostor = "0xbadbadbadbadbadbadbadbadbadbadbadbadbad0";
    assert.equal(instrumentClassOf(impostor), "memecoin");
    assert.equal(assetModeAllows("stocks", impostor), false, "a name is not an identity");
  });

  it("an unknown address is treated as crypto — the cautious arm", () => {
    assert.equal(assetModeAllows("stocks", "0x" + "11".repeat(20)), false);
  });
});

describe("the mode narrows the legs, and the weights follow", () => {
  const universe = [NVDA, CATE];
  const basket = ["NVDA", "CATE"];

  it("STOCKS ONLY LEAVES THE EQUITY", () => {
    const legs = legsForUniverse(basket, universe, [], "stocks");
    assert.deepEqual(legs.map((l) => l.symbol), ["NVDA"]);
  });

  it("CRYPTO ONLY LEAVES THE COIN", () => {
    const legs = legsForUniverse(basket, universe, [], "crypto");
    assert.deepEqual(legs.map((l) => l.symbol), ["CATE"]);
  });

  it("and the surviving leg takes the whole allocation", () => {
    // Not cosmetic: `even-keel` rebalances on a 500bps band, so re-splitting
    // weights is a dropdown that moves real money for some owners.
    const both = legsForUniverse(basket, universe, [], "all");
    assert.deepEqual(both.map((l) => l.weightBps), [5000, 5000]);
    assert.deepEqual(legsForUniverse(basket, universe, [], "stocks").map((l) => l.weightBps), [10000]);
  });

  it("DEFAULTS TO `all`, so every existing caller is unchanged", () => {
    assert.deepEqual(
      legsForUniverse(basket, universe).map((l) => l.symbol),
      legsForUniverse(basket, universe, [], "all").map((l) => l.symbol),
    );
  });

  it("and it narrows the POOL, so an official coin cannot slip past it", () => {
    // `alwaysSymbols` widens the basket intersection, not the pool. A listing
    // the platform publishes is still a coin, and stocks-only means stocks.
    const legs = legsForUniverse([], universe, ["CATE"], "stocks");
    assert.deepEqual(legs.map((l) => l.symbol), []);
  });
});

describe("what the mode must never do", () => {
  it("NOTHING PASSES IT TO `watchTokensFor` — the watch set is not filtered", () => {
    // The one line of this feature that could brick a live account. Asserted
    // against the source because the guarantee is "this call is never made",
    // and a passing behavioural test only proves it was not made THIS time.
    const src = ["index.ts", "strategies/registry.ts"]
      .map((f) => readFileSync(path.join(__dirname, f), "utf8"))
      .join("\n");
    const calls = [...src.matchAll(/watchTokensFor\(([^)]*)\)/g)].map((m) => m[1]!);
    assert.ok(calls.length > 0, "watchTokensFor must still be called");
    for (const args of calls) {
      assert.doesNotMatch(args, /assetMode/, "the watch set must never be narrowed by the mode");
    }
  });
});
