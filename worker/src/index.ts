/**
 * merrymen worker — the 24/7 loop.
 *
 * tick: snapshot → strategy intents → policy check → simulate → execute → record
 *
 * Phase 1 status: snapshot + strategy + policy are real; simulate/execute/record
 * are stubs pending Rialto API onboarding and the Kernel session-key client.
 */

import { createPublicClient, http } from "viem";
import { robinhoodChain, CASH, MORPHO, RIALTO, STOCK_TOKENS } from "@merrymen/core";
import { checkPolicy, type AgentLimits, type AgentState } from "./policy";
import { steadyBasketTick, type SteadyBasketConfig, type Snapshot } from "./strategies/steady-basket";

const client = createPublicClient({ chain: robinhoodChain, transport: http() });

const TICK_MS = 60_000;

// Demo wiring — real limits/config come from Supabase per agent in Phase 1.
const limits: AgentLimits = {
  perTradeUsdg: 50_000000n, // 50 USDG (6dp)
  dailyUsdg: 500_000000n,
  allowedTargets: [RIALTO.routerSnapshot, MORPHO.steakhouseUsdgVault],
  allowedAssets: [
    CASH.USDG,
    ...STOCK_TOKENS.filter((t) => ["AAPL", "MSFT", "QQQ"].includes(t.symbol)).map((t) => t.address),
  ],
  maxDrawdownBps: 800,
  expiresAt: Math.floor(Date.now() / 1000) + 14 * 86_400,
};

const basket: SteadyBasketConfig = {
  legs: STOCK_TOKENS.filter((t) => ["AAPL", "MSFT", "QQQ"].includes(t.symbol)).map((t, _, arr) => ({
    symbol: t.symbol,
    token: t.address,
    weightBps: Math.floor(10_000 / arr.length),
  })),
  buyPerTickUsdg: 25_000000n,
  idleFloorUsdg: 50_000000n,
  rialtoRouter: RIALTO.routerSnapshot,
  vault: MORPHO.steakhouseUsdgVault,
  usdg: CASH.USDG,
};

async function snapshot(): Promise<Snapshot> {
  const block = await client.getBlockNumber();
  console.log(`[snapshot] block ${block}`);
  // TODO Phase 1: read agent smart-account balances, token pause states,
  // Chainlink staleness, sequencer-uptime feed.
  return {
    cashUsdg: 0n,
    vaultUsdg: 0n,
    pausedTokens: new Set(),
    staleFeeds: new Set(),
    sequencerUp: true,
  };
}

async function tick() {
  const snap = await snapshot();
  const intents = steadyBasketTick(basket, snap);
  const state: AgentState = {
    spentTodayUsdg: 0n,
    highWaterMarkUsdg: 0n,
    equityUsdg: snap.cashUsdg + snap.vaultUsdg,
    nowSec: Math.floor(Date.now() / 1000),
  };

  for (const intent of intents) {
    const verdict = checkPolicy(intent, limits, state);
    if (!verdict.ok) {
      console.log(`[policy] REJECTED ${intent.kind}: ${verdict.rule} — ${verdict.detail}`);
      continue;
    }
    // TODO Phase 1: simulate (fork/Tenderly) → execute via Kernel session key → record to Supabase.
    console.log(`[policy] approved ${intent.kind} → (execution stubbed)`);
  }
}

console.log("merrymen worker starting — chain", robinhoodChain.id);
tick().catch((e) => console.error("[tick]", e));
setInterval(() => tick().catch((e) => console.error("[tick]", e)), TICK_MS);
