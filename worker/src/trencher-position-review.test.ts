/**
 * A REVIEW MAY ONLY OFFER ACTIONS THE DESK CAN TAKE.
 *
 * Observed live on 2026-09-21. Shogun held TE21291018B4 — `positions 22.02
 * USDG (TSLA, TE21291018B4)` — and the Brain answered BUY for it, twice:
 *
 *     [brain] BUY TE21291018B4 conf=0.62 delta=5000000 · decision dec_3364290e
 *     [brain] BUY TE21291018B4 conf=0.65 delta=5000000 · decision dec_da3fddd9
 *
 * Nothing could come of either. trencher.ts:461 is `if
 * (heldSymbols.has(c.symbol)) continue` — Trencher v1 opens positions and
 * closes them, and has no path that adds to one. Cash sat at 18.636197 USDG
 * across both, and the position moved 22.021358 → 22.024515, which is the mark
 * drifting and not a fill. What the owner saw was the feed publishing
 *
 *     buy CASHCAT (TE21291018B4) 5.00 USDG — no trade came of it
 *
 * which reads as a broken execution path and was a prompt that asked the wrong
 * question.
 *
 * The entry branch already got this right: it says BUY or HOLD, and then closes
 * the door it cannot open — "A bearish view means HOLD, not SELL; short selling
 * is not supported." The position branch named holding and selling and never
 * said BUY was unavailable, so the model reasonably took it.
 *
 * THIS IS NOT A THRESHOLD CHANGE. Nothing here makes a BUY more or less likely
 * on a coin the desk can actually enter, and every legitimate HOLD survives —
 * it stops an un-executable action being decided, published and counted.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { TrenchBrainReview, trenchBrainPersona } from "./trencher-brain";
import type { ShadowInputs, ShadowOutcome } from "./brain-shadow";

const TOKEN = "0x0000000000000000000000000000000000000011" as const;
const AGENT = "0x0000000000000000000000000000000000000044";
const input = { agentId: AGENT, market: { instrumentId: "merrymen:meme", symbol: "MEME", priceUsd: "0.01" } } as ShadowInputs;
const answer = (over = {}) => ({ ran: true, result: { ok: true, decision: {
  decision_id: "decision-1", agent_id: AGENT, instrument_id: "merrymen:meme", symbol: "MEME", action: "buy", suggested_delta_usdg: 5e6, gate_verdict: "proceed", ...over,
} } }) as ShadowOutcome;

const entry = trenchBrainPersona("MEME", false);
const position = trenchBrainPersona("MEME", true);

describe("the position review closes the door it cannot open", () => {
  it("says a bullish view is a hold, not a buy", () => {
    assert.match(position, /bullish view means HOLD, not BUY/);
  });

  it("says plainly that adding to a position is unsupported", () => {
    // The REASON, not just the instruction. A rule with no reason is one the
    // next reader deletes, and this one is a property of the venue path.
    assert.match(position, /adding to an existing position is not supported/i);
  });

  it("still offers both of the actions that DO exist", () => {
    assert.match(position, /HOLD/);
    assert.match(position, /SELL/);
  });
});

describe("the two branches stay symmetric", () => {
  it("each names the unavailable action and refuses it by name", () => {
    // The entry branch has had this shape since it was written; the position
    // branch did not, and that asymmetry is the whole bug. Asserting both
    // together is what stops one side being edited without the other.
    assert.match(entry, /means HOLD, not SELL/);
    assert.match(position, /means HOLD, not BUY/);
  });

  it("each states which review it is", () => {
    assert.match(entry, /entry review/i);
    assert.match(position, /position review/i);
  });

  it("names the coin on both sides", () => {
    assert.match(entry, /MEME/);
    assert.match(position, /MEME/);
  });
});

describe("what must not have changed", () => {
  it("keeps short selling refused on an entry", () => {
    assert.match(entry, /short selling is not supported/i);
  });

  it("keeps the cap described as a ceiling, not a verdict on the coin", () => {
    // The owner's brief is explicit that the 5 USDG entry cap is a sizing
    // constraint and not evidence a token has no opportunity.
    assert.match(position, /sizing ceiling, not evidence of poor liquidity/);
    assert.match(entry, /sizing ceiling, not evidence of poor liquidity/);
  });

  it("keeps insufficient evidence resolving to hold", () => {
    assert.match(position, /Hold if evidence or net edge is insufficient/);
  });
});

/**
 * THE ORDER LAYER'S OWN GUARD.
 *
 * The persona above is the cause; this is the check that makes it countable
 * when a model ignores it anyway. It mirrors, exactly, the guard that has
 * always refused a SELL with no position — and the absence of this half is
 * what let a BUY on a held coin become an approved order, get taken, and then
 * vanish into `if (heldSymbols.has(c.symbol)) continue` with nothing logged.
 *
 * What is refused is the ORDER. The decision row still records what the model
 * actually said, because a record that quietly disagrees with the model is
 * worse than one that reports an order nobody filled.
 */
describe("a buy for a coin already held cannot become an order", () => {
  const held = {
    ...input,
    positions: [{ symbol: "MEME", qtyRaw: "1000" }],
  } as ShadowInputs;

  it("approves no order and says why", async () => {
    const review = new TrenchBrainReview();
    const notes: string[] = [];
    review.launch("live", held, TOKEN, async () => answer(), (n) => notes.push(n));
    await setImmediate();
    assert.equal(review.take("MEME", TOKEN, 1_000_000n, 5, true), null, "no order may be takeable");
    assert.match(notes.join(" "), /does not add to one/);
  });

  it("still approves a buy when nothing is held", async () => {
    // The guard must be about the POSITION, not about buys. A Trencher that
    // stopped entering would be a worse bug than the one being fixed.
    const review = new TrenchBrainReview();
    review.launch("live", input, TOKEN, async () => answer(), () => {});
    await setImmediate();
    assert.ok(review.take("MEME", TOKEN, 1_000_000n, 5), "an entry must still be approved");
  });

  it("still approves a sell of a position that IS held", async () => {
    const review = new TrenchBrainReview();
    review.launch("live", held, TOKEN, async () => answer({ action: "sell", suggested_delta_usdg: -5e6 }), () => {});
    await setImmediate();
    assert.ok(review.take("MEME", TOKEN, 1_000_000n, 5, true), "an exit must still be approved");
  });
});
