import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BrainDecision } from "./brain-client";
import { runShadow, type ShadowInputs } from "./brain-shadow";
import { orderFromDecision, tradeConsumesSnapshot } from "./brain-live";
import { applyPaperIntent } from "./paper";
import { applyFill } from "./basis";
import { checkPolicy, type TradeIntent, type AgentLimits } from "./policy";
import { wrapSqlite } from "./db";
import { readPeerTheses } from "./peer-theses";
import { readPeers, writePeersForChild } from "./peer-files";
import { memoryLines, sentimentLine } from "./brain-material";
import * as store from "./store";

const AGENT = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x2222222222222222222222222222222222222222" as const;
const NVDA = "0x3333333333333333333333333333333333333333" as const;
const ROUTER = "0x4444444444444444444444444444444444444444" as const;

test("five-minute Brain decisions buy, sell and hold on the real paper ledger, then reach another agent", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-trading-loop-"));
  process.env.MERRYMEN_HOME = path.join(scratch, "home");
  delete process.env.DATABASE_URL;
  const cwd = process.cwd();
  const empty = path.join(scratch, "empty");
  mkdirSync(empty);
  try { process.chdir(empty); await store.initStore(); } finally { process.chdir(cwd); }
  await store.ensureAgent({ smartAccount: AGENT, owner: AGENT, sessionKeyAddress: AGENT, serialized: "test", caps: {}, grantedAt: 1, expiresAt: 2_000_000_000, chainId: 4663 } as never);
  await store.setAgentMode(AGENT, "paper", 1, false);
  const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));
  const seen: Record<string, unknown>[] = [];
  const now = Math.floor(Date.now() / 1000);
  const decisions: BrainDecision[] = (["buy", "sell", "hold"] as const).map((action, i) => ({
    schema_version: "1", decision_id: `dec_cycle_${i}`, agent_id: AGENT, created_at: now + i * 300, trigger_id: null,
    action, instrument_id: "merrymen:nvda", symbol: "NVDA", confidence: .65,
    suggested_delta_usdg: action === "buy" ? 10e6 : action === "sell" ? -11e6 : 0,
    target_position_usdg: null,
    thesis: action === "buy" ? "NVDA is holding above support. I would reconsider if the next quote loses that level."
      : action === "sell" ? "NVDA has reached the upper end of its range. I am taking profit and watching for a fresh base."
      : "NVDA is steady after the move. I am waiting for a new range before adding exposure.",
    evidence: [], bull_case: "Demand persists", bear_case: "Support may fail", risks: [], invalidation: ["Support fails"],
    time_horizon: "next review", tier: "research", depth_used: "adaptive", escalation_reasons: [], candidate_action: null,
    models: [], cost: { model_calls: 1, tokens_in: 1, tokens_out: 1, usd: 0 },
    gate_verdict: "proceed", hold_kind: action === "hold" ? "MODEL_HOLD" : null,
  }));
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, seconds: 0, decision: decisions[seen.length - 1] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const limits: AgentLimits = {
    perTradeUsdg: 50_000_000n, dailyUsdg: 100_000_000n, maxOpsPerDay: 10,
    allowedTargets: [ROUTER], allowedAssets: [USDG, NVDA], maxDrawdownBps: 1000, expiresAt: now + 3600,
  };
  try {
    for (let i = 0; i < 3; i++) {
      const price = i === 0 ? 100 : 110;
      const book = await store.getPaperBook(AGENT, 100);
      const peers = await readPeerTheses(wrapSqlite(raw), [AGENT], new Map([[AGENT, "robin"]]));
      const inputs: ShadowInputs = {
        agentId: AGENT, decisionSource: "brain", now: now + i * 300, epoch: 2,
        cashUsdg: Math.round(book.cashUsdg * 1e6), vaultUsdg: 0, quarantinedUsdg: 0,
        netContributionsUsdg: 100_000_000, grossContributionsUsdg: 100_000_000, grossWithdrawalsUsdg: 0, gasUsdg: 0,
        positions: Object.entries(book.shares).map(([symbol, p]) => ({ instrumentId: "merrymen:nvda", symbol, qtyRaw: String(BigInt(Math.round(p.shares * 1e18))), valueUsdg: Math.round(p.shares * price * 1e6), costBasisUsdg: 10_000_000, priceSource: "chainlink", quarantined: false })),
        quality: { auditPassed: true, epoch: 2, currentAccountingHistoryAuditable: true, contributionsKnown: true, equityComplete: true, gasBasis: "net", positionHistoryAvailable: true, quarantinedAssetsPresent: false, assessedAt: now + i * 300 },
        market: { instrumentId: "merrymen:nvda", symbol: "NVDA", instrumentClass: "equity-token", priceUsd: String(price), priceStale: false, signals: {} },
        expectedTradeGasUsdg: 0, memory: memoryLines(peers, now + i * 300),
      };
      const outcome = await runShadow({ url: `http://127.0.0.1:${port}`, token: "fixture", timeoutMs: 2000 }, inputs, () => {});
      assert.ok(outcome.ran && outcome.result.ok, `review ${i} must happen on its deadline`);
      const d = outcome.result.decision;
      assert.equal(await store.decisionAgent(d.decision_id), AGENT);
      assert.equal((await store.lifecycleOf(d.decision_id))?.decision.provenance, "brain");
      const order = orderFromDecision(d, { maxUsdg: 50, minUsdg: 5 });
      if (i === 2) { assert.equal(order.ok, false); continue; }
      assert.ok(order.ok);
      const intent: TradeIntent = {
        decisionId: d.decision_id, kind: "swap", target: ROUTER,
        sellToken: order.order.side === "buy" ? USDG : NVDA, buyToken: order.order.side === "buy" ? NVDA : USDG,
        sellAmountRaw: order.order.side === "buy" ? 10_000_000n : 100_000_000_000_000_000n,
        notionalUsdg: BigInt(Math.round(order.order.usdgAmount * 1e6)),
      };
      assert.equal(checkPolicy(intent, limits, { spentTodayUsdg: BigInt(i * 10_000_000), opsToday: i, highWaterMarkUsdg: 100_000_000n, equityUsdg: 100_000_000n, nowSec: inputs.now }).ok, true);
      // A tighter cap still blocks this very order.
      assert.equal(checkPolicy(intent, { ...limits, perTradeUsdg: 1n }, { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: 0n, equityUsdg: 0n, nowSec: inputs.now }).ok, false);
      const filled = applyPaperIntent(intent, book, Object.entries(book.shares).map(([symbol, p]) => ({ symbol, ...p })), {
        priceUsdOf: () => ({ priceUsd: price, stale: false }), symbolOf: () => "NVDA", multiplierOf: () => 1,
        usdgAddress: USDG, slippageBps: 0, notionalUsdg: order.order.usdgAmount,
      });
      assert.ok(filled.ok && filled.fill);
      const fill = filled.fill;
      const qtyRaw = BigInt(Math.round(fill.shares * 1e18));
      const basis = applyFill(await store.getBasis(AGENT, "paper", fill.symbol), { side: fill.side, qtyRaw, cashUsdg: BigInt(Math.round(fill.cashUsdg * 1e6)) });
      await store.setBasis(AGENT, "paper", fill.symbol, basis.basis);
      await store.setPaperBook(AGENT, { ...filled.book, shares: Object.fromEntries(filled.positions.map(p => [p.symbol, { token: p.token, shares: p.shares }])) });
      assert.equal(await store.addTrade({ agent_id: AGENT, decision_id: d.decision_id, kind: "swap", target: ROUTER, status: "paper", amount_usdg: order.order.usdgAmount,
        fill_side: fill.side, fill_qty_raw: String(qtyRaw), fill_cash_usdg: fill.cashUsdg, fill_price_usd: fill.priceUsd,
        realized_pnl_usdg: fill.side === "sell" ? Number(basis.realizedUsdg) / 1e6 : undefined, basis_source: "paper" }), true);
      assert.equal(tradeConsumesSnapshot((await store.lifecycleOf(d.decision_id))?.trades[0]?.status), true, "a second strategy must not reuse the pre-fill book");
    }
    const final = await store.getPaperBook(AGENT, 100);
    assert.equal(final.cashUsdg, 101);
    assert.deepEqual(final.shares, {});
    assert.equal((await store.lifecycleOf("dec_cycle_1"))?.trades[0]?.realized_pnl_usdg, 1);
    assert.equal((await store.lifecycleOf("dec_cycle_2"))?.trades.length, 0);
    const peers = await readPeerTheses(wrapSqlite(raw), [AGENT], new Map([[AGENT, "robin"]]));
    assert.equal(peers.length, 3);
    assert.ok(peers.every(p => p.paper));
    assert.ok(peers.some(p => p.action === "buy") && peers.some(p => p.action === "sell") && peers.some(p => p.action === "hold"));
    const readerHome = path.join(scratch, "another-agent");
    writePeersForChild(readerHome, { at: now + 600, theses: peers, own: [] });
    const material = sentimentLine(readPeers(readerHome).theses, "NVDA", "sentiment");
    assert.match(material ?? "", /robin|Robin/);
    assert.match(material ?? "", /support|range/);
    assert.ok((seen[1]?.memory as string[]).some(line => line.includes("support")), "the next decision sees its prior thesis and outcome");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    raw.close();
  }
});
