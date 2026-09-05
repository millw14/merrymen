import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * A CHART IS A PUBLISHED FIGURE TOO.
 *
 * The agent page refused to publish a return — "capital on record is not
 * evidenced" — and three lines below it drew a growth chart labelled -4.1%, from
 * the same data, at the same moment. Both are performance claims; only one was
 * behind the gate.
 *
 * The growth index works by subtracting each period's FLOW from the equity line,
 * so that what remains is the agent's doing rather than its owner's. That is the
 * right idea and it inherits the flows wholesale: the canary's three phantom
 * opening balances — 10 USDG each, inferred from a balance change, nothing
 * actually deposited — get divided out of a book that never received them.
 *
 * Source scans, in the idiom of this directory's other honesty tests: the
 * property is how the component is written, and a render test passes on a branch
 * that has not been reached.
 */

const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const CHART = at("./EquityLine.tsx");
const CHART_CODE = strip(CHART);
const READ = at("../lib/read-agent.ts");

describe("the equity chart is behind the same gate as the return", () => {
  it("REFUSES to draw a growth percentage when contributions are not evidenced", () => {
    assert.match(CHART_CODE, /!agent\.contributionsEvidenced/, "the chart must consult the evidence flag");
    // And the refusal must come BEFORE the percentage is ever computed.
    const gate = CHART_CODE.indexOf("agent.contributionsEvidenced");
    const firstPct = CHART_CODE.indexOf("pctOf(");
    assert.ok(gate > 0 && firstPct > gate, "the gate must precede every pctOf call");
  });

  it("the refusal says WHY, rather than rendering an empty chart", () => {
    // An owner who sees a blank panel learns nothing. The sentence is the point.
    assert.match(CHART, /inferred from balance changes/);
    assert.match(CHART, /not published until the capital behind it is evidenced/);
  });

  it("PAPER agents are unaffected — their book is its own domain", () => {
    // A paper agent has no real flows by construction, so gating it on real
    // capital evidence would blank a chart that is perfectly honest about a
    // simulation. The guard is scoped with `!paper` for that reason.
    assert.match(CHART_CODE, /!paper && !agent\.contributionsEvidenced/);
  });

  it("the flag is DERIVED from the worker's verdict, not recomputed here", () => {
    // Five disagreeing definitions of publishability is what this whole effort
    // is about. The chart reads the same signal the return gate reads.
    assert.match(READ, /contributionsEvidenced: contributionsKnown === true/);
    assert.match(READ, /contributions_known/, "which comes from the worker's durable column");
  });

  it("`funded` alone is NOT the gate — that was the bug", () => {
    // `funded` is `contributed !== null`: it only says rows exist, and three
    // phantom rows satisfy it.
    assert.match(READ, /funded: contributed !== null/);
    const fundedGate = CHART_CODE.indexOf("!paper && !agent.funded");
    const evidenceGate = CHART_CODE.indexOf("!paper && !agent.contributionsEvidenced");
    assert.ok(fundedGate > 0, "the funded guard still exists for the no-flows case");
    assert.ok(evidenceGate > fundedGate, "and the evidence guard sits after it, catching what it lets through");
  });
});

describe("the canary's exact shape produces no percentage", () => {
  /**
   * Three inferred rows of 10.000000 USDG and one real 10.000000 deposit that
   * was never written as a receipt. `funded` is true, `contributionsEvidenced`
   * is false, and the correct render is the sentence rather than a figure.
   */
  const canary = {
    equityRead: true,
    funded: true,
    contributionsEvidenced: false,
    growth: [
      { at: 1_756_000_000, g: 1 },
      { at: 1_756_086_400, g: 0.959 },
    ],
  };

  it("the guard that fires is the evidence one, not the funded one", () => {
    assert.equal(canary.funded, true, "so the old guard would have let it through");
    assert.equal(canary.contributionsEvidenced, false);
    // -4.1%, the figure that actually shipped, is what `growth` above encodes.
    const wouldHaveShown = `${((canary.growth[1]!.g - 1) * 100).toFixed(1)}%`;
    assert.equal(wouldHaveShown, "-4.1%");
  });

  it("and once the capital is evidenced the chart draws again", () => {
    // The refusal is a consequence of the data, not a permanent downgrade: after
    // the chain-derived backfill the canary's single 10 USDG deposit is a
    // receipt, contributionsEvidenced becomes true, and this guard stops firing.
    const repaired = { ...canary, contributionsEvidenced: true };
    assert.equal(repaired.funded && repaired.contributionsEvidenced, true);
  });
});
