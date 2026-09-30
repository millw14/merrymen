/**
 * EVERY READER OF `hold_kind` KNOWS ABOUT THE STALE MARK.
 *
 * `STALE_MARK_HOLD` was added where the decision is written, and the two
 * places that read the kind back were left as they were. So a hold made
 * against a stale price, which had counted as a model hold, dropped out of the
 * fleet's one-hour autonomy line: the line summed model, gate-forced and
 * unreported, and a fleet holding on dead feeds read as holding less. And the
 * quiet-review clock asked the publication gate with the Brain's RAW kind, so a
 * hold that is now kept private still counted as a published view and pushed
 * the review back, leaving the feed with nothing from that agent at all.
 *
 * Both are run here: the clause the autonomy line prints, and the question the
 * worker asks before it defers the review.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishesAView } from "./brain-shadow";
import { autonomyHolds } from "./orchestrator";

describe("the autonomy line counts every hold", () => {
  it("a stale-mark hold has its own bucket", () => {
    const line = autonomyHolds([
      { kind: "MODEL_HOLD", n: 3 },
      { kind: "GATE_FORCED_HOLD", n: "1" },
      { kind: "STALE_MARK_HOLD", n: 2 },
      { kind: "unreported", n: 4 },
    ]);
    assert.match(line, /\b2 stale-mark\b/);
    assert.match(line, /\b3 model\b/);
    assert.match(line, /\b1 gate-forced\b/);
    assert.match(line, /\b4 unreported\b/);
  });

  it("the buckets add up to every hold that was read, including a kind nobody has named yet", () => {
    // Counted from the query, not from a list of kinds this file happens to
    // know. A kind added at the writer tomorrow is printed under its own name
    // rather than vanishing, which is exactly how the stale mark vanished.
    const rows = [
      { kind: "MODEL_HOLD", n: 3 },
      { kind: "STALE_MARK_HOLD", n: 2 },
      { kind: "SOME_NEW_HOLD", n: 5 },
    ];
    const line = autonomyHolds(rows);
    const printed = [...line.matchAll(/(\d+) [\w-]+/g)].reduce((s, m) => s + Number(m[1]), 0);
    assert.equal(printed, 10);
    assert.match(line, /\b5 SOME_NEW_HOLD\b/);
  });

  it("a kind that was not read is a measured zero, printed as zero", () => {
    // The query ran and found none: that is a count, and "0 stale-mark" is
    // the true sentence. (A query that FAILED prints no line at all.)
    assert.match(autonomyHolds([{ kind: "MODEL_HOLD", n: 1 }]), /\b0 stale-mark\b/);
  });
});

describe("only a hold that was published defers the quiet review", () => {
  const who = { name: "Shogun", source: "brain" };
  const hold = (hold_kind: string | null) => ({
    action: "hold",
    symbol: "TSLA",
    thesis: "Price feed stale, no volume to read; holding until the tape returns.",
    hold_kind,
  });

  it("a model hold on a STALE mark is private, so the review is not pushed back", () => {
    // The Brain reports MODEL_HOLD; the ledger records STALE_MARK_HOLD because
    // the mark was stale. The clock must ask about what was recorded.
    assert.equal(publishesAView(hold("MODEL_HOLD"), who, { priceStale: true }), false);
    assert.equal(publishesAView(hold(null), who, { priceStale: true }), false);
  });

  it("the same hold on a fresh mark is a view, and does push it back", () => {
    assert.equal(publishesAView(hold("MODEL_HOLD"), who, { priceStale: false }), true);
  });

  it("a gate-forced hold is private whatever the mark", () => {
    assert.equal(publishesAView(hold("GATE_FORCED_HOLD"), who, { priceStale: false }), false);
  });
});
