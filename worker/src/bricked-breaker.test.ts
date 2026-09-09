/**
 * A KEY SIGNED WITH A ZERO DRAWDOWN LIMIT CAN NEVER TRADE.
 *
 * policy.ts refuses every non-exit intent when `drawdownBps >=
 * limits.maxDrawdownBps`. With the limit at zero that comparison is `0 >= 0` —
 * TRUE at a perfect high-water mark, on the first tick, and on every tick after
 * it for the life of the grant. The agent arms, reports itself live, reads the
 * market, proposes trades, and has every one of them turned back by its owner's
 * own signature.
 *
 * Found on the live fleet, not reasoned about: one agent rejecting
 * `drawdown-breaker — 0bps >= 0bps` on a loop, with nothing on any screen
 * saying why. `drawdown-breaker` is not in live-blocker.ts's advice and is not
 * an exec-mode blocker, so it never becomes a `liveBlocker` and never reaches
 * the banner — the owner sees rejected rows beside a status line that says the
 * agent is running.
 *
 * The SOURCE is already plugged (Wallet.tsx floors maxDrawdownPct at 1). This
 * is for the keys that already carry a zero, which no edit can reach — only a
 * new signature can, and it is the owner's to give.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the breaker still bricks a zero-limit key", () => {
  it("0 >= 0 IS THE WHOLE BUG, and the comparison is unchanged", () => {
    // Not fixed by loosening the rule: a breaker that ignored its own limit
    // would be worse. The limit is sealed in a signature and only a re-sign
    // moves it, so the product's job is to SAY so.
    const policy = read("./policy.ts");
    assert.match(policy, /if \(drawdownBps >= limits\.maxDrawdownBps\) \{/);
  });

  it("and no screen advises on it, which is why the worker must", () => {
    const advice = read("../../web/src/lib/live-blocker.ts");
    assert.ok(
      !advice.includes('"drawdown-breaker"'),
      "if this gains screen advice, the worker's note becomes a duplicate — reconsider it here",
    );
  });
});

describe("so the worker says it", () => {
  it("IT NAMES THE CAUSE, THE NON-REMEDY AND THE REMEDY", () => {
    const src = read("./index.ts");
    assert.match(src, /active\.limits\.maxDrawdownBps === 0/);
    assert.match(src, /signed with a 0% drawdown limit/);
    // The non-remedy matters as much as the remedy: this is the shape where an
    // owner sends more money at a problem money cannot fix.
    // The sentence is wrapped across two source lines, so collapse the
    // concatenation before matching rather than guessing where the break falls.
    const flat = src.replace(/"\s*\+\s*\n?\s*"/g, "");
    assert.match(flat, /adding funds will not help/);
    assert.match(src, /Re-sign the permission \(free\)/);
  });

  it("ONCE PER CHANGE, NOT ONCE PER TICK", () => {
    // A permanent condition written every four minutes buries every other
    // reason in the same feed the notice reads from.
    const src = read("./index.ts");
    assert.match(src, /let breakerBrickNoted = false;/);
    assert.match(src, /if \(!breakerBrickNoted\) \{\s*breakerBrickNoted = true;/);
    assert.match(src, /breakerBrickNoted = false;/);
  });

  it("and it is checked BEFORE the Circle gate, being the more absolute of the two", () => {
    // A Circle block lifts the moment they hold the token. This one does not
    // lift at all, so it is the truer answer to "why is nothing happening".
    const src = read("./index.ts");
    assert.ok(
      src.indexOf("active.limits.maxDrawdownBps === 0") < src.indexOf("isCircleStrategy(strategy.name)"),
      "the unfixable-without-a-signature case is reported first",
    );
  });

  it("and the signing screen can no longer mint another one", () => {
    const wallet = read("../../web/src/terminal/screens/Wallet.tsx");
    assert.match(wallet, /maxDrawdownPct: 1,/, "the floor is what stops this recurring");
  });
});
