/**
 * AN AGENT SPEAKS IN ONE LINE — A TAKE, NOT A REPORT.
 *
 * Wave 2 makes the agent's own post the primary line of a feed row, with our
 * deterministic sentence behind it as the "why". A primary line that runs to
 * three sentences is a paragraph, and the writer asked for exactly that: "one
 * sentence is often the whole post, two or three if you have more to say",
 * under the 220-character ceiling every surface shares.
 *
 * So the writer is now asked for one line under TAKE_MAX characters, and — the
 * module's own rule, "a prompt instruction is not enforcement" — the gate
 * refuses anything longer or anything on two lines. Refused, never cut: a post
 * that fails costs the agent its voice on that trade, and the trade still
 * publishes with our words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitPost, POST_MAX, TAKE_MAX, writerPrompt, type WriterContext } from "./social-post";
import type { ClassEvidence } from "./class-evidence";

const EVIDENCE: ClassEvidence = {
  act: "enter",
  symbol: "MOON",
  decidedBy: "rule",
  bands: { depth: "liquidity thin", breadth: "buyers mostly new" },
  raw: {},
};
const ctx = (over: Partial<WriterContext> = {}): WriterContext => ({
  name: "Shogun",
  evidence: EVIDENCE,
  traits: [],
  recent: [],
  ...over,
});

describe("the writer is asked for one line", () => {
  it("states the one-line budget it will be held to", () => {
    const p = writerPrompt(ctx());
    assert.match(p, new RegExp(`ONE line, under ${TAKE_MAX} characters`));
    assert.doesNotMatch(p, new RegExp(`Under ${POST_MAX} characters`), "not the old paragraph ceiling");
  });

  it("asks for a take, and never for a second or third sentence", () => {
    const p = writerPrompt(ctx());
    assert.match(p, /a take, not a report/i);
    assert.doesNotMatch(p, /two or three/i);
  });

  it("the budget is tighter than the ceiling every surface shares", () => {
    assert.equal(TAKE_MAX, 100);
    assert.ok(TAKE_MAX < POST_MAX);
  });
});

describe("the gate holds it to one line", () => {
  it("ADMITS a one-liner inside the budget", () => {
    const v = admitPost("Buyers are sticking around instead of flipping it, so I am in small.", ctx());
    assert.equal(v.ok, true, v.refusal);
  });

  it("admits a line exactly at the budget", () => {
    const at = "Buyers keep sticking around instead of flipping it, and that is the whole reason I am in small here.";
    assert.equal(at.length, TAKE_MAX, "the fixture sits exactly at the budget");
    assert.equal(admitPost(at, ctx()).ok, true);
  });

  it("REFUSES a line one character over the budget — refused, never cut", () => {
    const over = "Buyers keep sticking around instead of flipping it, and that is really the reason I am in small here.";
    assert.equal(over.length, TAKE_MAX + 1, "the fixture sits exactly one over");
    const v = admitPost(over, ctx());
    assert.equal(v.ok, false);
    assert.equal(v.refusal, "too-long");
    assert.equal(v.body, undefined, "nothing is published in its place");
  });

  it("REFUSES two lines, however short", () => {
    const v = admitPost("Buyers are sticking around.\nThin, so I kept it small.", ctx());
    assert.equal(v.ok, false);
    assert.equal(v.refusal, "not-one-line");
  });

  it("but a trailing newline from the model is not a second line", () => {
    const v = admitPost("Buyers are sticking around instead of flipping it, so I am in small.\n", ctx());
    assert.equal(v.ok, true, v.refusal);
  });
});
