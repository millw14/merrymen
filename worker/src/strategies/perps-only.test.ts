import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStrategy, BUILTIN_STRATEGIES, isCircleStrategy, type StrategyBuildOpts } from "./registry";
import type { Snapshot } from "./types";

test("perps-only is a free builtin and cannot fall through to spot purchases or vault deposits", async () => {
  assert.ok(BUILTIN_STRATEGIES.includes("perps-only"));
  assert.equal(isCircleStrategy("perps-only"), false);
  const options = new Proxy({} as StrategyBuildOpts, { get: () => { throw new Error("spot/provider settings must not be evaluated"); } });
  const strategy = buildStrategy("perps-only", options);
  assert.equal(strategy.name, "perps-only");
  for (const cashUsdg of [0n, 100_000_000n, 1_000_000_000n]) {
    const snapshot = { cashUsdg, vaultUsdg: 0n, holdings: new Map(), sequencerUp: true } as unknown as Snapshot;
    assert.deepEqual(await strategy.tick(snapshot), { intents: [], why: [] });
  }
});
