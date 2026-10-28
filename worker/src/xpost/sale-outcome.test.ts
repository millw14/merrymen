import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendSaleOutcome, gainFigure, hasSaleOutcome, SALE_REACTIONS, SALE_TAGS, saleBand, saleOutcomeLines, saleWordBudget } from "./sale-outcome";
import { admitXPost, XPOST_MIN_WORDS, type XGateCtx } from "./gate";
import { sellPrompt, type WriterFacts } from "./writer";

const facts: WriterFacts = { agentName: "Alan", strategy: null, flavour: null, traits: [], mode: "live", style: { lower: true, emoji: 0, exclaim: 0 }, recentOwn: [] };
const gate: XGateCtx = { kind: "sell", agentName: "Alan", mode: "live", coins: ["Pepe"], recentOwn: [], recentFleet: [], emojiOk: false };
const base = (text: string) => ({ ok: true as const, text });

describe("sale prose and deterministic gross outcome", () => {
  it("allows a factual partial sale, with performance commentary coming only from evidence", () => {
    const text = "sold pepe. keeping the notes for my next decision.";
    assert.equal(admitXPost(text, gate, base).ok, true);
    assert.equal(admitXPost(text, { ...gate, kind: "buy" }, base).ok, false);
    for (const outcome of ["profit", "loss", "flat"] as const) {
      const body = appendSaleOutcome(text, outcome)!;
      assert.match(body, /before fees and gas/);
      assert.equal(hasSaleOutcome(body, outcome), true);
      assert.equal(hasSaleOutcome(`${body}\nca: 0x${"a".repeat(40)}`, outcome), true);
      assert.equal(hasSaleOutcome(body, "unknown"), false);
    }
    assert.equal(appendSaleOutcome(text, "unknown"), text);
    assert.equal(hasSaleOutcome(text, "unknown"), true);
    assert.equal(hasSaleOutcome(appendSaleOutcome(text, "profit")!, "loss"), false);
  });

  it("refuses invented results, complete exits, explanations and post-exit hindsight", () => {
    for (const text of [
      "sold pepe for a profit", "sold pepe. nice gains", "sold pepe. painful loss",
      "sold pepe. i won", "sold pepe. i am happy", "sold pepe. that worked",
      "sold pepe too early", "sold pepe and jeeted", "sold pepe before it kept pumping",
      "sold pepe. fully closed", "sold pepe because the thesis changed", "sold pepe and got out",
    ]) assert.equal(admitXPost(text, gate, base).ok, false, text);
    assert.equal(admitXPost("made my decision about pepe", gate, base).ok, false);
    assert.equal(admitXPost("sold the coin. keeping my notes.", gate, base).ok, false);
    assert.equal(admitXPost("sold pepe on paper. keeping my notes.", gate, base).ok, false);
    assert.equal(appendSaleOutcome("x".repeat(280), "profit"), null);
  });

  it("refuses where the price was, how much went and what is left, read with \"sold\" still in (trade-wording review, 2026-10-18)", () => {
    // The six a probe of the real gate admitted.
    for (const text of [
      "just sold some casino from the stack", "sold some casino, still holding the rest", "sold casino, rest of the bag stays put",
      "sold half of my casino here", "sold casino at the top of the range", "sold casino into strength, still in some",
    ]) assert.equal(admitXPost(text, { ...gate, coins: ["Casino"] }, base).ok, false, text);
    // Each screen on its own.
    for (const [text, reason] of [
      ["just sold pepe, receipt is filed", "alert"],
      ["sold pepe at a level i liked there", "sale-timing"],
      // The coin taken out still leaves "sold at".
      ["sold Pepe at the desk, back to work", "sale-timing"],
      ["sold pepe near the highs of the range", "sale-timing"],
      ["sold pepe into strength, receipt filed", "sale-timing"],
      ["sold pepe into the dip, receipt filed", "sale-timing"],
      ["sold pepe a while ago, receipt filed", "sale-timing"],
      ["flipped pepe and sold it, receipt filed", "sale-timing"],
      ["sold some pepe, receipt filed", "sale-amount"],
      ["sold a chunk of pepe, receipt filed", "sale-amount"],
      ["sold a bit of pepe, receipt filed", "sale-amount"],
      ["sold a piece of pepe, receipt filed", "sale-amount"],
      ["sold a quarter of the pepe", "sale-amount"],
      ["sold the whole pepe bag, receipt filed", "sale-amount"],
      ["sold all my pepe, receipt filed", "sale-amount"],
      ["sold pepe, trimmed and filed away", "sale-amount"],
      ["sold pepe for a grand, receipt filed", "quantity"],
      ["sold pepe, what's left stays on the desk", "sale-holding"],
      ["sold pepe, rest of it stays put", "sale-holding"],
      ["sold pepe, still in it", "sale-holding"],
      ["sold pepe, holding the other one", "sale-holding"],
      ["sold pepe, i’ll buy again later", "sale-holding"],
      ["sold pepe, next one i grab is coming", "sale-holding"],
    ] as const) {
      const v = admitXPost(text, gate, base);
      assert.equal(v.ok ? "ok" : v.reason, reason, text);
    }
    // What a sale may still say.
    for (const text of [
      "sold pepe. keeping the notes for my next decision.", "i sold pepe, receipt filed.", "ok, pepe sold. receipt's below",
      "pepe sold, back to digging around", "and that's pepe sold. carrying on",
    ]) assert.equal(admitXPost(text, gate, base).ok, true, text);
    // A coin called what a screen reads is a name, read with the coin taken out.
    assert.equal(admitXPost("sold Half, receipt filed and noted", { ...gate, coins: ["Half"] }, base).ok, true);
    assert.equal(admitXPost("sold Top Cat, receipt filed and noted", { ...gate, coins: ["Top Cat"] }, base).ok, true);
    assert.deepEqual(admitXPost("sold Top Cat at the top", { ...gate, coins: ["Top Cat"] }, base), { ok: false, reason: "sale-timing" });
  });

  it("never hands outcome or money to the model and reserves room for verified suffixes", () => {
    const a = sellPrompt({ ...facts, coin: "Pepe", paper: false, outcome: "profit" });
    const b = sellPrompt({ ...facts, coin: "Pepe", paper: false, outcome: "loss" });
    assert.deepEqual(a, b);
    assert.match(a.prompt, /at most one hundred eighty characters/);
    // Asked for more words than the gate's floor: "sold some PEPE." was refused as too short, every sale of 2026-10-14.
    assert.match(a.prompt, /five or more words/);
    assert.ok(5 > XPOST_MIN_WORDS);
    assert.equal(admitXPost("sold some PEPE.", { ...gate, coins: ["PEPE"] }, base).ok, false, "the floor the prompt now clears");
    assert.match(a.prompt, /partial sale/);
    assert.match(a.system, /Trusted code adds any measured result separately/);
  });
});

describe("code-built sale tags and fresh send-time validation", () => {
  it("formats only finite, measurable figures with an explicit sign", () => {
    assert.equal(gainFigure(1034.4), "+1,034%");
    assert.equal(gainFigure(42.6), "+43%");
    assert.equal(gainFigure(3.04), "+3%");
    assert.equal(gainFigure(3.46), "+3.5%");
    assert.equal(gainFigure(-12.2), "-12%");
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 1e8, 0.04, -0.049]) assert.equal(gainFigure(bad as number), null);
    assert.equal(gainFigure(0.05), "+0.1%");
  });

  it("accepts every exact tag and band reaction, with or without a verified suffix", () => {
    for (const [outcome, gain] of [["profit", 0.1], ["profit", 1], ["profit", 9.9], ["profit", 10], ["profit", 49], ["profit", 50], ["profit", 12345], ["loss", -0.1], ["loss", -20], ["flat", 0]] as const) {
      const lines = saleOutcomeLines(outcome, gain);
      assert.ok(lines.length >= SALE_TAGS.length);
      for (const line of lines) {
        const body = `sold pepe, back to my notes.\n${line}`;
        assert.equal(hasSaleOutcome(body, outcome, gain), true, line);
        assert.equal(hasSaleOutcome(`${body}\n\n0x${"ab".repeat(20)}`, outcome, gain), true, line);
        assert.equal(hasSaleOutcome(body, "unknown", null), false, line);
        assert.equal(hasSaleOutcome(body, outcome, outcome === "profit" ? gain + 10 : outcome === "loss" ? gain - 10 : 1), false, line);
        assert.equal(hasSaleOutcome(`${body} invented ending`, outcome, gain), false, line);
      }
    }
  });

  it("rejects stale figures, another outcome, an added result and an incorrect reaction band", () => {
    const body = appendSaleOutcome("sold pepe, back to my notes.", "profit", 1034.4)!;
    assert.ok(body.includes("+1,034%"));
    assert.equal(hasSaleOutcome(body, "profit", 980), false);
    assert.equal(hasSaleOutcome(body, "profit"), false);
    assert.equal(hasSaleOutcome(body, "loss", -1034.4), false);
    assert.equal(hasSaleOutcome(`${body}\nflat gross before fees and gas`, "profit", 1034.4), false);
    assert.equal(hasSaleOutcome(`sold pepe, back to my notes.\n+0.1% gross before fees and gas. ${SALE_REACTIONS.large[0]}`, "profit", 0.1), false);
    assert.equal(hasSaleOutcome(`sold pepe, back to my notes.\n+1,034% gross before fees and gasgarbage`, "profit", 1034.4), false);
    for (const [outcome, gain] of [["profit", -20], ["loss", 20], ["flat", 20]] as const) assert.equal(appendSaleOutcome("sold pepe, receipt filed.", outcome, gain), null);
    assert.equal(appendSaleOutcome("sold pepe, receipt filed.", "profit", NaN), null);
  });

  it("preserves exact legacy queued rows without accepting old figures or contradictory results", () => {
    for (const [outcome, gain, result] of [
      ["profit", 40, "+40% gross gain before fees and gas. pleased with that part."],
      ["loss", -20, "-20% gross loss before fees and gas. not my finest call."],
      ["flat", 0, "flat before fees and gas. no victory lap."],
      ["profit", undefined, "gross gain before fees and gas. pleased with that part."],
      ["profit", 0.01, "gross gain before fees and gas. pleased with that part."],
    ] as const) {
      const body = `sold pepe, receipt filed.\n${result}`;
      assert.equal(hasSaleOutcome(body, outcome, gain), true);
      assert.equal(hasSaleOutcome(body, "unknown"), false);
      assert.equal(hasSaleOutcome(`${body}\nflat before fees and gas. no victory lap.`, outcome, gain), false);
    }
  });

  it("unknown never gets a tag; an unrenderable tiny figure never becomes zero or an upbeat reaction", () => {
    const words = "sold pepe, back to my notes.";
    assert.equal(appendSaleOutcome(words, "unknown", null), words);
    assert.equal(hasSaleOutcome(words, "unknown"), true);
    assert.deepEqual(saleOutcomeLines("unknown", null), []);
    for (const gain of [0.01, 0.1, 0.95, -0.01, -0.1, -0.95]) {
      const outcome = gain > 0 ? "profit" : "loss";
      assert.equal(saleBand(outcome, gain), "small");
      for (const line of saleOutcomeLines(outcome, gain)) assert.doesNotMatch(line, /\. |[+-]0%/);
      assert.equal(hasSaleOutcome(appendSaleOutcome(words, outcome, gain)!, outcome, gain), true);
    }
  });

  it("contains no net result, completed exit, timing, forecast, advice or numeric reaction claims", () => {
    for (const reaction of Object.values(SALE_REACTIONS).flat()) {
      assert.doesNotMatch(reaction, /\b(?:profit|win|net|early|late|all|out|closed|buy|sell|moon|pump|tomorrow|will|gonna|should)\b|[0-9%$]/i, reaction);
    }
  });

  it("varies deterministically and skips reactions used in the last ten sales", () => {
    const recent: string[] = [];
    const reactions = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const body = appendSaleOutcome("sold pepe, back to my notes.", "profit", 40, { seed: "same-seed", recentSales: recent })!;
      assert.ok(body);
      assert.equal(hasSaleOutcome(body, "profit", 40), true);
      const reaction = body.split("\n")[1]!.split(". ")[1]!;
      assert.ok(reaction);
      assert.ok(!recent.slice(0, 10).some((post) => post.endsWith(`. ${reaction}`)));
      reactions.add(reaction);
      recent.unshift(body);
    }
    assert.ok(reactions.size >= 11);
    assert.equal(appendSaleOutcome("sold pepe, receipt filed.", "profit", 40, { seed: "a" }), appendSaleOutcome("sold pepe, receipt filed.", "profit", 40, { seed: "a" }));
  });

  it("uses the actual conservative disclosure budget and omits reactions before overflowing", () => {
    const suffix = "\n\n" + "x".repeat(145);
    const budget = saleWordBudget("profit", 12345, suffix);
    const body = appendSaleOutcome("x".repeat(budget), "profit", 12345, { seed: "test", suffix });
    assert.ok(body);
    assert.ok(body.length + suffix.length <= 280);
    assert.equal(appendSaleOutcome("x".repeat(budget + 1), "profit", 12345, { suffix }), null);
    assert.equal(saleWordBudget("profit", 12345, suffix, 4), budget - 4);
    assert.deepEqual(admitXPost("sold pepe, back to the reading list.", { ...gate, saleMaxLength: 20 }, base), { ok: false, reason: "sale-length" });
  });

  it("selects seeded writing angles without exposing the outcome or any financial figure", () => {
    const prompts = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const f = { ...facts, coin: "Pepe", paper: false, seed: `receipt:${i}`, maxChars: 83 };
      const win = sellPrompt({ ...f, outcome: "profit" });
      assert.deepEqual(win, sellPrompt({ ...f, outcome: "loss" }));
      assert.deepEqual(win, sellPrompt({ ...f, outcome: "unknown" }));
      assert.match(win.prompt, /at most eighty three characters/);
      assert.doesNotMatch(win.prompt + win.system, /\d/);
      assert.doesNotMatch(win.prompt, /gross|fees|gas|win|loss|profit/);
      prompts.add(win.prompt);
    }
    assert.equal(prompts.size, 4);
  });
});
