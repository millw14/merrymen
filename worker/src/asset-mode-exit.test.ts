/**
 * A CLASS YOU SWITCH OFF MUST STAY SELLABLE.
 *
 * This is the half of the asset mode that can lose somebody money, and it is
 * the half that is easy to get wrong without anything failing loudly. Switch an
 * owner to "stocks only" while they hold a coin and three things must all still
 * be true:
 *
 *   the coin is still WATCHED     — or `snap.holdings` loses it, and with it the
 *                                   stop-loss, the take-profit, and the coin's
 *                                   whole value out of `equityUsdg` in one tick,
 *                                   against a high-water mark that only ratchets
 *                                   up. That trips the drawdown breaker: a
 *                                   settings dropdown that halts a live account.
 *   the wall still allows the SELL — it does, and says so: "Sells are never
 *                                   blocked by this rule."
 *   OUR OWN BOUNDARY allows it too — and this is the one that did not.
 *
 * `proposals.ts` resolved every proposal's address from `universe.legs`, which
 * is the set that may be BOUGHT. A held coin outside it was rejected as "not in
 * the tradable universe" — a sell refused by us, not by the chain, leaving the
 * mechanical floor as the only way out and `strategistStopLossBps` defaults to
 * zero.
 *
 * THAT IS A LATENT BUG, NOT ONE THIS FEATURE INTRODUCED: any owner who un-ticks
 * a basket symbol while holding it is already in that state today. The asset
 * mode makes it one dropdown away, which is why it is fixed here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { STOCK_TOKENS, assetModeAllows } from "../../packages/core/src/index";
import { watchTokensFor } from "./strategies/registry";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(path.join(__dirname, f), "utf8");

const CATE = {
  symbol: "CATE",
  address: "0xcacacacacacacacacacacacacacacacacacacace" as `0x${string}`,
  decimals: 18,
};

describe("a held coin survives a switch to stocks only", () => {
  it("IT IS STILL IN THE WATCH SET — which is what holdings are built from", () => {
    // `watchTokensFor` takes no mode, by design. If it ever did, this is the
    // assertion that would fail first and loudest.
    const watched = watchTokensFor(["NVDA", "CATE"], [CATE]);
    assert.ok(
      watched.some((t) => t.symbol === "CATE"),
      "a coin the owner holds must stay watched whatever the mode says",
    );
  });

  it("and it is still PRICED, so its value still counts toward equity", () => {
    // Same fact, stated as the thing that matters: equity is summed over the
    // watch set. Dropping a position from it does not free capital, it fakes a
    // loss — and the breaker measures against a mark that never comes back down.
    const watched = watchTokensFor([], [CATE]);
    assert.equal(watched.find((t) => t.symbol === "CATE")?.address, CATE.address);
  });

  it("BUT IT IS NO LONGER BUYABLE, which is the whole point", () => {
    assert.equal(assetModeAllows("stocks", CATE.address), false);
    assert.equal(assetModeAllows("stocks", STOCK_TOKENS.find((t) => t.symbol === "NVDA")!.address), true);
  });
});

describe("an exit is always attemptable", () => {
  const proposals = read("strategist/proposals.ts");

  it("A SELL RESOLVES ITS ADDRESS FROM HOLDINGS when the legs no longer carry it", () => {
    // The fix, pinned at the line. `universe.legs` is the buy set; judging a
    // sell against it means refusing an exit our own wall would have allowed.
    assert.match(
      proposals,
      /universe\.legs\.get\(p\.symbol\) \?\?\s*\(p\.action === "sell" \? snap\.holdings\.get\(p\.symbol\)\?\.token : undefined\)/,
    );
  });

  it("and ONLY a sell — this can never conjure a buy", () => {
    // Strictly narrower than widening `legs`: the fallback is gated on the
    // action and resolves from a chain read, so the most it can do is let the
    // agent out of something it demonstrably holds.
    const at = proposals.indexOf("universe.legs.get(p.symbol) ??");
    assert.ok(at > 0);
    const clause = proposals.slice(at, proposals.indexOf(";", at));
    assert.match(clause, /p\.action === "sell"/, "the fallback is gated on the direction");
    assert.match(clause, /snap\.holdings/, "and sourced from the chain read, not from settings");
  });

  it("the wall agrees — it never blocks a sell on the same grounds", () => {
    // Quoted from policy.ts so a future edit there has to reckon with this.
    assert.match(read("policy.ts"), /Sells are never blocked by this rule/);
  });
});

describe("the routes that are crypto by construction are gated, and say so", () => {
  const index = read("index.ts");

  it("THE CLASS ROUTE RETURNS NOTHING under stocks only", () => {
    assert.match(index, /if \(cfg\.assetMode === "stocks"\) return \[\];/);
  });

  it("AND THE TRENCHER SAYS SO RATHER THAN GOING QUIET", () => {
    // A feed that empties silently is how an owner ends up reporting "it didn't
    // take any trades yet" with no evidence but the absence of trades — the
    // exact incident the neighbouring block was written for.
    assert.match(index, /trencherStocksAnnounced/);
    assert.match(index, /asset mode is stocks only, so the candidate feed is empty/);
  });

  it("once per arm, not once per tick", () => {
    // The same discipline as its sibling: the same line sixty times an hour
    // teaches an owner to scroll past it.
    const at = index.indexOf("trencherStocksAnnounced = true");
    assert.ok(at > 0);
    assert.match(index.slice(at - 200, at), /if \(!trencherStocksAnnounced\)/);
  });
});

describe("the setting actually reaches the strategy", () => {
  it("STRATEGY KEY INCLUDES IT, or the dropdown does nothing", () => {
    // `watchTokens` and the strategy are rebuilt only when this key changes.
    const settings = read("settings.ts");
    const at = settings.indexOf("export function strategyKey");
    const body = settings.slice(at, settings.indexOf("\n}", at));
    assert.match(body, /cfg\.assetMode/);
  });

  it("AND SO DOES officialCoinsEnabled — a pre-existing bug found while adding it", () => {
    // Its own doc promises that turning it off "removes the listings from the
    // watch set entirely", and the rebuild that would do so sits behind this
    // key. Masked only because OFFICIAL_COINS[4663] is empty today.
    const settings = read("settings.ts");
    const at = settings.indexOf("export function strategyKey");
    const body = settings.slice(at, settings.indexOf("\n}", at));
    assert.match(body, /cfg\.officialCoinsEnabled/);
  });
});

describe("a mode that empties the basket does not go quiet", () => {
  const index = read("index.ts");

  it("SAYS SO, through the once-per-change idle channel", () => {
    // The one way this feature could be worse than not shipping it: an owner
    // picks "crypto only" over a basket of equities, every strategy resolves
    // zero legs, and the agent falls silent with nothing connecting that to the
    // dropdown they just moved. Exactly the trencher incident this file already
    // carries — "it didn't take any trades yet", then "I think I'm stuck in
    // paper mode".
    assert.match(index, /modeEmptied/);
    assert.match(index, /there is nothing to trade/);
    assert.match(index, /Change the mode in Settings/, "and what to do about it");
  });

  it("ONLY when the mode is what emptied it", () => {
    // An empty basket is an empty basket; blaming the mode for one would be a
    // different wrong sentence. The second `legsForUniverse` call — unfiltered —
    // is what tells those two apart.
    const at = index.indexOf("const modeEmptied");
    const clause = index.slice(at, index.indexOf("const idleNow", at));
    assert.match(clause, /cfg\.assetMode !== "all"/, "not reported when nothing is being filtered");
    assert.equal(
      (clause.match(/legsForUniverse\(/g) ?? []).length,
      2,
      "filtered AND unfiltered — the difference is the claim",
    );
  });

  it("and rides the existing channel rather than inventing a second one", () => {
    assert.match(index, /const idleNow = idle \? renderWhy\(idle\) : modeEmptied;/);
  });
});
