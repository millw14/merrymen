/**
 * THE FUNNEL EXISTS SO A QUIET AGENT CAN BE DIAGNOSED IN SECONDS.
 *
 * Two audiences, two registers, and the tests keep them apart: the operator
 * gets counts, the owner gets a sentence. The brief is explicit that a slug —
 * `no-exit`, `wrong-chain`, `live-not-enabled` — must never be the owner's
 * primary explanation, so the last block here pins that no internal vocabulary
 * can reach their screen at all.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { byKind, emptyFunnel, funnelLine, idleSentence, type ScanFunnel } from "./funnel";

const f = (over: Partial<ScanFunnel> = {}): ScanFunnel => ({ ...emptyFunnel("pons"), ...over });

describe("a stage that did not run is not a stage that found nothing", () => {
  it("renders an un-run stage as — and never as 0", () => {
    const line = funnelLine(f({ discovered: 126, verified: 0 }));
    assert.match(line, /discovered 126/);
    assert.match(line, /verified 0/);
    // quoted/eligible/policy/simulated never ran: nothing survived verification.
    assert.match(line, /quoted —/);
    assert.match(line, /eligible —/);
    assert.doesNotMatch(line, /quoted 0/, "0 would claim quoting ran and found nothing");
  });

  it("and a stage that ran and found nothing says 0", () => {
    const line = funnelLine(f({ discovered: 126, verified: 4, quoted: 4, eligible: 0 }));
    assert.match(line, /eligible 0/);
  });
});

describe("refusals group by cause, most common first", () => {
  it("counts them", () => {
    const out = byKind(
      f({
        refusals: [
          { symbol: "A", reason: "x", kind: "depth" },
          { symbol: "B", reason: "y", kind: "depth" },
          { symbol: "C", reason: "z", kind: "impact" },
        ],
      }),
    );
    assert.deepEqual(out, [
      { kind: "depth", count: 2 },
      { kind: "impact", count: 1 },
    ]);
  });
});

describe("the owner's sentence", () => {
  it("says nothing at all when the agent actually traded", () => {
    // There is nothing to explain about an agent that just bought something,
    // and inventing a line there is how a feed narrates its own silence.
    assert.equal(idleSentence(f({ discovered: 10, buys: 1 }), { holding: 0 }), null);
    assert.equal(idleSentence(f({ discovered: 10, sells: 1 }), { holding: 1 }), null);
  });

  it("names the DOMINANT cause, with the brief's own phrasing", () => {
    const s = idleSentence(
      f({
        discovered: 126,
        verified: 0,
        refusals: [
          { symbol: "A", reason: "x", kind: "depth" },
          { symbol: "B", reason: "y", kind: "depth" },
          { symbol: "C", reason: "z", kind: "impact" },
        ],
      }),
      { holding: 0 },
    );
    assert.match(s!, /126 tokens/);
    assert.match(s!, /enough real liquidity/);
    assert.doesNotMatch(s!, /cost too much/, "the tail is not worth a clause");
  });

  it("distinguishes 'found some but could not trade' from 'found none'", () => {
    const s = idleSentence(f({ discovered: 40, verified: 6, quoted: 6, eligible: 4, buys: 0 }), { holding: 0 });
    assert.match(s!, /4 candidates/);
    assert.match(s!, /did not pass your limits/);
  });

  it("mentions what is held, because a holder is not idle", () => {
    const s = idleSentence(f({ discovered: 40, verified: 0 }), { holding: 2 });
    assert.match(s!, /Holding 2 positions/);
  });

  it("and says so plainly when the venue has simply shown nothing yet", () => {
    const s = idleSentence(f({ discovered: 0 }), { holding: 0 });
    assert.match(s!, /no new tokens/);
  });
});

describe("NO SLUG MAY REACH THE OWNER", () => {
  it("no owner sentence contains internal vocabulary, for any funnel shape", () => {
    /**
     * A generic guard rather than a list of three strings: the point is that
     * this register never carries a code, not that these particular codes are
     * absent. A rule added next year lands here without anyone remembering to.
     */
    const FORBIDDEN =
      /no-exit|wrong-chain|gas-absurd|live-not-enabled|dead-policy|grant-too-wide|scout-budget|asset-allowlist|per-trade-cap|[a-z]+-[a-z]+-[a-z]+/;

    const shapes: ScanFunnel[] = [
      f({ discovered: 0 }),
      f({ discovered: 126, verified: 0, refusals: [{ symbol: "A", reason: "x", kind: "depth" }] }),
      f({ discovered: 126, verified: 3, quoted: 3, eligible: 0, refusals: [{ symbol: "A", reason: "x", kind: "impact" }] }),
      f({ discovered: 126, verified: 3, quoted: 3, eligible: 2 }),
      f({ discovered: 5, verified: 1, refusals: [{ symbol: "A", reason: "x", kind: "graduation" }] }),
      f({ discovered: 5, verified: 1, refusals: [{ symbol: "A", reason: "x", kind: "age" }] }),
      f({ discovered: 5, verified: 1, refusals: [{ symbol: "A", reason: "x", kind: "activity" }] }),
      f({ discovered: 5, verified: 1, refusals: [{ symbol: "A", reason: "x", kind: "unpriceable" }] }),
      f({ discovered: 5, verified: 1, refusals: [{ symbol: "A", reason: "x", kind: "venue" }] }),
    ];

    for (const shape of shapes) {
      for (const holding of [0, 1, 3]) {
        const s = idleSentence(shape, { holding });
        if (s === null) continue;
        assert.doesNotMatch(s, FORBIDDEN, `owner sentence leaked internal vocabulary: ${s}`);
        // An ellipsis counts: "Scanning 126 Pons tokens…" is the brief's own
        // example of the ongoing case, and it is the right punctuation for a
        // thing that has not finished happening.
        assert.match(s, /[.!…]$/, `owner sentence must be a sentence: ${s}`);
      }
    }
  });

  it("but the operator line keeps every count, because that register is for triage", () => {
    const line = funnelLine(
      f({ discovered: 126, verified: 3, quoted: 3, eligible: 0, refusals: [{ symbol: "A", reason: "x", kind: "depth" }] }),
    );
    assert.match(line, /\[funnel:pons\]/);
    assert.match(line, /refused: depth 1/);
  });
});
