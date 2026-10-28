/**
 * BRAIN DOES NOT PROPOSE PERPS IN v1 (docs/perps.md rule 15; the review's
 * brain-perps-defer-v1). Two walls, each tested alone:
 *
 *   brain-live   refuses any symbol ending `-PERP`, first, whatever the
 *                action, size or gate says — and whatever its case.
 *   brain-focus  never offers a perp key as a holding to review or a candidate
 *                to open, so Brain is never asked about one to begin with.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BrainDecision } from "./brain-client";
import { chooseFocus, type HeldPosition } from "./brain-focus";
import { BRAIN_MIN_TRADE_USDG, orderFromDecision } from "./brain-live";

const decision = (over: Partial<BrainDecision> = {}): BrainDecision =>
  ({
    schema_version: "1",
    decision_id: "d1",
    agent_id: "0xabc",
    created_at: 0,
    trigger_id: null,
    action: "buy",
    instrument_id: "merrymen:btc-perp",
    symbol: "BTC-PERP",
    confidence: 0.7,
    suggested_delta_usdg: 10_000_000,
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

describe("brain-live refuses every perp symbol", () => {
  it("a buy, a sell, any case, with or without whitespace — refused by name", () => {
    const cases: Array<Partial<BrainDecision>> = [
      { symbol: "BTC-PERP", action: "buy", suggested_delta_usdg: 10_000_000 },
      { symbol: "TSLA-PERP", action: "sell", suggested_delta_usdg: -10_000_000 },
      { symbol: "eth-perp", action: "buy", suggested_delta_usdg: 10_000_000 },
      { symbol: " SOL-PERP ", action: "buy", suggested_delta_usdg: 10_000_000 },
    ];
    for (const c of cases) {
      const v = orderFromDecision(decision(c), LIMITS);
      assert.equal(v.ok, false, String(c.symbol));
      assert.match((v as { why: string }).why, /perpetual market; Brain does not trade perps/);
    }
  });

  it("refused BEFORE the size and the gate: a perp with a garbage size still says why it is refused", () => {
    const v = orderFromDecision(decision({ suggested_delta_usdg: Number.NaN, gate_verdict: "refuse" } as Partial<BrainDecision>), LIMITS);
    assert.equal(v.ok, false);
    assert.match((v as { why: string }).why, /Brain does not trade perps/);
  });

  it("the spot token of the same name is untouched: TSLA still trades", () => {
    const v = orderFromDecision(decision({ symbol: "TSLA", instrument_id: "merrymen:tsla" }), LIMITS);
    assert.deepEqual(v, { ok: true, order: { side: "buy", symbol: "TSLA", usdgAmount: 10 } });
  });
});

describe("brain-focus never offers a perp key", () => {
  const held = (symbol: string, valueUsdg: number): HeldPosition => ({
    symbol,
    token: `0x${"1".repeat(40)}`,
    valueUsdg,
    price8: 100_00000000n,
    priceStale: false,
    priceSource: "chainlink",
  });
  const quote = { price8: 100_00000000n, stale: false, source: "chainlink" };

  it("a perp 'holding', however big, is never the focus; the real holding is", () => {
    const f = chooseFocus({
      agentId: "0xabc",
      positions: [held("BTC-PERP", 1_000_000_000), held("TSLA", 5_000_000)],
      universe: [],
      prices: new Map(),
      paused: new Set(),
    });
    assert.equal(f?.symbol, "TSLA");
    assert.equal(f?.held, true);
  });

  it("a perp key in the universe is never a candidate; with nothing else there is no focus", () => {
    const only = chooseFocus({
      agentId: "0xabc",
      positions: [held("ETH-PERP", 50_000_000)],
      universe: [{ symbol: "BTC-PERP", address: `0x${"2".repeat(40)}` }],
      prices: new Map([["BTC-PERP", quote]]),
      paused: new Set(),
    });
    assert.equal(only, null);
    const mixed = chooseFocus({
      agentId: "0xabc",
      positions: [],
      universe: [
        { symbol: "NVDA-PERP", address: `0x${"3".repeat(40)}` },
        { symbol: "NVDA", address: `0x${"4".repeat(40)}` },
      ],
      prices: new Map([
        ["NVDA-PERP", quote],
        ["NVDA", quote],
      ]),
      paused: new Set(),
    });
    assert.equal(mixed?.symbol, "NVDA");
    assert.equal(mixed?.held, false);
  });
});
