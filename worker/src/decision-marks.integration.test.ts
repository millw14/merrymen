/**
 * THE WRITER RECORDS WHAT THE AUTHOR SAW.
 *
 * The MARK a call was made against only exists at the moment of deciding, so
 * it is written there or never: without it a view can never say "+x% since
 * posted", and the feed could only print the token's own 24h change, which
 * readers took for the agent's result. Beside it, a memecoin's MARKET CAP from
 * the tape the Trencher already holds.
 *
 * A stale mark is not a mark — the author saw the absence of a market, and a
 * "since posted" computed from it would be a figure nobody read. These drive
 * the real writer and the real store, because the defect is what reaches the
 * row.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { BrainDecision } from "./brain-client";
import type { PortfolioSnapshot } from "../../packages/core/src/index";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-decision-marks-"));
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
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));
const { persistBrainDecision } = await import("./brain-shadow");

after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0x5555555555555555555555555555555555555555";
const COIN = "TA151B4A9E1B";
const cost = { model_calls: 1, tokens_in: 1, tokens_out: 1, usd: 0 };
const snapshot = { snapshotId: "fixture-snapshot", quality: {}, pnl: { publishable: true } } as PortfolioSnapshot;
const decision = (id: string, action: BrainDecision["action"], symbol = COIN): BrainDecision => ({
  schema_version: "1", decision_id: id, agent_id: AGENT, created_at: 1, trigger_id: "fixture-trigger",
  action, symbol, instrument_id: "fixture-instrument", confidence: .5, suggested_delta_usdg: action === "hold" ? 0 : 5e6,
  target_position_usdg: null, thesis: "Flow is two-sided and the book is deep enough.", evidence: [], risks: [], invalidation: [],
  bull_case: "", bear_case: "", time_horizon: "", tier: "", depth_used: "", escalation_reasons: [], candidate_action: null,
  models: [], cost, hold_kind: action === "hold" ? "MODEL_HOLD" : null,
});
const persist = (d: BrainDecision, market: { priceUsd: string | null; priceStale: boolean }, displayName?: string | null, mcapUsd?: number | null) =>
  persistBrainDecision(AGENT, "brain", "fixture-run", "fixture-trigger",
    { fire: true, reason: "scheduled-review", detail: "fixture", candidates: ["scheduled-review"] },
    snapshot, { ok: true, decision: d, seconds: 0 }, market, () => {}, displayName, mcapUsd);
const row = (id: string) =>
  raw.prepare("SELECT mark_usd, mcap_usd, display_name FROM decisions WHERE id = ?").get(id) as
    { mark_usd: number | null; mcap_usd: number | null; display_name: string | null } | undefined;

test("A BRAIN CALL RECORDS THE MARK IT WAS MADE AGAINST, and a memecoin its market cap", async () => {
  await persist(decision("dec_marked", "buy", "T3139F043B88"), { priceUsd: "0.00042", priceStale: false }, "JUGGERNAUT", 3_100_000);
  assert.deepEqual({ ...row("dec_marked") }, { mark_usd: 0.00042, mcap_usd: 3_100_000, display_name: "JUGGERNAUT" });
});

test("A STALE MARK IS NOT RECORDED AS ONE — the author saw no market", async () => {
  await persist(decision("dec_stale", "hold", "TSLA"), { priceUsd: "412.5", priceStale: true });
  assert.equal(row("dec_stale")?.mark_usd, null);
});

test("nor is a price that is not a price", async () => {
  await persist(decision("dec_zero", "hold", "TSLA"), { priceUsd: "0", priceStale: false });
  await persist(decision("dec_none", "hold", "TSLA"), { priceUsd: null, priceStale: false });
  assert.equal(row("dec_zero")?.mark_usd, null);
  assert.equal(row("dec_none")?.mark_usd, null);
});

test("a market cap that is not positive is absent, never zero", async () => {
  await persist(decision("dec_nocap", "hold"), { priceUsd: "0.0004", priceStale: false }, null, 0);
  assert.equal(row("dec_nocap")?.mcap_usd, null);
});
