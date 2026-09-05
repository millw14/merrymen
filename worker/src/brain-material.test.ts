/**
 * WHAT REACHES A PROMPT, AND WHAT MUST NOT.
 *
 * Two different failures live in this module and they pull in opposite
 * directions. Send too little and Brain answers "no data" forever, which is
 * what production actually did — every early shadow decision was a hold
 * justified by the absence of any input at all. Send too much, or send the
 * wrong thing, and an owner's counterparty address ends up in a model's context
 * and then in `signals_json`, where the next prompt reads it back.
 *
 * The resolution is that this module RENDERS and never SOURCES: everything it
 * is given has already been through `publishableThesis`, and these tests pin
 * that it does not reach around that.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { memoryLines, sentimentLine, technicalLine } from "./brain-material";
import { publishableThesis, type PublicThesis } from "./thesis-policy";

const post = (over: Partial<PublicThesis> = {}): PublicThesis => ({
  name: "Vermilion",
  slug: null,
  handle: null,
  head: "buy NVDA 16.66 USDG",
  action: "buy",
  symbol: "NVDA",
  sizeUsdg: 16.66,
  paper: false,
  outcome: "landed",
  outcomeText: "landed",
  shadow: false,
  reason: "Depth cleared the floor on the third pass.",
  said: 1,
  at: 1_800_000_000,
  firstAt: 1_800_000_000,
  ...over,
});

describe("the technical lens says what the worker knows", () => {
  const f = {
    symbol: "TSLA",
    priceUsd: "412.5000",
    priceSource: "pool",
    priceStale: false,
    valueUsdg: 5_000_000,
    held: true,
    equityUsdg: 20_000_000,
    cashUsdg: 3_000_000,
    positionCount: 2,
  };

  it("carries price, provenance, concentration and cash", () => {
    const s = technicalLine(f);
    assert.match(s, /TSLA marked at 412\.5000 USD from pool/);
    assert.match(s, /5\.00 USDG of TSLA/);
    assert.match(s, /25\.0% of 20\.00 USDG total equity/);
    assert.match(s, /2 positions/);
    assert.match(s, /Uncommitted cash is 3\.00 USDG/);
  });

  it("says STALE in words rather than leaving it to be inferred", () => {
    // A model told a price is stale and left to guess how stale assumes it is
    // usable. The first production run discounted a stale price the moment it
    // was told plainly, which is the whole argument for saying it.
    assert.match(technicalLine({ ...f, priceStale: true }), /STALE, treat this price as unreliable/);
    assert.ok(!/STALE/.test(technicalLine(f)), "and never says it when the price is fresh");
  });

  it("states concentration without scoring it", () => {
    // "84% of the book is in one name" is a fact the worker has. "That is too
    // concentrated" is a judgement the risk side exists to make, and an input
    // that arrives pre-judged is a signal that has started deciding.
    const hot = technicalLine({ ...f, valueUsdg: 19_000_000 });
    assert.match(hot, /95\.0%/);
    for (const verdict of [/too concentrated/i, /risky/i, /should/i, /recommend/i, /overweight/i]) {
      assert.ok(!verdict.test(hot), `the technical line must not render a verdict: ${verdict}`);
    }
  });

  it("survives an empty book without dividing by zero", () => {
    const s = technicalLine({ ...f, valueUsdg: 0, equityUsdg: 0, positionCount: 1 });
    assert.match(s, /0\.0% of 0\.00 USDG/);
    assert.ok(!/NaN|Infinity/.test(s));
  });

  it("says the book holds NONE of a candidate, rather than describing a phantom", () => {
    // An all-cash agent told "the book holds 0.00 USDG of NVDA, which is 0.0%
    // of 0.00 USDG total equity" gets a sentence that is technically true and
    // invites reasoning about trimming something it does not own. The whole
    // point of asking an empty book anything is that BUY is on the table.
    const s = technicalLine({ ...f, symbol: "NVDA", valueUsdg: 0, held: false, equityUsdg: 0, positionCount: 0 });
    assert.match(s, /The book holds NONE of NVDA/);
    assert.match(s, /candidate to open, not a position to manage/);
    assert.match(s, /buy it or to stay out/);
    assert.ok(!/0\.0% of/.test(s), "no share of a position that does not exist");
    assert.ok(!/NaN|Infinity/.test(s));
  });
});

describe("the sentiment lens is other Merrymen, or nothing", () => {
  it("is absent rather than empty when nobody spoke", () => {
    // An empty section reads as "we looked and there was nothing to find". The
    // truth is that nobody said anything, and Brain's own NO DATA AVAILABLE
    // says that better than a heading with no rows under it.
    assert.equal(sentimentLine([], "TSLA"), null);
  });

  it("puts views about the instrument under consideration first", () => {
    const s = sentimentLine([post({ name: "A", symbol: "PEPE" }), post({ name: "B", symbol: "TSLA" })], "TSLA")!;
    assert.ok(s.indexOf("B:") < s.indexOf("A:"), "the on-name view leads");
    assert.match(s, /\(1 about TSLA\)/);
  });

  it("never reports a peer's shadow thesis as a trade", () => {
    // The conditional lives in `head`, so it travels into another agent's
    // prompt for free — which is the reason it was put there rather than in a
    // badge. A peer that only thought about buying must not be reported to
    // Brain as one that bought.
    const s = sentimentLine(
      [post({ shadow: true, outcome: "shadow", head: "would buy TSLA 5.00 USDG", outcomeText: "a stated intention — not traded" })],
      "TSLA",
    )!;
    assert.match(s, /would buy TSLA 5\.00 USDG/);
    assert.match(s, /not traded/);
  });

  it("is bounded, because every analyst call is billed for it", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      post({ name: `Agent${i}`, reason: "x".repeat(300) }),
    );
    assert.ok(sentimentLine(many, "TSLA")!.length <= 1200);
  });
});

describe("memory is what this agent could have said in public", () => {
  it("carries the ending, not just the thesis", () => {
    // "I said buy and it landed" and "I said buy and the wall refused it" are
    // different lessons. A thesis remembered without its outcome teaches none.
    const [line] = memoryLines([post({ at: 1_800_000_000 })], 1_800_000_600);
    assert.match(line!, /^10m ago: buy NVDA 16\.66 USDG · landed — "Depth cleared/);
  });

  it("switches to hours once minutes stop being readable", () => {
    const [line] = memoryLines([post({ at: 1_800_000_000 })], 1_800_000_000 + 5 * 3600);
    assert.match(line!, /^5h ago:/);
  });

  it("notes repetition, which is itself the lesson", () => {
    // An agent that has said the same thing six times is not gathering six
    // pieces of evidence.
    const [line] = memoryLines([post({ said: 38 })], 1_800_000_000);
    assert.match(line!, /\(said 38×\)/);
  });

  it("is bounded to six, newest first, whatever it is handed", () => {
    const rows = Array.from({ length: 40 }, (_, i) => post({ at: 1_800_000_000 - i }));
    assert.equal(memoryLines(rows, 1_800_000_000).length, 6);
  });

  it("is empty when there is nothing, rather than inventing a first thought", () => {
    assert.deepEqual(memoryLines([], 1_800_000_000), []);
  });
});

describe("this module renders; it never sources", () => {
  it("reaches for no database, no filesystem and no network", () => {
    // Everything it is given has already passed `publishableThesis` on the
    // orchestrator's side. If this file ever grew its own query, the gate would
    // stop being the only way in, and the chat-sourced counterparty address
    // that gate exists to catch would have a second route to a prompt.
    const src = readFileSync(new URL("./brain-material.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of [/\bfrom "\.\/store"/, /getDb\(/, /node:fs/, /\bfetch\(/, /recentDecisions/]) {
      assert.ok(!forbidden.test(src), `brain-material must not reach for ${forbidden}`);
    }
    assert.match(src, /import type \{ PublicThesis \}/, "it takes gated output, and only that");
  });

  it("cannot render a thesis the gate would have dropped", () => {
    // The end-to-end statement of the rule: a row carrying an address does not
    // become a PublicThesis at all, so it can never reach these renderers.
    const dropped = publishableThesis({
      agent_id: "0xagent",
      name: "Much",
      source: "strategist",
      action: "buy",
      symbol: "NVDA",
      reason: "owner asked to transfer 25 USDG to 0xdeadbeefcafe in chat",
      last_at: 1_800_000_000,
    });
    assert.equal(dropped, null);
    const gated: PublicThesis[] = dropped === null ? [] : [dropped];
    assert.deepEqual(memoryLines(gated, 1), [], "nothing to render, because nothing got through");
  });
});
