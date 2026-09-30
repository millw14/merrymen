/**
 * WHAT THE TICK HANDS THE WRITER, EXECUTED.
 *
 * The mark a quiet review was written at, and the name and market cap a Brain
 * review of a memecoin is recorded with, were each built inline in index.ts's
 * main(), which no test boots. Any of those hunks could be reverted and every
 * test still passed, because the tests only called the store and
 * persistBrainDecision with hand-built arguments. The construction now lives
 * beside what it describes — quietReviewRow in market-review.ts, reviewRecord
 * in brain-shadow.ts — and the tick calls it. These run it into the real store,
 * through runShadow for the Brain half, and read the row back.
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

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-review-wiring-"));
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
const { marketReview, quietReviewRow, reviewSource, PRIVATE_REVIEW_SOURCE } = await import("./market-review");
const { reviewRecord, runShadow } = await import("./brain-shadow");

after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0x8888888888888888888888888888888888888888";
const row = (id: string) =>
  raw.prepare("SELECT source, provenance, action, symbol, reason, mark_usd, mcap_usd, display_name FROM decisions WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;

describe("a quiet review is written with the quote it was made at", () => {
  const quote = { symbol: "TSLA", priceUsd: 102, at: 1_800_000_000, stale: false };
  const history = [
    { at: quote.at - 3600, priceUsd: 100 },
    { at: quote.at - 1800, priceUsd: 103 },
    { at: quote.at - 60, priceUsd: 101 },
  ];

  it("A REVIEW CARRIES ITS MARK, so a published one can say 'since posted'", async () => {
    const review = marketReview(quote, null, history)!;
    assert.ok(review);
    await store.addDecision(quietReviewRow({ id: "qr-marked", agentId: AGENT, review, quote, focusSymbol: "TSLA", historyRead: true }));
    const r = row("qr-marked")!;
    assert.equal(r.mark_usd, 102);
    assert.equal(r.source, reviewSource(review));
    assert.equal(r.source, PRIVATE_REVIEW_SOURCE, "a first review is the owner's record, not news");
    assert.equal(r.provenance, "deterministic-strategy");
    assert.equal(r.action, "hold");
    assert.equal(r.symbol, "TSLA");
    assert.equal(r.reason, review.reason);
  });

  it("RESEARCH UNAVAILABLE SAW NO MARKET, and records no mark — never the quote it could not use", async () => {
    await store.addDecision(quietReviewRow({ id: "qr-none", agentId: AGENT, review: null, quote, focusSymbol: "TSLA", historyRead: false }));
    const r = row("qr-none")!;
    assert.equal(r.mark_usd, null);
    assert.equal(r.source, "research-unavailable");
    assert.equal(r.provenance, "deterministic-strategy");
    assert.equal(r.action, "hold");
    assert.equal(r.symbol, "TSLA");
    assert.match(String(r.reason), /Research does not establish a fresh, informative price series/);
  });

  it("and a review with no quote behind it records none either", () => {
    const review = marketReview(quote, null, history)!;
    assert.equal(quietReviewRow({ id: "x", agentId: AGENT, review, quote: null, focusSymbol: "TSLA", historyRead: true }).mark_usd, null);
  });
});

describe("a Brain review is recorded with the name and size of the coin", () => {
  const COIN = "T3139F043B88";
  const now = Math.floor(Date.now() / 1000);

  /**
   * One Brain run against a local stand-in for the service, filed under `id`.
   * Each run is its own agent: a second run for one agent would be cooling down.
   */
  const review = async (id: string, agentId: string, options: Parameters<typeof runShadow>[3]) => {
    const decision: BrainDecision = {
      schema_version: "1", decision_id: id, agent_id: agentId, created_at: now, trigger_id: null,
      action: "hold", instrument_id: "fixture-coin", symbol: COIN, confidence: 0.5, suggested_delta_usdg: 0,
      target_position_usdg: null, thesis: "Two-sided flow, no edge yet.", evidence: [], bull_case: "", bear_case: "",
      risks: [], invalidation: [], time_horizon: "", tier: "pulse", depth_used: "", escalation_reasons: [],
      candidate_action: null, models: [], cost: { model_calls: 1, tokens_in: 1, tokens_out: 1, usd: 0 },
      gate_verdict: "proceed", hold_kind: "MODEL_HOLD",
    };
    const server = createServer(async (req, res) => {
      for await (const _ of req) void _;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, seconds: 0, decision }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const inputs: ShadowInputs = {
      agentId, decisionSource: "brain", now, epoch: 1, userRequested: true,
      cashUsdg: 10_000_000, vaultUsdg: 0, quarantinedUsdg: 0,
      netContributionsUsdg: 10_000_000, grossContributionsUsdg: 10_000_000, grossWithdrawalsUsdg: 0, gasUsdg: 0,
      positions: [],
      quality: { auditPassed: true, epoch: 1, currentAccountingHistoryAuditable: true, contributionsKnown: true, equityComplete: true, gasBasis: "net", positionHistoryAvailable: true, quarantinedAssetsPresent: false, assessedAt: now },
      market: { instrumentId: "fixture-coin", symbol: COIN, instrumentClass: "memecoin", priceUsd: "0.00042", priceStale: false, signals: {} },
      expectedTradeGasUsdg: 0, memory: [],
    };
    try {
      const outcome = await runShadow({ url: `http://127.0.0.1:${port}`, token: "fixture", timeoutMs: 2000 }, inputs, () => {}, options);
      assert.ok(outcome.ran, `the review ran: ${outcome.ran ? "" : outcome.why}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return row(id)!;
  };

  it("THE TRENCHER'S: the tape's fdv becomes the row's market cap, beside the coin's name", async () => {
    const r = await review("dec_trench", "0x8888888888888888888888888888888888888801", { tier: "pulse", ...reviewRecord({ displayName: "JUGGERNAUT", tape: { fdvUsd: 3_100_000 } }) });
    assert.equal(r.display_name, "JUGGERNAUT");
    assert.equal(r.mcap_usd, 3_100_000);
    assert.equal(r.mark_usd, 0.00042);
  });

  it("NO TAPE, NO FIGURE — and a tape that did not size the coin is no figure either, never a zero", async () => {
    assert.deepEqual(reviewRecord({ displayName: null }), { displayName: null, mcapUsd: null });
    assert.deepEqual(reviewRecord({ displayName: "X", tape: { fdvUsd: null } }), { displayName: "X", mcapUsd: null });
    assert.deepEqual(reviewRecord({ displayName: "X", tape: null }), { displayName: "X", mcapUsd: null });
    const r = await review("dec_untaped", "0x8888888888888888888888888888888888888802", reviewRecord({ displayName: "JUGGERNAUT" }));
    assert.equal(r.display_name, "JUGGERNAUT");
    assert.equal(r.mcap_usd, null);
  });
});
