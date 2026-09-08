/**
 * WHAT A BRAIN DECISION IS ALLOWED TO BECOME.
 *
 * `brain-disconnected.test.ts` guards the SHAPE of the connection — one gated
 * call site, its own allowlist, through the wall-checked path, filed under its
 * own source. This guards the ARITHMETIC, which is the other half: the number
 * that decides how much of somebody's money moves.
 *
 * The units are the sharp edge. `suggested_delta_usdg` is integer MICRO-USDG,
 * positive to buy and negative to sell — graph.py says so in the prompt it
 * sends the model and schemas.py validates the sign on the way out. Read as
 * USDG it is a million-fold overstatement, and that is a mistake which only
 * ever shows up once real money is behind it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BRAIN_MIN_TRADE_USDG, brainLiveEnabledFor, orderFromDecision } from "./brain-live";
import type { BrainDecision } from "./brain-client";

const decision = (over: Partial<BrainDecision> = {}): BrainDecision =>
  ({
    schema_version: "1",
    decision_id: "d1",
    agent_id: "0xabc",
    created_at: 0,
    trigger_id: null,
    action: "buy",
    instrument_id: "merrymen:nvda",
    symbol: "NVDA",
    confidence: 0.7,
    suggested_delta_usdg: 10_000_000, // 10 USDG
    target_position_usdg: null,
    thesis: "t",
    evidence: [],
    bull_case: "",
    bear_case: "",
    risks: [],
    invalidation: [],
    time_horizon: "",
    tier: "",
    depth_used: "",
    escalation_reasons: [],
    candidate_action: null,
    cost: { model_calls: 1, tokens_in: 1, tokens_out: 1, usd: 0 },
    models: [],
    ...over,
  }) as BrainDecision;

const LIMITS = { maxUsdg: 50, minUsdg: BRAIN_MIN_TRADE_USDG };

describe("who may trade on model output", () => {
  it("NOBODY, BY DEFAULT", () => {
    // The whole point of a separate list. An unset variable is not "everyone".
    assert.equal(brainLiveEnabledFor("0xabc", {} as NodeJS.ProcessEnv), false);
    assert.equal(brainLiveEnabledFor("0xabc", { MERRYMEN_BRAIN_LIVE: "" } as NodeJS.ProcessEnv), false);
    assert.equal(brainLiveEnabledFor("0xabc", { MERRYMEN_BRAIN_LIVE: "   " } as NodeJS.ProcessEnv), false);
  });

  it("and only an agent the owner named", () => {
    const env = { MERRYMEN_BRAIN_LIVE: "0xAE769E64,0x1102b20c" } as NodeJS.ProcessEnv;
    assert.equal(brainLiveEnabledFor("0xae769e64125757e8d06f1e15c3cdc13e11e272fb", env), true);
    assert.equal(brainLiveEnabledFor("0x1102b20cffffffffffffffffffffffffffffffff", env), true);
    assert.equal(brainLiveEnabledFor("0xd55b2a5796231bc82323cabecdd639164302a9de", env), false);
    // A prefix matches from the START, so one account cannot be reached by
    // naming a fragment that happens to appear inside it.
    assert.equal(brainLiveEnabledFor("0x00000xAE769E64", env), false);
  });

  it("and an empty agent id is never a match", () => {
    assert.equal(brainLiveEnabledFor("", { MERRYMEN_BRAIN_LIVE: "all" } as NodeJS.ProcessEnv), false);
  });
});

describe("micro-USDG is not USDG", () => {
  it("10_000_000 MICRO-USDG IS TEN DOLLARS, not ten million", () => {
    const v = orderFromDecision(decision({ suggested_delta_usdg: 10_000_000 }), LIMITS);
    assert.ok(v.ok);
    assert.equal(v.order.usdgAmount, 10);
    assert.equal(v.order.side, "buy");
    assert.equal(v.order.symbol, "NVDA");
  });

  it("and a SELL carries a negative delta, sized by its magnitude", () => {
    const v = orderFromDecision(decision({ action: "sell", suggested_delta_usdg: -12_500_000 }), LIMITS);
    assert.ok(v.ok);
    assert.equal(v.order.side, "sell");
    assert.equal(v.order.usdgAmount, 12.5);
  });
});

describe("the word and the number must agree", () => {
  it("A BUY THAT SIZES A SELL IS REFUSED", () => {
    // Brain's own schema enforces this; checking again is the same reasoning
    // brain-client.ts gives for re-scanning addresses on this side of the
    // network boundary — the two failures are different, and only one of them
    // is a service that might one day be a different build than we think.
    const v = orderFromDecision(decision({ action: "buy", suggested_delta_usdg: -10_000_000 }), LIMITS);
    assert.equal(v.ok, false);
    assert.match((v as { why: string }).why, /says buy and sizes a sell/);
  });

  it("and a sell that sizes a buy", () => {
    const v = orderFromDecision(decision({ action: "sell", suggested_delta_usdg: 10_000_000 }), LIMITS);
    assert.equal(v.ok, false);
    assert.match((v as { why: string }).why, /says sell and sizes a buy/);
  });

  it("a HOLD is not an order", () => {
    const v = orderFromDecision(decision({ action: "hold", suggested_delta_usdg: 0 }), LIMITS);
    assert.equal(v.ok, false);
    assert.equal((v as { why: string }).why, "held");
  });

  it("and a size that is not a number never reaches a BigInt", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const v = orderFromDecision(decision({ suggested_delta_usdg: bad }), LIMITS);
      assert.equal(v.ok, false, `${bad} became an order`);
    }
  });
});

describe("what it refuses to trade", () => {
  it("DUST, because it cannot pay for its own gas", () => {
    // One swap on this chain costs 0.38-0.78 USDG and a round trip is two. The
    // four ops this deployment ever landed cost 6.97 USDG of gas to move 6.67
    // USDG of notional — more in fees than the trade was worth.
    const v = orderFromDecision(decision({ suggested_delta_usdg: 1_000_000 }), LIMITS);
    assert.equal(v.ok, false);
    assert.match((v as { why: string }).why, /under the 5 USDG floor/);
  });

  it("and a symbol that is not a ticker", () => {
    for (const bad of ["0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "buy everything", "", "NVDA;DROP"]) {
      const v = orderFromDecision(decision({ symbol: bad }), LIMITS);
      assert.equal(v.ok, false, `${bad} became a lookup`);
    }
  });
});

describe("the ceiling clamps, it does not refuse", () => {
  it("AN OVER-ASK BECOMES WHAT IT MAY HAVE", () => {
    // The same shape the strategist's own ceiling uses: min() can only tighten.
    // Refusing instead would turn one over-ask into a permanent hold, and the
    // wall's sealed per-trade cap is the number that binds either way.
    const v = orderFromDecision(decision({ suggested_delta_usdg: 900_000_000 }), { maxUsdg: 50, minUsdg: 5 });
    assert.ok(v.ok);
    assert.equal(v.order.usdgAmount, 50);
  });

  it("and a ceiling of zero means no order at all", () => {
    const v = orderFromDecision(decision(), { maxUsdg: 0, minUsdg: 0 });
    assert.equal(v.ok, false);
  });

  it("and nothing here can RAISE what an agent may spend", () => {
    // Every bound in this module is a floor or a min(). There is no path by
    // which a decision produces a number larger than the ceiling it was given.
    for (const micro of [1, 5_000_000, 50_000_000, 10_000_000_000]) {
      const v = orderFromDecision(decision({ suggested_delta_usdg: micro }), { maxUsdg: 7, minUsdg: 0 });
      if (v.ok) assert.ok(v.order.usdgAmount <= 7, `${micro} produced ${v.order.usdgAmount}`);
    }
  });
});
