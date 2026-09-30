import assert from "node:assert/strict";
import test from "node:test";
import { produceStrategyTick } from "./strategy-production";
import { circleStrategyTick } from "./circle-gate";
import { runPerpRoute, type PerpRouteIntent } from "./perps/route";
import { ctx, settings, view } from "./perps/testkit-perps";
import type { Tick } from "./strategies/types";

test("a failed spot producer leaves the independent trend route available with its original brakes", async () => {
  const produced = await produceStrategyTick(async () => { throw new Error("provider unavailable"); }, () => {});
  assert.equal(produced.failed, true);
  assert.deepEqual(produced.tick.intents, []);
  const route = (over: Parameters<typeof ctx>[0] = {}) => runPerpRoute({
    view: view(), settings: settings(), driver: "perp-trend", perpTrendCtx: ctx(over),
  });
  assert.ok(route().entry, "the same healthy snapshot can still produce the autonomous perp signal");
  for (const brakes of [{ breakerIdle: false }, { energyEntriesLeft: false }, { opsHeadroom: false }]) {
    assert.equal(route(brakes).entry, null, "producer isolation does not grant new trading authority");
  }
});

test("failed and stale strategist handoffs cannot leak into a later window; a successful retry can", async () => {
  const fresh = runPerpRoute({ view: view(), settings: settings(), driver: "perp-trend", perpTrendCtx: ctx() }).entry;
  assert.ok(fresh);
  let handoff: PerpRouteIntent[] = [fresh];
  const clear = () => { handoff = []; };
  const failed = await produceStrategyTick(async () => {
    assert.deepEqual(handoff, [], "the previous window has been retired before producing");
    handoff = [fresh];
    throw new Error("private-provider-response");
  }, clear);
  assert.equal(failed.failed, true);
  assert.doesNotMatch(JSON.stringify(failed), /private-provider-response/);
  assert.deepEqual(handoff, [], "a partly produced handoff is discarded");
  const route = () => runPerpRoute({ view: view(), settings: settings({ perpsDriver: "strategist" }), driver: "strategist", perpTrendCtx: ctx(), strategistPerpIntents: handoff });
  assert.equal(route().entry, null);
  const normal: Tick = { intents: [], why: [] };
  const recovered = await produceStrategyTick(async () => { handoff = [fresh]; return normal; }, clear);
  assert.equal(recovered.failed, false);
  assert.equal(recovered.tick, normal);
  assert.ok(route().entry, "the next successful review resumes without changing settings");
});

test("a gated Circle strategy is still never called, and its old handoff is cleared", async () => {
  let called = false;
  let stale = true;
  const result = await produceStrategyTick(() => circleStrategyTick(true, async () => {
    called = true;
    return { intents: [], why: [] };
  }), () => { stale = false; });
  assert.equal(called, false);
  assert.equal(stale, false);
  assert.equal(result.failed, false);
  assert.deepEqual(result.tick, { intents: [], why: [] });
});
