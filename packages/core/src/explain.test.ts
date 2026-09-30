import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CONCEPTS, conceptTooltip, conceptsFor, renderConcepts, type Concept } from "./explain";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("the concept base is grounded", () => {
  it("every entry cites a file that exists", () => {
    // An entry whose citation has rotted is a sentence the chat will repeat
    // confidently to somebody asking about their money. The citation is the
    // only thing that makes it checkable, so it has to stay true.
    const missing = CONCEPTS.filter((c) => {
      const path = c.evidence.split(":")[0]!.trim();
      return path === "" || !existsSync(join(ROOT, path));
    }).map((c) => `${c.term} → ${c.evidence}`);
    assert.deepEqual(missing, [], `citations no longer resolve: ${missing.join("; ")}`);
  });

  it("no entry is empty, and none leaks a file path into its prose", () => {
    for (const c of CONCEPTS) {
      assert.ok(c.term.trim(), "an entry has no term");
      assert.ok(c.plain.trim().length > 40, `${c.term}: plain is too short to be an explanation`);
      assert.ok(c.aliases.length > 0, `${c.term}: needs aliases — the term itself is rarely what people type`);
      // The prose is read aloud by an agent in character. A source path in it
      // breaks the illusion and tells the reader nothing they can act on.
      for (const field of [c.plain, c.because, c.confusable ?? ""]) {
        assert.doesNotMatch(field, /\.tsx?:\d/, `${c.term}: a citation leaked into prose`);
      }
    }
  });

  it("aliases are lowercase, so the matcher can find them", () => {
    // score() lowercases the question and compares directly. An alias with a
    // capital in it can never match, and would fail silently forever.
    const bad = CONCEPTS.flatMap((c) => c.aliases.filter((a) => a !== a.toLowerCase()).map((a) => `${c.term}: ${a}`));
    assert.deepEqual(bad, []);
  });

  it("no two entries claim the same term", () => {
    const seen = new Map<string, number>();
    for (const c of CONCEPTS) seen.set(c.term.toLowerCase(), (seen.get(c.term.toLowerCase()) ?? 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([t]) => t);
    assert.deepEqual(dupes, []);
  });
});

describe("selection is deterministic and bounded", () => {
  it("the same question always selects the same entries", () => {
    // The point of not asking a model what to look up: this is reproducible,
    // so a wrong answer can be traced to an entry rather than to a mood.
    const q = "what does paper mode mean";
    assert.deepEqual(conceptsFor(q).map((c) => c.term), conceptsFor(q).map((c) => c.term));
  });

  it("a question that matches nothing returns nothing", () => {
    // Silence is an answer. The prompt turns an empty block into "I'm not
    // certain", which is the behaviour replacing a confident invention.
    assert.deepEqual(conceptsFor("what is the airspeed velocity of a swallow"), []);
    assert.deepEqual(conceptsFor(""), []);
    assert.deepEqual(conceptsFor("   "), []);
  });

  it("noise words alone select nothing", () => {
    // Otherwise "what is this?" would drag in whatever sorted first and the
    // agent would confidently explain a term nobody asked about.
    assert.deepEqual(conceptsFor("what is this about"), []);
  });

  it("it never returns more than the limit", () => {
    // Prompt size is the real cost driver, and ten entries about adjacent
    // things is how an answer becomes a lecture.
    assert.ok(conceptsFor("what is my equity gas usdg wallet key balance").length <= 4);
  });

  it("A PHRASE BEATS A LOOSE WORD", () => {
    const base: Concept = { term: "t", aliases: [], plain: "p", because: "b", evidence: "x" };
    const loose = { ...base, term: "loose", aliases: ["key"] };
    const phrase = { ...base, term: "phrase", aliases: ["session key"] };
    // Written loose-first so a stable sort cannot be what puts phrase on top.
    const picked = conceptsFor("what is a session key", [loose, phrase], 2);
    assert.equal(picked[0]!.term, "phrase", "an intact phrase is stronger evidence than one shared word");
  });
});

describe("the questions testers actually asked are answerable", () => {
  // Every one of these was asked by a real person in the first hour of the
  // closed beta, and every one had a precise answer that lived only in this
  // codebase. If a change ever stops one of them matching, the chat goes back
  // to guessing about somebody's money.
  const asked = [
    "I tried to fund my wallet with USDG but it didn't arrive",
    "recovery key is only a bunch of dots",
    "couldn't read your owner key",
    "your wallet is on 0x... but you signed in as 0x...",
    "do I need to send ETH for gas fees?",
    "what is breaker 5%",
    "what does paper mean",
    "why does it say would buy",
    "what is a session key",
    "why is my feed quiet",
    // Asked in the beta group on 2026-09-06, in these words.
    "How to switch from paper mode to real trading? Agent is funded with ETH and USDG",
    "so how do I get it to actually start trading?",
    "on settings page it shows could not load ai models",
  ];

  for (const question of asked) {
    it(`answers: ${question}`, () => {
      const hits = conceptsFor(question);
      assert.ok(hits.length > 0, `nothing in the concept base matches "${question}"`);
      const rendered = renderConcepts(hits);
      assert.ok(rendered.length > 0);
      assert.match(rendered, /why:/);
    });
  }
});

describe("rendering", () => {
  it("empty in, empty out — so the prompt omits the block entirely", () => {
    assert.equal(renderConcepts([]), "");
  });

  it("leads with the confusion when there is one", () => {
    const rendered = renderConcepts(conceptsFor("why does it say would buy"));
    assert.match(rendered, /often confused with/);
  });
});

describe("tooltips beside numbers", () => {
  it("EVERY TERM THE UI ASKS FOR RESOLVES", () => {
    // The caps row shipped asking for "Per trade limit", which the harvest had
    // rejected — so the one cap the CHAIN actually enforces rendered an empty
    // popover, on the row where that distinction matters most. A tooltip that
    // silently resolves to "" is indistinguishable from one nobody wrote.
    const wallet = readFileSync(new URL("../../../web/src/terminal/screens/Wallet.tsx", import.meta.url), "utf8");
    const asked = [...wallet.matchAll(/conceptTooltip\("([^"]+)"\)/g)].map((m) => m[1]!);
    assert.ok(asked.length >= 4, `expected the caps row to ask for tooltips, found ${asked.length}`);
    const missing = asked.filter((t) => conceptTooltip(t) === "");
    assert.deepEqual(missing, [], `these render an empty popover: ${missing.join(", ")}`);
  });

  it("a tooltip is short enough to read in one breath", () => {
    for (const term of ["Per trade limit", "Per day limit", "daily cap", "drawdown breaker"]) {
      const tip = conceptTooltip(term);
      assert.ok(tip.length > 60, `${term}: too short to explain anything`);
      assert.ok(tip.length <= 420, `${term}: ${tip.length} chars is a paragraph, not a hover`);
      assert.match(tip, /[.!?]$/, `${term}: a tooltip must not stop mid-sentence`);
    }
  });

  it("an unknown term renders nothing rather than something else's meaning", () => {
    assert.equal(conceptTooltip("not a term in the base"), "");
  });

  it("the caps row says which limits the chain enforces and which merrymen does", () => {
    // Four numbers on one row read as four equally hard promises. Two of them
    // are counters in our own software. That is the single most important
    // thing an owner can learn from hovering.
    assert.match(conceptTooltip("Per trade limit"), /blockchain itself enforces/i);
    assert.match(conceptTooltip("Per day limit"), /merrymen's own software/i);
  });
});

/**
 * THE ENERGY CONCEPT STATES THE THROTTLE CONDITIONALLY.
 *
 * It reaches the web chat and Telegram whenever an owner says "energy" or asks
 * "why are you limited" (agent-chat.ts appends conceptsFor(message); the
 * Telegram explainTerm tool returns the same text). MERRYMEN_ENERGY_GATE is
 * off until an operator turns it on and a self-hosted install is never gated,
 * so a concept that stated "without it … about a tenth" as plain fact handed
 * the model a false reason to buy $MERRYMEN — the one the tier perks and
 * Settings already stopped giving.
 */
describe("the Energy concept", () => {
  const energy = () => conceptsFor("why are you limited? what is energy")[0]!;

  it("is what an owner asking why they are limited is handed", () => {
    assert.equal(energy().term, "Energy");
  });

  it("SAYS THE GATE IS AN OPERATOR SWITCH, OFF UNTIL TURNED ON, before it states any throttle", () => {
    const { plain } = energy();
    const gate = plain.indexOf("only limits anything when the hosted service turns energy on");
    const tenth = plain.indexOf("about a tenth of a standard day");
    assert.ok(gate > 0 && tenth > gate, "the condition comes first");
    assert.match(plain, /an operator switch, off until it is turned on; a self-hosted install is never gated/);
    assert.match(plain, /While it is off, nothing is limited, whatever you hold\./);
    assert.match(plain, /When it is on, with 100,000 \$MERRYMEN between your wallet and your agent's account it runs at full strength; without it, it still runs, but gets about a tenth/);
  });

  it("and its rendered form, what the model actually reads, carries the condition too", () => {
    const rendered = renderConcepts([energy()]);
    assert.match(rendered, /only limits anything when the hosted service turns energy on/);
    assert.match(rendered, /only while its operator has the energy gate enforcing/);
  });

  it("no price or returns language (a take-profit is an exit, not a promise)", () => {
    const e = energy();
    assert.doesNotMatch(`${e.plain} ${e.because} ${e.confusable ?? ""}`, /price|returns?\b|(?<!take-)profit|invest|moon/i);
  });
});

/**
 * THE PERPETUALS CONCEPTS (docs/perps.md, "How it is built": explain.ts gains
 * grounded concepts for leverage, liquidation price, funding, mark vs index,
 * isolated margin, reduce-only and "at the venue").
 *
 * Leverage is where a general-purpose answer hurts most: "leverage" at most
 * exchanges is an order field a trader picks, "margin" may be cross, and a
 * close can flip a position. None of that is true here, and each entry is
 * held to saying so, and to never telling an owner their money is home.
 */
describe("the perpetuals concepts", () => {
  const PERPS_TERMS = [
    "Leverage (perpetuals)",
    "Liquidation price",
    "Funding (perpetuals)",
    "Mark price vs index price",
    "Isolated margin",
    "Reduce-only",
    "At Lighter (at the venue)",
  ];
  /** One entry by its exact term; a missing one fails the test that asked for it. */
  const byTerm = (term: string): Concept => {
    const c = CONCEPTS.find((x) => x.term === term);
    assert.ok(c, `${term} is missing`);
    return c;
  };
  const perps = (): Concept[] => PERPS_TERMS.map(byTerm);

  it("every one exists and cites the perps code that makes it true", () => {
    for (const c of perps()) {
      assert.match(c.evidence, /packages\/core\/src\/perps\.ts|worker\/src\/perps\/|worker\/src\/policy\.ts/, `${c.term}: cites no perps code`);
      assert.ok(c.confusable && c.confusable.length > 40, `${c.term}: the confusion IS the entry for leverage words`);
    }
  });

  const asked: Array<[string, string]> = [
    ["what is leverage", "Leverage (perpetuals)"],
    ["can I change the leverage on my BTC position", "Leverage (perpetuals)"],
    ["what is my liquidation price", "Liquidation price"],
    ["will I get liquidated", "Liquidation price"],
    ["what is the funding rate", "Funding (perpetuals)"],
    ["why did I pay funding on my BTC-PERP", "Funding (perpetuals)"],
    ["what's the difference between mark price and index price", "Mark price vs index price"],
    ["what is isolated margin", "Isolated margin"],
    ["what does reduce-only mean", "Reduce-only"],
    ["how do I close a perp", "Reduce-only"],
    ["why is my money on lighter", "At Lighter (at the venue)"],
    ["how long is the withdrawal delay", "At Lighter (at the venue)"],
  ];
  for (const [question, term] of asked) {
    it(`answers: ${question}`, () => {
      assert.equal(conceptsFor(question)[0]?.term, term, `picked ${conceptsFor(question).map((c) => c.term).join(", ")}`);
    });
  }

  it("does not hijack the questions about funding a wallet or spot trading", () => {
    // "funding" alone is how owners talk about depositing, and "close a
    // position" is a spot sell too: neither may pull in a perps entry first.
    for (const q of ["I tried to fund my wallet with USDG but it didn't arrive", "how do I put money in", "what is breaker 5%", "what does paper mean"]) {
      const first = conceptsFor(q)[0]?.term;
      assert.ok(first && !PERPS_TERMS.includes(first), `${q} → ${first}`);
    }
  });

  it("states the merrymen meaning where the industry one differs", () => {
    const leverage = byTerm("Leverage (perpetuals)");
    const liq = byTerm("Liquidation price");
    const funding = byTerm("Funding (perpetuals)");
    const markIndex = byTerm("Mark price vs index price");
    const margin = byTerm("Isolated margin");
    const reduce = byTerm("Reduce-only");
    const venue = byTerm("At Lighter (at the venue)");
    assert.match(leverage.plain, /no model or chat message ever chooses it/);
    assert.match(leverage.plain, /never above 10x/);
    assert.match(liq.confusable!, /It is not your stop/);
    assert.match(funding.plain, /It is not a merrymen fee/);
    assert.match(markIndex.plain, /judged on the mark/);
    assert.match(margin.plain, /only ever uses isolated margin/);
    assert.match(reduce.plain, /cannot open a new position in the opposite direction/);
    assert.match(reduce.confusable!, /does not guarantee a fill/);
    assert.match(venue.plain, /only ever come back to your agent's own smart account/);
    assert.match(venue.plain, /withdrawal delay/);
  });

  it("never tells an owner the money is home, or that unread means empty", () => {
    for (const c of perps()) {
      const all = `${c.plain} ${c.because} ${c.confusable ?? ""}`;
      assert.doesNotMatch(all, /stays? in (your|the) smart account|funds are safe|guaranteed|risk-free/i, c.term);
    }
    assert.match(byTerm("At Lighter (at the venue)").confusable ?? "", /"Could not be read" is not "nothing there"/);
  });

  it("the rendered form a model reads carries the mechanism and the confusion", () => {
    const rendered = renderConcepts(conceptsFor("what is my liquidation price"));
    assert.match(rendered, /why: isolatedLiqPrice/);
    assert.match(rendered, /often confused with: It is not your stop/);
  });
});
