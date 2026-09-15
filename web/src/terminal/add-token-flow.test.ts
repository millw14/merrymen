/**
 * "I ADDED A CONTRACT ADRESS OF A TOKEN, BUT THE AGENT STILL SAY THAT HE CAN
 * TRADE ONLY STOCKS OF HIS BASKET. SO I DON'T KNOW I'M DOING WRONG OR SOMETHING
 * ELSE."
 *
 * He was not doing anything wrong. Trading a token an owner adds needs TWO
 * writes, and this screen only ever made one:
 *
 *   customTokens   "know about this" — priced, valued, watched
 *   basketSymbols  "trade it"        — `legsForUniverse` intersects the watch
 *                                      set with this, so a token outside it is
 *                                      invisible to every strategy
 *
 * The second was offered nowhere he would find it: the chip rendered unselected
 * at the end of twenty-five identical stock chips, and the rule itself lived
 * only in a JSX comment. The visible copy named the re-signature and stopped —
 * so he added the token, saved, re-signed, and still had an agent that traded
 * only stocks, having done everything he was told.
 *
 * `Proposals.tsx` had always done both in one click. This is that, for the
 * manual path, with the choice left visible rather than assumed — because the
 * rule it respects is deliberate: "a token added to be tracked must not start
 * being bought on its own" (strategies/registry.ts). That protects an owner from
 * the PLATFORM widening what gets bought. A person typing forty-two hex
 * characters is not the platform.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { basketAfterAdd, basketNow, withSymbol } from "./basket";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** Comments stripped — these files argue at length about what they will not do. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

describe("an unset basket is the default basket, not an empty one", () => {
  it("READS THE DEFAULT when the owner has never edited it", () => {
    // The trap this helper exists for: `values.basketSymbols ?? []` does not
    // read "no basket", it reads "the default basket" as empty — and a
    // read-modify-write on top of that PUTs a basket containing only the coin
    // just added, silently narrowing the agent's whole universe to it.
    assert.deepEqual(basketNow({ defaults: { basketSymbols: ["QQQ", "NVDA", "TSLA"] } }), [
      "QQQ",
      "NVDA",
      "TSLA",
    ]);
  });

  it("and an EDITED basket wins over the default", () => {
    assert.deepEqual(
      basketNow({ values: { basketSymbols: ["NVDA"] }, defaults: { basketSymbols: ["QQQ", "NVDA"] } }),
      ["NVDA"],
    );
  });

  it("an explicitly emptied basket stays empty — that IS an answer", () => {
    assert.deepEqual(basketNow({ values: { basketSymbols: [] }, defaults: { basketSymbols: ["QQQ"] } }), []);
  });

  it("adding a symbol keeps everything already there, and never duplicates", () => {
    assert.deepEqual(withSymbol(["QQQ", "NVDA"], "CATE"), ["QQQ", "NVDA", "CATE"]);
    assert.deepEqual(withSymbol(["QQQ", "CATE"], "CATE"), ["QQQ", "CATE"]);
    // A duplicate leg would halve every other leg's weight and silently double
    // the coin's allocation — `legsForUniverse` dedupes for exactly this reason.
    assert.equal(new Set(withSymbol(["CATE"], "CATE")).size, 1);
  });
});

describe("the settings screen writes both gates", () => {
  const settings = code(src("./screens/Settings.tsx"));

  it("ADDING A TOKEN ALSO SELECTS IT — the write that never happened", () => {
    // EXECUTED, not matched. The first version of this asserted that
    // `setSymbols(` appeared in the handler's source, and that is still true
    // when the call sits inside `if (false)` — it passed against a deliberately
    // broken build, which is the one thing a test must not do. The decision
    // lives in `basketAfterAdd` now, where it can be run.
    assert.deepEqual(basketAfterAdd({ saved: ["QQQ", "NVDA"], symbol: "CATE", trade: true }), [
      "QQQ",
      "NVDA",
      "CATE",
    ]);
  });

  it("and DECLINING leaves the basket exactly as it was", () => {
    // The rule stays — adding a token to watch it must not start it being
    // bought. What changed is that the owner can see and make the choice.
    assert.deepEqual(basketAfterAdd({ saved: ["QQQ"], symbol: "CATE", trade: false }), ["QQQ"]);
  });

  it("and the handler routes through it rather than deciding for itself", () => {
    const fn = settings.slice(settings.indexOf("function addToken()"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    assert.match(body, /setTokens\(/, "it still records the token");
    assert.match(body, /basketAfterAdd\(/, "and the basket goes through the rule");
  });

  it("and builds on the CURRENT basket, not on an empty one", () => {
    // Two ways to lose the basket here, and both have bitten this repo: reading
    // `values ?? []` (which discards the default) and rebuilding from `view`
    // (which discards an unsaved edit made in this session).
    const fn = settings.slice(settings.indexOf("function addToken()"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    assert.match(body, /symbols \?\? basketNow\(/, "session edit first, then the default");
    assert.doesNotMatch(body, /basketSymbols \?\? \[\]/, "an unset basket is not an empty one");
  });

  it("the choice is OFFERED, not assumed", () => {
    // The rule at strategies/registry.ts is deliberate and stays: what changed
    // is that the owner can now see and decline it, in the place they added the
    // token, rather than hunting an unselected chip among twenty-five stocks.
    assert.match(settings, /tradeNewToken/, "there is a control");
    assert.match(settings, /useState\(true\)/, "defaulted on — it is what they came to do");
    assert.match(src("./screens/Settings.tsx"), /Trade this one too/, "and it says so in words");
  });
});

describe("the copy stops promising things it cannot deliver", () => {
  it("SETTINGS NAMES ALL THREE STEPS, not two", () => {
    // It said "Save your tokens, then update trading permissions to enable
    // trading them" — which omits the basket, the one gate that was invisible.
    const hint = src("./screens/Settings.tsx");
    assert.match(hint, /in your trading basket/i);
    assert.match(hint, /only means .+watch this/i, "and says what adding alone does");
  });

  it("AND THE WALLET STOPS SAYING A SIGNATURE FIXES A SELECTION PROBLEM", () => {
    // "Re-signing fixes it: same wallet, same funds, same caps, free and
    // instant." True for coverage. False for a token that is not in the basket,
    // where the grant will cover it and no strategy will ever propose it.
    const wallet = src("./screens/Wallet.tsx");
    assert.match(wallet, /watchedNotTraded/, "the two cases are told apart");
    assert.match(wallet, /a signature won&apos;t do it/i, "and the second one says so");
  });

  it("and the class-route hint points where the control actually is", () => {
    const settings = src("./screens/Settings.tsx");
    assert.doesNotMatch(settings, /turn on the class route below/, "it is above, in another block");
  });
});
