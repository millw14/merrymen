/**
 * A HOLD ON A STALE MARK IS THE OWNER'S FACT, NOT A POST.
 *
 * The Brain holding because "price feed stale, no volume…" was published as a
 * view about the coin: the staleness lived only in the private `signals_json`,
 * so the publication gate could not see it. It is now stamped on the row as
 * `STALE_MARK_HOLD`, by the real writer, and the gate keeps it private the way
 * it keeps a gate-forced hold. These drive the actual writer, store and public
 * route, because the defect was the seam between them; the feed reader's half
 * is in web/src/lib/read-theses.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { BrainDecision } from "./brain-client";
import type { PortfolioSnapshot } from "../../packages/core/src/index";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-stale-mark-"));
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
const { persistBrainDecision, recordedHoldKind } = await import("./brain-shadow");
const { GET } = await import("../../web/src/app/api/decision/[id]/route");

after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0x3333333333333333333333333333333333333333";
const OWNER = "0x4444444444444444444444444444444444444444";
await store.ensureAgent({ smartAccount: AGENT, owner: OWNER, sessionKeyAddress: OWNER, serialized: "fixture", caps: {}, grantedAt: 1, expiresAt: 2_000_000_000, chainId: 4663 } as never);
await store.setAgentMode(AGENT, "live", 1, false);

const cost = { model_calls: 1, tokens_in: 1, tokens_out: 1, usd: 0 };
const snapshot = { snapshotId: "fixture-snapshot", quality: {}, pnl: { publishable: true } } as PortfolioSnapshot;
const decision = (id: string, action: BrainDecision["action"], hold_kind: BrainDecision["hold_kind"] = action === "hold" ? "MODEL_HOLD" : null): BrainDecision => ({
  schema_version: "1", decision_id: id, agent_id: AGENT, created_at: 1, trigger_id: "fixture-trigger",
  action, symbol: "TSLA", instrument_id: "fixture-instrument", confidence: .5, suggested_delta_usdg: action === "hold" ? 0 : 5e6,
  target_position_usdg: null, thesis: "Price feed stale, no volume to read; holding until the tape returns.", evidence: [], risks: [], invalidation: [], bull_case: "", bear_case: "",
  time_horizon: "", tier: "", depth_used: "", escalation_reasons: [], candidate_action: null, models: [], cost, hold_kind,
});
const persist = (d: BrainDecision, priceStale: boolean) =>
  persistBrainDecision(AGENT, "brain", "fixture-run", "fixture-trigger",
    { fire: true, reason: "scheduled-review", detail: "fixture", candidates: ["scheduled-review"] },
    snapshot, { ok: true, decision: d, seconds: 0 }, { priceUsd: "1", priceStale }, () => {});
const publicRoute = (id: string) => GET(new Request(`https://app.example/api/decision/${id}`), { params: Promise.resolve({ id }) });

test("a hold on a stale mark is kept for the owner and not published", async () => {
  await persist(decision("dec_stale_hold", "hold"), true);
  const life = await store.lifecycleOf("dec_stale_hold");
  assert.equal(life?.decision.hold_kind, "STALE_MARK_HOLD", "the owner's record keeps the row and says why");
  assert.equal(life?.decision.reason, "Price feed stale, no volume to read; holding until the tape returns.");
  assert.equal((await publicRoute("dec_stale_hold")).status, 404, "a missing market is not a public market view");
});

test("the same hold on a fresh mark is still a view", async () => {
  await persist(decision("dec_fresh_hold", "hold"), false);
  assert.equal((await store.lifecycleOf("dec_fresh_hold"))?.decision.hold_kind, "MODEL_HOLD");
  assert.equal((await publicRoute("dec_fresh_hold")).status, 200);
});

test("the stamp only reclassifies a hold, and never over a gate", () => {
  assert.equal(recordedHoldKind({ action: "buy", hold_kind: null }, { priceStale: true }), undefined, "a trade is not a hold");
  assert.equal(recordedHoldKind({ action: "hold", hold_kind: "GATE_FORCED_HOLD" }, { priceStale: true }), "GATE_FORCED_HOLD");
  assert.equal(recordedHoldKind({ action: "hold", hold_kind: null }, { priceStale: true }), "STALE_MARK_HOLD");
  assert.equal(recordedHoldKind({ action: "hold", hold_kind: "MODEL_HOLD" }, { priceStale: false }), "MODEL_HOLD");
});
