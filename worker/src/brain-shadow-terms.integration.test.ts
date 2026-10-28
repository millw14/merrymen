/**
 * THE DESK POLICY, END TO END THROUGH runShadow, against the real store and a
 * local stand-in for Brain that serves both /health and /v1/decide.
 *
 * The unit tests pin decide() in isolation. This pins the two things only the
 * whole path can: ShadowInputs.strategyTerms actually reaches the wire through
 * the process-wide capability probe, and the decision row records whether it
 * did — so "did the terms change what the desk decided?" is a ledger query.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import type { BrainDecision } from "./brain-client";
import type { ShadowInputs } from "./brain-shadow";
import { TRENCHER_FAST } from "./strategies/trencher";
import { trencherStrategyTerms } from "./strategy-terms";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-shadow-terms-"));
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
const { brainCapabilities } = await import("./brain-client");

after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const now = Math.floor(Date.now() / 1000);
let seq = 0;

async function brainStub(capabilities: string[]) {
  const decides: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/health") {
      res.end(JSON.stringify({ ok: true, schema_version: "1.0.0", capabilities }));
      return;
    }
    decides.push(JSON.parse(raw) as Record<string, unknown>);
    const decision: BrainDecision = {
      schema_version: "1.0.0", decision_id: `dec_terms_${++seq}_${now}`, agent_id: "x", created_at: now, trigger_id: null,
      action: "hold", instrument_id: "fixture", symbol: "MEME", confidence: 0.5, suggested_delta_usdg: 0,
      target_position_usdg: null, thesis: "Sells are growing into strength.", evidence: [], bull_case: "", bear_case: "",
      risks: [], invalidation: [], time_horizon: "up to 30 minutes", tier: "pulse", depth_used: "analysts",
      escalation_reasons: [], candidate_action: null, models: [], cost: { model_calls: 4, tokens_in: 1, tokens_out: 1, usd: 0 },
    };
    res.end(JSON.stringify({ ok: true, seconds: 0, decision }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, decides, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const inputs = (agentId: string, over: Partial<ShadowInputs> = {}): ShadowInputs => ({
  agentId, decisionSource: "brain", now, epoch: 1,
  cashUsdg: 10_000_000, vaultUsdg: 0, quarantinedUsdg: 0,
  netContributionsUsdg: 10_000_000, grossContributionsUsdg: 10_000_000, grossWithdrawalsUsdg: 0, gasUsdg: 0,
  positions: [],
  quality: { auditPassed: true, epoch: 1, currentAccountingHistoryAuditable: true, contributionsKnown: true, equityComplete: true, gasBasis: "net", positionHistoryAvailable: true, quarantinedAssetsPresent: false, assessedAt: now },
  market: { instrumentId: "fixture", symbol: "MEME", instrumentClass: "memecoin", priceUsd: "0.0001", priceStale: false, signals: {} },
  expectedTradeGasUsdg: 0, memory: [], persona: "Trencher persona.",
  ...over,
});

function signalsOf(id: string): Record<string, unknown> {
  const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
  try {
    const row = raw.prepare("SELECT signals_json FROM decisions WHERE id = ?").get(id) as { signals_json: string } | undefined;
    return JSON.parse(row!.signals_json) as Record<string, unknown>;
  } finally {
    raw.close();
  }
}

const terms = trencherStrategyTerms(TRENCHER_FAST)!;

describe("runShadow carries the desk policy", () => {
  it("to a Brain that advertises it, and records that it was sent", async () => {
    const brain = await brainStub(["strategy-terms"]);
    const agent = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b001";
    try {
      // The probe is false until known and never reads on a review's clock;
      // prime it the way the first review of a process would.
      brainCapabilities.advertises(brain.url, "strategy-terms");
      await brainCapabilities.settled();
      const out = await runShadow({ url: brain.url, token: "t", timeoutMs: 2000 }, inputs(agent, { strategyTerms: terms }), () => {});
      assert.equal(out.ran, true);
      assert.ok(out.ran && out.result.ok);
      assert.equal(brain.decides.length, 1);
      assert.equal(brain.decides[0]!.strategy_terms, terms.terms);
      assert.equal(brain.decides[0]!.horizon, "up to 30 minutes");
      const id = out.ran && out.result.ok ? out.result.decision.decision_id : "";
      assert.equal(signalsOf(id).strategy_terms, "sent");
    } finally {
      await brain.close();
    }
  });

  it("withholds it from one that does not, and records that too", async () => {
    const brain = await brainStub([]);
    const agent = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b002";
    try {
      brainCapabilities.advertises(brain.url, "strategy-terms");
      await brainCapabilities.settled();
      const out = await runShadow({ url: brain.url, token: "t", timeoutMs: 2000 }, inputs(agent, { strategyTerms: terms }), () => {});
      assert.ok(out.ran && out.result.ok);
      assert.equal("strategy_terms" in brain.decides[0]!, false);
      assert.equal("horizon" in brain.decides[0]!, false);
      assert.equal(signalsOf(out.result.decision.decision_id).strategy_terms, "withheld");
    } finally {
      await brain.close();
    }
  });

  it("and a review that supplies none is recorded as none", async () => {
    const brain = await brainStub(["strategy-terms"]);
    const agent = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b003";
    try {
      const out = await runShadow({ url: brain.url, token: "t", timeoutMs: 2000 }, inputs(agent), () => {});
      assert.ok(out.ran && out.result.ok);
      assert.equal("strategy_terms" in brain.decides[0]!, false);
      assert.equal(signalsOf(out.result.decision.decision_id).strategy_terms, null);
    } finally {
      await brain.close();
    }
  });
});
