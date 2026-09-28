/**
 * A REVIEW THE ALLOWANCE REFUSES COSTS NOTHING, CHANGES NOTHING, AND DOES NOT
 * SPIN THE CLOCK.
 *
 * runShadow asks `admit` once its trigger has fired and before it saves the
 * fired state. Three things must hold, each run here against the real store and
 * a local stand-in for the Brain service:
 *
 *   - refused: Brain is never called, the cooldowns are exactly as they were
 *     (so the same trigger fires again once the allowance allows), and the
 *     outcome carries `nextReviewAt: null`;
 *   - admitted: nothing about the run changes;
 *   - a trigger that does not fire never asks — a quiet tick claims nothing.
 *
 * And the regression the null exists for: the unfired state's deadline is in
 * the PAST when a trigger is due, and nextTickDelayMs turns a past deadline
 * into a one-second tick. A refused review returning it would have the agent
 * ask, be refused and ask again every second.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { BrainDecision } from "./brain-client";
import type { ShadowInputs } from "./brain-shadow";
import { nextTickDelayMs } from "./decision-cadence";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-shadow-admit-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const { runShadow } = await import("./brain-shadow");

after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const now = Math.floor(Date.now() / 1000);
let decisionSeq = 0;

async function brainStub() {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _;
    calls++;
    const decision: BrainDecision = {
      schema_version: "1", decision_id: `dec_admit_${++decisionSeq}_${now}`, agent_id: "x", created_at: now, trigger_id: null,
      action: "hold", instrument_id: "fixture", symbol: "TSLA", confidence: 0.5, suggested_delta_usdg: 0,
      target_position_usdg: null, thesis: "Nothing new.", evidence: [], bull_case: "", bear_case: "",
      risks: [], invalidation: [], time_horizon: "", tier: "pulse", depth_used: "", escalation_reasons: [],
      candidate_action: null, models: [], cost: { model_calls: 1, tokens_in: 1, tokens_out: 1, usd: 0 },
      gate_verdict: "proceed", hold_kind: "MODEL_HOLD",
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, seconds: 0, decision }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, calls: () => calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const inputs = (agentId: string, over: Partial<ShadowInputs> = {}): ShadowInputs => ({
  agentId, decisionSource: "brain", now, epoch: 1,
  cashUsdg: 10_000_000, vaultUsdg: 0, quarantinedUsdg: 0,
  netContributionsUsdg: 10_000_000, grossContributionsUsdg: 10_000_000, grossWithdrawalsUsdg: 0, gasUsdg: 0,
  positions: [],
  quality: { auditPassed: true, epoch: 1, currentAccountingHistoryAuditable: true, contributionsKnown: true, equityComplete: true, gasBasis: "net", positionHistoryAvailable: true, quarantinedAssetsPresent: false, assessedAt: now },
  market: { instrumentId: "fixture", symbol: "TSLA", instrumentClass: "equity-token", priceUsd: "250.00", priceStale: false, signals: {} },
  expectedTradeGasUsdg: 0, memory: [],
  ...over,
});

describe("admit refuses", () => {
  it("BRAIN IS NOT CALLED, THE COOLDOWNS ARE UNTOUCHED, AND nextReviewAt IS NULL", async () => {
    const brain = await brainStub();
    const agent = "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a001";
    let asked = 0;
    try {
      const out = await runShadow({ url: brain.url, token: "t", timeoutMs: 2000 }, inputs(agent), () => {}, {
        admit: async () => {
          asked++;
          return false;
        },
      });
      assert.equal(asked, 1, "asked once the trigger fired");
      assert.equal(out.ran, false);
      assert.equal(out.nextReviewAt, null, "never the unfired state's past deadline");
      assert.match(out.ran ? "" : out.why, /energy/);
      assert.equal(out.trigger.fire, true, "the trigger did fire — it is the allowance that said no");
      assert.equal(brain.calls(), 0, "no paid call");
      assert.equal(await store.loadTriggerState(agent), null, "no fired state saved: the same trigger fires again later");
    } finally {
      await brain.close();
    }
  });

  it("and once the allowance allows, the same trigger runs", async () => {
    const brain = await brainStub();
    const agent = "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a002";
    try {
      const refused = await runShadow({ url: brain.url, token: "t", timeoutMs: 2000 }, inputs(agent), () => {}, { admit: async () => false });
      assert.equal(refused.ran, false);
      const admitted = await runShadow({ url: brain.url, token: "t", timeoutMs: 2000 }, inputs(agent), () => {}, { admit: async () => true });
      assert.equal(admitted.ran, true);
      assert.equal(brain.calls(), 1);
    } finally {
      await brain.close();
    }
  });
});

describe("admit accepts", () => {
  it("the run is unchanged: Brain is called and the fired state is saved", async () => {
    const brain = await brainStub();
    const agent = "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a003";
    let asked = 0;
    try {
      const out = await runShadow({ url: brain.url, token: "t", timeoutMs: 2000 }, inputs(agent), () => {}, {
        admit: async () => {
          asked++;
          return true;
        },
      });
      assert.equal(out.ran, true);
      assert.equal(asked, 1);
      assert.equal(brain.calls(), 1);
      assert.ok(await store.loadTriggerState(agent), "the fired state is saved before the call, as always");
    } finally {
      await brain.close();
    }
  });

  it("A QUIET TICK NEVER ASKS — nothing fired, nothing claimed", async () => {
    const brain = await brainStub();
    const agent = "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a004";
    let asked = 0;
    const admit = async () => {
      asked++;
      return true;
    };
    try {
      await runShadow({ url: brain.url, token: "t", timeoutMs: 2000 }, inputs(agent), () => {}, { admit });
      assert.equal(asked, 1);
      // The same inputs a moment later: every cooldown is running, nothing fires.
      const quiet = await runShadow({ url: brain.url, token: "t", timeoutMs: 2000 }, inputs(agent, { now: now + 5 }), () => {}, { admit });
      assert.equal(quiet.ran, false);
      assert.equal(asked, 1, "a trigger that did not fire claims nothing");
      assert.ok(quiet.nextReviewAt !== null && quiet.nextReviewAt > now, "and the ordinary future deadline still comes back");
    } finally {
      await brain.close();
    }
  });
});

describe("THE TICK NEVER SPINS AT ONE SECOND", () => {
  const startedAt = 1_800_000_000_000;
  it("a null nextReviewAt schedules the regular interval", () => {
    const ms = nextTickDelayMs({ startedAt, now: startedAt + 2_000, tickSeconds: 240, nextReviewAt: null, reviewIntervalSec: 300 });
    assert.equal(ms, 238_000);
    assert.notEqual(ms, 1000);
  });
  it("which is the whole point: a past deadline would have been one second", () => {
    const past = Math.floor(startedAt / 1000) - 60;
    const ms = nextTickDelayMs({ startedAt, now: startedAt + 2_000, tickSeconds: 240, nextReviewAt: past, reviewIntervalSec: 300 });
    assert.equal(ms, 1000, "the hazard a refused review must not hand back");
  });
});
