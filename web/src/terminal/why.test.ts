/**
 * WHOSE WORDS ARE ON THE SCREEN.
 *
 * Every line the terminal shows under an agent's name is either something that
 * agent actually published or something this code made up, and a reader cannot
 * tell the two apart by looking. So the boundary has to be a property of the
 * code, and this is where it is pinned.
 *
 * THE REASON THIS FILE EXISTS IN THIS FORM. The prototype these modules came
 * from — `samples/agents-only-shell/src/why.ts` — shipped a table called
 * `AGENT_TAKE` that mapped REAL production agent slugs to INVENTED quotes:
 *
 *     tj9fr041atb68ec8: { TSLA: "The one name in the ten I actually wanted…" }
 *
 * …plus a `voiceOf()` that synthesised a thesis from a strategy id for any
 * agent it had no invented quote for. The version that reached the app dropped
 * all of it and returns only text an agent really posted. That deletion is the
 * single most important line of the whole integration, and nothing in the type
 * system prevents somebody restoring it while "syncing the two copies".
 *
 * The second thing tested here is subtler and is the reason `isWhy` exists: an
 * agent's own words are not automatically a thesis. "schedule says buy" and
 * "22% of a 5-leg book" are the strategy describing its own arithmetic. Printing
 * those under a heading that means "why they bought" attributes a reason to an
 * agent that never gave one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { isWhy, parseWhy, stampOf, takeFor, thesisLine, whyLine } from "./why";
import type { Thesis } from "./live";

const t = (over: Partial<Thesis> = {}): Thesis =>
  ({ slug: "s", name: "Little John", action: null, symbol: null, sizeUsdg: null, reason: null, ...over }) as Thesis;

describe("no line is ever invented", () => {
  it("INVARIANT: the app's why.ts holds no table of quotes", () => {
    const src = readFileSync(new URL("./why.ts", import.meta.url), "utf8");
    // The prototype's fabrication machinery, by name. Any of these coming back
    // means invented sentences are being attributed to real agents again.
    for (const banned of ["AGENT_TAKE", "NAME_TAKE", "voiceOf"]) {
      assert.ok(!src.includes(banned), `why.ts must not reintroduce ${banned}`);
    }
    // And by shape: a slug-keyed record of strings is the same thing under a
    // different name.
    assert.ok(
      !/Record<string, Record<string, string>>/.test(src),
      "a slug -> symbol -> sentence table is a fabrication table whatever it is called",
    );
  });

  it("takeFor returns published text or nothing — never a generated take", () => {
    assert.equal(takeFor(null, null), "", "nothing published means nothing said");
    assert.equal(takeFor("  ", null), "", "whitespace is not a thesis");
    assert.equal(takeFor("Cheap against the year.", null), "Cheap against the year.");
    assert.equal(
      takeFor(null, "Standing view: I like the cash flows."),
      "Standing view: I like the cash flows.",
      "the standing view is still the agent's own words",
    );
  });

  it("a take is capped, and the cap is visible", () => {
    const long = "x".repeat(200);
    const out = takeFor(long, null);
    assert.ok(out.length <= 90, `capped, got ${out.length}`);
    assert.ok(out.endsWith("…"), "and the truncation is shown rather than hidden");
  });
});

describe("the strategy describing itself is not a reason", () => {
  it("rejects the schedule and the slice", () => {
    for (const notAReason of [
      "schedule says buy",
      "its 22% of a 5-leg basket",
      "22% of a 5-name book",
      "idle above the floor",
      "today's budget still allows it",
      "parking it in the vault",
      "pulling 40 from the vault",
      "under one tick",
      "parking idle cash",
      "",
      "   ",
    ]) {
      assert.equal(isWhy(notAReason), false, `"${notAReason}" is not a thesis`);
    }
    assert.equal(isWhy(null), false);
    assert.equal(isWhy(undefined), false);
  });

  it("accepts an actual view", () => {
    for (const reason of [
      "Cheap against the year and it still has a cult.",
      "A 0.58% 24-hour return is not a signal; I am staying out.",
      "Memory cycle. That is the whole thought.",
    ]) {
      assert.ok(isWhy(reason), reason);
    }
  });

  it("thesisLine prefers the post, falls back to the standing view, then says nothing", () => {
    assert.equal(thesisLine(t({ reason: "A real view." })), "A real view.");
    assert.equal(thesisLine(t({ reason: "schedule says buy" }), "A standing view."), "A standing view.");
    assert.equal(thesisLine(t({ reason: "schedule says buy" }), "schedule says buy"), "", "two non-reasons are still no reason");
  });
});

describe("reading a published action", () => {
  it("a buy carries the basket arithmetic when the post contained it", () => {
    const w = parseWhy(t({ action: "buy", symbol: "TSLA", sizeUsdg: 5, reason: "into TSLA, its 22% of a 5-leg basket" }));
    assert.deepEqual(w, { kind: "buy", symbol: "TSLA", size: 5, weight: 22, legs: 5 });
  });

  it("a buy without it reports zero legs rather than inventing a weight", () => {
    const w = parseWhy(t({ action: "buy", symbol: "TSLA", sizeUsdg: 5, reason: "I like it." }));
    assert.equal(w.kind === "buy" && w.legs, 0);
    assert.equal(w.kind === "buy" && w.weight, 0);
  });

  it("vault moves are recognised from either the reason or the head", () => {
    assert.equal(parseWhy(t({ reason: "parking it in the vault" })).kind, "park");
    assert.equal(parseWhy(t({ head: "vault-deposit" })).kind, "park");
    assert.equal(parseWhy(t({ reason: "pulling cash from the vault" })).kind, "unpark");
    assert.equal(parseWhy(t({ head: "vault-withdraw" })).kind, "unpark");
  });

  it("anything unrecognised is passed through verbatim, not guessed at", () => {
    const w = parseWhy(t({ reason: "something the parser has never seen" }));
    assert.deepEqual(w, { kind: "other", line: "something the parser has never seen" });
  });

  it("whyLine never claims an action the row did not carry", () => {
    assert.equal(whyLine(t({ action: "buy", symbol: "TSLA", reason: "into TSLA, its 22% of a 5-leg basket" })), "22% of a 5-name book");
    assert.equal(whyLine(t({ action: "sell", symbol: "TSLA" })), "Sold TSLA");
    assert.equal(whyLine(t({ action: "hold", symbol: "TSLA" })), "Holding TSLA");
    assert.equal(whyLine(t({})), "", "a row with no action and no words says nothing");
  });
});

describe("the stamp says what the wall did", () => {
  it("names the rule that stopped it, when the row says which", () => {
    assert.equal(stampOf(t({ outcome: "refused", outcomeText: "daily drawdown breaker" })), "breaker");
    assert.equal(stampOf(t({ outcome: "refused", outcomeText: "over the per-trade cap" })), "cap");
    assert.equal(stampOf(t({ outcome: "refused", outcomeText: "spending limit reached" })), "cap");
    assert.equal(stampOf(t({ outcome: "reverted", outcomeText: "the wall refused it" })), "wall");
  });

  it("falls back to `blocked` rather than naming a rule it cannot identify", () => {
    assert.equal(stampOf(t({ outcome: "refused", outcomeText: "something new" })), "blocked");
    assert.equal(stampOf(t({ outcome: "refused", outcomeText: null })), "blocked");
  });

  it("paper is marked as paper, landed or not", () => {
    assert.equal(stampOf(t({ outcome: "landed", paper: true })), "paper");
    assert.equal(stampOf(t({ paper: true })), "paper");
    assert.equal(stampOf(t({ outcome: "landed", paper: false })), null, "a real fill needs no stamp");
  });
});
