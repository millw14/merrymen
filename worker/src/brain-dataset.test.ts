/**
 * A HOLD BECAUSE THE EVIDENCE SAYS STAY OUT, AND A HOLD BECAUSE THERE WAS
 * NOTHING TO READ, ARE THE SAME WORD AND DIFFERENT FINDINGS.
 *
 * That distinction is the whole reason this report exists. Counting a blind run
 * as a considered hold credits the reasoner for a failure of the pipeline in
 * front of it — which is exactly the mistake the first week of shadow made,
 * where every decision was a hold and it took reading the prose to notice that
 * every lens had returned no-data.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { datasetLines, viewRun, type ShadowRun } from "./brain-dataset";

const run = (over: Partial<ShadowRun> = {}, signals: Record<string, unknown> = {}): ShadowRun => ({
  agentId: "0x3E34E58e39DC6614e047dFD3BAD5B7DEA45DCd62",
  agentName: "tester",
  at: 1_788_600_000,
  symbol: "TSLA",
  action: "hold",
  sizeUsdg: 0,
  thesis: "no actionable evidence",
  signals: {
    trigger_reason: "scheduled-review",
    confidence: 0.2,
    suggested_delta_usdg: 0,
    depth_used: "analysts",
    escalation_reasons: [],
    analyst_views: [
      { lens: "technical", direction: "no-data", confidence: 0 },
      { lens: "news", direction: "no-data", confidence: 0 },
    ],
    economics: "unknown",
    cost: { model_calls: 5, tokens_in: 3000, tokens_out: 800, usd: 0.0012 },
    latency_seconds: 2.4,
    executor_calls: 0,
    ...signals,
  },
  ...over,
});

describe("visibility separates a considered hold from a blind one", () => {
  it("calls a run BLIND when every lens returned no-data", () => {
    assert.equal(viewRun(run()).visibility, "blind");
  });

  it("calls it THIN when exactly one lens saw something", () => {
    const v = viewRun(
      run({}, {
        analyst_views: [
          { lens: "technical", direction: "hold", confidence: 0.2 },
          { lens: "news", direction: "no-data", confidence: 0 },
        ],
      }),
    );
    assert.equal(v.visibility, "thin");
  });

  it("calls it INFORMED when two or more did", () => {
    const v = viewRun(
      run({}, {
        analyst_views: [
          { lens: "technical", direction: "buy", confidence: 0.7 },
          { lens: "news", direction: "hold", confidence: 0.4 },
        ],
      }),
    );
    assert.equal(v.visibility, "informed");
  });

  it("treats a run with no recorded lenses as blind, not as informed", () => {
    // A decision from a Brain build that predates analyst_views tells us
    // nothing about what it saw, and "nothing" must not read as "everything".
    assert.equal(viewRun(run({}, { analyst_views: [] })).visibility, "blind");
  });

  it("splits the hold count by why, which is the headline", () => {
    const text = datasetLines([
      viewRun(run()),
      viewRun(run({}, { analyst_views: [{ lens: "technical", direction: "hold", confidence: 0.3 }] })),
    ]).join("\n");
    assert.match(text, /holds\s+2 — 1 with NOTHING to read, 1 with at least one lens reporting/);
  });
});

describe("the economics of a proposed trade", () => {
  const buy = () =>
    viewRun(
      run({ action: "buy" }, {
        suggested_delta_usdg: 2_000_000,
        expected_edge_usdg: 1_500_000,
        expected_trade_gas_usdg: 764_720,
        economics: "viable",
        confidence: 0.7,
      }),
    );

  it("measures gas against the size actually proposed", () => {
    // Not against a typical trade — against this one. That is the number that
    // decides whether THIS trade was worth making.
    assert.equal(buy().gasShareOfTradePct!.toFixed(1), "38.2");
  });

  it("says nothing about the economics of a hold", () => {
    // A hold proposes no size, so a gas share of it is a division nobody asked
    // for. `n/a (hold)` rather than a number that looks like a judgement.
    assert.equal(viewRun(run()).gasShareOfTradePct, null);
    assert.match(datasetLines([viewRun(run())]).join("\n"), /"n\/a \(hold\)":1/);
  });

  it("reports the proposed size and its gas share when there IS a trade", () => {
    const text = datasetLines([buy()]).join("\n");
    assert.match(text, /BUY\/SELL\s+1 — sizes 2\.000000 USDG · gas 38\.2% of size/);
    assert.match(text, /economics viable · edge 1500000 vs gas 764720/);
  });

  it("says so plainly while every decision is still a hold", () => {
    assert.match(datasetLines([viewRun(run())]).join("\n"), /none yet — every decision so far is a hold/);
  });
});

describe("the report answers the questions the cohort exists to ask", () => {
  it("counts actions, lens verdicts, escalations and confidence spread", () => {
    const text = datasetLines([
      viewRun(run({}, { confidence: 0.1 })),
      viewRun(run({ action: "buy" }, { confidence: 0.9, suggested_delta_usdg: 1, escalation_reasons: ["analysts-disagree"] })),
    ]).join("\n");
    assert.match(text, /"hold":1/);
    assert.match(text, /"buy":1/);
    assert.match(text, /confidence\s+median .* min 0\.10 · max 0\.90/);
    assert.match(text, /escalated\s+1 of 2 \(50%\)/);
    assert.match(text, /"no-data":4/);
  });

  it("groups by agent, oldest first, because confidence-vs-evidence is a sequence", () => {
    const text = datasetLines([
      viewRun(run({ at: 200 })),
      viewRun(run({ at: 100 })),
      viewRun(run({ agentId: "0xother", agentName: "Gary", at: 150 })),
    ]).join("\n");
    const a = text.indexOf("00:01:40"); // at=100
    const b = text.indexOf("00:03:20"); // at=200
    assert.ok(a > 0 && b > a, "oldest first within an agent");
    assert.match(text, /2 decision\(s\)/);
    assert.match(text, /Gary — 1 decision\(s\)/);
    assert.match(text, /across 2 agent\(s\)/);
  });

  it("STATES the executor count every time rather than assuming it", () => {
    assert.match(datasetLines([viewRun(run())]).join("\n"), /EXECUTOR CALLS 0 — must be exactly 0/);
    assert.match(
      datasetLines([viewRun(run({}, { executor_calls: 3 }))]).join("\n"),
      /EXECUTOR CALLS 3/,
      "and reports a non-zero one rather than hiding it",
    );
  });

  it("survives a row whose blob is missing entirely", () => {
    // A decision that happened is a decision that happened. Dropping it would
    // quietly shrink the denominator of every rate in the report.
    const v = viewRun({ ...run(), signals: {} });
    assert.equal(v.visibility, "blind");
    assert.equal(v.calls, 0);
    assert.doesNotThrow(() => datasetLines([v]));
  });

  it("says so when there is nothing yet", () => {
    assert.deepEqual(datasetLines([]), ["no shadow decisions recorded yet"]);
  });
});

describe("a refusal is not a trade, and the report must not invent one", () => {
  // A run that produced no decision writes a row with NO action field at all —
  // deliberately, so "decided nothing" and "decided, with no size" are
  // different row shapes. The first live report read that absence as a
  // placeholder, tested `!== "hold"`, and announced "1 BUY/SELL, size 0.000000
  // USDG". There was no trade. This report exists to answer whether Brain ever
  // proposes one, so inventing one is the worst thing it can do.
  const refusal = () =>
    viewRun({
      agentId: "0x3E34",
      agentName: "tester",
      at: 1_788_600_000,
      symbol: null,
      action: null,
      sizeUsdg: null,
      thesis: "no decision (refused): portfolio-quality-insufficient",
      signals: { trigger_reason: "scheduled-review", cost: null },
    });

  it("classifies a row with no action as refused", () => {
    assert.equal(refusal().action, "refused");
  });

  it("counts it as neither a trade nor a hold", () => {
    const text = datasetLines([refusal(), viewRun(run())]).join("\n");
    assert.match(text, /BUY\/SELL\s+none yet/);
    assert.match(text, /holds\s+1 —/, "the hold count is the real holds only");
    assert.match(text, /refused\s+1 — runs that produced no decision at all/);
  });

  it("does not put a refusal in the economics table as a judged trade", () => {
    assert.match(datasetLines([refusal()]).join("\n"), /"n\/a \(refused\)":1/);
  });

  it("still counts a genuine buy", () => {
    const text = datasetLines([
      refusal(),
      viewRun(run({ action: "buy" }, { suggested_delta_usdg: 2_000_000, expected_trade_gas_usdg: 764_720 })),
    ]).join("\n");
    assert.match(text, /BUY\/SELL\s+1 — sizes 2\.000000 USDG/);
  });
});
