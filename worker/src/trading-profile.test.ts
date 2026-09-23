import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROFILE_DEFAULTS,
  featureWeights,
  parseProfile,
  profileSentence,
  rankForProfile,
  type RankableCandidate,
  type TradingProfile,
} from "./trading-profile";
import type { CurveTrend } from "./venues/pons-tape";

/**
 * A PROFILE CHANGES SELECTION AND NOTHING ELSE.
 *
 * Two agents on the same snapshot bought the same launch because the class
 * route is one argmax every agent inherits. The fix is taste, not noise: the
 * same profile on the same candidates must give the same order every time,
 * two profiles must be able to disagree, and neither may reach a candidate
 * the deterministic prefilter refused — which is enforced by what the ranker
 * is GIVEN, and pinned here by what it is not.
 */

function trend(o: { n5?: number; n15?: number; n60?: number; traders5?: number; new5?: number; mom15?: number | null; imb5?: number | null; accel?: number | null }): CurveTrend {
  const w = (sec: number, trades: number, traders: number, newTraders: number, momentum: number | null, imbalanceQuote: number | null) => ({
    sec,
    trades,
    buys: trades,
    sells: 0,
    traders,
    newTraders,
    quoteIn: 0n,
    quoteOut: 0n,
    volume: 0n,
    imbalanceCount: null,
    imbalanceQuote,
    tradesPerMin: trades / (sec / 60),
    quotePerMin: 0,
    firstPrice: null,
    lastPrice: null,
    momentum,
    incomplete: false,
  });
  return {
    curve: "0xc",
    windows: [
      w(300, o.n5 ?? 5, o.traders5 ?? 3, o.new5 ?? 1, null, o.imb5 ?? null),
      w(900, o.n15 ?? 30, 8, 2, o.mom15 ?? null, null),
      w(3600, o.n60 ?? 60, 15, 4, null, null),
    ],
    tradeAcceleration: o.accel ?? 1,
    volumeAcceleration: o.accel ?? 1,
    netQuoteFlow: 0n,
    firstBlock: 0n,
    lastBlock: 0n,
  };
}

const cand = (key: string, o: Partial<RankableCandidate> & { trend?: CurveTrend } = {}): RankableCandidate => ({
  key,
  symbol: key.toUpperCase(),
  depthUsd: 500,
  costBps: 250,
  graduationBps: 3000,
  ageSec: 1800,
  trend: trend({}),
  ...o,
});

const EARLY: TradingProfile = { ...PROFILE_DEFAULTS, momentum: "early", liquidity: "thin-ok", hold: "quick" };
const LATE: TradingProfile = { ...PROFILE_DEFAULTS, momentum: "late", liquidity: "prefer-deep", hold: "ride" };

describe("parsing a profile", () => {
  it("unknown words fall back per field, never failing the whole profile", () => {
    const p = parseProfile({ momentum: "yolo", liquidity: "thin-ok", convictionMin: 7, researchTopN: 0.4, riskAppetite: "aggressive" });
    assert.equal(p.momentum, PROFILE_DEFAULTS.momentum);
    assert.equal(p.liquidity, "thin-ok");
    assert.equal(p.convictionMin, 1, "clamped into 0..1");
    assert.equal(p.researchTopN, 1, "clamped into 1..5");
    assert.equal(p.riskAppetite, "aggressive");
  });

  it("null or absent is the default profile", () => {
    assert.deepEqual(parseProfile(null), PROFILE_DEFAULTS);
    assert.deepEqual(parseProfile(undefined), PROFILE_DEFAULTS);
  });

  it("the sentence is made of enum words and a number — nothing a user typed", () => {
    const s = profileSentence(parseProfile({ momentum: "<script>", hold: "quick" }));
    assert.doesNotMatch(s, /<script>/);
    assert.match(s, /takes quick exits/);
  });
});

describe("ranking is deterministic and profile-driven", () => {
  it("the same profile on the same candidates gives the same order, every time", () => {
    const cs = [cand("a", { trend: trend({ accel: 3 }) }), cand("b", { depthUsd: 2000 }), cand("c", { ageSec: 60 })];
    const first = rankForProfile(cs, EARLY).map((r) => r.key);
    for (let i = 0; i < 20; i++) assert.deepEqual(rankForProfile(cs, EARLY).map((r) => r.key), first);
  });

  it("two profiles can disagree on the same survivors — that is the point", () => {
    const young = cand("young", { ageSec: 120, depthUsd: 260, trend: trend({ accel: 4, new5: 6, n60: 30 }) });
    const proven = cand("proven", { ageSec: 7200, depthUsd: 3000, trend: trend({ accel: 0.8, n60: 200, mom15: 0.2 }) });
    assert.equal(rankForProfile([young, proven], EARLY)[0]!.key, "young");
    assert.equal(rankForProfile([young, proven], LATE)[0]!.key, "proven");
  });

  it("the membership never changes — only the order does", () => {
    const cs = [cand("a"), cand("b", { depthUsd: 9000 }), cand("c", { costBps: 50 })];
    for (const p of [EARLY, LATE, PROFILE_DEFAULTS]) {
      assert.deepEqual(rankForProfile(cs, p).map((r) => r.key).sort(), ["a", "b", "c"]);
    }
  });

  it("an indifferent profile keeps input order — which is the deterministic scorer's order", () => {
    const same = [cand("first"), cand("second"), cand("third")];
    assert.deepEqual(rankForProfile(same, PROFILE_DEFAULTS).map((r) => r.key), ["first", "second", "third"]);
  });

  it("every term is named, weighted and ranked, so the reasoning is auditable", () => {
    const r = rankForProfile([cand("a", { depthUsd: 1 }), cand("b", { depthUsd: 5000 })], LATE);
    const b = r.find((x) => x.key === "b")!;
    const depth = b.terms.find((t) => t.feature === "real depth")!;
    assert.equal(depth.rank, 1);
    assert.equal(depth.weight, 2.5, "prefer-deep cares about depth");
    assert.match(b.reasoning, /real depth/);
  });

  it("a candidate that could not be measured on a feature ranks at the bottom of it", () => {
    const r = rankForProfile([cand("known", { ageSec: 60 }), cand("unknown", { ageSec: null })], EARLY);
    const unk = r.find((x) => x.key === "unknown")!.terms.find((t) => t.feature === "age")!;
    assert.equal(unk.rank, 0, "unknown is never a reason to prefer");
  });
});

describe("what a profile may never do", () => {
  it("the weight table contains weights and directions, and no threshold of any kind", () => {
    for (const p of [EARLY, LATE, PROFILE_DEFAULTS]) {
      for (const spec of featureWeights(p)) {
        assert.deepEqual(Object.keys(spec).sort(), ["feature", "higherIsBetter", "value", "weight"]);
        assert.ok(spec.weight >= 0);
      }
    }
  });

  it("the ranker takes candidates and a profile — there is no argument through which a limit could travel", () => {
    assert.equal(rankForProfile.length, 2);
  });
});
