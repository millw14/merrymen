/**
 * Ported from 112dbeb6: the dedicated Perps worker's Spot strategy stays inert.
 * The wallet now selects it internally; it is deliberately absent from the
 * strategies an owner can select for a Spot worker.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStrategy, BUILTIN_STRATEGIES, isCircleStrategy, PERPS_ONLY_STRATEGY, type StrategyBuildOpts } from "./registry";
import type { Snapshot } from "./types";

test("the internal Perps strategy is not selectable and never proposes Spot purchases or vault deposits", async () => {
  assert.equal((BUILTIN_STRATEGIES as readonly string[]).includes(PERPS_ONLY_STRATEGY), false);
  assert.equal(isCircleStrategy(PERPS_ONLY_STRATEGY), false);
  const options = new Proxy({} as StrategyBuildOpts, { get: () => { throw new Error("spot/provider settings must not be evaluated"); } });
  const strategy = buildStrategy(PERPS_ONLY_STRATEGY, options);
  assert.equal(strategy.name, PERPS_ONLY_STRATEGY);
  for (const cashUsdg of [0n, 100_000_000n, 1_000_000_000n]) {
    const snapshot = { cashUsdg, vaultUsdg: 0n, holdings: new Map(), sequencerUp: true } as unknown as Snapshot;
    assert.deepEqual(await strategy.tick(snapshot), { intents: [], why: [] });
  }
});
