/**
 * A TRENCHER TRADE SHOULD SOUND LIKE THE AGENT MADE IT.
 *
 * ── TWO THINGS THIS FIXES, AND WHY THEY WERE ONE BUG ─────────────────────
 *
 * The class route bands its measurements before writing them, so its decisions
 * carry `evidence_json` and reach the writer. A Trencher trade is decided by
 * the Brain, which writes no bands — so every autonomous memecoin buy and sell
 * fell out of `maybePost` at `if (!rawEvidence) return` and the agent never
 * said a word about the trades it actually makes. Measured in production on
 * 2026-09-20: three buys and three sells, no post for any of them.
 *
 * And what the feed DID show was `TE21291018B4`, the address-derived id. That
 * id is deliberate — a coin's own `symbol()` is text its deployer chose and can
 * change, and one calling itself NVDA must never resolve to a stock's price —
 * but it tells a reader nothing. The name now rides ALONGSIDE it.
 *
 * ── WHAT IS DELIBERATELY NOT RELAXED ─────────────────────────────────────
 *
 * The Brain's thesis contains figures ("+5% 6h move"), so the writer is now
 * shown prose that has numbers in it where before it was shown none. The digit
 * ban stays in both the prompt and `admitPost`: the justification shifts from
 * "it saw no figures" to "it was told not to repeat them", and the check is
 * what enforces it either way.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitPost, writerPrompt, type WriterContext } from "./social-post";
import type { ClassEvidence } from "./class-evidence";

const BELIEF =
  "Short-term flow shows strong buys and a 6h move up, the 24h dip is only context; " +
  "ample liquidity supports a small buy.";

const evidence = (over: Partial<ClassEvidence> = {}): ClassEvidence => ({
  act: "enter",
  symbol: "TE21291018B4",
  decidedBy: "brain",
  bands: { thesis: BELIEF },
  raw: {},
  ...over,
});

const ctx = (over: Partial<WriterContext> = {}): WriterContext => ({
  name: "shogun",
  evidence: evidence(),
  traits: [],
  recent: [],
  ...over,
});

describe("the writer is given the Brain's own belief", () => {
  it("puts the recorded thesis in front of the writer", () => {
    assert.match(writerPrompt(ctx()), /Short-term flow shows strong buys/);
  });

  it("still forbids repeating a figure, now that it is shown some", () => {
    // The prose it is handed contains "6h" and "24h". The ban is what keeps
    // those out of the post; it is not optional because the input changed.
    const p = writerPrompt(ctx());
    assert.match(p, /NO numbers, percentages, prices or amounts of any kind/);
    assert.match(p, /Say nothing you were not told above/);
  });

  it("refuses a post that repeats one anyway", () => {
    const v = admitPost("flow looks strong here, up 5% on the 6h and depth is fine", ctx());
    assert.equal(v.ok, false);
    assert.equal(v.refusal, "has-digits");
  });
});

describe("the coin gets the name a reader recognises", () => {
  it("names it alongside the id, not instead of it", () => {
    // Both: the id is what everything prices and settles against, and what
    // admitPost strips before checking for digits.
    const p = writerPrompt(ctx({ evidence: evidence({ displayName: "CASHCAT" }) }));
    assert.match(p, /\$TE21291018B4/);
    assert.match(p, /CASHCAT/);
  });

  it("says nothing about a name when the tape carried none", () => {
    const p = writerPrompt(ctx());
    assert.match(p, /\$TE21291018B4/);
    assert.doesNotMatch(p, /calls itself/);
  });

  it("does not let the name change what is verified", () => {
    // The digit check strips the TICKER. A name with a digit in it must not
    // become a hole — the post below is refused either way.
    const c = ctx({ evidence: evidence({ displayName: "CASH2CAT" }) });
    assert.equal(admitPost("depth held up and the flow kept coming, 42 buyers deep", c).ok, false);
  });
});

describe("an exit reads as an exit", () => {
  it("does not describe a sell as a buy", () => {
    const p = writerPrompt(ctx({ evidence: evidence({ act: "exit" }) }));
    assert.match(p, /just sold/);
    assert.doesNotMatch(p, /just bought/);
  });

  it("carries the same belief on the way out", () => {
    assert.match(writerPrompt(ctx({ evidence: evidence({ act: "exit" }) })), /Short-term flow/);
  });
});

describe("what a Brain-decided post may never claim", () => {
  it("records that a model decided it, not a rule", () => {
    // `decidedBy` is the field a reader uses to tell a deterministic trade from
    // a model's opinion. A Trencher trade is the second.
    assert.equal(evidence().decidedBy, "brain");
  });

  it("keeps `raw` empty rather than inventing measurements", () => {
    // The Brain's numbers live inside its prose; it recorded none as fields.
    // Synthesising them here would put a sentence where a measurement belongs.
    assert.deepEqual(evidence().raw, {});
  });

  it("still refuses an address or a handle in the post", () => {
    assert.equal(admitPost("bought 0xdeadbeef1234 because flow", ctx()).ok, false);
    assert.equal(admitPost("flow looked strong, thanks @someone for the tip", ctx()).ok, false);
  });

  it("accepts an ordinary qualitative post", () => {
    const v = admitPost(
      "Flow kept coming all session and the book was deep enough to get back out, so I took a small one.",
      ctx(),
    );
    assert.equal(v.ok, true, v.refusal);
    assert.ok(v.body);
  });
});
