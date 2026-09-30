/**
 * THE GATE BETWEEN A MODEL AND A PUBLIC FEED.
 *
 * Most of this file is an ATTACK SUITE. The design claim is that a writer shown
 * no figures cannot publish one, and a claim like that is worth only as much as
 * the attempts made to break it — so these are written as an adversary would:
 * digits hidden in a ticker, quantities spelled out in words, a template with
 * the noun swapped, a post that quotes an address back.
 *
 * WHAT THE GATE DOES NOT DO, said here so nobody adds it later: it does not
 * check that every word came from the evidence. We asked for a human sentence,
 * so most words are the model's own and must be. What it checks is narrower and
 * far harder to argue with — nothing numeric, nothing that identifies a third
 * party, and nothing this agent has just said in the same shape.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  admitPost,
  POST_MAX,
  REPEAT_LIMIT,
  similarity,
  traitsOf,
  writerPrompt,
  type Disposition,
  type WriterContext,
} from "./social-post";
import type { ClassEvidence } from "./class-evidence";

const EVIDENCE: ClassEvidence = {
  act: "enter",
  symbol: "MOON",
  decidedBy: "rule",
  bands: {
    depth: "liquidity thin",
    curve: "curve early",
    activity: "activity picking up",
    breadth: "buyers mostly new",
    impact: "our size barely moves it",
  },
  raw: { usdg: 5, trades: 60, traders: 20, depthUsdg: 400, impactBps: 40, costBps: 120, graduationBps: 2000, field: 4 },
};

const ctx = (over: Partial<WriterContext> = {}): WriterContext => ({
  name: "Shogun",
  evidence: EVIDENCE,
  traits: ["moves early and does not wait around"],
  recent: [],
  ...over,
});

describe("a post may not carry a figure the agent was never given", () => {
  it("admits an ordinary human sentence", () => {
    const v = admitPost(
      // One line, inside the take's budget — see social-take.test.ts.
      "Buyers are finally sticking around instead of hitting it once; thin, so I kept it small.",
      ctx(),
    );
    assert.equal(v.ok, true, v.refusal);
  });

  it("refuses any digit", () => {
    assert.equal(admitPost("Buyers are up 32% on the hour, taking a position.", ctx()).refusal, "has-digits");
    assert.equal(admitPost("Depth is around 410 dollars, so keeping it small.", ctx()).refusal, "has-digits");
  });

  /**
   * THE ATTACK THIS DESIGN WAS REWRITTEN FOR.
   *
   * The ticker is substituted from evidence AFTER the model writes, and
   * `sanitizeSymbol` (discovery.ts) permits digits in a symbol — a launcher
   * chooses the string. So a check run on the model's raw output would pass a
   * post that ends up containing "100" once the ticker lands in it. The gate
   * strips the ticker and checks what remains, so the launcher cannot smuggle a
   * figure into an agent's mouth by naming their token.
   */
  it("is not fooled by digits that are part of an attacker-chosen ticker", () => {
    const moon100x: ClassEvidence = { ...EVIDENCE, symbol: "MOON100X" };
    const c = ctx({ evidence: moon100x });
    const good = admitPost("Buyers are sticking around on MOON100X, so I took a small position.", c);
    assert.equal(good.ok, true, `a legitimate post naming the token must survive (${good.refusal})`);

    const bad = admitPost("MOON100X is up 40 since I looked.", c);
    assert.equal(bad.refusal, "has-digits", "a real figure beside the ticker must still be caught");
  });

  it("refuses a quantity spelled out in words", () => {
    // "forty buyers" carries the same claim "40 buyers" does, and a digit check
    // alone would wave it through.
    assert.equal(admitPost("Forty buyers through it in the last stretch, that is enough for me.", ctx()).refusal, "unvouched-claim");
    assert.equal(admitPost("Liquidity is thin but the buyers are up twenty percent.", ctx()).refusal, "unvouched-claim");
  });

  it("refuses an address or a handle", () => {
    assert.equal(admitPost("Following 0xdeadbeefcafe into this one, looks early.", ctx()).refusal, "has-address");
    assert.equal(admitPost("Taking this after @someone flagged it, buyers look real.", ctx()).refusal, "has-handle");
    assert.equal(admitPost("More on this at https://example.com, liquidity is thin.", ctx()).refusal, "has-handle");
  });
});

describe("not posting is a normal outcome", () => {
  it("treats an explicit PASS as a refusal, not as content", () => {
    assert.equal(admitPost("PASS", ctx()).refusal, "passed");
    assert.equal(admitPost("  pass  ", ctx()).refusal, "passed");
  });

  it("refuses an empty or one-word answer rather than publishing it", () => {
    assert.equal(admitPost("", ctx()).refusal, "empty");
    assert.equal(admitPost("Interesting.", ctx()).refusal, "too-short");
    assert.equal(admitPost("Thin. Early.", ctx()).refusal, "too-short", "two words is not a view");
    // AND A GENUINELY SHORT POST IS ADMITTED, which is the other half of the
    // brief: sometimes one sentence is enough, and a floor set where it feels
    // safe would quietly turn "vary the length" into "always write three lines".
    assert.equal(
      admitPost("Thin, but early enough that I will wear it.", ctx()).ok,
      true,
      "one sentence must be allowed to be the whole post",
    );
  });

  it("refuses an overlong one rather than cutting it mid-word", () => {
    assert.equal(admitPost("a".repeat(POST_MAX + 1), ctx()).refusal, "too-long");
  });
});

describe("an agent must not repeat itself", () => {
  /**
   * THE FAILURE THIS EXISTS FOR, measured from the live feed: one agent
   * produced 27 of 40 posts, every one of them the same sentence with a
   * different ticker and figure in it. The feed's own GROUP BY collapses
   * byte-identical prose, so exact-match dedup already existed and was useless
   * against exactly that.
   */
  it("catches a template with the noun swapped", () => {
    const first = "Buyers are sticking around on this one instead of hitting it once, so I took a small position.";
    const second = "Buyers are sticking around on that one instead of hitting it once, so I took a small position.";
    assert.ok(similarity(first, second) >= REPEAT_LIMIT);
    assert.equal(admitPost(second, ctx({ recent: [first] })).refusal, "repeats-itself");
  });

  it("allows two genuinely different posts about the same kind of trade", () => {
    // They will share vocabulary — they are about the same thing — and that
    // must not be enough to refuse, or an agent can only ever say one thing
    // about launches.
    const first = "Buyers are sticking around instead of hitting it once and leaving, so I am in small.";
    const second = "Thin, but the curve is early enough that I will wear the risk on a small clip.";
    assert.ok(similarity(first, second) < REPEAT_LIMIT, `too similar: ${similarity(first, second)}`);
    assert.equal(admitPost(second, ctx({ recent: [first] })).ok, true);
  });

  it("ignores punctuation and case when judging repetition", () => {
    const first = "Buyers finally sticking around here, liquidity thin, keeping the clip small.";
    const second = "BUYERS FINALLY STICKING AROUND HERE — liquidity thin! Keeping the clip small.";
    assert.equal(admitPost(second, ctx({ recent: [first] })).refusal, "repeats-itself");
  });
});

describe("the prompt hands over words, never measurements", () => {
  it("contains no digit from the evidence", () => {
    const p = writerPrompt(ctx());
    // The raw figures are on the evidence object and must not reach the model.
    // POST_MAX appears as a length instruction, so the assertion is scoped to
    // the part of the prompt that describes the market.
    const observed = p.slice(p.indexOf("This is what you observed"), p.indexOf("Rules:"));
    assert.ok(!/\d/.test(observed), `the observation block must be figure-free:\n${observed}`);
  });

  it("carries every band it was given", () => {
    const p = writerPrompt(ctx());
    for (const band of Object.values(EVIDENCE.bands)) assert.ok(p.includes(band), `missing band: ${band}`);
  });

  it("says nothing about a band that was absent", () => {
    // The null rule, one layer further out: no activity evidence means the
    // prompt contains no activity claim for the model to lean on.
    const quiet: ClassEvidence = { ...EVIDENCE, bands: { depth: "liquidity thin", curve: "curve early" } };
    const p = writerPrompt(ctx({ evidence: quiet }));
    assert.ok(!/buyers|activity/i.test(p.slice(p.indexOf("This is what"), p.indexOf("Rules:"))));
  });

  it("offers no example post to copy", () => {
    // An example in the prompt IS the template. The whole failure being fixed is
    // twenty posts with one skeleton.
    const p = writerPrompt(ctx());
    assert.ok(!/^["'].*["']$/m.test(p.slice(0, p.indexOf("You recently posted"))));
  });
});

describe("voice comes from what an owner actually chose", () => {
  const DEFAULTS: Disposition = {
    maxHoldSec: 21600,
    exitAtGraduationPct: 85,
    perEntryUsdg: 5,
    maxImpactBps: 300,
    minDepthUsdg: 100,
  };

  it("reads a short hold as someone who moves early", () => {
    const t = traitsOf({ ...DEFAULTS, maxHoldSec: 1800 }, DEFAULTS);
    assert.ok(t.some((x) => /early/.test(x)));
  });

  it("reads a high depth floor as someone who wants liquidity first", () => {
    const t = traitsOf({ ...DEFAULTS, minDepthUsdg: 400 }, DEFAULTS);
    assert.ok(t.some((x) => /liquidity/.test(x)));
  });

  /**
   * THE HONEST CASE, asserted rather than hidden.
   *
   * Two agents configured identically HAVE no different disposition, and this
   * must yield the same traits. Shogun and SirSendIt are byte-identical today,
   * so nothing here can make them sound different — and manufacturing a
   * difference would be inventing a fact about an agent, which is the one thing
   * this whole feature may not do. What separates them is their own history.
   */
  it("gives identically configured agents identical traits", () => {
    assert.deepEqual(traitsOf(DEFAULTS, DEFAULTS), traitsOf(DEFAULTS, DEFAULTS));
    assert.deepEqual(traitsOf(DEFAULTS, DEFAULTS), [], "a default agent has no distinguishing trait to claim");
  });

  it("is relative to the defaults, not to absolute numbers", () => {
    // The same hold window is "early" against one default and unremarkable
    // against another. Absolute edges here would be a second set of trading
    // opinions nobody agreed to.
    const d: Disposition = { ...DEFAULTS, maxHoldSec: 3600 };
    assert.ok(traitsOf(d, DEFAULTS).some((x) => /early/.test(x)));
    assert.deepEqual(traitsOf(d, { ...DEFAULTS, maxHoldSec: 3600 }), []);
  });
});
