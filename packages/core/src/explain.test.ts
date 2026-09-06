import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CONCEPTS, conceptsFor, renderConcepts, type Concept } from "./explain";

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
