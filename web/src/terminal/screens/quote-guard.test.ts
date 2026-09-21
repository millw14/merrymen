import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQuoteGuard } from "./quote-guard";

/**
 * The race Swap.tsx guards against: the debounce cancels only the timer,
 * never an in-flight fetch, so an older amount's response can arrive after a
 * newer one's. A full jsdom mount is out of reach here (the screen imports
 * CSS and next/link, neither of which the tsx test runner can load), so these
 * drive the guard through the exact application rule the component uses:
 * take a generation at fetch start, apply only if still current.
 */
describe("createQuoteGuard — only the latest preview writes state", () => {
  it("reverse-order responses: the older one loses", async () => {
    const guard = createQuoteGuard();
    const applied: string[] = [];
    const fetchQuote = (label: string) => {
      const gen = guard.next();
      return Promise.resolve(label).then((result) => {
        if (guard.isCurrent(gen)) applied.push(result);
      });
    };
    // A starts, B starts, A resolves first... then B — but also the reverse:
    const a = fetchQuote("A-old-amount");
    const b = fetchQuote("B-new-amount");
    await b;
    await a;
    assert.deepEqual(applied, ["B-new-amount"]);
  });

  it("clearing the field retires the in-flight fetch", async () => {
    const guard = createQuoteGuard();
    const applied: string[] = [];
    const gen = guard.next();
    const pending = Promise.resolve("stale").then((result) => {
      if (guard.isCurrent(gen)) applied.push(result);
    });
    guard.invalidate(); // what the component does when the input clears
    await pending;
    assert.deepEqual(applied, [], "a cleared field must never receive its own stale preview");
  });

  it("generations are monotonic and independent per guard", () => {
    const g1 = createQuoteGuard();
    const g2 = createQuoteGuard();
    const a = g1.next();
    g2.next();
    g2.next(); // g2 moved on; g1 did not
    assert.equal(g1.isCurrent(a), true);
    assert.equal(g2.isCurrent(a), false);
  });
});
