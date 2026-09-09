/**
 * A STRATEGY THE WORKER WILL NOT RUN MUST NOT BE OFFERED UNMARKED.
 *
 * Reported by a tester, about a funded agent: "when the strategy is 'even
 * keel', I've realised that the agent hasn't bought automatically a single
 * stock token during all day.... I don't know if it makes sense and first buys
 * must be done by user or agent should have bought some if there are some
 * stocks in the basket".
 *
 * Nothing was broken. `even-keel` and `dip-hunter` are Merry Circle strategies:
 * the tick gates them on `holderTier.bonusStrategies`, writes ONE warn event,
 * and returns — every tick, for ever, for anyone below Merry Man. The picker
 * offered both with no marking, so the whole flow was available to somebody who
 * could never use it: choose it, read a description of what it does, sign a
 * grant, send real money, and watch an agent that never buys anything.
 *
 * THE TWO LISTS LIVE IN TWO PLACES AND THIS IS WHY THEY MAY. The canonical one
 * is `CIRCLE_STRATEGIES` in the worker's registry; the picker is a client
 * component, and importing the registry there would pull every strategy
 * implementation into the browser bundle for the sake of two strings. So the
 * picker keeps its own flag and this test is the seam: add a strategy to the
 * gate without marking it here and this fails, which is the only way the next
 * one does not repeat the report above.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** The names the WORKER refuses to run for a non-holder. */
function gatedInWorker(): string[] {
  const src = read("../../../worker/src/strategies/registry.ts");
  const m = src.match(/export const CIRCLE_STRATEGIES = \[([^\]]*)\]/);
  assert.ok(m, "CIRCLE_STRATEGIES must still be a literal array in the registry");
  return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

/** The names the PICKER marks as holder-only. */
function markedInPicker(): string[] {
  const src = read("./screens/CreateAgent.tsx");
  return [...src.matchAll(/\{id:"([^"]+)"[^}]*circle:true[^}]*\}/g)].map((x) => x[1]!);
}

describe("the picker marks what the worker gates", () => {
  it("EVERY GATED STRATEGY IS MARKED", () => {
    const gated = gatedInWorker();
    assert.ok(gated.length > 0, "the gate must still exist");
    const marked = markedInPicker();
    for (const s of gated) {
      assert.ok(marked.includes(s), `${s} is holder-only in the worker but unmarked in the picker`);
    }
  });

  it("and nothing is marked that the worker would happily run", () => {
    // The other direction matters too: a false badge sends somebody to buy a
    // token they did not need.
    const gated = gatedInWorker();
    for (const s of markedInPicker()) {
      assert.ok(gated.includes(s), `${s} is marked holder-only but the worker does not gate it`);
    }
  });

  it("AND THE MARK SAYS WHAT HAPPENS IF YOU PICK IT ANYWAY", () => {
    // A badge alone is a label. The sentence is what stops somebody funding an
    // agent that will not trade.
    const src = read("./screens/CreateAgent.tsx");
    assert.match(src, /Runs only while you hold \$MERRYMEN/);
    assert.match(src, /stays idle until you do/);
  });

  it("and the gate itself is still where the test thinks it is", () => {
    // If the worker stops gating, this whole file is obsolete rather than
    // quietly passing over a check that no longer applies.
    const src = read("../../../worker/src/index.ts");
    assert.match(src, /isCircleStrategy\(strategy\.name\) && !holderTier\.bonusStrategies/);
  });
});

describe("even-keel says why it is idle", () => {
  it("IT NO LONGER RETURNS EMPTY AND SILENT", () => {
    // steady-basket.ts learned this the hard way — its own comment records 34
    // agents spending a weekend "doing nothing and saying nothing". The `idle`
    // channel on Tick and the `all-legs-stale` / `under-one-buy` vocabulary
    // were built for it; even-keel used neither.
    const src = read("../../../worker/src/strategies/even-keel.ts");
    assert.match(src, /idle: \{ code: "all-legs-stale"/);
    assert.match(src, /code: "under-one-buy"/);
  });

  it("and the stale case is the one that fires overnight", () => {
    // Every Chainlink equity feed is stale outside US market hours, so a stock
    // basket has nothing to weigh itself against for most of the day. That is
    // the branch the tester hit, and it is the one that must speak.
    const src = read("../../../worker/src/strategies/even-keel.ts");
    const stale = src.slice(src.indexOf("if (tradable.length === 0)"), src.indexOf("const valueOf"));
    assert.match(stale, /all-legs-stale/);
    assert.match(stale, /cfg\.legs\.length > 0/, "a basket with no legs is a different fact");
  });
});

describe("the Circle gate is satisfiable, and the warning is visible", () => {
  it("THE ORCHESTRATOR SUPPLIES THE HOLDER ADDRESS, so the tier can be earned at all", () => {
    // `cfg.holderAddress` is what the child reads to resolve its tier, and
    // hosted NO SCREEN EVER WROTE IT — so circle.ts returned OUTSIDER for every
    // tenant and half the picker was inert for the whole beta, however much
    // $MERRYMEN anybody held. Marking the strategies as holders-only (above)
    // would have been a lie without this.
    const orch = readFileSync(new URL("../../../worker/src/orchestrator.ts", import.meta.url), "utf8");
    assert.match(orch, /const forChild: MerrymenSettings = \{ \.\.\.settings, holderAddress: tenant \};/);
    assert.match(orch, /JSON\.stringify\(forChild, null, 2\)/, "and the child must be written the amended copy");
  });

  it("AND IT OVERWRITES, because the field was self-declared", () => {
    // /api/settings accepts holderAddress from the tenant with shape validation
    // and nothing else, so anyone could have named a whale's wallet and claimed
    // the tier. /api/alpha refuses to use this field for exactly that reason.
    // The orchestrator's copy is the session-verified wallet, so the spread has
    // to put it LAST.
    const orch = readFileSync(new URL("../../../worker/src/orchestrator.ts", import.meta.url), "utf8");
    const line = orch.match(/const forChild: MerrymenSettings = \{[^}]*\};/)![0];
    assert.ok(
      line.indexOf("...settings") < line.indexOf("holderAddress: tenant"),
      "the verified address must override the stored one, not the other way round",
    );
  });

  it("and a worker warning now reaches a screen that ships", () => {
    // Every gate that reports itself with addEvent() and nothing else was
    // invisible: /api/feed selected the events table, live.ts had no field for
    // it, and the only renderer sits in a route that returns null.
    const live = readFileSync(new URL("./live.ts", import.meta.url), "utf8");
    assert.match(live, /notice\?: \{ level: string; message: string; at: string \} \| null;/);
    assert.match(live, /e\.level === "warn" \|\| e\.level === "err"/);
    const agent = readFileSync(new URL("./screens/Agent.tsx", import.meta.url), "utf8");
    assert.match(agent, /\{!blocked && mine\.notice && \(/);
  });

  it("and the blocker still outranks it, because one is resolved and one is a log line", () => {
    const agent = readFileSync(new URL("./screens/Agent.tsx", import.meta.url), "utf8");
    assert.ok(
      agent.indexOf("{blocked && (") < agent.indexOf("{!blocked && mine.notice && ("),
      "the resolved blocker must render above the notice",
    );
  });
});
