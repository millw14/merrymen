/**
 * WHY SHOGUN ONLY EVER HELD ONE COIN AT A TIME.
 *
 * Measured on the live fleet 2026-09-21: every 30s review went to
 * TE21291018B4, the one memecoin it held, for the whole window. No entry
 * candidate was ever the subject, so trades ran strictly serially — enter,
 * hold up to the 30-minute cap, exit, enter — and the gap between trades was
 * the HOLD DURATION, not the review interval. That is what "time between
 * trades feels slow" actually was.
 *
 * The cause is the branch above: a held position won outright, on the
 * reasoning that "an existing exposure is a live risk and a hypothetical
 * opening is not". That reasoning is sound wherever the Brain is what closes a
 * position. On the Trencher rail it is not: trencher.ts runs "exits first,
 * always" off the trading tick, `shouldExit` is mechanical (price, liquidity,
 * elapsed time), and the Brain is consulted only as an ADDITIONAL exit
 * trigger — `!verdict.exit && brain?.side !== "sell"` — never as a
 * requirement. Skipping a held position's review therefore cannot delay a
 * stop, a take-profit, a drain exit or the max-hold exit.
 *
 * Nor does this let the desk spend more. The vault caps 5 USDG per buy and
 * 25 USDG per 24h ON CHAIN (contracts/trencher-deployment.json), so the daily
 * spend is identical either way; only the overlap changes.
 *
 * THE GUARANTEE THAT MAKES IT SAFE: a held position may never go longer than
 * `maxGapMs` without being reviewed. Overdue always wins, and so does a
 * position that has never been reviewed at all — absent is not recent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseFocus, type HeldPosition, type QuotedPrice } from "./brain-focus";

const MINUTE = 60_000;
const NOW = 1_789_000_000_000;

const position = (symbol: string, valueUsdg: number): HeldPosition => ({
  symbol,
  token: `0x${symbol.toLowerCase().padEnd(40, "0")}`,
  valueUsdg,
  price8: 1_000_000n,
  priceStale: false,
  priceSource: "pool",
});

const quote = (over: Partial<QuotedPrice> = {}): QuotedPrice => ({
  price8: 1_000_000n,
  stale: false,
  source: "pool",
  ...over,
});

/** A book holding MEME, with CAND available to enter. */
const book = (alternate?: Parameters<typeof chooseFocus>[0]["alternate"]) =>
  chooseFocus({
    agentId: "0xagent",
    positions: [position("MEME", 5_000_000)],
    universe: [{ symbol: "CAND", address: `0x${"c".repeat(40)}` }],
    prices: new Map([
      ["MEME", quote()],
      ["CAND", quote()],
    ]),
    paused: new Set(),
    alternate,
  });

const recently = (ms = NOW - MINUTE) =>
  ({ lastReviewedAtMs: new Map([["MEME", ms]]), nowMs: NOW, maxGapMs: 5 * MINUTE });

describe("every other rail is untouched", () => {
  it("still gives a held position the focus outright", () => {
    // No `alternate` means the old behaviour exactly. The Brain-live and class
    // rails call this the same way they always have, and for them the original
    // reasoning still holds.
    const focus = book();
    assert.equal(focus?.symbol, "MEME");
    assert.equal(focus?.held, true);
  });
});

describe("the Trencher rail can look at an entry while it holds", () => {
  it("gives the slot to the candidate when the position is current", () => {
    const focus = book(recently());
    assert.equal(focus?.symbol, "CAND", "an entry must be reachable while holding");
    assert.equal(focus?.held, false);
    assert.equal(focus?.heldUsdg, 0);
  });

  it("still reviews the position when nothing is worth entering", () => {
    // No candidate is not a reason to review nothing. This is the branch that
    // would otherwise return null and skip the tick entirely.
    const focus = chooseFocus({
      agentId: "0xagent",
      positions: [position("MEME", 5_000_000)],
      universe: [],
      prices: new Map([["MEME", quote()]]),
      paused: new Set(),
      alternate: recently(),
    });
    assert.equal(focus?.symbol, "MEME");
    assert.equal(focus?.held, true);
  });

  it("still reviews the position when the only candidate is unpriceable", () => {
    const focus = chooseFocus({
      agentId: "0xagent",
      positions: [position("MEME", 5_000_000)],
      universe: [{ symbol: "CAND", address: `0x${"c".repeat(40)}` }],
      // A curve quote may value a holding and may not authorise an opening.
      prices: new Map([["MEME", quote()], ["CAND", quote({ source: "curve" })]]),
      paused: new Set(),
      alternate: recently(),
    });
    assert.equal(focus?.symbol, "MEME");
  });
});

describe("a held position is never left unreviewed", () => {
  it("reclaims the slot once it is overdue", () => {
    const focus = book(recently(NOW - 5 * MINUTE));
    assert.equal(focus?.symbol, "MEME", "an overdue position outranks any candidate");
    assert.equal(focus?.held, true);
  });

  it("reclaims it well past the gap too", () => {
    assert.equal(book(recently(NOW - 60 * MINUTE))?.symbol, "MEME");
  });

  it("treats never-reviewed as overdue, not as recent", () => {
    // ABSENT IS NOT RECENT. A position opened this tick has no entry in the
    // map, and reading that as "reviewed just now" would let a brand new
    // exposure go unexamined for the whole gap.
    const focus = book({ lastReviewedAtMs: new Map(), nowMs: NOW, maxGapMs: 5 * MINUTE });
    assert.equal(focus?.symbol, "MEME");
  });

  it("measures the gap against the position that would be skipped", () => {
    // Two positions, and the one whose review is overdue is not the biggest.
    // The focus rule picks the biggest, so a stale entry for a smaller one
    // must not hold the slot hostage — nor may the biggest be starved.
    const focus = chooseFocus({
      agentId: "0xagent",
      positions: [position("BIG", 9_000_000), position("SMALL", 1_000_000)],
      universe: [{ symbol: "CAND", address: `0x${"c".repeat(40)}` }],
      prices: new Map([["BIG", quote()], ["SMALL", quote()], ["CAND", quote()]]),
      paused: new Set(),
      alternate: { lastReviewedAtMs: new Map([["SMALL", NOW - MINUTE]]), nowMs: NOW, maxGapMs: 5 * MINUTE },
    });
    assert.equal(focus?.symbol, "BIG", "BIG has never been reviewed, so it is overdue");
  });

  it("reviews the OVERDUE holding, not the biggest one", () => {
    // The rule outside the alternation picks the biggest. Reusing it here
    // would let an overdue small position block entries (it is due) while the
    // slot went to the big one (it is first) — so the holding the gap exists
    // to protect would never actually be reviewed and the alternation would
    // stall for good.
    const focus = chooseFocus({
      agentId: "0xagent",
      positions: [position("BIG", 9_000_000), position("SMALL", 1_000_000)],
      universe: [{ symbol: "CAND", address: `0x${"c".repeat(40)}` }],
      prices: new Map([["BIG", quote()], ["SMALL", quote()], ["CAND", quote()]]),
      paused: new Set(),
      alternate: {
        lastReviewedAtMs: new Map([["BIG", NOW - MINUTE], ["SMALL", NOW - 30 * MINUTE]]),
        nowMs: NOW,
        maxGapMs: 5 * MINUTE,
      },
    });
    assert.equal(focus?.symbol, "SMALL", "the longest unreviewed takes the slot");
  });

  it("picks the longest unreviewed when several are overdue at once", () => {
    // With only one overdue holding the comparator never runs, so the ordering
    // it encodes has to be pinned against a field of them. Oldest first is what
    // stops the queue inverting into "whoever was just looked at, again".
    const focus = chooseFocus({
      agentId: "0xagent",
      positions: [position("BIG", 9_000_000), position("MID", 5_000_000), position("SMALL", 1_000_000)],
      universe: [{ symbol: "CAND", address: `0x${"c".repeat(40)}` }],
      prices: new Map([
        ["BIG", quote()],
        ["MID", quote()],
        ["SMALL", quote()],
        ["CAND", quote()],
      ]),
      paused: new Set(),
      alternate: {
        lastReviewedAtMs: new Map([
          ["BIG", NOW - 10 * MINUTE],
          ["MID", NOW - 40 * MINUTE],
          ["SMALL", NOW - 20 * MINUTE],
        ]),
        nowMs: NOW,
        maxGapMs: 5 * MINUTE,
      },
    });
    assert.equal(focus?.symbol, "MID", "40 minutes unreviewed outranks 20 and 10");
  });

  it("is deterministic when two overdue holdings are equally stale", () => {
    // The tiebreak may not depend on the order positions happened to arrive in,
    // or two otherwise identical ticks would ask different questions.
    const args = (order: readonly HeldPosition[]) =>
      chooseFocus({
        agentId: "0xagent",
        positions: order,
        universe: [],
        prices: new Map([["AAA", quote()], ["ZZZ", quote()]]),
        paused: new Set(),
        alternate: {
          lastReviewedAtMs: new Map([["AAA", NOW - 9 * MINUTE], ["ZZZ", NOW - 9 * MINUTE]]),
          nowMs: NOW,
          maxGapMs: 5 * MINUTE,
        },
      });
    const a = position("AAA", 4_000_000);
    const z = position("ZZZ", 4_000_000);
    assert.equal(args([a, z])?.symbol, args([z, a])?.symbol);
  });

  it("hands the slot back and forth rather than sticking", () => {
    // The property the whole change exists for: across a run of reviews both
    // the position and the entry candidate get looked at.
    const seen: string[] = [];
    let lastHeld = NOW - 10 * MINUTE;
    for (let i = 0; i < 12; i++) {
      const nowMs = NOW + i * 30_000;
      const focus = chooseFocus({
        agentId: "0xagent",
        positions: [position("MEME", 5_000_000)],
        universe: [{ symbol: "CAND", address: `0x${"c".repeat(40)}` }],
        prices: new Map([["MEME", quote()], ["CAND", quote()]]),
        paused: new Set(),
        alternate: { lastReviewedAtMs: new Map([["MEME", lastHeld]]), nowMs, maxGapMs: 5 * MINUTE },
      });
      seen.push(focus!.symbol);
      if (focus!.held) lastHeld = nowMs;
    }
    assert.ok(seen.includes("CAND"), `entries must get slots: ${seen.join(",")}`);
    assert.ok(seen.includes("MEME"), `the position must get slots: ${seen.join(",")}`);
    // Six minutes of 30s reviews with a five-minute floor: the position is due
    // at the start and again five minutes later.
    assert.equal(seen.filter((s) => s === "MEME").length, 2, seen.join(","));
  });
});
