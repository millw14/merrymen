import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildPortfolioSnapshot, type PortfolioSnapshot } from "../../packages/core/src/portfolio-snapshot";
import type { BrainConfig, BrainDecision, BrainResult, DecideArgs } from "./brain-client";
import { prefilter, researchForAgent, type ClassRouteConfig, type TrendingAgent } from "./brain-trending";
import type { AgentLimits, AgentState } from "./policy";
import { PROFILE_DEFAULTS, type TradingProfile } from "./trading-profile";
import type { TrendingCandidate, TrendingSnapshot } from "./trending-snapshot";
import type { CurveTrend } from "./venues/pons-tape";

/**
 * THE BRAIN CHOOSES AMONG SURVIVORS, AND THE DETERMINISTIC LAYER STILL SAYS
 * NO — proved through the real prefilter, the real entry chain and the real
 * `checkPolicy`, with only the model faked.
 *
 * What is pinned here is the shape of the seam, not the model's taste: a
 * survivor the Brain prefers over `chooseEntry`'s argmax becomes the pick; a
 * refused candidate is never shown to the Brain at all; the Brain naming
 * something it was not asked about is ignored; an unreachable Brain is a hold
 * with the deterministic pick still on record; and nothing the Brain is sent
 * carries an address.
 */

const USDG = "0x3333333333333333333333333333333333333333" as const;
const VAULT = "0x9999999999999999999999999999999999999999" as const;
const addr = (n: number) => `0x${String(n).padStart(40, "0")}` as `0x${string}`;

function trend(n15: number, accel: number): CurveTrend {
  const w = (sec: number, trades: number) => ({
    sec,
    trades,
    buys: trades,
    sells: 0,
    traders: Math.max(1, Math.floor(trades / 2)),
    newTraders: 1,
    quoteIn: BigInt(trades) * 1_000_000n,
    quoteOut: 0n,
    volume: BigInt(trades) * 1_000_000n,
    imbalanceCount: trades ? 1 : null,
    imbalanceQuote: trades ? 1 : null,
    tradesPerMin: trades / (sec / 60),
    quotePerMin: 0,
    firstPrice: 1,
    lastPrice: 1.1,
    momentum: 0.1,
    incomplete: false,
  });
  return {
    curve: "0x",
    windows: [w(300, Math.round(n15 / 3)), w(900, n15), w(3600, n15 * 2)],
    tradeAcceleration: accel,
    volumeAcceleration: accel,
    netQuoteFlow: 0n,
    firstBlock: 0n,
    lastBlock: 0n,
  };
}

/** A candidate with a healthy, readable curve. `realUsdg` is real depth on top of the seed. */
function candidate(i: number, o: { realUsdg: number; n15?: number; accel?: number; ageSec?: number }): TrendingCandidate {
  const threshold = 10_000_000_000n;
  const reserves = {
    quoteRaw: 4_000_000_000n + BigInt(Math.round(o.realUsdg * 1e6)),
    tokenRaw: 800_000_000n * 10n ** 18n,
    quoteDecimals: 6,
    tokenDecimals: 18,
    graduationThresholdRaw: threshold,
  };
  return {
    id: `c${String(i).padStart(2, "0")}`,
    token: addr(100 + i),
    symbol: `TOK${i}`,
    decimals: 18,
    curve: addr(200 + i),
    quoteToken: USDG,
    quoteIsUsdg: true,
    graduationThresholdRaw: threshold,
    launchBlock: 1n,
    ageSec: o.ageSec ?? 1200,
    reserves,
    depthUsdg: o.realUsdg,
    graduationBps: Math.round((o.realUsdg / 10_000) * 10_000),
    priceUsd: "0.00000500",
    trend: trend(o.n15 ?? 40, o.accel ?? 1),
    trendingScore: 10,
  };
}

function snapshot(candidates: TrendingCandidate[]): TrendingSnapshot {
  return {
    id: "trend_test",
    head: 1000n,
    asOf: 1_800_000_000,
    secPerBlock: 0.1,
    clockMeasured: true,
    windowsSec: [300, 900, 3600],
    launchLookbackBlocks: 216_000n,
    launches: candidates.length,
    launchScanClamped: false,
    tape: { trades: 100, from: 0n, to: 1000n, holes: [] },
    tradedCurves: candidates.length,
    droppedNonUsdg: 0,
    quoteBreakdown: [],
    candidates,
  };
}

const cfg: ClassRouteConfig = {
  classMinDepthUsdg: 250,
  maxImpactBps: 300,
  slippageBps: 100,
  classExitAtGraduationPct: 85,
  classPerEntryUsdg: 5,
  scoutEnabled: true,
  scoutBudgetUsdg: 15,
  scoutPerTokenUsdg: 25,
};

function portfolio(): PortfolioSnapshot {
  return buildPortfolioSnapshot({
    agentId: "0xagent",
    asOf: 1_800_000_000,
    epoch: 1,
    cashUsdg: 20_000_000,
    netContributionsUsdg: 20_000_000,
    gasUsdg: null,
    positions: [],
    quality: {
      auditPassed: null,
      epoch: 1,
      currentAccountingHistoryAuditable: true,
      contributionsKnown: true,
      equityComplete: true,
      gasBasis: "net",
      positionHistoryAvailable: true,
      quarantinedAssetsPresent: false,
      assessedAt: 1_800_000_000,
    },
    snapshotId: "snap_test",
  });
}

function agent(o: { profile?: Partial<TradingProfile>; knownCurves?: string[]; heldCost?: bigint } = {}): TrendingAgent {
  const limits: AgentLimits = {
    perTradeUsdg: 25_000_000n,
    dailyUsdg: 100_000_000n,
    allowedTargets: [VAULT, USDG],
    allowedAssets: [USDG],
    sellableAssets: [USDG],
    curveAdapters: [],
    ponsClassVault: VAULT,
    knownCurves: o.knownCurves ?? [addr(201), addr(202), addr(203)],
    quoteAssets: [USDG],
    cashToken: USDG,
    maxDrawdownBps: 10_000,
    expiresAt: 1_800_000_000 + 86_400,
    maxOpsPerDay: 100,
  } as AgentLimits;
  const state: AgentState = { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: 20_000_000n, equityUsdg: 20_000_000n, nowSec: 1_800_000_000 };
  return {
    agentId: "0xagent",
    name: "Tester",
    profile: { ...PROFILE_DEFAULTS, ...o.profile },
    vault: VAULT,
    cfg,
    limits,
    state,
    heldClassCostUsdg: o.heldCost ?? 0n,
    portfolio: portfolio(),
    memory: [],
  };
}

/** A fake Brain: answers per instrument from a table, records every request. */
function fakeBrain(answers: Record<string, Partial<BrainDecision> | "unreachable">) {
  const asked: DecideArgs[] = [];
  const decideFn = async (_cfg: BrainConfig, args: DecideArgs): Promise<BrainResult> => {
    asked.push(args);
    const a = answers[args.market.instrument_id];
    if (a === undefined) return { ok: false, kind: "refused", reason: "insufficient-data", detail: "not in the table", cost: { model_calls: 0, tokens_in: 0, tokens_out: 0, usd: 0 } };
    if (a === "unreachable") return { ok: false, kind: "unreachable", detail: "ECONNREFUSED" };
    const d: BrainDecision = {
      schema_version: "1.0.0",
      decision_id: `dec_${args.market.instrument_id}`,
      agent_id: args.agentId,
      created_at: 1,
      trigger_id: args.triggerId,
      action: "hold",
      instrument_id: args.market.instrument_id,
      symbol: args.market.symbol,
      confidence: 0.5,
      suggested_delta_usdg: 0,
      target_position_usdg: null,
      thesis: "a thesis",
      evidence: [],
      bull_case: "",
      bear_case: "",
      risks: [],
      invalidation: [],
      catalysts: [],
      time_horizon: "",
      tier: "research",
      depth_used: "analysts",
      escalation_reasons: [],
      candidate_action: null,
      cost: { model_calls: 5, tokens_in: 1000, tokens_out: 200, usd: 0.001 },
      models: [],
      ...a,
    };
    return { ok: true, decision: d, seconds: 1 };
  };
  return { asked, decideFn };
}

const deps = (decideFn: ResearchDepsFn) => ({ brain: { url: "http://fake", token: "t" }, decideFn, expectedTradeGasUsdg: 60_000, runId: "r", now: () => 1_800_000_000 });
type ResearchDepsFn = (cfg: BrainConfig, args: DecideArgs) => Promise<BrainResult>;

describe("the prefilter is the class route's own scorer", () => {
  it("refuses thin, quiet and unreadable candidates with the tick's own words", () => {
    const legs = prefilter(
      snapshot([
        candidate(1, { realUsdg: 100 }),
        candidate(2, { realUsdg: 800, n15: 4 }),
        { ...candidate(3, { realUsdg: 800 }), reserves: null },
        candidate(4, { realUsdg: 800 }),
      ]),
      cfg,
      5_000_000n,
    );
    assert.deepEqual(
      legs.map((l) => [l.candidate.id, l.ok, l.refusal?.kind ?? null]),
      [
        ["c01", false, "depth"],
        ["c02", false, "activity"],
        ["c03", false, "depth"],
        ["c04", true, null],
      ],
    );
    assert.match(legs[0]!.refusal!.reason, /only 100\.00 USDG of real liquidity/);
    assert.match(legs[1]!.refusal!.reason, /4 trades recently/);
  });
});

describe("the Brain reorders survivors; the deterministic layer keeps the veto", () => {
  it("a survivor the Brain prefers over the argmax becomes the pick, and passes the real wall", async () => {
    // c01 is deeper (chooseEntry's favourite); c02 is accelerating (the Brain's).
    const snap = snapshot([candidate(1, { realUsdg: 2_000 }), candidate(2, { realUsdg: 600, accel: 4 })]);
    const brain = fakeBrain({
      "pons:c01:tok1": { action: "hold", confidence: 0.4 },
      "pons:c02:tok2": { action: "buy", confidence: 0.8, suggested_delta_usdg: 9_000_000, thesis: "waking up", catalysts: ["4x trade acceleration"] },
    });
    const run = await researchForAgent(snap, agent(), deps(brain.decideFn));
    assert.equal(run.deterministicPick?.candidateId, "c01", "chooseEntry still prefers depth");
    assert.equal(run.decision.action, "buy");
    assert.equal(run.decision.candidateId, "c02");
    assert.equal(run.decision.token, addr(102), "resolved by trusted code from the handle");
    assert.equal(run.decision.sizeUsdg, 5, "selection-only: the deterministic spend, not the Brain's 9");
    assert.equal(run.decision.brainSuggestedUsdg, 9, "…but what it wanted is on record");
    assert.deepEqual(run.decision.catalysts, ["4x trade acceleration"]);
    assert.equal(run.agreesWithDeterministic, false);
    assert.ok(run.entry?.ok);
    assert.equal(run.intent?.kind, "curve-trade");
    assert.equal(run.intent && run.intent.kind === "curve-trade" ? run.intent.target : null, VAULT);
    assert.deepEqual(run.policy, { ok: true });
  });

  it("a refused candidate is never shown to the Brain", async () => {
    const snap = snapshot([candidate(1, { realUsdg: 100 }), candidate(2, { realUsdg: 800 })]);
    const brain = fakeBrain({ "pons:c02:tok2": { action: "hold" } });
    await researchForAgent(snap, agent(), deps(brain.decideFn));
    assert.deepEqual(
      brain.asked.map((a) => a.market.instrument_id),
      ["pons:c02:tok2"],
      "the thin one was refused on depth before any model saw it",
    );
  });

  it("nothing sent to the Brain carries an address, and the profile travels as risk_appetite", async () => {
    const snap = snapshot([candidate(1, { realUsdg: 800 })]);
    const brain = fakeBrain({ "pons:c01:tok1": { action: "hold" } });
    await researchForAgent(snap, agent({ profile: { riskAppetite: "aggressive" } }), deps(brain.decideFn));
    const a = brain.asked[0]!;
    const everything = [a.market.instrument_id, a.market.symbol, a.persona ?? "", ...Object.values(a.market.signals)].join("\n");
    assert.doesNotMatch(everything, /0x[0-9a-fA-F]{16,}/);
    assert.equal(a.riskAppetite, "aggressive");
    assert.match(a.persona ?? "", /You are Tester, a Merryman/);
    assert.ok(a.market.signals.onchain!.includes("Last 5 minutes"), "the tape is rendered, not the addresses");
    assert.ok(a.market.signals.liquidity!.includes("real depth 800.00 USDG"));
  });

  it("the Brain answering about something it was not asked about is ignored", async () => {
    const snap = snapshot([candidate(1, { realUsdg: 800 })]);
    const brain = fakeBrain({ "pons:c01:tok1": { action: "buy", confidence: 0.9, suggested_delta_usdg: 5_000_000, instrument_id: "pons:c09:other" } });
    const run = await researchForAgent(snap, agent(), deps(brain.decideFn));
    assert.equal(run.decision.action, "hold");
    assert.match(run.decision.holdWhy ?? "", /held on every researched candidate|no usable answer|under the/);
  });

  it("a buy under the profile's conviction floor is a hold that says so", async () => {
    const snap = snapshot([candidate(1, { realUsdg: 800 })]);
    const brain = fakeBrain({ "pons:c01:tok1": { action: "buy", confidence: 0.5, suggested_delta_usdg: 5_000_000 } });
    const run = await researchForAgent(snap, agent({ profile: { convictionMin: 0.7 } }), deps(brain.decideFn));
    assert.equal(run.decision.action, "hold");
    assert.match(run.decision.holdWhy ?? "", /0\.50 confidence, under the 0\.70/);
  });

  it("an unreachable Brain is a hold — and the deterministic pick is still on record", async () => {
    const snap = snapshot([candidate(1, { realUsdg: 800 })]);
    const brain = fakeBrain({ "pons:c01:tok1": "unreachable" });
    const run = await researchForAgent(snap, agent(), deps(brain.decideFn));
    assert.equal(run.decision.action, "hold");
    assert.match(run.decision.holdWhy ?? "", /unreachable/);
    assert.equal(run.deterministicPick?.candidateId, "c01");
  });

  it("no Brain configured is a dry run, not a crash", async () => {
    const snap = snapshot([candidate(1, { realUsdg: 800 })]);
    const run = await researchForAgent(snap, agent(), { ...deps(fakeBrain({}).decideFn), brain: null });
    assert.equal(run.decision.action, "hold");
    assert.equal(run.researched[0]!.result.ok, false);
  });

  it("the wall still refuses: a curve outside provenance, and a scout budget already spent", async () => {
    const snap = snapshot([candidate(1, { realUsdg: 800 })]);
    const buy = { "pons:c01:tok1": { action: "buy" as const, confidence: 0.9, suggested_delta_usdg: 5_000_000 } };
    const noProvenance = await researchForAgent(snap, agent({ knownCurves: [] }), deps(fakeBrain(buy).decideFn));
    assert.equal(noProvenance.decision.action, "buy", "the Brain said buy…");
    assert.equal(noProvenance.policy?.ok, false, "…and the wall said no");
    assert.equal(noProvenance.policy && !noProvenance.policy.ok ? noProvenance.policy.rule : null, "curve-provenance");

    const budgetSpent = await researchForAgent(snap, agent({ heldCost: 15_000_000n }), deps(fakeBrain(buy).decideFn));
    assert.equal(budgetSpent.policy && !budgetSpent.policy.ok ? budgetSpent.policy.rule : null, "scout-budget");
  });

  it("two profiles on the SAME snapshot can research different candidates", async () => {
    const snap = snapshot([
      candidate(1, { realUsdg: 3_000, accel: 0.8, ageSec: 7200 }),
      candidate(2, { realUsdg: 300, accel: 4, ageSec: 120 }),
      candidate(3, { realUsdg: 900, accel: 1.5, ageSec: 1800 }),
    ]);
    const early = fakeBrain({});
    const late = fakeBrain({});
    await researchForAgent(snap, agent({ profile: { momentum: "early", liquidity: "thin-ok", hold: "quick", researchTopN: 1 } }), deps(early.decideFn));
    await researchForAgent(snap, agent({ profile: { momentum: "late", liquidity: "prefer-deep", hold: "ride", researchTopN: 1 } }), deps(late.decideFn));
    assert.equal(early.asked[0]!.market.instrument_id, "pons:c02:tok2");
    assert.equal(late.asked[0]!.market.instrument_id, "pons:c01:tok1");
  });
});

describe("the seam is shadow by construction", () => {
  const code = readFileSync(new URL("./brain-trending.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

  it("imports the veto and nothing that can move money", () => {
    const modules = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    for (const bad of ["./executor", "./simulate", "./wall", "./intents", "./proposals", "./store"]) {
      assert.equal(modules.find((m) => m === bad || m.endsWith(bad.slice(1))), undefined, `imports ${bad}`);
    }
    assert.ok(modules.includes("./policy"), "checkPolicy is the veto and must be present");
    assert.match(code, /checkPolicy\(/);
    for (const fn of ["sendUserOp", "executeIntent", "buildCalldata", "processIntent"]) {
      assert.doesNotMatch(code, new RegExp(`\\b${fn}\\s*\\(`), `calls ${fn}`);
    }
  });
});
